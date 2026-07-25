import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const defaultFiles = [
  { name: "sense-voice-small-q8_0.gguf", required: true },
  { name: "fsmn-vad.gguf", required: false },
  { name: "cam++.onnx", required: false },
];

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
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
    if (!isGitHubUrl(manifestUrl)) throw fail("模型 manifest 必须来自 GitHub HTTPS 地址。", "invalid_model_source");
  } catch (error) {
    if (error.code) throw error;
    throw fail(`模型 manifest 地址无效：${error.message}`, "invalid_model_source");
  }
  const response = await fetch(manifestUrl, { redirect: "follow" });
  if (!response.ok) throw fail(`模型 manifest 下载失败：HTTP ${response.status}`, "model_manifest_failed");
  const manifest = await response.json();
  if (!manifest || !Array.isArray(manifest.files) || !manifest.version) {
    throw fail("模型 manifest 缺少 version 或 files。", "invalid_model_manifest");
  }
  return manifest;
}

async function downloadFile(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw fail(`模型下载失败：HTTP ${response.status}`, "model_download_failed");
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function validateFileEntry(entry) {
  if (!entry || typeof entry.name !== "string" || path.basename(entry.name) !== entry.name) {
    throw fail("模型 manifest 包含非法文件名。", "invalid_model_manifest");
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
    throw fail(`模型 ${entry.name} 缺少有效 SHA256。`, "invalid_model_manifest");
  }
}

export async function ensureModels({ dataRoot, manifestUrl = process.env.ZCODE_VOICE_MODEL_MANIFEST_URL } = {}) {
  const modelDir = path.join(dataRoot || path.join(os.homedir(), ".zcode", "voice-transcriber"), "models");
  await fs.mkdir(modelDir, { recursive: true });
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
  });
  const installedFile = path.join(modelDir, "installed.json");
  const installed = await readJson(installedFile, null);
  const downloaded = [];
  for (const entry of entries) {
    const target = path.join(modelDir, entry.name);
    const recorded = installed?.files?.find((file) => file.name === entry.name && file.sha256 === entry.sha256 && file.version === manifest.version);
    if (await isFile(target)) {
      if (recorded) continue;
      if (await sha256(target) === entry.sha256.toLowerCase()) continue;
      throw fail(`本地模型校验失败：${entry.name}`, "model_checksum_mismatch");
    }
    const baseUrl = manifest.baseUrl || manifestUrl;
    let url;
    try {
      url = new URL(entry.url || entry.name, baseUrl).toString();
      if (!isGitHubUrl(url)) throw fail(`模型 ${entry.name} 下载地址必须来自 GitHub。`, "invalid_model_source");
    } catch (error) {
      if (error.code) throw error;
      throw fail(`模型 ${entry.name} 下载地址无效：${error.message}`, "invalid_model_source");
    }
    await downloadFile(url, target);
    if (await sha256(target) !== entry.sha256.toLowerCase()) {
      await fs.rm(target, { force: true });
      throw fail(`下载的模型校验失败：${entry.name}`, "model_checksum_mismatch");
    }
    downloaded.push(entry.name);
  }
  await fs.writeFile(installedFile, `${JSON.stringify({ version: manifest.version, files: entries.map(({ name, sha256 }) => ({ name, sha256, version: manifest.version })), installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  const availability = await Promise.all(entries.map(async (entry) => ({ entry, exists: await isFile(path.join(modelDir, entry.name)) })));
  const missing = availability.filter(({ entry, exists }) => entry.required && !exists).map(({ entry }) => entry.name);
  return {
    ready: missing.length === 0,
    modelDir,
    missing,
    optionalMissing: availability.filter(({ entry, exists }) => !entry.required && !exists).map(({ entry }) => entry.name),
    downloaded,
  };
}
