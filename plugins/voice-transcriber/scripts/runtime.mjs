import fs from "node:fs/promises";
import path from "node:path";

function configuredValue(value) {
  const trimmed = String(value || "").trim();
  return trimmed && !trimmed.startsWith("${") ? trimmed : null;
}

export function bundledRuntimeCandidates(pluginRoot, executable) {
  const names = [executable];
  if (process.platform === "win32" && !executable.toLowerCase().endsWith(".exe")) names.push(`${executable}.exe`);
  return names.map((name) => path.join(pluginRoot, "bin", process.platform, process.arch, name));
}

export async function isFile(file) {
  const stat = await fs.stat(file).catch(() => null);
  return Boolean(stat?.isFile());
}

export async function commandAvailable(command) {
  const configured = configuredValue(command);
  if (!configured) return false;
  if (path.isAbsolute(configured) || configured.includes(path.sep) || (process.platform === "win32" && configured.includes("/"))) {
    return isFile(configured);
  }
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" && !configured.toLowerCase().endsWith(".exe")
    ? [configured, `${configured}.exe`, `${configured}.cmd`, `${configured}.bat`]
    : [configured];
  for (const entry of pathEntries) {
    for (const name of names) {
      if (await isFile(path.join(entry, name))) return true;
    }
  }
  return false;
}

export async function resolveRuntimeCommand({ pluginRoot, configured, defaultName }) {
  const value = configuredValue(configured);
  if (value && (path.isAbsolute(value) || value.includes(path.sep) || (process.platform === "win32" && value.includes("/")))) {
    return { command: value, source: "config", exists: await isFile(value) };
  }
  const bundledNames = [...new Set([value, defaultName].filter(Boolean))];
  for (const name of bundledNames) {
    for (const candidate of bundledRuntimeCandidates(pluginRoot, name)) {
      if (await isFile(candidate)) return { command: candidate, source: "bundled", exists: true };
    }
  }
  const command = value || defaultName;
  return { command, source: value ? "config" : "default", exists: await commandAvailable(command) };
}
