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
const output = path.resolve(option("output", "runtime-manifest.json"));
const version = option("version");
const repository = option("repository");
if (!version || !repository) throw new Error("需要 --version 和 --repository。");

const files = (await fs.readdir(input, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && !entry.name.endsWith(".pdb"))
  .map((entry) => entry.name)
  .sort();
if (!files.length) throw new Error(`运行时目录为空：${input}`);

const platform = path.basename(path.dirname(input));
const arch = path.basename(input);
const baseUrl = `https://github.com/${repository}/releases/download/${version}/`;
const entries = await Promise.all(files.map(async (name) => ({
  name,
  url: new URL(name, baseUrl).toString(),
  sha256: await sha256(path.join(input, name)),
  required: true,
})));

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify({
  version,
  platforms: {
    [`${platform}-${arch}`]: { files: entries },
  },
}, null, 2)}\n`);
console.log(JSON.stringify({ output, platform: `${platform}-${arch}`, files: entries.map((entry) => entry.name) }, null, 2));
