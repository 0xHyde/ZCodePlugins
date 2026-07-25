import fs from "node:fs/promises";
import path from "node:path";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

async function findManifests(root) {
  const results = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await findManifests(file));
    else if (/^runtime-manifest-[^/]+\.json$/.test(entry.name)) results.push(file);
  }
  return results;
}

const input = path.resolve(option("input"));
const output = path.resolve(option("output", path.join(input, "runtime-manifest.json")));
const files = await findManifests(input);
if (!files.length) throw new Error(`没有找到平台 runtime manifest：${input}`);

const manifests = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))));
const versions = new Set(manifests.map((manifest) => manifest.version));
if (versions.size !== 1) throw new Error(`平台 runtime manifest 版本不一致：${[...versions].join(", ")}`);

const platforms = {};
for (const manifest of manifests) {
  for (const [platform, value] of Object.entries(manifest.platforms || {})) {
    if (platforms[platform]) throw new Error(`重复的平台 runtime manifest：${platform}`);
    platforms[platform] = value;
  }
}
if (!Object.keys(platforms).length) throw new Error("runtime manifest 没有平台内容。");

await fs.writeFile(output, `${JSON.stringify({ version: manifests[0].version, platforms }, null, 2)}\n`);
console.log(JSON.stringify({ output, platforms: Object.keys(platforms).sort() }, null, 2));
