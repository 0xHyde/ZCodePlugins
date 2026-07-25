import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "voice-transcriber");
const sourceRepository = "https://github.com/modelscope/3D-Speaker.git";
const nlohmannHeaderUrl = "https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp";
const ortVersion = option("ort-version", process.env.ZCODE_ONNXRUNTIME_VERSION || "1.12.0");

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

async function run(command, args, cwd = root) {
  console.log(`> ${command} ${args.join(" ")}`);
  try {
    const result = await exec(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
  } catch (error) {
    // execFile rejects before the normal output forwarding below. Preserve
    // compiler/linker diagnostics in CI logs so a failed native build is
    // actionable instead of appearing as a bare exit code 1.
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

async function findFile(directory, names) {
  const wanted = new Set(Array.isArray(names) ? names : [names]);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && wanted.has(entry.name)) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, names);
      if (nested) return nested;
    }
  }
  return null;
}

async function findDirectory(directory, name) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = await findDirectory(candidate, name);
      if (nested) return nested;
    }
  }
  return null;
}

function platformPackage() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return { name: `onnxruntime-osx-arm64-${ortVersion}.tgz`, library: `libonnxruntime.${ortVersion}.dylib` };
    if (process.arch === "x64") return { name: `onnxruntime-osx-x86_64-${ortVersion}.tgz`, library: `libonnxruntime.${ortVersion}.dylib` };
  }
  if (process.platform === "linux") {
    if (process.arch === "x64") return { name: `onnxruntime-linux-x64-${ortVersion}.tgz`, library: `libonnxruntime.so.${ortVersion}` };
    if (process.arch === "arm64") return { name: `onnxruntime-linux-aarch64-${ortVersion}.tgz`, library: `libonnxruntime.so.${ortVersion}` };
  }
  if (process.platform === "win32" && process.arch === "x64") return { name: `onnxruntime-win-x64-${ortVersion}.zip`, library: "onnxruntime.dll" };
  throw new Error(`当前构建脚本暂不支持 ${process.platform}/${process.arch} 的 ONNX Runtime 预编译包。`);
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}: ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: "wx" }));
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function extractArchive(archive, destination) {
  if (process.platform === "win32" && archive.toLowerCase().endsWith(".zip")) {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `Expand-Archive -LiteralPath ${powershellLiteral(archive)} -DestinationPath ${powershellLiteral(destination)} -Force`,
    ].join("; ");
    await run("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]);
    return;
  }
  await run("tar", ["-xf", archive, "-C", destination]);
}

const packageInfo = platformPackage();
const output = path.resolve(option("output", path.join(pluginRoot, "bin", process.platform, process.arch)));
const ref = option("ref", process.env.ZCODE_3D_SPEAKER_REF || "main");
const keepBuild = process.env.ZCODE_KEEP_BUILD === "1";
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-campp-build-"));
const source = path.join(temporaryRoot, "3D-Speaker");
const ortArchive = path.join(temporaryRoot, packageInfo.name);
const ortRoot = path.join(temporaryRoot, "onnxruntime");
const build = path.join(temporaryRoot, "build");

try {
  await run("git", ["clone", "--depth", "1", "--branch", ref, sourceRepository, source]);
  const nlohmannHeader = path.join(source, "runtime", "onnxruntime", "third_party", "nlohmann_json-src", "include", "nlohmann", "json.hpp");
  if (!(await fs.stat(nlohmannHeader).catch(() => null))) {
    await fs.mkdir(path.dirname(nlohmannHeader), { recursive: true });
    await download(nlohmannHeaderUrl, nlohmannHeader);
  }
  await fs.mkdir(ortRoot, { recursive: true });
  await download(`https://github.com/microsoft/onnxruntime/releases/download/v${ortVersion}/${packageInfo.name}`, ortArchive);
  await extractArchive(ortArchive, ortRoot);
  const extracted = await findDirectory(ortRoot, "include");
  if (!extracted) throw new Error("ONNX Runtime 压缩包解压后缺少 include 目录。");
  const packageRoot = path.dirname(extracted);
  const cmakeConfigureArgs = [
    "-S", path.join(pluginRoot, "native"),
    "-B", build,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DSPEAKERLAB_ROOT=${path.join(source, "runtime", "onnxruntime")}`,
    `-DONNXRUNTIME_ROOT=${packageRoot}`,
  ];
  if (process.platform === "win32") cmakeConfigureArgs.push("-A", "x64");
  await run("cmake", cmakeConfigureArgs);
  await run("cmake", [
    "--build", build,
    "--config", "Release",
    "--parallel", String(Math.max(1, Number(option("jobs", process.env.ZCODE_BUILD_JOBS || Math.min(4, os.cpus().length || 1))))),
  ]);

  const binaryName = process.platform === "win32" ? "campp-adapter.exe" : "campp-adapter";
  const binary = await findFile(build, binaryName);
  const library = await findFile(packageRoot, packageInfo.library);
  if (!binary || !library) throw new Error(`构建完成但缺少 ${binaryName} 或 ${packageInfo.library}。`);
  await fs.mkdir(output, { recursive: true });
  const binaryDestination = path.join(output, binaryName);
  await fs.copyFile(binary, binaryDestination);
  await fs.copyFile(library, path.join(output, path.basename(library)));
  if (process.platform !== "win32") await fs.chmod(binaryDestination, 0o755);
  console.log(JSON.stringify({ sourceRepository, ref, ortVersion, output, binary: binaryDestination, library: path.basename(library) }, null, 2));
} finally {
  if (!keepBuild) await fs.rm(temporaryRoot, { recursive: true, force: true });
  else console.log(`保留构建目录：${temporaryRoot}`);
}
