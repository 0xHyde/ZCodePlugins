import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function runtimePlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function runtimeDataDir(dataRoot, platform = process.platform, arch = process.arch) {
  return path.join(dataRoot || path.join(os.homedir(), ".zcode", "voice-transcriber"), "runtimes", runtimePlatformKey(platform, arch));
}

function isGitHubUrl(value) {
  const url = new URL(value);
  return url.protocol === "https:" && (
    url.hostname === "github.com" ||
    url.hostname.endsWith(".github.com") ||
    url.hostname === "raw.githubusercontent.com" ||
    url.hostname.endsWith(".githubusercontent.com") ||
    url.hostname === "objects.githubusercontent.com"
  );
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function isFile(file) {
  const stat = await fs.stat(file).catch(() => null);
  return Boolean(stat?.isFile());
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function fetchManifest(manifestUrl) {
  try {
    if (!isGitHubUrl(manifestUrl)) throw fail("运行时 manifest 必须来自 GitHub HTTPS 地址。", "invalid_runtime_source");
  } catch (error) {
    if (error.code) throw error;
    throw fail(`运行时 manifest 地址无效：${error.message}`, "invalid_runtime_source");
  }
  const response = await fetch(manifestUrl, { redirect: "follow" });
  if (!response.ok) throw fail(`运行时 manifest 下载失败：HTTP ${response.status}`, "runtime_manifest_failed");
  const manifest = await response.json();
  if (!manifest || !manifest.version || !manifest.platforms || typeof manifest.platforms !== "object") {
    throw fail("运行时 manifest 缺少 version 或 platforms。", "invalid_runtime_manifest");
  }
  return manifest;
}

function validateEntry(entry) {
  if (!entry || typeof entry.name !== "string" || path.basename(entry.name) !== entry.name) {
    throw fail("运行时 manifest 包含非法文件名。", "invalid_runtime_manifest");
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
    throw fail(`运行时 ${entry.name} 缺少有效 SHA256。`, "invalid_runtime_manifest");
  }
}

async function downloadFile(url, target) {
  try {
    if (!isGitHubUrl(url)) throw fail(`运行时下载地址必须来自 GitHub：${url}`, "invalid_runtime_source");
  } catch (error) {
    if (error.code) throw error;
    throw fail(`运行时下载地址无效：${error.message}`, "invalid_runtime_source");
  }
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw fail(`运行时下载失败：HTTP ${response.status}`, "runtime_download_failed");
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  if (process.platform !== "win32") await fs.chmod(target, 0o755);
}

export async function ensureRuntime({
  dataRoot,
  manifestUrl = process.env.ZCODE_VOICE_RUNTIME_MANIFEST_URL,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const runtimeDir = runtimeDataDir(dataRoot, platform, arch);
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const usableManifestUrl = manifestUrl && !manifestUrl.startsWith("${") ? manifestUrl : null;
  if (!usableManifestUrl) {
    return { ready: false, configured: false, runtimeDir, missing: [] };
  }

  const manifest = await fetchManifest(usableManifestUrl);
  const platformManifest = manifest.platforms[runtimePlatformKey(platform, arch)];
  if (!platformManifest || !Array.isArray(platformManifest.files)) {
    throw fail(`运行时 manifest 不支持 ${runtimePlatformKey(platform, arch)}。`, "runtime_platform_unsupported");
  }
  const entries = platformManifest.files.map((entry) => {
    validateEntry(entry);
    return { ...entry, required: entry.required !== false };
  });
  const installedFile = path.join(runtimeDir, "installed.json");
  const installed = await readJson(installedFile, null);
  const downloaded = [];
  for (const entry of entries) {
    const target = path.join(runtimeDir, entry.name);
    const recorded = installed?.files?.find((file) =>
      file.name === entry.name && file.sha256 === entry.sha256 && file.version === manifest.version
    );
    if (await isFile(target)) {
      if (recorded || await sha256(target) === entry.sha256.toLowerCase()) continue;
      await fs.rm(target, { force: true });
    }
    const baseUrl = platformManifest.baseUrl || manifest.baseUrl || usableManifestUrl;
    let url;
    try {
      url = new URL(entry.url || entry.name, baseUrl).toString();
    } catch (error) {
      throw fail(`运行时 ${entry.name} 下载地址无效：${error.message}`, "invalid_runtime_source");
    }
    await downloadFile(url, target);
    if (await sha256(target) !== entry.sha256.toLowerCase()) {
      await fs.rm(target, { force: true });
      throw fail(`下载的运行时校验失败：${entry.name}`, "runtime_checksum_mismatch");
    }
    downloaded.push(entry.name);
  }
  await fs.writeFile(installedFile, `${JSON.stringify({
    version: manifest.version,
    platform: runtimePlatformKey(platform, arch),
    files: entries.map(({ name, sha256 }) => ({ name, sha256, version: manifest.version })),
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  const availability = await Promise.all(entries.map(async (entry) => ({
    entry,
    exists: await isFile(path.join(runtimeDir, entry.name)),
  })));
  const missing = availability.filter(({ entry, exists }) => entry.required && !exists).map(({ entry }) => entry.name);
  return {
    ready: missing.length === 0,
    configured: true,
    version: manifest.version,
    runtimeDir,
    missing,
    downloaded,
  };
}
