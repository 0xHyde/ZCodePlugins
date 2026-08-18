import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function frontmatter(text, file) {
  if (!text.startsWith("---\n")) throw new Error(`${file}: missing YAML frontmatter`);
  const end = text.indexOf("\n---", 4);
  if (end < 0) throw new Error(`${file}: unterminated YAML frontmatter`);
  const fields = new Map();
  for (const line of text.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return fields;
}

const marketplace = await readJson(path.join(root, "marketplace.json"));
if (!Array.isArray(marketplace.plugins)) throw new Error("marketplace.json: plugins must be an array");
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

for (const entry of marketplace.plugins) {
  const pluginPath = path.resolve(root, entry.source);
  const manifestPath = path.join(pluginPath, ".zcode-plugin", "plugin.json");
  const manifest = await readJson(manifestPath);
  if (manifest.name !== entry.name) throw new Error(`${manifestPath}: name does not match marketplace entry`);
  if (manifest.version !== entry.version) throw new Error(`${manifestPath}: version does not match marketplace entry`);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(manifest.name)) throw new Error(`${manifestPath}: invalid plugin name`);
  if (!semanticVersion.test(manifest.version || "")) throw new Error(`${manifestPath}: invalid semantic version`);

  const packagePath = path.join(pluginPath, "package.json");
  if (await exists(packagePath)) {
    const packageJson = await readJson(packagePath);
    if (packageJson.version !== manifest.version) throw new Error(`${packagePath}: version does not match plugin manifest`);
    if (packageJson.license !== manifest.license) throw new Error(`${packagePath}: license does not match plugin manifest`);
  }

  const packageLockPath = path.join(pluginPath, "package-lock.json");
  if (await exists(packageLockPath)) {
    const packageLock = await readJson(packageLockPath);
    if (packageLock.version !== manifest.version || packageLock.packages?.[""]?.version !== manifest.version) {
      throw new Error(`${packageLockPath}: version does not match plugin manifest`);
    }
  }

  if (manifest.license && !(await exists(path.join(pluginPath, "LICENSE")))) {
    throw new Error(`${pluginPath}: manifest declares ${manifest.license} but the standalone plugin has no LICENSE`);
  }

  if (typeof manifest.skills === "string") {
    const skillsPath = path.resolve(pluginPath, manifest.skills);
    if (!(await exists(skillsPath))) throw new Error(`${manifestPath}: skills path does not exist: ${manifest.skills}`);
  }

  if (typeof manifest.mcpServers === "string") {
    const mcpServersPath = path.resolve(pluginPath, manifest.mcpServers);
    if (!(await exists(mcpServersPath))) throw new Error(`${manifestPath}: mcpServers path does not exist: ${manifest.mcpServers}`);
  }

  for (const key of ["model_manifest_url"]) {
    const value = manifest.userConfig?.[key]?.default;
    if (!value || !value.includes(`/v${manifest.version}/`)) {
      throw new Error(`${manifestPath}: ${key} must point to the matching immutable release`);
    }
  }

  const mcpPath = path.join(pluginPath, ".mcp.json");
  if (await exists(mcpPath)) {
    const mcp = await readJson(mcpPath);
    if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") throw new Error(`${mcpPath}: missing mcpServers`);
    for (const [name, server] of Object.entries(mcp.mcpServers)) {
      if (!server.command || !Array.isArray(server.args)) throw new Error(`${mcpPath}: invalid server ${name}`);
    }
  }

  if (manifest.mcpServers) {
    const distServer = path.join(pluginPath, "dist", "mcp", "server.js");
    if (!(await exists(distServer))) throw new Error(`${pluginPath}: missing built MCP server at dist/mcp/server.js`);
  }

  for (const component of ["commands", "agents", "skills"]) {
    const componentPath = path.join(pluginPath, component);
    if (!(await exists(componentPath))) continue;
    const entries = await fs.readdir(componentPath, { withFileTypes: true });
    const files = [];
    for (const item of entries) {
      if (item.isFile() && item.name.endsWith(".md")) files.push(path.join(componentPath, item.name));
      if (item.isDirectory() && component === "skills") {
        const skillFile = path.join(componentPath, item.name, "SKILL.md");
        if (await exists(skillFile)) files.push(skillFile);
      }
    }
    for (const file of files) {
      const fields = frontmatter(await fs.readFile(file, "utf8"), file);
      if (!fields.get("name") || !fields.get("description")) throw new Error(`${file}: name and description are required`);
    }
  }

  const darwinRuntime = path.join(pluginPath, "bin", "darwin", "arm64");
  if (await exists(darwinRuntime)) {
    for (const executable of ["ffmpeg", "llama-funasr-sensevoice", "campp-adapter"]) {
      const file = path.join(darwinRuntime, executable);
      if (!(await exists(file))) continue;
      const stat = await fs.stat(file);
      if ((stat.mode & 0o111) === 0) {
        throw new Error(`${file}: macOS runtime is not executable`);
      }
    }
  }

  console.log(`ok ${manifest.name}`);
}
