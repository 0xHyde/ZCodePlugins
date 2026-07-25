import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const input = path.resolve(option("input"));
const output = path.resolve(option("output", "model-manifest.json"));
const version = option("version");
const repository = option("repository");
const assetPrefix = option("asset-prefix", "");
const optional = new Set((option("optional", "") || "").split(",").map((name) => name.trim()).filter(Boolean));
if (!version || !repository) throw new Error("需要 --version 和 --repository。");

const files = (await fs.readdir(input, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && !entry.name.endsWith(".part"))
  .map((entry) => entry.name)
  .sort();
if (!files.length) throw new Error(`模型目录为空：${input}`);

const baseUrl = `https://github.com/${repository}/releases/download/${version}/`;
const entries = await Promise.all(files.map(async (name) => {
  const file = path.join(input, name);
  const stat = await fs.stat(file);
  return {
    name,
    url: new URL(`${assetPrefix}${name}`, baseUrl).toString(),
    sha256: await sha256(file),
    size: stat.size,
    required: !optional.has(name),
  };
}));

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify({
  version,
  baseUrl,
  files: entries,
}, null, 2)}\n`);
console.log(JSON.stringify({ output, files: entries }, null, 2));
