import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const defaultFiles = [
  { name: "sense-voice-small-q8_0.gguf", required: true },
  { name: "fsmn-vad.gguf", required: true },
  { name: "cam++.onnx", required: false },
];

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const allowedModelHosts = [
  "github.com",
  "raw.githubusercontent.com",
  "githubusercontent.com",
  "huggingface.co",
  "hf.co",
  "huggingfaceusercontent.com",
  "modelscope.cn",
  "modelscope.com",
];

const activeBootstraps = new Map();
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function isAllowedModelUrl(value) {
  const url = new URL(value);
  return url.protocol === "https:" && allowedModelHosts.some((host) =>
    url.hostname === host || url.hostname.endsWith(`.${host}`)
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

function configuredNumber(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

async function fetchAllowed(value, { timeoutMs = configuredNumber("ZCODE_MODEL_DOWNLOAD_TIMEOUT_MS", 300_000, 5_000, 3_600_000) } = {}) {
  let current = new URL(value).toString();
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isAllowedModelUrl(current)) {
      throw fail(`模型下载重定向到了未允许的地址：${displayUrl(current)}`, "invalid_model_source");
    }
    let response;
    try {
      response = await fetch(current, { redirect: "manual", signal });
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw fail(`模型下载超时：${displayUrl(current)}`, "model_download_timeout");
      }
      throw error;
    }
    if (!redirectStatuses.has(response.status)) return { response, signal, finalUrl: current };
    const location = response.headers?.get?.("location");
    if (!location) throw fail(`模型下载重定向缺少 Location：${displayUrl(current)}`, "model_download_failed");
    try {
      current = new URL(location, current).toString();
    } catch {
      throw fail("模型下载重定向地址无效。", "invalid_model_source");
    }
  }
  throw fail("模型下载重定向次数过多。", "model_download_failed");
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
    if (!isAllowedModelUrl(manifestUrl)) throw fail("模型 manifest 必须来自 GitHub、ModelScope 或 Hugging Face 的 HTTPS 地址。", "invalid_model_source");
  } catch (error) {
    if (error.code) throw error;
    throw fail(`模型 manifest 地址无效：${displayUrl(manifestUrl)}`, "invalid_model_source");
  }
  const { response } = await fetchAllowed(manifestUrl, {
    timeoutMs: configuredNumber("ZCODE_MODEL_MANIFEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
  });
  if (!response.ok) throw fail(`模型 manifest 下载失败：HTTP ${response.status}`, "model_manifest_failed");
  const manifest = await response.json();
  if (!manifest || !Array.isArray(manifest.files) || !manifest.version) {
    throw fail("模型 manifest 缺少 version 或 files。", "invalid_model_manifest");
  }
  return manifest;
}

