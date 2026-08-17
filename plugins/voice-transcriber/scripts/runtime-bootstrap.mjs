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

function displayUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function isPortableBasename(value) {
  return value !== "." && value !== ".." &&
    path.posix.basename(value) === value && path.win32.basename(value) === value;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const activeBootstraps = new Map();

function configuredNumber(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

async function fetchAllowed(value, { timeoutMs = configuredNumber("ZCODE_RUNTIME_DOWNLOAD_TIMEOUT_MS", 300_000, 5_000, 3_600_000) } = {}) {
  let current = new URL(value).toString();
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isGitHubUrl(current)) throw fail(`运行时下载重定向到了未允许的地址：${displayUrl(current)}`, "invalid_runtime_source");
    let response;
    try {
      response = await fetch(current, { redirect: "manual", signal });
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw fail(`运行时下载超时：${displayUrl(current)}`, "runtime_download_timeout");
      }
      throw error;
    }
    if (!redirectStatuses.has(response.status)) return { response, signal };
    const location = response.headers?.get?.("location");
    if (!location) throw fail(`运行时下载重定向缺少 Location：${displayUrl(current)}`, "runtime_download_failed");
    try {
      current = new URL(location, current).toString();
    } catch {
      throw fail("运行时下载重定向地址无效。", "invalid_runtime_source");
    }
  }
  throw fail("运行时下载重定向次数过多。", "runtime_download_failed");
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
    throw fail(`运行时 manifest 地址无效：${displayUrl(manifestUrl)}`, "invalid_runtime_source");
  }
  const { response } = await fetchAllowed(manifestUrl, {
    timeoutMs: configuredNumber("ZCODE_RUNTIME_MANIFEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
  });
  if (!response.ok) throw fail(`运行时 manifest 下载失败：HTTP ${response.status}`, "runtime_manifest_failed");
  const manifest = await response.json();
  if (!manifest || !manifest.version || !manifest.platforms || typeof manifest.platforms !== "object") {
    throw fail("运行时 manifest 缺少 version 或 platforms。", "invalid_runtime_manifest");
  }
  return manifest;
}

function validateEntry(entry) {
  if (!entry || typeof entry.name !== "string" || !isPortableBasename(entry.name)) {
    throw fail("运行时 manifest 包含非法文件名。", "invalid_runtime_manifest");
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
    throw fail(`运行时 ${entry.name} 缺少有效 SHA256。`, "invalid_runtime_manifest");
  }
  if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
    throw fail(`运行时 ${entry.name} 缺少有效文件大小。`, "invalid_runtime_manifest");
  }
  if (entry.url !== undefined && typeof entry.url !== "string") {
    throw fail(`运行时 ${entry.name} 的下载地址无效。`, "invalid_runtime_manifest");
  }
}

