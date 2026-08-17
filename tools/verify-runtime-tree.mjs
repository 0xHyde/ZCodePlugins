import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const rootOption = option("root");
const manifestOption = option("manifest");
if (!rootOption || !manifestOption) throw new Error("需要 --root 和 --manifest。");
const root = path.resolve(rootOption);
const manifestFile = path.resolve(manifestOption);
const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
const expectedPlatforms = ["darwin-arm64", "win32-x64"];
const actualPlatforms = Object.keys(manifest.platforms || {}).sort();
if (JSON.stringify(actualPlatforms) !== JSON.stringify(expectedPlatforms)) {
  throw new Error(`runtime manifest 平台不完整：需要 ${expectedPlatforms.join(", ")}，实际 ${actualPlatforms.join(", ") || "无"}`);
}

for (const [platformKey, platform] of Object.entries(manifest.platforms || {})) {
  const separator = platformKey.lastIndexOf("-");
  if (!/^(?:darwin-arm64|win32-x64)$/.test(platformKey) || separator <= 0 || !Array.isArray(platform?.files)) {
    throw new Error(`无效的 runtime manifest 平台：${platformKey}`);
  }
  const directory = path.join(root, platformKey.slice(0, separator), platformKey.slice(separator + 1));
  const expectedNames = new Set();
  for (const entry of platform.files) {
    if (!entry || path.posix.basename(entry.name || "") !== entry.name || path.win32.basename(entry.name || "") !== entry.name || !/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
      throw new Error(`无效的 runtime manifest 文件：${platformKey}/${entry?.name || "<unknown>"}`);
    }
    if (expectedNames.has(entry.name)) throw new Error(`runtime manifest 包含重复文件：${platformKey}/${entry.name}`);
    expectedNames.add(entry.name);
    const file = path.join(directory, entry.name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error(`最终插件缺少 runtime：${platformKey}/${entry.name}`);
    if (await sha256(file) !== entry.sha256.toLowerCase()) {
      throw new Error(`最终插件 runtime SHA 不匹配：${platformKey}/${entry.name}`);
    }
  }
  const actualNames = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const unexpected = actualNames.filter((name) => !expectedNames.has(name));
  if (unexpected.length) {
    throw new Error(`最终插件包含本次 runtime manifest 之外的文件：${platformKey}/${unexpected.sort().join(", ")}`);
  }
}

console.log(`verified runtime tree: ${root}`);