async function downloadFile(url, target) {
  if (!isAllowedModelUrl(url)) throw fail(`模型下载地址必须来自 GitHub、ModelScope 或 Hugging Face：${displayUrl(url)}`, "invalid_model_source");
  const { response, signal } = await fetchAllowed(url);
  if (!response.ok || !response.body) throw fail(`模型下载失败：HTTP ${response.status}`, "model_download_failed");
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body, { signal }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
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

async function withModelLock(modelDir, operation) {
  const lockFile = path.join(modelDir, ".download.lock");
  const timeoutMs = configuredNumber("ZCODE_MODEL_LOCK_TIMEOUT_MS", 300_000, 1_000, 3_600_000);
  const staleMs = configuredNumber("ZCODE_MODEL_LOCK_STALE_MS", 1_800_000, 30_000, 86_400_000);
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
      if (Date.now() - startedAt >= timeoutMs) throw fail("等待其他 ZCode 任务下载模型超时。", "model_lock_timeout");
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

function validateFileEntry(entry) {
  if (!entry || typeof entry.name !== "string" || !isPortableBasename(entry.name)) {
    throw fail("模型 manifest 包含非法文件名。", "invalid_model_manifest");
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
    throw fail(`模型 ${entry.name} 缺少有效 SHA256。`, "invalid_model_manifest");
  }
  if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
    throw fail(`模型 ${entry.name} 缺少有效文件大小。`, "invalid_model_manifest");
  }
  if (entry.urls !== undefined && (!Array.isArray(entry.urls) || entry.urls.some((url) => typeof url !== "string"))) {
    throw fail(`模型 ${entry.name} 的备用下载地址无效。`, "invalid_model_manifest");
  }
  if (entry.url !== undefined && typeof entry.url !== "string") {
    throw fail(`模型 ${entry.name} 的下载地址无效。`, "invalid_model_manifest");
  }
}

async function downloadAndVerify(entry, urls, target) {
  let lastError = null;
  for (const url of urls) {
    try {
      await downloadFile(url, target);
      const downloadedSize = (await fs.stat(target)).size;
      if (entry.size !== undefined && downloadedSize !== entry.size) {
        throw fail(`下载的模型大小校验失败：${entry.name}`, "model_size_mismatch");
      }
      if (await sha256(target) !== entry.sha256.toLowerCase()) {
        throw fail(`下载的模型校验失败：${entry.name}`, "model_checksum_mismatch");
      }
      return url;
    } catch (error) {
      await fs.rm(target, { force: true });
      lastError = error;
    }
  }
  throw lastError || fail(`模型没有可用下载地址：${entry.name}`, "model_download_failed");
}

async function ensureModelsLocked({ dataRoot, manifestUrl, includeOptional }) {
  const modelDir = path.join(dataRoot || path.join(os.homedir(), ".zcode", "voice-transcriber"), "models");
  await fs.mkdir(modelDir, { recursive: true, mode: 0o700 });
  await fs.chmod(modelDir, 0o700).catch(() => {});
  const existing = await Promise.all(defaultFiles.map(async (file) => ({
    ...file,
    exists: await isFile(path.join(modelDir, file.name)),
  })));
  const usableManifestUrl = manifestUrl && !manifestUrl.startsWith("${") ? manifestUrl : null;
  if (!usableManifestUrl) {
    return {
      ready: existing.every((file) => !file.required || file.exists),
      modelDir,
      missing: existing.filter((file) => file.required && !file.exists).map((file) => file.name),
      optionalMissing: existing.filter((file) => !file.required && !file.exists).map((file) => file.name),
      downloaded: [],
    };
  }

  const manifest = await fetchManifest(usableManifestUrl);
  const entries = manifest.files.map((entry) => {
    validateFileEntry(entry);
    return { ...entry, required: entry.required !== false };
  }).filter((entry) => includeOptional || entry.required);
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw fail("模型 manifest 包含重复文件名。", "invalid_model_manifest");
  }
  const installedFile = path.join(modelDir, "installed.json");
  const installed = await readJson(installedFile, null);
  const downloaded = [];
  const optionalFailures = [];
  for (const entry of entries) {
    const target = path.join(modelDir, entry.name);
    const recorded = installed?.files?.find((file) => file.name === entry.name && file.sha256 === entry.sha256 && file.version === manifest.version);
    if (await isFile(target)) {
      const stat = await fs.stat(target);
      if (recorded && recorded.size === stat.size && recorded.mtimeMs === stat.mtimeMs) continue;
      if (await sha256(target) === entry.sha256.toLowerCase()) continue;
      await fs.rm(target, { force: true });
    }
    const baseUrl = manifest.baseUrl || manifestUrl;
    const candidateValues = [entry.url, ...(entry.urls || [])].filter(Boolean);
    try {
      const urls = [...candidateValues.map((value) => new URL(value, baseUrl).toString()), new URL(entry.name, baseUrl).toString()];
      await downloadAndVerify(entry, urls, target);
    } catch (error) {
      const resolvedError = error.code ? error : fail(`模型 ${entry.name} 下载地址无效。`, "invalid_model_source");
      if (entry.required) throw resolvedError;
      optionalFailures.push({ name: entry.name, code: resolvedError.code, message: resolvedError.message });
      continue;
    }
    downloaded.push(entry.name);
  }
  const installedFiles = await Promise.all(entries.map(async ({ name, sha256 }) => {
    const stat = await fs.stat(path.join(modelDir, name)).catch(() => null);
    return { name, sha256, version: manifest.version, size: stat?.size ?? null, mtimeMs: stat?.mtimeMs ?? null };
  }));
  await writeJsonAtomic(installedFile, { version: manifest.version, files: installedFiles, installedAt: new Date().toISOString() });
  const availability = await Promise.all(entries.map(async (entry) => ({ entry, exists: await isFile(path.join(modelDir, entry.name)) })));
  const missing = availability.filter(({ entry, exists }) => entry.required && !exists).map(({ entry }) => entry.name);
  return {
    ready: missing.length === 0,
    modelDir,
    missing,
    optionalMissing: availability.filter(({ entry, exists }) => !entry.required && !exists).map(({ entry }) => entry.name),
    optionalFailures,
    downloaded,
  };
}

export async function ensureModels({
  dataRoot,
  manifestUrl = process.env.ZCODE_VOICE_MODEL_MANIFEST_URL,
  includeOptional = true,
} = {}) {
  const modelDir = path.resolve(dataRoot || path.join(os.homedir(), ".zcode", "voice-transcriber"), "models");
  const key = `${modelDir}\0${manifestUrl || ""}\0${includeOptional ? "all" : "required"}`;
  if (activeBootstraps.has(key)) return activeBootstraps.get(key);
  const operation = (async () => {
    await fs.mkdir(modelDir, { recursive: true, mode: 0o700 });
    return withModelLock(modelDir, () => ensureModelsLocked({ dataRoot, manifestUrl, includeOptional }));
  })();
  activeBootstraps.set(key, operation);
  try {
    return await operation;
  } finally {
    if (activeBootstraps.get(key) === operation) activeBootstraps.delete(key);
  }
}