async function downloadFile(url, target) {
  try {
    if (!isGitHubUrl(url)) throw fail(`运行时下载地址必须来自 GitHub：${displayUrl(url)}`, "invalid_runtime_source");
  } catch (error) {
    if (error.code) throw error;
    throw fail(`运行时下载地址无效：${error.message}`, "invalid_runtime_source");
  }
  const { response, signal } = await fetchAllowed(url);
  if (!response.ok || !response.body) throw fail(`运行时下载失败：HTTP ${response.status}`, "runtime_download_failed");
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body, { signal }), createWriteStream(temporary, { flags: "wx", mode: 0o700 }));
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  if (process.platform !== "win32") await fs.chmod(target, 0o755);
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function removeOwnedLock(lockFile, token) {
  const current = await readJson(lockFile, null).catch(() => null);
  if (current?.token === token) await fs.rm(lockFile, { force: true });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function reclaimAbandonedLock(lockFile, staleMs) {
  const stat = await fs.stat(lockFile).catch(() => null);
  if (!stat) return true;
  const record = await readJson(lockFile, null).catch(() => null);
  const stale = Date.now() - stat.mtimeMs > staleMs;
  const alive = processIsAlive(record?.pid);
  if (alive === true || (!stale && alive !== false)) return false;
  const currentStat = await fs.stat(lockFile).catch(() => null);
  if (!currentStat) return true;
  if (currentStat.mtimeMs !== stat.mtimeMs) return false;
  const current = await readJson(lockFile, null).catch(() => null);
  if (record?.token && current?.token !== record.token) return false;
  await fs.rm(lockFile, { force: true });
  return true;
}

async function withRuntimeLock(runtimeDir, operation) {
  const lockFile = path.join(runtimeDir, ".download.lock");
  const timeoutMs = configuredNumber("ZCODE_RUNTIME_LOCK_TIMEOUT_MS", 300_000, 1_000, 3_600_000);
  const staleMs = configuredNumber("ZCODE_RUNTIME_LOCK_STALE_MS", 1_800_000, 30_000, 86_400_000);
  const startedAt = Date.now();
  let handle = null;
  let token = null;
  while (!handle) {
    try {
      handle = await fs.open(lockFile, "wx", 0o600);
      token = crypto.randomBytes(16).toString("hex");
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => {});
        handle = null;
        await fs.rm(lockFile, { force: true });
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await reclaimAbandonedLock(lockFile, staleMs)) continue;
      if (Date.now() - startedAt >= timeoutMs) throw fail("等待其他 ZCode 任务下载运行时超时。", "runtime_lock_timeout");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const heartbeatMs = Math.max(1_000, Math.min(60_000, Math.floor(staleMs / 3)));
  const heartbeat = setInterval(() => {
    const now = new Date();
    handle?.utimes(now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await handle.close().catch(() => {});
    await removeOwnedLock(lockFile, token);
  }
}

async function ensureRuntimeLocked({
  dataRoot,
  manifestUrl,
  platform,
  arch,
}) {
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
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw fail("运行时 manifest 包含重复文件名。", "invalid_runtime_manifest");
  }
  const installedFile = path.join(runtimeDir, "installed.json");
  const installed = await readJson(installedFile, null);
  const downloaded = [];
  for (const entry of entries) {
    const target = path.join(runtimeDir, entry.name);
    const recorded = installed?.files?.find((file) =>
      file.name === entry.name && file.sha256 === entry.sha256 && file.version === manifest.version
    );
    if (await isFile(target)) {
      const stat = await fs.stat(target);
      if (recorded && Number(recorded.size) === stat.size && Number(recorded.mtimeMs) === stat.mtimeMs) continue;
      if (await sha256(target) === entry.sha256.toLowerCase()) continue;
      await fs.rm(target, { force: true });
    }
    const baseUrl = platformManifest.baseUrl || manifest.baseUrl || usableManifestUrl;
    let url;
    try {
      url = new URL(entry.url || entry.name, baseUrl).toString();
    } catch {
      throw fail(`运行时 ${entry.name} 下载地址无效。`, "invalid_runtime_source");
    }
    await downloadFile(url, target);
    if (entry.size !== undefined && (await fs.stat(target)).size !== entry.size) {
      await fs.rm(target, { force: true });
      throw fail(`下载的运行时大小校验失败：${entry.name}`, "runtime_size_mismatch");
    }
    if (await sha256(target) !== entry.sha256.toLowerCase()) {
      await fs.rm(target, { force: true });
      throw fail(`下载的运行时校验失败：${entry.name}`, "runtime_checksum_mismatch");
    }
    downloaded.push(entry.name);
  }
  const installedFiles = await Promise.all(entries.map(async ({ name, sha256: checksum }) => {
    const stat = await fs.stat(path.join(runtimeDir, name)).catch(() => null);
    return { name, sha256: checksum, version: manifest.version, size: stat?.size ?? null, mtimeMs: stat?.mtimeMs ?? null };
  }));
  await writeJsonAtomic(installedFile, {
    version: manifest.version,
    platform: runtimePlatformKey(platform, arch),
    files: installedFiles,
    installedAt: new Date().toISOString(),
  });
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

export async function ensureRuntime({
  dataRoot,
  manifestUrl = process.env.ZCODE_VOICE_RUNTIME_MANIFEST_URL,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const runtimeDir = runtimeDataDir(dataRoot, platform, arch);
  const key = `${path.resolve(runtimeDir)}\0${manifestUrl || ""}\0${platform}\0${arch}`;
  if (activeBootstraps.has(key)) return activeBootstraps.get(key);
  const operation = (async () => {
    await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(runtimeDir, 0o700);
    return withRuntimeLock(runtimeDir, () => ensureRuntimeLocked({ dataRoot, manifestUrl, platform, arch }));
  })();
  activeBootstraps.set(key, operation);
  try {
    return await operation;
  } finally {
    if (activeBootstraps.get(key) === operation) activeBootstraps.delete(key);
  }
}
