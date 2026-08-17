import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { ensureModels } from "./model-bootstrap.mjs";
import { ensureRuntime } from "./runtime-bootstrap.mjs";
import { resolveRuntimeCommand } from "./runtime.mjs";
import { parseSenseVoiceOutput } from "./sensevoice-parser.mjs";
import { prepareAudio, splitAudio } from "./audio-prep.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ZCODE_VOICE_DATA_DIR || path.join(os.homedir(), ".zcode", "voice-transcriber");
const taskRoot = path.join(dataRoot, "tasks");
const cacheRoot = path.join(dataRoot, "cache");
const learningRoot = path.join(dataRoot, "learning");
const artifactRoot = path.join(dataRoot, "artifacts");
const modelRoot = path.join(dataRoot, "models");
const pluginPackage = JSON.parse(await fs.readFile(path.join(pluginRoot, "package.json"), "utf8"));
const PLUGIN_VERSION = pluginPackage.version;
const PIPELINE_VERSION = "voice-transcriber-v0.4-speaker-v2.0";
const ASR_PIPELINE_VERSION = "asr-v2";
const SPEAKER_PIPELINE_VERSION = "speaker-v2";
const STAGE_CACHE_VERSION = 2;
const ASR_CHECKPOINT_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TASK_ID_PATTERN = /^task_[a-f0-9]{16,64}$/;
const LEARNING_ID_PATTERN = /^learn_[a-f0-9]{16,64}$/;
const SEGMENT_ID_PATTERN = /^seg_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PERSON_ID_PATTERN = /^person_[\p{L}\p{N}_-]{1,128}$/u;
const DEFAULT_VAD_MAX_SEGMENT_MS = 5000;
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "preparing_models", "preparing_audio", "transcribing", "identifying_speakers"]);
let runtimeBootstrapPromise = null;
const activeTasks = new Map();
const startOperations = new Map();
const taskMutations = new Map();
let profileMutation = Promise.resolve();
const heavyQueue = [];
let heavyWorkerRunning = false;
let stateInitialization = null;
const fileIdentityMemo = new Map();

async function secureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== "win32") await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function ensureDirs() {
  await secureDirectory(dataRoot);
  await Promise.all([taskRoot, cacheRoot, learningRoot, artifactRoot, modelRoot].map(secureDirectory));
}

