import fs from "node:fs/promises";
import crypto from "node:crypto";
import dns from "node:dns";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
dns.setDefaultResultOrder("ipv4first");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "voice-transcriber");
const sourceRepository = "https://github.com/modelscope/3D-Speaker.git";
const defaultRef = "065629c313eaf1a01c65c640c46d77e61e9607b4";
const nlohmannHeaderUrl = "https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp";
const nlohmannLicenseUrl = "https://raw.githubusercontent.com/nlohmann/json/v3.11.3/LICENSE.MIT";
const nlohmannHeaderSha256 = "9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6";
const nlohmannLicenseSha256 = "86b998c792894ccb911a1cb7994f7a9652894e7a094c0b5e45be2f553f45cf14";
const knownOrtArchiveSha256 = {
  "onnxruntime-osx-arm64-1.12.0.tgz": "23117b6f5d7324d4a7c51184e5f808dd952aec411a6b99a1b6fd1011de06e300",
  "onnxruntime-win-x64-1.12.0.zip": "8b5d61204989350b7904ac277f5fbccd3e6736ddbb6ec001e412723d71c9c176",
};
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
    const diagnostic = [error.stdout, error.stderr, error.message]
      .filter(Boolean)
      .join("\n")
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A")
      .slice(-3500);
    process.stdout.write(`::error title=CAM++ native command failed::${diagnostic}\n`);
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

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(url, target, expectedSha256) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}: ${url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: "wx" }));
      const actualSha256 = await sha256(target);
      if (actualSha256 !== expectedSha256) {
        throw new Error(`下载文件 SHA256 不匹配：${path.basename(target)} (${actualSha256})`);
      }
      return;
    } catch (error) {
      await fs.rm(target, { force: true });
      lastError = error;
      if (attempt < 4) {
        console.warn(`下载失败，准备第 ${attempt + 1}/4 次重试：${path.basename(target)} (${error.message})`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw lastError;
}

async function patchSpeakerlabWindowsUtf8Paths(source) {
  if (process.platform !== "win32") return;
  const file = path.join(source, "runtime", "onnxruntime", "utils", "wav_reader.cpp");
  let code = (await fs.readFile(file, "utf8")).replace(/\r\n/g, "\n");
  const include = '#include "utils/wav_reader.h"\n';
  const open = "std::ifstream in_file(wav_filename, std::ios::binary);";
  if (!code.includes(include) || !code.includes(open)) {
    throw new Error("3D-Speaker WavReader 源码结构发生变化，无法应用 Windows UTF-8 路径适配。");
  }
  code = code.replace(include, `${include}\n#include <filesystem>\n\nnamespace {\nstd::filesystem::path path_from_utf8(const std::string &value) {\n    const auto *begin = reinterpret_cast<const char8_t *>(value.data());\n    return std::filesystem::path(std::u8string(begin, begin + value.size()));\n}\n}\n`);
  code = code.replace(open, "std::ifstream in_file(path_from_utf8(wav_filename), std::ios::binary);");
  await fs.writeFile(file, code, "utf8");
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
const ref = option("ref", process.env.ZCODE_3D_SPEAKER_REF || defaultRef);
const macosDeploymentTarget = process.env.MACOSX_DEPLOYMENT_TARGET || "12.0";
const keepBuild = process.env.ZCODE_KEEP_BUILD === "1";
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-campp-build-"));
const source = path.join(temporaryRoot, "3D-Speaker");
const ortArchive = path.join(temporaryRoot, packageInfo.name);
const ortRoot = path.join(temporaryRoot, "onnxruntime");
const build = path.join(temporaryRoot, "build");
const nlohmannLicense = path.join(temporaryRoot, "NLOHMANN_JSON_LICENSE.txt");

try {
  await fs.mkdir(source, { recursive: true });
  await run("git", ["init"], source);
  await run("git", ["remote", "add", "origin", sourceRepository], source);
  await run("git", ["fetch", "--depth", "1", "origin", ref], source);
  await run("git", ["checkout", "--detach", "FETCH_HEAD"], source);
  await patchSpeakerlabWindowsUtf8Paths(source);
  const nlohmannHeader = path.join(source, "runtime", "onnxruntime", "third_party", "nlohmann_json-src", "include", "nlohmann", "json.hpp");
  if (!(await fs.stat(nlohmannHeader).catch(() => null))) {
    await fs.mkdir(path.dirname(nlohmannHeader), { recursive: true });
    await download(nlohmannHeaderUrl, nlohmannHeader, nlohmannHeaderSha256);
  } else if (await sha256(nlohmannHeader) !== nlohmannHeaderSha256) {
    throw new Error("3D-Speaker 构建树中的 nlohmann/json 与固定的 v3.11.3 不一致。");
  }
  await download(nlohmannLicenseUrl, nlohmannLicense, nlohmannLicenseSha256);
  await fs.mkdir(ortRoot, { recursive: true });
  const ortArchiveSha256 = process.env.ZCODE_ONNXRUNTIME_SHA256 || knownOrtArchiveSha256[packageInfo.name];
  if (!ortArchiveSha256) throw new Error(`缺少 ${packageInfo.name} 的固定 SHA256。`);
  await download(`https://github.com/microsoft/onnxruntime/releases/download/v${ortVersion}/${packageInfo.name}`, ortArchive, ortArchiveSha256);
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
  if (process.platform === "darwin") cmakeConfigureArgs.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${macosDeploymentTarget}`);
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
  const speakerLicense = path.join(source, "LICENSE");
  const ortLicense = path.join(packageRoot, "LICENSE");
  const ortThirdPartyNotices = path.join(packageRoot, "ThirdPartyNotices.txt");
  const legalFiles = [speakerLicense, nlohmannLicense, ortLicense, ortThirdPartyNotices];
  const legalStats = await Promise.all(legalFiles.map((file) => fs.stat(file).catch(() => null)));
  if (!binary || !library || legalStats.some((stat) => !stat?.isFile())) {
    throw new Error(`构建完成但缺少 ${binaryName}、${packageInfo.library} 或第三方许可证文件。`);
  }
  await fs.mkdir(output, { recursive: true });
  const binaryDestination = path.join(output, binaryName);
  await fs.copyFile(binary, binaryDestination);
  await fs.copyFile(library, path.join(output, path.basename(library)));
  await fs.copyFile(speakerLicense, path.join(output, "3D_SPEAKER_LICENSE.txt"));
  await fs.copyFile(nlohmannLicense, path.join(output, "NLOHMANN_JSON_LICENSE.txt"));
  await fs.copyFile(ortLicense, path.join(output, "ORT_LICENSE.txt"));
  await fs.copyFile(ortThirdPartyNotices, path.join(output, "ORT_THIRD_PARTY_NOTICES.txt"));
  if (process.platform !== "win32") await fs.chmod(binaryDestination, 0o755);
  console.log(JSON.stringify({ sourceRepository, ref, ortVersion, output, binary: binaryDestination, library: path.basename(library) }, null, 2));
} finally {
  if (!keepBuild) await fs.rm(temporaryRoot, { recursive: true, force: true });
  else console.log(`保留构建目录：${temporaryRoot}`);
}
