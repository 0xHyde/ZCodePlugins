import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "voice-transcriber");
const repository = "https://github.com/lovemefan/SenseVoice.cpp.git";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

async function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = await exec(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

async function findFile(directory, filename) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename);
      if (nested) return nested;
    }
  }
  return null;
}

const ref = option("ref", process.env.ZCODE_SENSEVOICE_REF || "main");
const output = path.resolve(option(
  "output",
  path.join(pluginRoot, "bin", process.platform, process.arch),
));
const jobs = String(Math.max(1, Number(option("jobs", process.env.ZCODE_BUILD_JOBS || Math.min(4, os.cpus().length || 1)))));
const keepBuild = process.env.ZCODE_KEEP_BUILD === "1";
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-sensevoice-build-"));
const source = path.join(temporaryRoot, "SenseVoice.cpp");
const build = path.join(temporaryRoot, "build");

try {
  await run("git", ["clone", "--depth", "1", "--branch", ref, "--recurse-submodules", repository, source], root);
  await run("cmake", ["-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release"], root);
  await run("cmake", ["--build", build, "--config", "Release", "-j", jobs], root);

  const binaryName = process.platform === "win32" ? "sense-voice-main.exe" : "sense-voice-main";
  const binary = await findFile(build, binaryName);
  if (!binary) throw new Error(`构建完成但找不到 ${binaryName}。`);
  await fs.mkdir(output, { recursive: true });
  const destination = path.join(output, binaryName);
  await fs.copyFile(binary, destination);
  if (process.platform !== "win32") await fs.chmod(destination, 0o755);
  console.log(JSON.stringify({ repository, ref, output: destination, jobs }, null, 2));
} finally {
  if (!keepBuild) await fs.rm(temporaryRoot, { recursive: true, force: true });
  else console.log(`保留构建目录：${temporaryRoot}`);
}