function configuredDuration(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function taskRunLockFile(taskId) {
  requireTaskId(taskId);
  return path.join(taskRoot, `${taskId}.run.lock`);
}

function taskMutationLockFile(taskId) {
  requireTaskId(taskId);
  return path.join(taskRoot, `${taskId}.mutation.lock`);
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

async function inspectLease(lockFile, staleMs) {
  const stat = await fs.stat(lockFile).catch(() => null);
  if (!stat?.isFile()) return { active: false, record: null, mtimeMs: null };
  const record = await readJson(lockFile, null).catch(() => null);
  const fresh = Date.now() - stat.mtimeMs <= staleMs;
  const alive = processIsAlive(record?.pid);
  return {
    active: alive === true || (fresh && alive !== false),
    record,
    mtimeMs: stat.mtimeMs,
  };
}

async function reclaimInactiveLease(lockFile, staleMs) {
  const inspected = await inspectLease(lockFile, staleMs);
  if (inspected.active) return false;
  const currentStat = await fs.stat(lockFile).catch(() => null);
  if (!currentStat) return true;
  if (!currentStat.isFile() || currentStat.mtimeMs !== inspected.mtimeMs) return false;
  const current = await readJson(lockFile, null).catch(() => null);
  if (inspected.record?.token && current?.token !== inspected.record.token) return false;
  await fs.rm(lockFile, { force: true });
  return true;
}

async function tryAcquireLease(lockFile, { staleMs }) {
  await secureDirectory(path.dirname(lockFile));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    const token = crypto.randomBytes(16).toString("hex");
    try {
      handle = await fs.open(lockFile, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, "utf8");
      const heartbeatMs = Math.max(1_000, Math.min(30_000, Math.floor(staleMs / 3)));
      const heartbeat = setInterval(() => {
        const now = new Date();
        handle?.utimes(now, now).catch(() => {});
      }, heartbeatMs);
      heartbeat.unref?.();
      let released = false;
      return {
        token,
        async release() {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          await handle.close().catch(() => {});
          const current = await readJson(lockFile, null).catch(() => null);
          if (current?.token === token) await fs.rm(lockFile, { force: true }).catch(() => {});
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== "EEXIST") {
        if (handle) await fs.rm(lockFile, { force: true }).catch(() => {});
        throw error;
      }
      if (!await reclaimInactiveLease(lockFile, staleMs)) return null;
    }
  }
  return null;
}

async function acquireLease(lockFile, { staleMs, timeoutMs, timeoutMessage, timeoutCode }) {
  const startedAt = Date.now();
  while (true) {
    const lease = await tryAcquireLease(lockFile, { staleMs });
    if (lease) return lease;
    if (Date.now() - startedAt >= timeoutMs) throw fail(timeoutMessage, timeoutCode);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function withMutationLease(lockFile, operation) {
  const staleMs = configuredDuration("ZCODE_VOICE_MUTATION_LOCK_STALE_MS", 120_000, 10_000, 3_600_000);
  const timeoutMs = configuredDuration("ZCODE_VOICE_MUTATION_LOCK_TIMEOUT_MS", 300_000, 1_000, 3_600_000);
  const lease = await acquireLease(lockFile, {
    staleMs,
    timeoutMs,
    timeoutMessage: "等待其他 ZCode 会话保存本地转写数据超时。",
    timeoutCode: "mutation_lock_timeout",
  });
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

async function updateTaskStatus(taskId, status, progress = {}, extra = {}) {
  const task = await readJson(taskFile(taskId), null);
  if (!task) return null;
  task.status = status;
  task.progress = { ...(task.progress || {}), ...progress };
  Object.assign(task, extra);
  task.updatedAt = new Date().toISOString();
  await writeJson(taskFile(taskId), task);
  return task;
}

async function initializeState() {
  if (!stateInitialization) {
    stateInitialization = (async () => {
      await ensureDirs();
      const entries = await fs.readdir(taskRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(taskRoot, entry.name);
        const task = await readJson(file, null).catch(() => null);
        if (!task || !ACTIVE_TASK_STATUSES.has(task.status) || !TASK_ID_PATTERN.test(task.taskId || "")) continue;
        const staleMs = configuredDuration("ZCODE_VOICE_TASK_LOCK_STALE_MS", 120_000, 10_000, 3_600_000);
        const lease = await tryAcquireLease(taskRunLockFile(task.taskId), { staleMs });
        if (!lease) continue;
        try {
          const current = await readJson(file, null).catch(() => null);
          if (!current || !ACTIVE_TASK_STATUSES.has(current.status)) continue;
          current.status = "interrupted";
          current.progress = { ...(current.progress || {}), stage: "interrupted", message: "上一次 ZCode 会话中断，可重新提交此录音。" };
          current.updatedAt = new Date().toISOString();
          await writeJson(file, current);
        } finally {
          await lease.release();
        }
      }
    })();
  }
  return stateInitialization;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file, value) {
  await secureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, value, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
    await fs.rename(temporary, file);
    if (process.platform !== "win32") await fs.chmod(file, PRIVATE_FILE_MODE);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireIdentifier(value, pattern, field, code) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw fail(`${field} 格式无效。`, code);
  }
  return value;
}

function requireTaskId(value) {
  return requireIdentifier(value, TASK_ID_PATTERN, "taskId", "invalid_task_id");
}

function requireLearningId(value) {
  return requireIdentifier(value, LEARNING_ID_PATTERN, "learningId", "invalid_learning_id");
}

function requireSegmentIds(values, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) throw fail("segmentIds 格式无效。", "invalid_segment_id");
  return values.map((value) => requireIdentifier(value, SEGMENT_ID_PATTERN, "segmentId", "invalid_segment_id"));
}

function requirePersonId(value) {
  return requireIdentifier(value, PERSON_ID_PATTERN, "personId", "invalid_person_id");
}

function requirePersonName(value) {
  if (typeof value !== "string") throw fail("personName 不能为空。", "invalid_person");
  const name = value.trim();
  if (!name || [...name].length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw fail("personName 格式无效。", "invalid_person");
  }
  return name;
}

async function withTaskMutation(taskId, operation) {
  requireTaskId(taskId);
  const previous = taskMutations.get(taskId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => withMutationLease(taskMutationLockFile(taskId), operation));
  taskMutations.set(taskId, current);
  try {
    return await current;
  } finally {
    if (taskMutations.get(taskId) === current) taskMutations.delete(taskId);
  }
}

async function withProfileMutation(operation) {
  const current = profileMutation.catch(() => {}).then(() => withMutationLease(path.join(dataRoot, "profiles.mutation.lock"), operation));
  profileMutation = current;
  return current;
}

function taskFile(taskId) {
  requireTaskId(taskId);
  return path.join(taskRoot, `${taskId}.json`);
}

function profileFile() {
  return path.join(dataRoot, "profiles.json");
}

async function isFile(file) {
  if (!file) return false;
  const stat = await fs.stat(file).catch(() => null);
  return Boolean(stat?.isFile());
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function installedFileRecord(file) {
  const installed = await readJson(path.join(path.dirname(file), "installed.json"), null).catch(() => null);
  const record = installed?.files?.find((item) => item.name === path.basename(file));
  return record && /^[a-f0-9]{64}$/i.test(record.sha256 || "")
    ? { ...record, manifestVersion: installed.version || record.version || null }
    : null;
}

async function fileIdentity(file) {
  if (!file) return null;
  const resolved = path.resolve(file);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) return null;
  const recorded = await installedFileRecord(resolved);
  let sha256 = null;
  if (recorded && Number(recorded.size) === stat.size && Number(recorded.mtimeMs) === stat.mtimeMs) {
    sha256 = recorded.sha256.toLowerCase();
  } else {
    const memoKey = `${resolved}\0${stat.size}\0${stat.mtimeMs}`;
    sha256 = fileIdentityMemo.get(memoKey) || await sha256File(resolved);
    fileIdentityMemo.set(memoKey, sha256);
  }
  return {
    name: path.basename(resolved),
    sha256,
    size: stat.size,
    ...(recorded?.manifestVersion ? { version: recorded.manifestVersion } : {}),
  };
}

async function findExecutable(command) {
  if (!command) return null;
  if (path.isAbsolute(command) || command.includes(path.sep) || (process.platform === "win32" && command.includes("/"))) {
    return path.resolve(command);
  }
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const hasExtension = process.platform === "win32" && extensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()));
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of hasExtension ? [""] : extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function runtimeIdentity(runtime, { companions = [] } = {}) {
  if (!runtime?.exists) return null;
  const executable = await findExecutable(runtime.command);
  const binary = await fileIdentity(executable);
  if (!binary) return null;
  const companionFiles = [];
  if (executable && companions.length) {
    const entries = await fs.readdir(path.dirname(executable), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && companions.some((pattern) => pattern.test(entry.name))) {
        const identity = await fileIdentity(path.join(path.dirname(executable), entry.name));
        if (identity) companionFiles.push(identity);
      }
    }
  }
  companionFiles.sort((left, right) => left.name.localeCompare(right.name));
  return { source: runtime.source, binary, ...(companionFiles.length ? { companions: companionFiles } : {}) };
}

async function resolveModel(envName, defaultName) {
  const rawConfigured = process.env[envName]?.trim();
  const configured = rawConfigured && !rawConfigured.startsWith("${") ? rawConfigured : null;
  if (configured) return { path: configured, source: "config", exists: await isFile(configured) };
  const discovered = path.join(modelRoot, defaultName);
  return { path: discovered, source: "data", exists: await isFile(discovered) };
}

async function ensureDownloadedRuntime() {
  if (!process.env.ZCODE_VOICE_RUNTIME_MANIFEST_URL || process.env.ZCODE_VOICE_RUNTIME_MANIFEST_URL.startsWith("${")) return null;
  if (!runtimeBootstrapPromise) runtimeBootstrapPromise = ensureRuntime({ dataRoot });
  return runtimeBootstrapPromise;
}

async function resolveBackendRuntime(commandEnv, defaultName, { bootstrap = false } = {}) {
  let runtime = await resolveRuntimeCommand({
    pluginRoot,
    dataRoot,
    configured: process.env[commandEnv],
    defaultName,
  });
  if (bootstrap && !runtime.exists) {
    await ensureDownloadedRuntime();
    runtime = await resolveRuntimeCommand({
      pluginRoot,
      dataRoot,
      configured: process.env[commandEnv],
      defaultName,
    });
  }
  return runtime;
}

async function resolveSenseVoiceRuntime(options = {}) {
  return resolveBackendRuntime("ZCODE_SENSEVOICE_BINARY", "llama-funasr-sensevoice", options);
}

async function resolveCamppRuntime(options = {}) {
  return resolveBackendRuntime("ZCODE_CAMPP_COMMAND", "campp-adapter", options);
}

async function runtimeStatus() {
  const asrModel = await resolveModel("ZCODE_SENSEVOICE_MODEL", "sense-voice-small-q8_0.gguf");
  const vadModel = await resolveModel("ZCODE_FSMN_VAD_MODEL", "fsmn-vad.gguf");
  const camppModel = await resolveModel("ZCODE_CAMPP_MODEL", "cam++.onnx");
  const senseVoice = await resolveSenseVoiceRuntime();
  const camppRuntime = await resolveCamppRuntime();
  return {
    status: "ok",
    dataRoot,
    modelsRoot: modelRoot,
    runtimeManifestConfigured: Boolean(process.env.ZCODE_VOICE_RUNTIME_MANIFEST_URL),
    asr: {
      binary: senseVoice.command,
      binarySource: senseVoice.source,
      binaryExists: senseVoice.exists,
      modelPath: asrModel.path,
      modelSource: asrModel.source,
      modelExists: asrModel.exists,
      vadPath: vadModel.path,
      vadSource: vadModel.source,
      vadExists: vadModel.exists,
    },
    speaker: {
      modelPath: camppModel.path,
      modelSource: camppModel.source,
      modelExists: camppModel.exists,
      adapter: camppRuntime.command,
      adapterSource: camppRuntime.source,
      adapterConfigured: camppRuntime.exists,
      modelDownloadConfigured: Boolean(process.env.ZCODE_VOICE_MODEL_MANIFEST_URL),
    },
  };
}

function requireSenseVoiceRuntime(runtime) {
  if (!runtime.exists) {
    throw fail(`找不到 SenseVoice 运行时：${runtime.command}。请安装或将平台运行时放入插件 bin/${process.platform}/${process.arch}/。`, "sensevoice_runtime_not_found");
  }
}


function artifactDir(taskId) {
  requireTaskId(taskId);
  return path.join(artifactRoot, taskId);
}

function learningFile(learningId) {
  requireLearningId(learningId);
  return path.join(learningRoot, `${learningId}.json`);
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return "--:--:--";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function renderMarkdown(task) {
  return [
    `# 本地转写\n`,
    `- 任务：${task.taskId}`,
    `- 音频：${task.audioPath}`,
    `- 片段数：${task.segments.length}`,
    "",
    ...task.segments.map((segment) => `### [${formatClock(segment.start)}] ${segment.speaker || "未知说话人"}\n${segment.text}`),
    "",
  ].join("\n");
}

function formatSubtitleClock(seconds, separator) {
  const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const whole = Math.floor(value);
  const milliseconds = Math.round((value - whole) * 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(milliseconds).padStart(3, "0")}`;
}

function renderSubtitles(task, separator) {
  return task.segments.map((segment, index) => {
    const start = Number.isFinite(segment.start) ? segment.start : index * 5;
    const end = Number.isFinite(segment.end) && segment.end > start ? segment.end : start + 5;
    return `${index + 1}\n${formatSubtitleClock(start, separator)} --> ${formatSubtitleClock(end, separator)}\n${segment.speaker || "未知说话人"}：${segment.text}\n`;
  }).join("\n");
}

async function writeArtifacts(task) {
  const revision = Math.max(1, Number(task.revision || 1));
  const directory = path.join(artifactDir(task.taskId), "revisions", String(revision).padStart(6, "0"));
  const transcript = {
    version: 2,
    revision,
    taskId: task.taskId,
    audioPath: task.audioPath,
    audio: task.audio,
    text: task.text,
    segments: task.segments,
  };
  await writeJson(path.join(directory, "transcript.json"), transcript);
  await writeText(path.join(directory, "transcript.txt"), `${task.text || ""}\n`);
  await writeText(path.join(directory, "transcript.md"), renderMarkdown(task));
  if (task.options?.outputFormat === "srt") await writeText(path.join(directory, "transcript.srt"), renderSubtitles(task, ","));
  if (task.options?.outputFormat === "vtt") await writeText(path.join(directory, "transcript.vtt"), `WEBVTT\n\n${renderSubtitles(task, ".")}`);
  return {
    json: path.join(directory, "transcript.json"),
    text: path.join(directory, "transcript.txt"),
    markdown: path.join(directory, "transcript.md"),
    ...(task.options?.outputFormat === "srt" ? { srt: path.join(directory, "transcript.srt") } : {}),
    ...(task.options?.outputFormat === "vtt" ? { vtt: path.join(directory, "transcript.vtt") } : {}),
  };
}

async function getProfiles() {
  return readJson(profileFile(), { version: 1, profiles: [] });
}

async function saveProfiles(value) {
  return writeJson(profileFile(), value);
}

function makeCacheIdentity(audioPath, stat, options, profilesFingerprint) {
  return {
    pipelineVersion: PIPELINE_VERSION,
    pluginVersion: PLUGIN_VERSION,
    source: { audioPath, size: stat.size, mtimeMs: stat.mtimeMs },
    asr: {
      pipelineVersion: ASR_PIPELINE_VERSION,
      language: options.language,
      model: process.env.ZCODE_SENSEVOICE_MODEL || "sense-voice-small-q8_0.gguf",
      vadModel: process.env.ZCODE_FSMN_VAD_MODEL || "fsmn-vad.gguf",
      vadMaxSegmentMs: Number(process.env.ZCODE_VOICE_VAD_MAXSEG_MS || DEFAULT_VAD_MAX_SEGMENT_MS),
      chunkSeconds: process.env.ZCODE_VOICE_CHUNK_SECONDS || "adaptive",
    },
    speaker: {
      enabled: options.speakerProfile,
      pipelineVersion: options.speakerProfile ? SPEAKER_PIPELINE_VERSION : null,
      model: options.speakerProfile ? (process.env.ZCODE_CAMPP_MODEL || "cam++.onnx") : null,
      adapter: options.speakerProfile ? (process.env.ZCODE_CAMPP_COMMAND || "campp-adapter") : null,
      adapterArgs: options.speakerProfile ? (process.env.ZCODE_CAMPP_ARGS || null) : null,
      clusterThreshold: options.speakerProfile ? Number(process.env.ZCODE_CAMPP_CLUSTER_THRESHOLD || 0.35) : null,
      minClusterSize: options.speakerProfile ? Number(process.env.ZCODE_CAMPP_MIN_CLUSTER_SIZE || 2) : null,
      minSpeakers: options.speakerProfile ? Number(process.env.ZCODE_CAMPP_MIN_SPEAKERS || 1) : null,
      maxSpeakers: options.speakerProfile ? Number(process.env.ZCODE_CAMPP_MAX_SPEAKERS || 15) : null,
      batchSize: options.speakerProfile ? Number(process.env.ZCODE_CAMPP_BATCH_SIZE || 64) : null,
      threads: options.speakerProfile ? Number(process.env.ZCODE_CAMPP_THREADS || 2) : null,
      matchThreshold: options.speakerProfile ? Number(process.env.ZCODE_CAMPP_MATCH_THRESHOLD || 0.62) : null,
      matchMargin: options.speakerProfile ? Number(process.env.ZCODE_CAMPP_MATCH_MARGIN || 0.05) : null,
      profilesFingerprint: options.speakerProfile ? profilesFingerprint : null,
    },
    render: { outputFormat: options.outputFormat },
  };
}

function configuredPath(name) {
  const value = String(process.env[name] || "").trim();
  return value && !value.startsWith("${") ? value : null;
}

async function modelDependency(envName, defaultName, mockName) {
  const model = await resolveModel(envName, defaultName);
  const identity = model.exists ? await fileIdentity(model.path) : null;
  if (identity) return identity;
  if (process.env.ZCODE_VOICE_MOCK === "1" && !configuredPath(envName)) {
    return { name: mockName, sha256: cacheKey({ mockName, version: 1 }), size: 0, version: "mock-v1" };
  }
  return null;
}

async function resolveExecutionDependencies(options) {
  const mock = process.env.ZCODE_VOICE_MOCK === "1";
  const senseVoice = mock
    ? { source: "mock", binary: { name: "mock-asr", sha256: cacheKey({ mock: "asr", version: 1 }), size: 0, version: "mock-v1" } }
    : await runtimeIdentity(await resolveSenseVoiceRuntime());
  const asrModel = await modelDependency("ZCODE_SENSEVOICE_MODEL", "sense-voice-small-q8_0.gguf", "mock-asr-model");
  const vadModel = await modelDependency("ZCODE_FSMN_VAD_MODEL", "fsmn-vad.gguf", "mock-vad-model");
  const asr = {
    ready: Boolean(senseVoice && asrModel && vadModel),
    runtime: senseVoice,
    model: asrModel,
    vadModel,
  };
  if (!options.speakerProfile) return { asr, speaker: null };
  const configuredCampp = configuredPath("ZCODE_CAMPP_COMMAND");
  const camppRuntime = mock && !configuredCampp
    ? null
    : await runtimeIdentity(await resolveCamppRuntime(), {
      companions: [/^onnxruntime\.dll$/i, /^libonnxruntime(?:\.[^.]+)*\.(?:dylib|so)$/i],
    });
  const camppModel = await modelDependency("ZCODE_CAMPP_MODEL", "cam++.onnx", "mock-campp-model");
  return {
    asr,
    speaker: {
      ready: Boolean(camppRuntime && camppModel),
      runtime: camppRuntime,
      model: camppModel,
    },
  };
}

async function prepareExecutionDependencies(options) {
  if (process.env.ZCODE_VOICE_MOCK === "1") return;
  requireSenseVoiceRuntime(await resolveSenseVoiceRuntime({ bootstrap: true }));
  await ensureModels({ dataRoot, includeOptional: options.speakerProfile });
}

function makeTaskId(cacheIdentity) {
  // This key represents the final user-visible projection. Expensive ASR and
  // speaker analysis have independent stage keys; profile matching and render
  // remain cheap projections over those cached results.
  const input = JSON.stringify(cacheIdentity);
  return `task_${crypto.createHash("sha256").update(input).digest("hex").slice(0, 20)}`;
}

function cacheKey(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contentFileIdentity(identity) {
  if (!identity || !/^[a-f0-9]{64}$/i.test(identity.sha256 || "")) return null;
  return {
    sha256: identity.sha256.toLowerCase(),
    size: Number(identity.size),
  };
}

function contentRuntimeIdentity(runtime) {
  const binary = contentFileIdentity(runtime?.binary);
  if (!binary) return null;
  const companions = (runtime.companions || [])
    .map((identity) => {
      const content = contentFileIdentity(identity);
      return content ? { name: identity.name, ...content } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
  return { binary, ...(companions.length ? { companions } : {}) };
}

function makeStageCacheKeys(cacheIdentity, dependencies) {
  // Stage caches are content-addressed. Paths, manifest labels, runtime source
  // (bundled/downloaded/configured), and the plugin release number must not
  // invalidate expensive inference when the actual bytes and pipeline version
  // are unchanged.
  const asrAnalysis = { ...cacheIdentity.asr };
  delete asrAnalysis.model;
  delete asrAnalysis.vadModel;
  const asrDependencies = dependencies?.asr?.ready ? {
    runtime: contentRuntimeIdentity(dependencies.asr.runtime),
    model: contentFileIdentity(dependencies.asr.model),
    vadModel: contentFileIdentity(dependencies.asr.vadModel),
  } : null;
  const asr = dependencies?.asr?.ready ? cacheKey({
    version: STAGE_CACHE_VERSION,
    source: cacheIdentity.source,
    asr: asrAnalysis,
    dependencies: asrDependencies,
  }) : null;
  const { matchThreshold, matchMargin, profilesFingerprint, ...speakerAnalysis } = cacheIdentity.speaker;
  delete speakerAnalysis.model;
  delete speakerAnalysis.adapter;
  const speakerDependencies = dependencies?.speaker?.ready ? {
    runtime: contentRuntimeIdentity(dependencies.speaker.runtime),
    model: contentFileIdentity(dependencies.speaker.model),
  } : null;
  return {
    asr,
    speaker: cacheIdentity.speaker.enabled && asr && dependencies?.speaker?.ready ? cacheKey({
      version: STAGE_CACHE_VERSION,
      asr,
      speaker: speakerAnalysis,
      dependencies: speakerDependencies,
    }) : null,
  };
}

async function reusableCompletedTask(task, cacheIdentity, options) {
  if (task?.status !== "completed") return false;
  const dependencies = await resolveExecutionDependencies(options);
  const keys = makeStageCacheKeys(cacheIdentity, dependencies);
  if (keys.asr && task.cache?.asr?.key !== keys.asr) return false;
  if (options.speakerProfile && keys.speaker && task.cache?.speaker?.key !== keys.speaker) return false;
  return true;
}

function stageCacheFile(stage, key) {
  if (!new Set(["asr", "speaker"]).has(stage) || !/^[a-f0-9]{64}$/.test(key || "")) {
    throw fail("阶段缓存标识无效。", "invalid_cache_key");
  }
  return path.join(cacheRoot, stage, `${key}.json`);
}

async function readStageCache(stage, key) {
  if (!key) return null;
  let value;
  try {
    value = await readJson(stageCacheFile(stage, key), null);
  } catch {
    return null;
  }
  if (value?.version !== STAGE_CACHE_VERSION || value?.stage !== stage || value?.key !== key) return null;
  return value.result || null;
}

async function writeStageCache(stage, key, result) {
  await writeJson(stageCacheFile(stage, key), {
    version: STAGE_CACHE_VERSION,
    stage,
    key,
    createdAt: new Date().toISOString(),
    result,
  });
}

function asrCheckpointFile(taskId) {
  requireTaskId(taskId);
  return path.join(cacheRoot, "checkpoints", `${taskId}.json`);
}

async function readAsrCheckpoint(taskId, asrKey) {
  if (!asrKey) return null;
  const valid = (checkpoint) => checkpoint?.version === ASR_CHECKPOINT_VERSION &&
    checkpoint?.asrKey === asrKey && Array.isArray(checkpoint.chunks);
  const checkpoint = await readJson(asrCheckpointFile(taskId), null).catch(() => null);
  if (valid(checkpoint)) return { ...checkpoint, sourceTaskId: taskId };

  // Profile matching and rendering intentionally have their own task
  // identities. If either changed while ZCode was stopped, recover the ASR
  // work by its content key instead of forcing completed chunks to run again.
  const directory = path.join(cacheRoot, "checkpoints");
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  let best = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const candidateTaskId = entry.name.slice(0, -5);
    if (candidateTaskId === taskId || !TASK_ID_PATTERN.test(candidateTaskId)) continue;
    const candidate = await readJson(path.join(directory, entry.name), null).catch(() => null);
    if (!valid(candidate)) continue;
    const score = [candidate.chunks.length, Date.parse(candidate.updatedAt || "") || 0];
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) {
      best = { checkpoint: candidate, sourceTaskId: candidateTaskId, score };
    }
  }
  return best ? { ...best.checkpoint, sourceTaskId: best.sourceTaskId } : null;
}

async function writeAsrCheckpoint(taskId, asrKey, checkpoint) {
  if (!asrKey) return;
  await writeJson(asrCheckpointFile(taskId), {
    version: ASR_CHECKPOINT_VERSION,
    taskId,
    asrKey,
    initialChunkSeconds: checkpoint.initialChunkSeconds,
    chunks: checkpoint.chunks,
    updatedAt: new Date().toISOString(),
  });
}

async function clearAsrCheckpoint(taskId) {
  await fs.rm(asrCheckpointFile(taskId), { force: true }).catch(() => {});
}

function makeLearningId() {
  return `learn_${crypto.randomBytes(8).toString("hex")}`;
}

class JsonlBackendClient {
  constructor(commandEnv, argsEnv, defaultName) {
    this.commandEnv = commandEnv;
    this.argsEnv = argsEnv;
    this.defaultName = defaultName;
    this.child = null;
    this.starting = null;
    this.idleTimer = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closeAfterPending = false;
  }

  async start() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const runtime = await resolveRuntimeCommand({
        pluginRoot,
        dataRoot,
        configured: process.env[this.commandEnv],
        defaultName: this.defaultName,
      });
      if (!runtime.exists) {
        await ensureDownloadedRuntime();
      }
      const resolvedRuntime = runtime.exists ? runtime : await resolveRuntimeCommand({
        pluginRoot,
        dataRoot,
        configured: process.env[this.commandEnv],
        defaultName: this.defaultName,
      });
      if (!resolvedRuntime.exists) throw fail(`找不到说话人运行时：${resolvedRuntime.command}。请安装或将平台 adapter 放入插件 bin/${process.platform}/${process.arch}/。`, "backend_not_configured");
      let extraArgs = [];
      if (process.env[this.argsEnv]) {
        extraArgs = JSON.parse(process.env[this.argsEnv]);
        if (!Array.isArray(extraArgs)) throw fail(`${this.argsEnv} 必须是 JSON 数组。`, "invalid_backend_args");
      }
      this.stderr = "";
      const child = spawn(resolvedRuntime.command, [...extraArgs.map(String), "--stdio"], {
        cwd: pluginRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(fail(message.error.message || "speaker backend error", message.error.code || "backend_failed"));
        else pending.resolve(message.result);
        if (this.closeAfterPending && !this.pending.size) this.close();
        else this.scheduleIdleClose();
      });
      child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
      child.on("error", (error) => {
        if (this.child === child) this.close(fail(error.message, "backend_not_found"));
      });
      child.on("exit", (code) => {
        if (this.child === child) this.close(fail(`speaker backend exited with code ${code}${this.stderr ? `: ${this.stderr.trim()}` : ""}`, "backend_failed"));
      });
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async call(method, params) {
    await this.start();
    if (!this.child) throw fail("speaker backend 未启动。", "backend_closed");
    this.closeAfterPending = false;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(error = null) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    if (child) {
      if (error) child.kill();
      else child.stdin.end();
    }
    for (const item of this.pending.values()) item.reject(error || fail("speaker backend closed", "backend_closed"));
    this.pending.clear();
    this.child = null;
    this.closeAfterPending = false;
  }

  release() {
    if (!this.child) return;
    if (this.pending.size) {
      this.closeAfterPending = true;
      return;
    }
    this.close();
  }

  scheduleIdleClose() {
    if (!this.child || this.pending.size || this.closeAfterPending) return;
    const idleMs = Math.max(1000, Number(process.env.ZCODE_CAMPP_IDLE_MS || 30000));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pending.size) this.close();
    }, idleMs);
    this.idleTimer.unref?.();
  }
}

const campp = new JsonlBackendClient("ZCODE_CAMPP_COMMAND", "ZCODE_CAMPP_ARGS", "campp-adapter");

async function configureCamppRuntime() {
  const configured = String(process.env.ZCODE_CAMPP_COMMAND || "").trim();
  if (process.env.ZCODE_VOICE_MOCK === "1" && (!configured || configured.startsWith("${"))) {
    return { command: "campp-adapter", source: "mock-disabled", exists: false };
  }
  return resolveCamppRuntime({ bootstrap: true });
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const runtimeDirectory = path.dirname(path.resolve(command));
    const environment = { ...process.env, ...(options.env || {}) };
    if (process.platform === "win32") {
      // ZCode Desktop is an Electron/Node process. Do not leak host runtime
      // flags into a native GGML executable launched from that process tree.
      for (const key of [
        "NODE_OPTIONS",
        "ELECTRON_RUN_AS_NODE",
        "ELECTRON_NO_ATTACH_CONSOLE",
        "ELECTRON_ENABLE_LOGGING",
        "ELECTRON_ENABLE_STACK_DUMPING",
      ]) delete environment[key];
      const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") || "PATH";
      environment[pathKey] = [runtimeDirectory, environment[pathKey]].filter(Boolean).join(path.delimiter);
    }
    const child = spawn(command, args, {
      // The official SenseVoice CLI is normally run from its runtime folder.
      // Keep that working directory so native sidecar assets/DLL lookup match
      // the verified manual invocation on Windows.
      cwd: options.cwd || runtimeDirectory,
      windowsHide: true,
      shell: false,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => reject(fail(`${command} 无法启动：${error.message}`, "backend_not_found")));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        const windowsHint = process.platform === "win32" && code === 3221226505
          ? "；Windows GGML 内存上下文初始化失败，已隔离 Electron/Node 环境变量，请检查 runtime 与模型路径"
          : "";
        const error = fail(`${command} 运行失败 (code=${code}, signal=${signal})${windowsHint}${stderr ? `: ${stderr.trim()}` : ""}`, "backend_failed");
        error.nativeExitCode = code;
        error.nativeSignal = signal;
        error.nativeStderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function runSenseVoice(audioPath, options = {}, onStage = null) {
  if (process.env.ZCODE_VOICE_MOCK === "1") {
    const mockChunkCount = Math.max(0, Math.floor(Number(process.env.ZCODE_VOICE_MOCK_CHUNKS || 0)));
    if (mockChunkCount) {
      const checkpointChunks = Array.isArray(options.checkpoint?.chunks) ? [...options.checkpoint.chunks] : [];
      const byOffset = new Map(checkpointChunks.map((chunk) => [Number(chunk.offset), chunk]));
      const results = [];
      for (let index = 0; index < mockChunkCount; index += 1) {
        let record = byOffset.get(index);
        if (!record) {
          if (process.env.ZCODE_VOICE_ASR_CALL_LOG) await fs.appendFile(process.env.ZCODE_VOICE_ASR_CALL_LOG, `chunk:${index + 1}\n`);
          const text = `${process.env.ZCODE_VOICE_MOCK_TEXT || "模拟分块"}${index + 1}`;
          record = {
            offset: index,
            chunkSeconds: 1,
            result: {
              text,
              segments: [{ id: "seg_0001", start: index, end: index + 1, text, speaker: "unknown", confidence: null }],
              backend: "mock",
              model: "mock",
            },
          };
          byOffset.set(index, record);
          await options.onCheckpoint?.({
            initialChunkSeconds: 1,
            chunks: [...byOffset.values()].sort((left, right) => left.offset - right.offset),
          });
        }
        results.push(record.result);
        const segments = reindexSegments(results.flatMap((result) => result.segments || []));
        await options.onChunk?.({
          text: results.map((result) => result.text).join("\n"),
          segments,
          completedChunks: results.length,
          totalChunks: mockChunkCount,
          chunkSeconds: 1,
        });
        const failAfter = Math.max(0, Math.floor(Number(process.env.ZCODE_VOICE_MOCK_FAIL_AFTER_CHUNKS || 0)));
        const failMarker = configuredPath("ZCODE_VOICE_MOCK_FAIL_ONCE_FILE");
        if (failAfter && results.length >= failAfter && failMarker && !(await isFile(failMarker))) {
          await fs.writeFile(failMarker, "failed-once\n", { mode: PRIVATE_FILE_MODE });
          const error = fail("模拟分块转写中断。", "mock_chunk_interrupted");
          error.completedChunks = results.length;
          error.totalChunks = mockChunkCount;
          throw error;
        }
      }
      return {
        text: results.map((result) => result.text).join("\n"),
        segments: reindexSegments(results.flatMap((result) => result.segments || [])),
        backend: "mock",
        model: "mock",
        warnings: checkpointChunks.length ? [`已从 ${checkpointChunks.length} 个本地 ASR checkpoint 分块继续。`] : [],
      };
    }
    if (process.env.ZCODE_VOICE_ASR_CALL_LOG) await fs.appendFile(process.env.ZCODE_VOICE_ASR_CALL_LOG, "transcribe\n");
    const delayMs = Math.max(0, Number(process.env.ZCODE_VOICE_MOCK_DELAY_MS || 0));
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const failurePattern = process.env.ZCODE_VOICE_MOCK_FAIL_PATTERN;
    if (failurePattern && audioPath.includes(failurePattern)) throw fail("模拟转写失败。", "mock_transcription_failed");
    return { text: process.env.ZCODE_VOICE_MOCK_TEXT || "这是本地语音引擎的测试转写结果。", backend: "mock", model: "mock" };
  }

  const runtime = await resolveSenseVoiceRuntime({ bootstrap: true });
  requireSenseVoiceRuntime(runtime);
  let modelReady = true;
  if (!options.dependenciesReady) {
    await onStage?.("preparing_models", 10, "正在准备本地模型；首次使用可能需要下载。", { modelReady: false });
    const modelBootstrap = await ensureModels({ dataRoot, includeOptional: options.speakerProfile !== false });
    modelReady = modelBootstrap.ready;
  }
  await onStage?.("transcribing", 35, "模型已准备，正在进行本地转写。", { modelReady });
  const modelInfo = await resolveModel("ZCODE_SENSEVOICE_MODEL", "sense-voice-small-q8_0.gguf");
  if (!modelInfo.exists) {
    throw fail(`找不到 SenseVoice GGUF 模型：${modelInfo.path}。请将模型放入本地模型目录或配置 ZCODE_SENSEVOICE_MODEL。`, "sensevoice_not_configured");
  }
  const model = modelInfo.path;
  const binary = runtime.command;
  const vadInfo = await resolveModel("ZCODE_FSMN_VAD_MODEL", "fsmn-vad.gguf");
  const runSingle = async (inputPath, offsetSeconds = 0, runOptions = {}) => {
    const args = ["-m", model, "-a", inputPath];
    if (vadInfo.exists) args.push("--vad", vadInfo.path, "--vad-maxseg", String(runOptions.vadMaxSegMs || process.env.ZCODE_VOICE_VAD_MAXSEG_MS || DEFAULT_VAD_MAX_SEGMENT_MS));
    const result = await runCommand(binary, args);
    const device = "cpu";
    const stdout = result.stdout.trim();
    const raw = `${result.stdout}\n${result.stderr}`.trim();
    let parsed = null;
    if (stdout.startsWith("{") || stdout.startsWith("[")) {
      try { parsed = JSON.parse(stdout); } catch { parsed = null; }
    }
    const rawSegments = Array.isArray(parsed) ? parsed : parsed?.segments;
    const segments = Array.isArray(rawSegments) ? rawSegments.map((segment, index) => ({
      id: `seg_${String(index + 1).padStart(4, "0")}`,
      start: Number.isFinite(segment.start) ? segment.start : null,
      end: Number.isFinite(segment.end) ? segment.end : null,
      text: String(segment.text || "").trim(),
      speaker: segment.speaker || "unknown",
      confidence: Number.isFinite(segment.confidence) ? segment.confidence : null,
    })).filter((segment) => segment.text) : null;
    const parsedOutput = parsed
      ? { text: String(parsed?.text || "").trim(), segments }
      : parseSenseVoiceOutput(raw);
    const offsetSegments = Array.isArray(parsedOutput.segments)
      ? parsedOutput.segments.map((segment, index) => ({
        ...segment,
        id: `seg_${String(index + 1).padStart(4, "0")}`,
        start: Number.isFinite(segment.start) ? segment.start + offsetSeconds : null,
        end: Number.isFinite(segment.end) ? segment.end + offsetSeconds : null,
      }))
      : null;
    const text = String(parsedOutput.text || offsetSegments?.map((segment) => segment.text).join(" ") || raw).trim();
    if (!text) throw fail("SenseVoice 没有返回文字结果。", "empty_transcription");
    return {
      text,
      segments: offsetSegments,
      backend: "qwen-audio-sensevoice",
      model,
      vadModel: vadInfo.exists ? vadInfo.path : null,
      device,
    };
  };

  const savedChunks = Array.isArray(options.checkpoint?.chunks) ? options.checkpoint.chunks : [];
  if (!savedChunks.length) {
    try {
      return await runSingle(audioPath);
    } catch (error) {
      if (!isGgmlMemoryCrashError(error)) throw error;
    }
  }
  {
    await onStage?.("transcribing", 36, "长录音触发本地内存保护，正在自动分块重试。", { fallback: "chunked" });
    const initialChunkSeconds = Number(options.checkpoint?.initialChunkSeconds) || chooseChunkSeconds();
    const split = await splitAudio({ audioPath, dataRoot, taskId: options.taskId, chunkSeconds: initialChunkSeconds });
    const allSegments = [];
    const allTexts = [];
    let completedChunks = 0;
    let plannedChunks = split.chunks.length;
    let firstResult = null;
    const checkpointChunks = new Map(savedChunks.map((chunk) => [
      `${Number(chunk.offset)}:${Number(chunk.chunkSeconds)}`,
      chunk,
    ]));

    const emitChunk = async (result, chunk, { checkpoint = true } = {}) => {
      if (!firstResult) firstResult = result;
      const segments = result.segments?.length
        ? result.segments
        : [{ start: chunk.offset, end: null, text: result.text, speaker: "unknown", confidence: null }];
      allSegments.push(...segments);
      allTexts.push(result.text);
      completedChunks += 1;
      if (checkpoint) {
        checkpointChunks.set(`${Number(chunk.offset)}:${Number(chunk.chunkSeconds)}`, {
          offset: Number(chunk.offset),
          chunkSeconds: Number(chunk.chunkSeconds),
          result,
        });
        await options.onCheckpoint?.({
          initialChunkSeconds,
          chunks: [...checkpointChunks.values()].sort((left, right) => left.offset - right.offset),
        });
      }
      const stableSegments = reindexSegments(allSegments);
      const percent = 38 + Math.floor((completedChunks / Math.max(1, plannedChunks)) * 28);
      await onStage?.("transcribing", percent, `正在转写第 ${completedChunks}/${plannedChunks} 个音频分块。`, {
        fallback: "chunked",
        chunk: completedChunks,
        chunks: plannedChunks,
      });
      await options.onChunk?.({
        text: allTexts.join("\n"),
        segments: stableSegments,
        completedChunks,
        totalChunks: plannedChunks,
        chunkSeconds: chunk.chunkSeconds,
      });
    };

    const processChunk = async (chunk, depth = 0) => {
      const saved = checkpointChunks.get(`${Number(chunk.offset)}:${Number(chunk.chunkSeconds)}`);
      if (saved?.result?.text) {
        await emitChunk(saved.result, chunk, { checkpoint: false });
        return;
      }
      try {
        const result = await runSingle(chunk.path, chunk.offset, {
          // Smaller VAD windows reduce the peak feature/graph allocation on
          // machines that already needed the long-audio fallback.
          vadMaxSegMs: DEFAULT_VAD_MAX_SEGMENT_MS,
        });
        await emitChunk(result, chunk);
        return;
      } catch (chunkError) {
        if (!isGgmlMemoryCrashError(chunkError) || chunk.chunkSeconds <= 60 || depth >= 2) {
          chunkError.partialText = allTexts.join("\n");
          chunkError.partialSegments = reindexSegments(allSegments);
          chunkError.completedChunks = completedChunks;
          chunkError.totalChunks = plannedChunks;
          throw chunkError;
        }
        const smallerChunkSeconds = Math.max(60, Math.floor(chunk.chunkSeconds / 2));
        await onStage?.("transcribing", 38 + Math.floor((completedChunks / Math.max(1, plannedChunks)) * 28), `第 ${completedChunks + 1} 个分块内存仍不足，正在切成更小分块重试。`, {
          fallback: "chunked",
          chunk: completedChunks + 1,
          chunks: plannedChunks,
          retryChunkSeconds: smallerChunkSeconds,
        });
        const nested = await splitAudio({
          audioPath: chunk.path,
          dataRoot,
          taskId: `${options.taskId || "audio"}-retry-${depth}`,
          chunkSeconds: smallerChunkSeconds,
        });
        plannedChunks += nested.chunks.length - 1;
        try {
          for (const subChunk of nested.chunks) {
            await processChunk({
              ...subChunk,
              offset: chunk.offset + subChunk.offset,
              chunkSeconds: smallerChunkSeconds,
            }, depth + 1);
            await waitForNativeRelease();
          }
        } finally {
          await nested.cleanup();
        }
      }
    };

    try {
      for (const chunk of split.chunks) {
        await processChunk({ ...chunk, chunkSeconds: initialChunkSeconds });
        await waitForNativeRelease();
      }
      return {
        ...firstResult,
        text: allTexts.filter(Boolean).join("\n"),
        segments: reindexSegments(allSegments),
        warnings: [`长录音已自动分为 ${completedChunks} 个分块处理（初始分块 ${initialChunkSeconds} 秒，内存不足时自动缩小）。`],
      };
    } finally {
      await split.cleanup();
    }
  }
}

const GB = 1024 ** 3;

function chooseChunkSeconds() {
  const configured = Number(process.env.ZCODE_VOICE_CHUNK_SECONDS);
  if (Number.isFinite(configured) && configured >= 60) return Math.min(300, Math.floor(configured));
  const freeMemory = os.freemem();
  if (freeMemory < 6 * GB) return 90;
  if (freeMemory < 10 * GB) return 120;
  return 300;
}

function isGgmlMemoryCrashError(error) {
  return (error?.nativeExitCode === 3221226505 || error?.nativeExitCode === -1073740791)
    && /GGML_ASSERT\(ctx\.mem_buffer != NULL\)|mem_buffer/i.test(error.nativeStderr || error.message || "");
}

function reindexSegments(segments) {
  return segments.map((segment, index) => ({
    ...segment,
    id: `seg_${String(index + 1).padStart(4, "0")}`,
  }));
}

async function waitForNativeRelease() {
  const configured = Number(process.env.ZCODE_VOICE_PROCESS_RECLAIM_MS);
  const delay = Number.isFinite(configured) ? Math.max(0, configured) : 500;
  if (!delay) return;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function makeSegments(text) {
  return [{ id: "seg_0001", start: 0, end: null, text, speaker: "unknown", confidence: null }];
}

function normalizeClusterId(value) {
  if (Number.isInteger(value) && value >= 0) return `cluster_${value}`;
  const text = String(value ?? "").trim();
  if (!text || text === "unknown") return null;
  if (/^\d+$/.test(text)) return `cluster_${text}`;
  return /^cluster_[A-Za-z0-9_-]+$/.test(text) ? text : null;
}

function segmentCluster(segment) {
  return normalizeClusterId(segment?.speakerCluster)
    || (String(segment?.speaker || "").startsWith("cluster_") ? normalizeClusterId(segment.speaker) : null);
}

function normalizedOrNull(value) {
  try {
    return Array.isArray(value) ? normalize(value) : null;
  } catch {
    return null;
  }
}

function normalizeSpeakerClusters(result) {
  if (!Array.isArray(result?.clusters)) return [];
  return result.clusters.map((summary, index) => {
    const clusterId = normalizeClusterId(summary?.clusterId ?? summary?.id ?? index);
    if (!clusterId) return null;
    const prototype = normalizedOrNull(summary?.prototype);
    return {
      clusterId,
      size: Math.max(0, Number(summary?.size ?? summary?.windowCount ?? 0) || 0),
      windowCount: Math.max(0, Number(summary?.windowCount ?? summary?.size ?? 0) || 0),
      voicedSeconds: Number.isFinite(summary?.voicedSeconds) ? summary.voicedSeconds : null,
      canonicalKey: typeof summary?.canonicalKey === "string" ? summary.canonicalKey : null,
      ...(prototype ? { prototype } : {}),
    };
  }).filter(Boolean);
}

function publicSpeakerAnalysis(analysis) {
  if (!analysis) return null;
  return {
    status: analysis.status,
    algorithmVersion: analysis.algorithmVersion || null,
    metrics: analysis.metrics || {},
    clusters: (analysis.clusters || []).map((cluster) => ({
      clusterId: cluster.clusterId,
      size: cluster.size,
      windowCount: cluster.windowCount,
      voicedSeconds: cluster.voicedSeconds,
    })),
    ...(analysis.code ? { code: analysis.code } : {}),
  };
}

function embeddingEntries(result, segments) {
  if (!Array.isArray(result?.embeddings)) return [];
  return result.embeddings.map((entry, index) => {
    if (Array.isArray(entry)) return { segmentId: segments[index]?.id, embedding: entry };
    return {
      segmentId: entry.segmentId || entry.id || segments[index]?.id,
      embedding: entry.embedding || entry.vector,
    };
  }).filter((entry) => entry.segmentId && Array.isArray(entry.embedding));
}

function profileFingerprint(profiles) {
  // Matching depends on identity, display name and prototype bytes. Hash those
  // inputs directly so two updates within the same clock millisecond cannot
  // accidentally reuse a stale user-visible projection.
  const matchInputs = (profiles.profiles || [])
    .map(({ personId, name, prototype }) => ({ personId, name, prototype }))
    .sort((left, right) => String(left.personId).localeCompare(String(right.personId)));
  return crypto.createHash("sha256").update(JSON.stringify(matchInputs)).digest("hex").slice(0, 16);
}

function matchSpeakerClusters(segments, clusters, profiles) {
  const usableProfiles = profiles.profiles.filter((profile) => Array.isArray(profile.prototype));
  const threshold = Number(process.env.ZCODE_CAMPP_MATCH_THRESHOLD || 0.62);
  const margin = Number(process.env.ZCODE_CAMPP_MATCH_MARGIN || 0.05);
  const matches = new Map();

  for (const cluster of clusters) {
    const prototype = normalizedOrNull(cluster.prototype);
    if (!prototype || !usableProfiles.length) continue;
    const ranked = usableProfiles.map((profile) => ({
      profile,
      score: cosine(prototype, normalizedOrNull(profile.prototype)),
    })).filter((item) => item.score !== null).sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const second = ranked[1];
    if (best && best.score >= threshold && (!second || best.score - second.score >= margin)) {
      matches.set(cluster.clusterId, best);
    }
  }

  return segments.map((segment) => {
    const speakerCluster = segmentCluster(segment);
    const best = speakerCluster ? matches.get(speakerCluster) : null;
    if (!best) return {
      ...segment,
      ...(speakerCluster ? { speakerCluster, speaker: speakerCluster, speakerMatch: "cluster" } : {}),
    };
    return {
      ...segment,
      speakerCluster,
      speaker: best.profile.name,
      personId: best.profile.personId,
      speakerMatch: "known",
      speakerConfidence: best.score,
    };
  });
}

async function matchKnownSpeakersLegacy(audioPath, segments, modelPath, profiles) {
  const usableProfiles = profiles.profiles.filter((profile) => Array.isArray(profile.prototype));
  if (!usableProfiles.length || !segments.length) return segments;
  const result = await campp.call("embed_segments", {
    audioPath,
    segmentIds: segments.map((segment) => segment.id),
    segments,
    model: modelPath,
  });
  const embeddings = new Map(embeddingEntries(result, segments).map((entry) => [entry.segmentId, normalize(entry.embedding)]));
  const threshold = Number(process.env.ZCODE_CAMPP_MATCH_THRESHOLD || 0.62);
  const margin = Number(process.env.ZCODE_CAMPP_MATCH_MARGIN || 0.05);
  return segments.map((segment) => {
    const embedding = embeddings.get(segment.id);
    if (!embedding) return segment;
    const ranked = usableProfiles.map((profile) => ({
      profile,
      score: cosine(embedding, normalizedOrNull(profile.prototype)),
    })).filter((item) => item.score !== null).sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const second = ranked[1];
    if (!best || best.score < threshold || (second && best.score - second.score < margin)) return segment;
    return { ...segment, speaker: best.profile.name, personId: best.profile.personId, speakerMatch: "known", speakerConfidence: best.score };
  });
}

async function analyzeSpeakers(audioPath, segments) {
  const runtime = await configureCamppRuntime();
  if (!runtime.exists) {
    const configured = String(process.env.ZCODE_CAMPP_COMMAND || "").trim();
    if (configured && !configured.startsWith("${")) throw fail(`找不到 CAM++ adapter：${runtime.command}。`, "backend_not_configured");
    const analysis = { status: "not_configured", algorithmVersion: null, metrics: {}, clusters: [] };
    return { segments, privateAnalysis: null, publicAnalysis: publicSpeakerAnalysis(analysis) };
  }
  const modelInfo = await resolveModel("ZCODE_CAMPP_MODEL", "cam++.onnx");
  if (!modelInfo.exists && process.env.ZCODE_VOICE_MOCK !== "1") {
    const analysis = { status: "not_configured", algorithmVersion: null, metrics: {}, clusters: [] };
    return { segments, privateAnalysis: null, publicAnalysis: publicSpeakerAnalysis(analysis) };
  }

  try {
    const result = await campp.call("diarize", {
      audioPath,
      segments,
      model: modelInfo.exists ? modelInfo.path : null,
    });
    if (!Array.isArray(result?.segments)) throw fail("CAM++ adapter 没有返回 segments。", "invalid_speaker_result");
    const clusters = normalizeSpeakerClusters(result);
    const algorithmVersion = String(result.algorithmVersion || (Array.isArray(result.clusters) ? SPEAKER_PIPELINE_VERSION : "speaker-v1"));
    const diarizedSegments = result.segments.map((segment) => {
      const speakerCluster = segmentCluster(segment);
      return { ...segment, ...(speakerCluster ? { speakerCluster } : {}) };
    });
    const matchedSegments = algorithmVersion === SPEAKER_PIPELINE_VERSION
      ? diarizedSegments
      : await matchKnownSpeakersLegacy(
        audioPath,
        diarizedSegments,
        modelInfo.exists ? modelInfo.path : null,
        await getProfiles(),
      );
    const privateAnalysis = {
      status: "completed",
      algorithmVersion,
      metrics: result.metrics && typeof result.metrics === "object" ? result.metrics : {},
      clusters,
    };
    return {
      segments: matchedSegments,
      privateAnalysis,
      publicAnalysis: publicSpeakerAnalysis(privateAnalysis),
      cacheable: algorithmVersion === SPEAKER_PIPELINE_VERSION,
    };
  } finally {
    campp.release();
  }
}

async function transcribe(params, profileSnapshot = null) {
  const audioPath = params?.audioPath;
  if (!audioPath || !path.isAbsolute(audioPath)) throw fail("audioPath 必须是绝对路径。", "invalid_audio_path");
  const stat = await fs.stat(audioPath).catch(() => null);
  if (!stat?.isFile()) throw fail(`找不到音频文件：${audioPath}`, "audio_not_found");

  await ensureDirs();
  const options = {
    language: params.language || "auto",
    outputFormat: params.outputFormat || "markdown",
    speakerProfile: params.speakerProfile !== false,
  };
  const profiles = options.speakerProfile ? (profileSnapshot || await getProfiles()) : { version: 1, profiles: [] };
  const cacheIdentity = makeCacheIdentity(audioPath, stat, options, profileFingerprint(profiles));
  const taskId = params.taskId ? requireTaskId(params.taskId) : makeTaskId(cacheIdentity);
  const cached = await readJson(taskFile(taskId));
  if (cached?.status === "completed" && !params.taskId && await reusableCompletedTask(cached, cacheIdentity, options)) {
    return { ...cached, cacheHit: true };
  }

  await updateTaskStatus(taskId, "running", { stage: "preparing_models", percent: 1, message: "正在准备本地运行时和模型。" });
  let dependencies = await resolveExecutionDependencies(options);
  let stageKeys = makeStageCacheKeys(cacheIdentity, dependencies);
  if (!stageKeys.asr || (options.speakerProfile && !stageKeys.speaker)) {
    await prepareExecutionDependencies(options);
    dependencies = await resolveExecutionDependencies(options);
    stageKeys = makeStageCacheKeys(cacheIdentity, dependencies);
  }
  let cachedAsr = await readStageCache("asr", stageKeys.asr);
  let asrCacheHit = Boolean(cachedAsr && typeof cachedAsr.text === "string" && cachedAsr.text.trim());
  let cachedSpeaker = options.speakerProfile ? await readStageCache("speaker", stageKeys.speaker) : null;
  let speakerCacheReady = Boolean(
    cachedSpeaker?.privateAnalysis?.algorithmVersion === SPEAKER_PIPELINE_VERSION && Array.isArray(cachedSpeaker.segments),
  );

  if (!asrCacheHit && process.env.ZCODE_VOICE_MOCK !== "1") requireSenseVoiceRuntime(await resolveSenseVoiceRuntime());
  await updateTaskStatus(taskId, "running", { stage: "preparing_audio", percent: 5, message: "正在检查和转换音频。" });
  const needsPreparedAudio = !asrCacheHit || (options.speakerProfile && !speakerCacheReady);
  const prepared = process.env.ZCODE_VOICE_MOCK === "1" || !needsPreparedAudio
    ? { path: audioPath, converted: false, cleanup: async () => {} }
    : await prepareAudio({ audioPath, dataRoot, taskId });
  try {
    let asr = cachedAsr;
    let resumedCheckpointTaskId = null;
    if (asrCacheHit) {
      await updateTaskStatus(taskId, "running", { stage: "transcribing", percent: 65, message: "已复用本地转写缓存。" });
      await clearAsrCheckpoint(taskId);
    } else {
      const checkpoint = await readAsrCheckpoint(taskId, stageKeys.asr);
      resumedCheckpointTaskId = checkpoint?.sourceTaskId || null;
      asr = await runSenseVoice(prepared.path, {
        ...options,
        taskId,
        dependenciesReady: process.env.ZCODE_VOICE_MOCK !== "1",
        checkpoint,
        onCheckpoint: (value) => writeAsrCheckpoint(taskId, stageKeys.asr, value),
        onChunk: async (partial) => {
          const partialTask = {
            version: 1,
            taskId,
            audioPath,
            text: partial.text,
            segments: partial.segments,
            completedChunks: partial.completedChunks,
            totalChunks: partial.totalChunks,
            updatedAt: new Date().toISOString(),
          };
          await updateTaskStatus(taskId, "running", {
            stage: "transcribing",
            percent: 38 + Math.floor((partial.completedChunks / Math.max(1, partial.totalChunks)) * 28),
            message: `已完成 ${partial.completedChunks}/${partial.totalChunks} 个音频分块，正在继续处理。`,
          }, {
            partial: {
              resumable: Boolean(stageKeys.asr),
              completedChunks: partial.completedChunks,
              totalChunks: partial.totalChunks,
              chunkSeconds: partial.chunkSeconds,
            },
            partialArtifacts: {
              json: path.join(artifactDir(taskId), "partial-transcript.json"),
              text: path.join(artifactDir(taskId), "partial-transcript.txt"),
            },
            text: partial.text,
            segments: partial.segments,
            partialAvailable: true,
          });
          await writeJson(path.join(artifactDir(taskId), "partial-transcript.json"), partialTask);
          await writeText(path.join(artifactDir(taskId), "partial-transcript.txt"), `${partial.text || ""}\n`);
        },
      }, async (stage, percent, message, extra) => {
        await updateTaskStatus(taskId, "running", { stage, percent, message }, extra);
      });
      // Model/runtime bootstrap can complete while the first task is already
      // running. Re-resolve before writing so the first result lands directly
      // under the final SHA-based key rather than a provisional identity.
      dependencies = await resolveExecutionDependencies(options);
      stageKeys = makeStageCacheKeys(cacheIdentity, dependencies);
      if (!stageKeys.asr) throw fail("ASR 模型或 runtime 身份不可用，无法安全写入阶段缓存。", "dependency_identity_unavailable");
      await writeStageCache("asr", stageKeys.asr, asr);
      await clearAsrCheckpoint(taskId);
      if (resumedCheckpointTaskId && resumedCheckpointTaskId !== taskId) {
        await clearAsrCheckpoint(resumedCheckpointTaskId);
      }
    }
    if (options.speakerProfile) {
      dependencies = await resolveExecutionDependencies(options);
      stageKeys = makeStageCacheKeys(cacheIdentity, dependencies);
      cachedSpeaker = await readStageCache("speaker", stageKeys.speaker);
      speakerCacheReady = Boolean(
        cachedSpeaker?.privateAnalysis?.algorithmVersion === SPEAKER_PIPELINE_VERSION && Array.isArray(cachedSpeaker.segments),
      );
    }
    const baseSegments = asr.segments?.length ? asr.segments : makeSegments(asr.text);
    let segments = baseSegments;
    let privateSpeakerAnalysis = null;
    let speakerAnalysis = { status: options.speakerProfile ? "not_configured" : "disabled", algorithmVersion: null, metrics: {}, clusters: [] };
    let speakerCacheHit = false;
    const speakerWarnings = [];
    if (options.speakerProfile) {
      await updateTaskStatus(taskId, "running", { stage: "identifying_speakers", percent: 70, message: "正在区分和匹配说话人。" });
      try {
        let analyzed;
        if (speakerCacheReady) {
          speakerCacheHit = true;
          analyzed = {
            segments: cachedSpeaker.segments,
            privateAnalysis: cachedSpeaker.privateAnalysis,
            publicAnalysis: publicSpeakerAnalysis(cachedSpeaker.privateAnalysis),
            cacheable: true,
          };
        } else {
          analyzed = await analyzeSpeakers(prepared.path, baseSegments);
          if (analyzed.cacheable && analyzed.privateAnalysis) {
            await writeStageCache("speaker", stageKeys.speaker, {
              segments: analyzed.segments,
              privateAnalysis: analyzed.privateAnalysis,
            });
          }
        }
        segments = analyzed.privateAnalysis?.algorithmVersion === SPEAKER_PIPELINE_VERSION
          ? matchSpeakerClusters(analyzed.segments, analyzed.privateAnalysis.clusters || [], profiles)
          : analyzed.segments;
        privateSpeakerAnalysis = analyzed.privateAnalysis;
        speakerAnalysis = { ...analyzed.publicAnalysis, cacheHit: speakerCacheHit };
      } catch (error) {
        campp.release();
        speakerAnalysis = {
          status: "failed",
          algorithmVersion: SPEAKER_PIPELINE_VERSION,
          metrics: {},
          clusters: [],
          code: error.code || "speaker_analysis_failed",
        };
        speakerWarnings.push(`说话人分析失败，已保留完整转写文字：${sanitizeErrorMessage(error.message)}`);
      }
    }
    // Resolve speaker state after ASR/model preparation. The first-run model
    // bootstrap may have changed both paths since the task began.
    const camppRuntime = options.speakerProfile ? await resolveCamppRuntime() : { exists: false, source: "disabled" };
    const camppModel = options.speakerProfile ? await resolveModel("ZCODE_CAMPP_MODEL", "cam++.onnx") : { exists: false, source: "disabled", path: null };
    const speakerAvailable = options.speakerProfile && (speakerAnalysis.status === "completed" || (camppRuntime.exists && camppModel.exists));
    const task = {
      taskId,
      status: "completed",
      createdAt: cached?.createdAt || new Date().toISOString(),
      audioPath,
      audio: { size: stat.size, mtimeMs: stat.mtimeMs },
      options,
      cacheIdentity,
      cache: {
        dependencies,
        asr: { key: stageKeys.asr, hit: asrCacheHit },
        speaker: options.speakerProfile ? { key: stageKeys.speaker, hit: speakerCacheHit } : null,
      },
      backend: {
        asr: asr.backend,
        asrModel: dependencies.asr?.model?.name || path.basename(String(asr.model || "")) || null,
        speaker: options.speakerProfile ? (speakerAvailable ? "available" : "not_configured") : "disabled",
        speakerModelExists: camppModel.exists,
      },
      text: asr.text,
      segments,
      speakerAnalysis,
      ...(privateSpeakerAnalysis ? { _speakerAnalysis: privateSpeakerAnalysis } : {}),
      revision: Math.max(1, Number(cached?.revision || 0) + 1),
      progress: { stage: "completed", percent: 100, message: "本地转写已完成。" },
      corrections: [],
      learningIds: [],
      warnings: [
        ...(asr.device === "cpu-fallback" ? ["Metal 初始化失败，已自动回退到 CPU。"] : []),
        ...(asr.warnings || []),
        ...speakerWarnings,
        ...(!options.speakerProfile || speakerAvailable ? [] : ["CAM++ adapter 或模型尚未配置，当前结果只包含转写文字，无法自动匹配注册说话人。"]),
        ...(prepared.converted ? ["录音已在本地临时转换为 16kHz 单声道 WAV，任务结束后已清理。"] : []),
      ],
    };
    task.artifacts = await writeArtifacts(task);
    await writeJson(taskFile(taskId), task);
    await writeJson(path.join(cacheRoot, `${taskId}.json`), { taskId, createdAt: task.createdAt });
    return task;
  } finally {
    await prepared.cleanup();
  }
}

function taskOptions(params) {
  return {
    language: params?.language || "auto",
    outputFormat: params?.outputFormat || "markdown",
    speakerProfile: params?.speakerProfile !== false,
  };
}

function startTaskResponse(task, { cacheHit = false } = {}) {
  return {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
    audio: task.audio || null,
    progress: task.progress || { stage: task.status, percent: 0 },
    artifacts: task.artifacts || null,
    partialArtifacts: task.partialArtifacts || null,
    partialAvailable: Boolean(task.partialAvailable || task.segments?.length),
    segmentCount: task.segments?.length || 0,
    totalCharacters: task.text?.length || 0,
    preview: task.text ? task.text.slice(0, 1200) : "",
    warnings: task.warnings || [],
    ...(cacheHit ? { cacheHit: true } : {}),
  };
}

async function startTranscription(params) {
  const audioPath = params?.audioPath;
  if (!audioPath || !path.isAbsolute(audioPath)) throw fail("audioPath 必须是绝对路径。", "invalid_audio_path");
  const stat = await fs.stat(audioPath).catch(() => null);
  if (!stat?.isFile()) throw fail(`找不到音频文件：${audioPath}`, "audio_not_found");
  const options = taskOptions(params);
  const profiles = options.speakerProfile ? await getProfiles() : { version: 1, profiles: [] };
  const cacheIdentity = makeCacheIdentity(audioPath, stat, options, profileFingerprint(profiles));
  const taskId = makeTaskId(cacheIdentity);
  if (startOperations.has(taskId)) return startOperations.get(taskId);
  const operation = (async () => {
    let existing = await readJson(taskFile(taskId), null);
    if (existing?.status === "completed" && await reusableCompletedTask(existing, cacheIdentity, options)) {
      return startTaskResponse(existing, { cacheHit: true });
    }
    if (activeTasks.has(taskId)) return startTaskResponse(existing || { taskId, status: "queued" });
    const staleMs = configuredDuration("ZCODE_VOICE_TASK_LOCK_STALE_MS", 120_000, 10_000, 3_600_000);
    let taskLease = null;
    for (let attempt = 0; attempt < 4 && !taskLease; attempt += 1) {
      taskLease = await tryAcquireLease(taskRunLockFile(taskId), { staleMs });
      if (!taskLease && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!taskLease) {
      for (let attempt = 0; attempt < 10 && !existing; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        existing = await readJson(taskFile(taskId), null);
      }
      return startTaskResponse(existing || { taskId, status: "queued" });
    }
    let enqueued = false;
    try {
      // The previous owner may have completed between our first read and lease
      // acquisition. Re-check before replacing a reusable result with queued.
      existing = await readJson(taskFile(taskId), null);
      if (existing?.status === "completed" && await reusableCompletedTask(existing, cacheIdentity, options)) {
        return startTaskResponse(existing, { cacheHit: true });
      }
      const task = {
        taskId,
        status: "queued",
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        audioPath,
        audio: { size: stat.size, mtimeMs: stat.mtimeMs },
        options,
        cacheIdentity,
        revision: Math.max(0, Number(existing?.revision || 0)),
        progress: { stage: "queued", percent: 0, message: "任务已创建，等待本地引擎启动。" },
        warnings: [],
        ...(existing?.partial ? { partial: existing.partial } : {}),
        ...(existing?.partialArtifacts ? { partialArtifacts: existing.partialArtifacts } : {}),
        ...(existing?.partialAvailable ? { partialAvailable: true } : {}),
        ...(existing?.partialAvailable && typeof existing.text === "string" ? { text: existing.text } : {}),
        ...(existing?.partialAvailable && Array.isArray(existing.segments) ? { segments: existing.segments } : {}),
      };
      await writeJson(taskFile(taskId), task);
      activeTasks.set(taskId, { status: "queued" });
      heavyQueue.push({ taskId, params: { ...params, taskId }, profiles, taskLease });
      enqueued = true;
      void drainHeavyQueue();
      return startTaskResponse(task);
    } finally {
      if (!enqueued) await taskLease.release();
    }
  })();
  startOperations.set(taskId, operation);
  try {
    return await operation;
  } finally {
    startOperations.delete(taskId);
  }
}

async function runHeavyTask({ taskId, params, profiles, taskLease }) {
  let engineLease = null;
  try {
    engineLease = await acquireLease(path.join(dataRoot, "engine.run.lock"), {
      staleMs: configuredDuration("ZCODE_VOICE_ENGINE_LOCK_STALE_MS", 120_000, 10_000, 3_600_000),
      timeoutMs: configuredDuration("ZCODE_VOICE_ENGINE_LOCK_TIMEOUT_MS", 86_400_000, 1_000, 86_400_000),
      timeoutMessage: "等待其他 ZCode 会话完成本地转写超时。",
      timeoutCode: "engine_lock_timeout",
    });
    activeTasks.set(taskId, { status: "running" });
    await updateTaskStatus(taskId, "running", { stage: "preparing_models", percent: 1, message: "正在准备本地运行时和模型。" });
    await transcribe(params, profiles);
  } catch (error) {
    try {
      const current = await readJson(taskFile(taskId), null);
      const partialAvailable = Boolean(current?.partialAvailable || current?.segments?.length || current?.text);
      await updateTaskStatus(taskId, "failed", {
        stage: "failed",
        percent: 100,
        message: error.message,
      }, {
        partialAvailable,
        partial: current?.partial ? {
          ...current.partial,
          failedChunk: error.completedChunks ? error.completedChunks + 1 : undefined,
          error: error.code || "transcription_failed",
        } : undefined,
        error: {
          code: error.code || "transcription_failed",
          message: error.message,
          ...(error.completedChunks ? { completedChunks: error.completedChunks } : {}),
          ...(error.totalChunks ? { totalChunks: error.totalChunks } : {}),
          ...(partialAvailable ? { partialAvailable: true } : {}),
        },
      });
    } catch (statusError) {
      process.stderr.write(`voice-transcriber could not persist failed task ${taskId}: ${statusError.message}\n`);
    }
  } finally {
    activeTasks.delete(taskId);
    await engineLease?.release();
    await taskLease?.release();
  }
}

async function drainHeavyQueue() {
  if (heavyWorkerRunning) return;
  heavyWorkerRunning = true;
  try {
    while (heavyQueue.length) {
      const item = heavyQueue.shift();
      await runHeavyTask(item);
    }
  } finally {
    heavyWorkerRunning = false;
    if (heavyQueue.length) void drainHeavyQueue();
  }
}

async function transcriptionStatus(params) {
  const task = await readJson(taskFile(params?.taskId));
  if (!task) throw fail(`找不到任务：${params?.taskId}`, "task_not_found");
  return {
    taskId: task.taskId,
    status: task.status,
    audio: task.audio,
    progress: task.progress || { stage: task.status, percent: 0 },
    error: task.error ? { ...task.error, message: sanitizeErrorMessage(task.error.message) } : null,
    artifacts: task.artifacts || null,
    partialArtifacts: task.partialArtifacts || null,
    partialAvailable: Boolean(task.partialAvailable || task.segments?.length),
    partial: task.partial || null,
    segmentCount: task.segments?.length || 0,
    totalCharacters: task.text?.length || 0,
    preview: task.text ? task.text.slice(0, 1200) : "",
    warnings: task.warnings || [],
  };
}

async function waitTranscription(params) {
  const taskId = requireTaskId(params?.taskId);
  const requestedTimeout = Number(params?.timeoutSeconds ?? 45);
  const timeoutSeconds = Number.isFinite(requestedTimeout) ? Math.min(50, Math.max(0, requestedTimeout)) : 45;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let status = await transcriptionStatus({ taskId });
  while (!TERMINAL_TASK_STATUSES.has(status.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(25, deadline - Date.now()))));
    status = await transcriptionStatus({ taskId });
  }
  const terminal = TERMINAL_TASK_STATUSES.has(status.status);
  return {
    ...status,
    timedOut: !terminal,
    ...(terminal ? {} : { retryAfterMs: 500 }),
  };
}

function makePersonId(name) {
  const raw = String(name || "unknown").trim().toLowerCase();
  const normalized = raw.replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 128);
  return `person_${normalized || crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

async function correctSpeaker(params) {
  const taskId = requireTaskId(params?.taskId);
  const requestedIds = requireSegmentIds(params?.segmentIds, { allowEmpty: false });
  const personName = requirePersonName(params?.personName);
  const personId = params.personId ? requirePersonId(params.personId) : makePersonId(personName);
  return withTaskMutation(taskId, async () => {
    const task = await readJson(taskFile(taskId));
    if (!task) throw fail(`找不到任务：${taskId}`, "task_not_found");
    if (task.status !== "completed") throw fail("转写任务尚未完成，不能修正说话人。", "task_not_completed");
    const availableIds = new Set((task.segments || []).map((segment) => segment.id));
    const missingIds = requestedIds.filter((id) => !availableIds.has(id));
    if (missingIds.length) throw fail(`找不到转写片段：${missingIds.join(", ")}`, "segment_not_found");
    const requested = new Set(requestedIds);
    const cleanClusters = new Set((task.segments || [])
      .filter((segment) => requested.has(segment.id) && !segment.mixedSpeaker)
      .map(segmentCluster)
      .filter(Boolean));
    const ids = new Set((task.segments || [])
      .filter((segment) => requested.has(segment.id) || (!segment.mixedSpeaker && cleanClusters.has(segmentCluster(segment))))
      .map((segment) => segment.id));
    const correction = {
      correctionId: `correction_${crypto.randomBytes(6).toString("hex")}`,
      personId,
      personName,
      requestedSegmentIds: [...requested],
      segmentIds: [...ids],
      createdAt: new Date().toISOString(),
    };
    for (const segment of task.segments || []) {
      if (ids.has(segment.id)) {
        segment.speaker = correction.personName;
        segment.personId = personId;
        segment.corrected = true;
      }
    }
    task.corrections = [...(task.corrections || []), correction];
    task.updatedAt = correction.createdAt;
    task.revision = Math.max(1, Number(task.revision || 1)) + 1;
    task.artifacts = await writeArtifacts(task);
    await writeJson(taskFile(task.taskId), task);
    const response = { taskId: task.taskId, revision: task.revision, correction, artifacts: task.artifacts };
    if (params?.autoLearn === false) return response;
    let learning;
    try {
      learning = await learnFromTask({ task, personId, personName, segmentIds: [...ids] });
    } catch (error) {
      return {
        ...response,
        learning: {
          applied: false,
          code: error.code || "speaker_learning_failed",
          reason: sanitizeErrorMessage(error.message),
        },
      };
    }
    task.learningIds = [...(task.learningIds || []), learning.learningId];
    task.updatedAt = learning.profile.updatedAt || correction.createdAt;
    try {
      await writeJson(taskFile(task.taskId), task);
      return { ...response, learning: { learningId: learning.learningId, applied: true, taskLinked: true } };
    } catch (error) {
      return {
        ...response,
        learning: {
          learningId: learning.learningId,
          applied: true,
          taskLinked: false,
          warning: `声纹学习已生效，但任务关联保存失败；仍可使用 learningId 回滚：${sanitizeErrorMessage(error.message)}`,
        },
      };
    }
  });
}

function normalize(vector) {
  if (!vector.length || vector.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw fail("无效的 CAM++ 声纹向量。", "invalid_embedding");
  }
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm === 0) throw fail("无效的 CAM++ 声纹向量。", "invalid_embedding");
  return vector.map((item) => item / norm);
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return null;
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function averageEmbeddings(entries) {
  const valid = entries.map((entry) => ({
    vector: normalizedOrNull(entry.vector),
    weight: Math.max(1, Number(entry.weight || 1)),
  })).filter((entry) => entry.vector);
  if (!valid.length) return null;
  const dimension = valid[0].vector.length;
  if (!valid.every((entry) => entry.vector.length === dimension)) return null;
  const totalWeight = valid.reduce((sum, entry) => sum + entry.weight, 0);
  return normalize(valid[0].vector.map((_, index) =>
    valid.reduce((sum, entry) => sum + entry.vector[index] * entry.weight, 0) / totalWeight));
}

function clusterLearningEmbedding(task, segmentIds) {
  const analysis = task?._speakerAnalysis;
  if (analysis?.algorithmVersion !== SPEAKER_PIPELINE_VERSION || !Array.isArray(analysis.clusters)) return null;
  const ids = new Set(segmentIds);
  const minimumPurity = Number(process.env.ZCODE_CAMPP_LEARNING_MIN_PURITY || 0.8);
  const eligibleSegments = (task.segments || []).filter((segment) =>
    ids.has(segment.id) && !segment.mixedSpeaker &&
    (!Number.isFinite(segment.speakerPurity) || segment.speakerPurity >= minimumPurity));
  const clusterIds = [...new Set(eligibleSegments.map(segmentCluster).filter(Boolean))];
  if (!clusterIds.length) throw fail("选中的片段包含混合或低置信说话人，未写入声纹档案。", "insufficient_speaker_sample");
  const selectedClusters = analysis.clusters.filter((cluster) => clusterIds.includes(normalizeClusterId(cluster.clusterId)));
  const embedding = averageEmbeddings(selectedClusters.map((cluster) => ({
    vector: cluster.prototype,
    weight: cluster.windowCount || cluster.size || 1,
  })));
  if (!embedding) throw fail("speaker-v2 没有可用于学习的 cluster prototype。", "invalid_embedding");
  const voicedSeconds = eligibleSegments.reduce((sum, segment) => {
    const duration = Number(segment.end) - Number(segment.start);
    return sum + (Number.isFinite(duration) && duration > 0 ? duration : 0);
  }, 0);
  const windowCount = selectedClusters.reduce((sum, cluster) => sum + Math.max(0, Number(cluster.windowCount || cluster.size || 0)), 0);
  if (voicedSeconds < 1.5 && windowCount < 2) {
    throw fail("确认片段中的有效人声不足 1.5 秒，暂不写入声纹档案。", "insufficient_speaker_sample");
  }
  return { embedding, source: SPEAKER_PIPELINE_VERSION, clusterIds, voicedSeconds, windowCount };
}

async function legacyLearningEmbedding(task, segmentIds) {
  const camppRuntime = await configureCamppRuntime();
  if (!camppRuntime.exists) throw fail("CAM++ 尚未配置，当前不会伪造声纹样本。", "campp_not_configured");
  const modelInfo = await resolveModel("ZCODE_CAMPP_MODEL", "cam++.onnx");
  if (!modelInfo.exists && process.env.ZCODE_VOICE_MOCK !== "1") throw fail(`找不到 CAM++ ONNX 模型：${modelInfo.path}。`, "campp_model_not_configured");
  const prepared = process.env.ZCODE_VOICE_MOCK === "1"
    ? { path: task.audioPath, cleanup: async () => {} }
    : await prepareAudio({ audioPath: task.audioPath, dataRoot, taskId: `${task.taskId}-learning` });
  try {
    const result = await campp.call("embed_segments", {
      audioPath: prepared.path,
      segmentIds,
      segments: task.segments,
      model: modelInfo.exists ? modelInfo.path : null,
    });
    const direct = normalizedOrNull(result?.embedding);
    const averaged = direct || averageEmbeddings(embeddingEntries(result, task.segments)
      .filter((entry) => segmentIds.includes(entry.segmentId))
      .map((entry) => ({ vector: entry.embedding, weight: 1 })));
    if (!averaged) throw fail("CAM++ adapter 没有返回 embedding。", "invalid_embedding");
    return { embedding: averaged, source: "legacy-segments", clusterIds: [], voicedSeconds: null, windowCount: null };
  } finally {
    await prepared.cleanup();
    campp.release();
  }
}

function profilePrototype(samples, fallback) {
  const averaged = averageEmbeddings((samples || []).map((sample) => ({ vector: sample.vector, weight: 1 })));
  return averaged || normalize(fallback);
}

async function learnFromTask({ task, personId, personName, segmentIds, embedding = null }) {
  const correctedSegment = task.segments.find((segment) =>
    segmentIds.includes(segment.id) && segment.corrected && segment.personId === personId);
  if (!correctedSegment) throw fail("指定片段尚未完成说话人修正。", "correction_not_found");
  const extracted = Array.isArray(embedding)
    ? { embedding: normalize(embedding), source: "provided", clusterIds: [], voicedSeconds: null, windowCount: null }
    : clusterLearningEmbedding(task, segmentIds) || await legacyLearningEmbedding(task, segmentIds);
  return withProfileMutation(async () => {
    const profiles = await getProfiles();
    requirePersonId(personId);
    const vector = normalize(extracted.embedding);
    const previous = profiles.profiles.find((item) => item.personId === personId) || null;
    const learningId = makeLearningId();
    const createdAt = new Date().toISOString();
    const sample = {
      learningId,
      vector,
      taskId: task.taskId,
      segmentIds,
      source: extracted.source,
      clusterIds: extracted.clusterIds,
      voicedSeconds: extracted.voicedSeconds,
      windowCount: extracted.windowCount,
      confirmed: true,
      createdAt,
    };
    const profile = previous || { personId, name: personName, prototype: vector, confirmedSamples: [], candidateSamples: [] };
    profile.name = personName;
    profile.confirmedSamples = [...(profile.confirmedSamples || []), sample].slice(-16);
    profile.prototype = profilePrototype(profile.confirmedSamples, vector);
    profile.updatedAt = createdAt;
    const index = profiles.profiles.findIndex((item) => item.personId === personId);
    if (index >= 0) profiles.profiles[index] = profile;
    else profiles.profiles.push(profile);
    profiles.version = Math.max(2, Number(profiles.version || 1));
    await writeJson(learningFile(learningId), {
      version: 2,
      learningId,
      personId,
      taskId: task.taskId,
      sampleLearningIds: [learningId],
      createdAt,
    });
    await saveProfiles(profiles);
    return { learningId, profile: publicProfile(profile), taskId: task.taskId };
  });
}

async function enrollFromCorrection(params) {
  const taskId = requireTaskId(params?.taskId);
  const personName = requirePersonName(params?.personName);
  const segmentIds = requireSegmentIds(params?.segmentIds, { allowEmpty: false });
  return withTaskMutation(taskId, async () => {
    const task = await readJson(taskFile(taskId));
    if (!task) throw fail(`找不到任务：${taskId}`, "task_not_found");
    const correctedSegment = task.segments.find((segment) => segmentIds.includes(segment.id) && segment.corrected && segment.personId);
    if (!correctedSegment) throw fail("指定片段尚未完成说话人修正。", "correction_not_found");
    const personId = params.personId ? requirePersonId(params.personId) : correctedSegment.personId || makePersonId(personName);
    const learning = await learnFromTask({ task, personId, personName, segmentIds, embedding: params.embedding });
    task.learningIds = [...(task.learningIds || []), learning.learningId];
    task.updatedAt = learning.profile.updatedAt || new Date().toISOString();
    await writeJson(taskFile(task.taskId), task);
    return learning;
  });
}

async function rollbackLearning(params) {
  const learningId = requireLearningId(params?.learningId);
  return withProfileMutation(async () => {
    const snapshot = await readJson(learningFile(learningId));
    if (!snapshot) throw fail(`找不到学习记录：${params?.learningId}`, "learning_not_found");
    const profiles = await getProfiles();
    const index = profiles.profiles.findIndex((item) => item.personId === snapshot.personId);
    if (snapshot.version >= 2) {
      if (index >= 0) {
        const profile = profiles.profiles[index];
        const learningIds = new Set(snapshot.sampleLearningIds || [learningId]);
        profile.confirmedSamples = (profile.confirmedSamples || []).filter((sample) => !learningIds.has(sample.learningId));
        if (profile.confirmedSamples.length) {
          profile.prototype = profilePrototype(profile.confirmedSamples, profile.prototype);
          profile.updatedAt = new Date().toISOString();
        } else {
          profiles.profiles.splice(index, 1);
        }
      }
      snapshot.rolledBackAt = snapshot.rolledBackAt || new Date().toISOString();
      await writeJson(learningFile(learningId), snapshot);
    } else if (snapshot.previousProfile) {
      if (index >= 0) profiles.profiles[index] = snapshot.previousProfile;
      else profiles.profiles.push(snapshot.previousProfile);
    } else if (index >= 0) {
      profiles.profiles.splice(index, 1);
    }
    await saveProfiles(profiles);
    return { learningId: params.learningId, profiles };
  });
}

async function getTask(params) {
  const task = await readJson(taskFile(params?.taskId));
  if (!task) throw fail(`找不到任务：${params?.taskId}`, "task_not_found");
  const { _speakerAnalysis, cacheIdentity, ...publicTask } = task;
  const allSegments = task.segments || [];
  const requestedIds = new Set(params?.segmentIds === undefined ? [] : requireSegmentIds(params.segmentIds));
  const offset = Math.max(0, Number(params?.offset || 0));
  const limit = Math.min(500, Math.max(1, Number(params?.limit || 200)));
  const selected = requestedIds.size
    ? allSegments.filter((segment) => requestedIds.has(segment.id))
    : allSegments.slice(offset, offset + limit);
  const selectedText = selected.map((segment) => segment.text).filter(Boolean).join("\n");
  return {
    ...publicTask,
    text: params?.includeText ? (selected.length === allSegments.length ? task.text : selectedText) : undefined,
    textScope: params?.includeText ? (selected.length === allSegments.length ? "full" : "selected_segments") : "none",
    segments: selected,
    totalSegments: allSegments.length,
    offset,
    returnedSegments: selected.length,
    hasMoreSegments: !requestedIds.size && offset + selected.length < allSegments.length,
  };
}

async function searchTranscript(params) {
  const task = await readJson(taskFile(params?.taskId));
  if (!task) throw fail(`找不到任务：${params?.taskId}`, "task_not_found");
  const query = String(params?.query || "").trim().toLowerCase();
  const personId = String(params?.personId || "").trim();
  if (personId) requirePersonId(personId);
  if (!query && !personId) throw fail("query 或 personId 至少填写一个。", "invalid_search");
  const matches = task.segments.map((segment, index) => ({ segment, index })).filter(({ segment }) => {
    const textMatch = query && String(segment.text || "").toLowerCase().includes(query);
    const personMatch = personId && segment.personId === personId;
    return textMatch || personMatch;
  }).slice(0, Math.min(100, Math.max(1, Number(params?.limit || 50))));
  return {
    taskId: task.taskId,
    query: params?.query || null,
    personId: params?.personId || null,
    totalMatches: matches.length,
    matches,
  };
}

function sanitizePublicValue(value) {
  if (Array.isArray(value)) return value.map(sanitizePublicValue);
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return value;
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("_") || ["prototype", "embedding", "embeddings", "vector", "cacheidentity"].includes(key.toLowerCase())) continue;
    sanitized[key] = sanitizePublicValue(item);
  }
  return sanitized;
}

function publicProfile(profile) {
  return {
    personId: profile.personId,
    name: profile.name,
    confirmedSampleCount: Array.isArray(profile.confirmedSamples) ? profile.confirmedSamples.length : 0,
    candidateSampleCount: Array.isArray(profile.candidateSamples) ? profile.candidateSamples.length : 0,
    updatedAt: profile.updatedAt || null,
  };
}

function publicProfiles(value) {
  return {
    version: value?.version || 1,
    profiles: Array.isArray(value?.profiles) ? value.profiles.map(publicProfile) : [],
  };
}

function sanitizeErrorMessage(value) {
  return String(value || "voice-transcriber error")
    .replace(/"(?:prototype|embedding|embeddings|vector)"\s*:\s*\[[^\]]*\]/gi, '"voiceprint":"[redacted]"');
}

async function dispatch(method, params) {
  await initializeState();
  if (method === "health") return runtimeStatus();
  if (method === "start_transcription") return startTranscription(params);
  if (method === "wait_transcription") return waitTranscription(params);
  if (method === "get_transcription_status") return transcriptionStatus(params);
  if (method === "read_transcript") return getTask(params);
  if (method === "transcribe") return transcribe(params);
  if (method === "correct_speaker") return correctSpeaker(params);
  if (method === "enroll_from_correction") return sanitizePublicValue(await enrollFromCorrection(params));
  if (method === "list_speakers") return publicProfiles(await getProfiles());
  if (method === "get_task") return getTask(params);
  if (method === "search_transcript") return searchTranscript(params);
  if (method === "rollback_learning") {
    const result = await rollbackLearning(params);
    return { learningId: result.learningId, profiles: publicProfiles(result.profiles) };
  }
  throw fail(`未知方法：${method}`, "method_not_found");
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    const result = sanitizePublicValue(await dispatch(request.method, request.params || {}));
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: error.code || "engine_error", message: sanitizeErrorMessage(error.message) } })}\n`);
  }
});
