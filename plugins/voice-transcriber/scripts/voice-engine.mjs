import crypto from "node:crypto";
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
let runtimeBootstrapPromise = null;
const activeTasks = new Map();
let stateInitialization = null;

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(taskRoot, { recursive: true }),
    fs.mkdir(cacheRoot, { recursive: true }),
    fs.mkdir(learningRoot, { recursive: true }),
    fs.mkdir(artifactRoot, { recursive: true }),
    fs.mkdir(modelRoot, { recursive: true }),
  ]);
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
        const task = await readJson(file, null);
        if (task && ["queued", "preparing_models", "preparing_audio", "transcribing", "identifying_speakers"].includes(task.status)) {
          task.status = "interrupted";
          task.progress = { ...(task.progress || {}), stage: "interrupted", message: "上一次 ZCode 会话中断，可重新提交此录音。" };
          task.updatedAt = new Date().toISOString();
          await writeJson(file, task);
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
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function taskFile(taskId) {
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
  return path.join(artifactRoot, taskId);
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
  const directory = artifactDir(task.taskId);
  const transcript = {
    version: 1,
    taskId: task.taskId,
    audioPath: task.audioPath,
    audio: task.audio,
    text: task.text,
    segments: task.segments,
  };
  await writeJson(path.join(directory, "transcript.json"), transcript);
  await fs.writeFile(path.join(directory, "transcript.md"), renderMarkdown(task), "utf8");
  if (task.options.outputFormat === "srt") await fs.writeFile(path.join(directory, "transcript.srt"), renderSubtitles(task, ","), "utf8");
  if (task.options.outputFormat === "vtt") await fs.writeFile(path.join(directory, "transcript.vtt"), `WEBVTT\n\n${renderSubtitles(task, ".")}`, "utf8");
  return {
    json: path.join(directory, "transcript.json"),
    markdown: path.join(directory, "transcript.md"),
    ...(task.options.outputFormat === "srt" ? { srt: path.join(directory, "transcript.srt") } : {}),
    ...(task.options.outputFormat === "vtt" ? { vtt: path.join(directory, "transcript.vtt") } : {}),
  };
}

async function getProfiles() {
  return readJson(profileFile(), { version: 1, profiles: [] });
}

async function saveProfiles(value) {
  return writeJson(profileFile(), value);
}

function makeTaskId(audioPath, stat, options, profileFingerprint) {
  const input = JSON.stringify({
    audioPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    options,
    asrModel: process.env.ZCODE_SENSEVOICE_MODEL || null,
    speakerModel: process.env.ZCODE_CAMPP_MODEL || null,
    profileFingerprint,
  });
  return `task_${crypto.createHash("sha256").update(input).digest("hex").slice(0, 20)}`;
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
  }

  async start() {
    if (this.child) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
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
        this.scheduleIdleClose();
      });
      child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
      child.on("error", (error) => this.close(fail(error.message, "backend_not_found")));
      child.on("exit", (code) => this.close(fail(`speaker backend exited with code ${code}${this.stderr ? `: ${this.stderr.trim()}` : ""}`, "backend_failed")));
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
    if (this.child) this.child.kill();
    for (const item of this.pending.values()) item.reject(error || fail("speaker backend closed", "backend_closed"));
    this.pending.clear();
    this.child = null;
  }

  scheduleIdleClose() {
    if (!this.child || this.pending.size) return;
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
  const runtime = await resolveCamppRuntime({ bootstrap: true });
  if (runtime.exists && ["bundled", "downloaded"].includes(runtime.source)) process.env.ZCODE_CAMPP_COMMAND = runtime.command;
  return runtime;
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
    return { text: process.env.ZCODE_VOICE_MOCK_TEXT || "这是本地语音引擎的测试转写结果。", backend: "mock", model: "mock" };
  }

  const runtime = await resolveSenseVoiceRuntime({ bootstrap: true });
  requireSenseVoiceRuntime(runtime);
  await onStage?.("preparing_models", 10, "正在准备本地模型；首次使用可能需要下载。", { modelReady: false });
  const modelBootstrap = await ensureModels({ dataRoot });
  await onStage?.("transcribing", 35, "模型已准备，正在进行本地转写。", { modelReady: modelBootstrap.ready });
  const modelInfo = await resolveModel("ZCODE_SENSEVOICE_MODEL", "sense-voice-small-q8_0.gguf");
  if (!modelInfo.exists) {
    throw fail(`找不到 SenseVoice GGUF 模型：${modelInfo.path}。请将模型放入本地模型目录或配置 ZCODE_SENSEVOICE_MODEL。`, "sensevoice_not_configured");
  }
  const model = modelInfo.path;
  const binary = runtime.command;
  const vadInfo = await resolveModel("ZCODE_FSMN_VAD_MODEL", "fsmn-vad.gguf");
  const runSingle = async (inputPath, offsetSeconds = 0, runOptions = {}) => {
    const args = ["-m", model, "-a", inputPath];
    if (vadInfo.exists) args.push("--vad", vadInfo.path, "--vad-maxseg", String(runOptions.vadMaxSegMs || 15000));
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

  try {
    return await runSingle(audioPath);
  } catch (error) {
    const isGgmlMemoryCrash = isGgmlMemoryCrashError(error);
    if (!isGgmlMemoryCrash) throw error;

    await onStage?.("transcribing", 36, "长录音触发本地内存保护，正在自动分块重试。", { fallback: "chunked" });
    const initialChunkSeconds = chooseChunkSeconds();
    const split = await splitAudio({ audioPath, dataRoot, taskId: options.taskId, chunkSeconds: initialChunkSeconds });
    const allSegments = [];
    const allTexts = [];
    let completedChunks = 0;
    let plannedChunks = split.chunks.length;
    let firstResult = null;

    const emitChunk = async (result, chunk) => {
      if (!firstResult) firstResult = result;
      const segments = result.segments?.length
        ? result.segments
        : [{ start: chunk.offset, end: null, text: result.text, speaker: "unknown", confidence: null }];
      allSegments.push(...segments);
      allTexts.push(result.text);
      completedChunks += 1;
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
      try {
        const result = await runSingle(chunk.path, chunk.offset, {
          // Smaller VAD windows reduce the peak feature/graph allocation on
          // machines that already needed the long-audio fallback.
          vadMaxSegMs: 10000,
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

async function diarize(audioPath, segments) {
  const runtime = await configureCamppRuntime();
  if (!runtime.exists) {
    const configured = String(process.env.ZCODE_CAMPP_COMMAND || "").trim();
    if (configured && !configured.startsWith("${")) throw fail(`找不到 CAM++ adapter：${runtime.command}。`, "backend_not_configured");
    return segments;
  }
  const modelInfo = await resolveModel("ZCODE_CAMPP_MODEL", "cam++.onnx");
  if (!modelInfo.exists && process.env.ZCODE_VOICE_MOCK !== "1") return segments;
  const result = await campp.call("diarize", {
    audioPath,
    segments,
    model: modelInfo.exists ? modelInfo.path : null,
  });
  if (!Array.isArray(result?.segments)) throw fail("CAM++ adapter 没有返回 segments。", "invalid_speaker_result");
  return result.segments;
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
  return crypto.createHash("sha256").update(JSON.stringify(
    profiles.profiles.map(({ personId, name, updatedAt }) => ({ personId, name, updatedAt })),
  )).digest("hex").slice(0, 16);
}

async function matchKnownSpeakers(audioPath, segments, enabled) {
  const runtime = await configureCamppRuntime();
  if (!enabled || !runtime.exists) return segments;
  const modelInfo = await resolveModel("ZCODE_CAMPP_MODEL", "cam++.onnx");
  if (!modelInfo.exists && process.env.ZCODE_VOICE_MOCK !== "1") return segments;
  const profiles = await getProfiles();
  const usableProfiles = profiles.profiles.filter((profile) => Array.isArray(profile.prototype));
  if (!usableProfiles.length || !segments.length) return segments;

  const result = await campp.call("embed_segments", {
    audioPath,
    segmentIds: segments.map((segment) => segment.id),
    segments,
    model: modelInfo.exists ? modelInfo.path : null,
  });
  const embeddings = new Map(embeddingEntries(result, segments).map((entry) => [entry.segmentId, normalize(entry.embedding)]));
  const threshold = Number(process.env.ZCODE_CAMPP_MATCH_THRESHOLD || 0.62);
  const margin = Number(process.env.ZCODE_CAMPP_MATCH_MARGIN || 0.05);

  return segments.map((segment) => {
    const embedding = embeddings.get(segment.id);
    if (!embedding) return segment;
    const ranked = usableProfiles.map((profile) => ({
      profile,
      score: cosine(embedding, normalize(profile.prototype)),
    })).filter((item) => item.score !== null).sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const second = ranked[1];
    if (!best || best.score < threshold || (second && best.score - second.score < margin)) {
      return { ...segment, speaker: segment.speaker || "unknown", speakerMatch: "unknown", speakerConfidence: best?.score ?? null };
    }
    return {
      ...segment,
      speaker: best.profile.name,
      personId: best.profile.personId,
      speakerMatch: "known",
      speakerConfidence: best.score,
    };
  });
}

async function transcribe(params) {
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
  const profiles = options.speakerProfile ? await getProfiles() : { version: 1, profiles: [] };
  const taskId = params.taskId || makeTaskId(audioPath, stat, options, profileFingerprint(profiles));
  const cached = await readJson(taskFile(taskId));
  if (cached?.status === "completed" && !params.taskId) return { ...cached, cacheHit: true };

  await updateTaskStatus(taskId, "preparing_models", { stage: "preparing_models", percent: 1, message: "正在准备本地运行时和模型。" });
  const camppRuntime = await configureCamppRuntime();
  const camppModel = await resolveModel("ZCODE_CAMPP_MODEL", "cam++.onnx");
  if (process.env.ZCODE_VOICE_MOCK !== "1") requireSenseVoiceRuntime(await resolveSenseVoiceRuntime());
  await updateTaskStatus(taskId, "preparing_audio", { stage: "preparing_audio", percent: 5, message: "正在检查和转换音频。" });
  const prepared = process.env.ZCODE_VOICE_MOCK === "1"
    ? { path: audioPath, converted: false, cleanup: async () => {} }
    : await prepareAudio({ audioPath, dataRoot, taskId });
  try {
    const asr = await runSenseVoice(prepared.path, {
      ...options,
      taskId,
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
        await updateTaskStatus(taskId, "transcribing", {
          stage: "transcribing",
          percent: 38 + Math.floor((partial.completedChunks / Math.max(1, partial.totalChunks)) * 28),
          message: `已完成 ${partial.completedChunks}/${partial.totalChunks} 个音频分块，正在继续处理。`,
        }, {
          partial: {
            completedChunks: partial.completedChunks,
            totalChunks: partial.totalChunks,
            chunkSeconds: partial.chunkSeconds,
          },
          partialArtifacts: {
            json: path.join(artifactDir(taskId), "partial-transcript.json"),
          },
          text: partial.text,
          segments: partial.segments,
          partialAvailable: true,
        });
        await writeJson(path.join(artifactDir(taskId), "partial-transcript.json"), partialTask);
      },
    }, async (stage, percent, message, extra) => {
      await updateTaskStatus(taskId, stage, { stage, percent, message }, extra);
    });
    const baseSegments = asr.segments?.length ? asr.segments : makeSegments(asr.text);
    await updateTaskStatus(taskId, "identifying_speakers", { stage: "identifying_speakers", percent: 70, message: "正在区分和匹配说话人。" });
    const diarizedSegments = await diarize(prepared.path, baseSegments);
    const segments = await matchKnownSpeakers(prepared.path, diarizedSegments, options.speakerProfile);
    const task = {
      taskId,
      status: "completed",
      createdAt: cached?.createdAt || new Date().toISOString(),
      audioPath,
      audio: { size: stat.size, mtimeMs: stat.mtimeMs },
      options,
      backend: {
        asr: asr.backend,
        asrModel: asr.model,
        speaker: camppRuntime.exists && (camppModel.exists || process.env.ZCODE_VOICE_MOCK === "1") ? "available" : "not_configured",
      },
      text: asr.text,
      segments,
      progress: { stage: "completed", percent: 100, message: "本地转写已完成。" },
      corrections: [],
      learningIds: [],
      warnings: [
        ...(asr.device === "cpu-fallback" ? ["Metal 初始化失败，已自动回退到 CPU。"] : []),
        ...(asr.warnings || []),
        ...(camppRuntime.exists && (camppModel.exists || process.env.ZCODE_VOICE_MOCK === "1") ? [] : ["CAM++ adapter 或模型尚未配置，当前结果只包含转写文字，无法自动匹配注册说话人。"]),
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

async function startTranscription(params) {
  const audioPath = params?.audioPath;
  if (!audioPath || !path.isAbsolute(audioPath)) throw fail("audioPath 必须是绝对路径。", "invalid_audio_path");
  const stat = await fs.stat(audioPath).catch(() => null);
  if (!stat?.isFile()) throw fail(`找不到音频文件：${audioPath}`, "audio_not_found");
  const options = taskOptions(params);
  const profiles = options.speakerProfile ? await getProfiles() : { version: 1, profiles: [] };
  const taskId = makeTaskId(audioPath, stat, options, profileFingerprint(profiles));
  const existing = await readJson(taskFile(taskId), null);
  if (existing?.status === "completed") return { ...existing, cacheHit: true };
  if (activeTasks.has(taskId)) return existing || { taskId, status: "queued" };

  const task = {
    taskId,
    status: "queued",
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    audioPath,
    audio: { size: stat.size, mtimeMs: stat.mtimeMs },
    options,
    progress: { stage: "queued", percent: 0, message: "任务已创建，等待本地引擎启动。" },
    warnings: [],
  };
  await writeJson(taskFile(taskId), task);
  const job = (async () => {
    try {
      await transcribe({ ...params, taskId });
    } catch (error) {
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
    } finally {
      activeTasks.delete(taskId);
    }
  })();
  activeTasks.set(taskId, job);
  return task;
}

async function transcriptionStatus(params) {
  const task = await readJson(taskFile(params?.taskId));
  if (!task) throw fail(`找不到任务：${params?.taskId}`, "task_not_found");
  return {
    taskId: task.taskId,
    status: task.status,
    audio: task.audio,
    progress: task.progress || { stage: task.status, percent: 0 },
    error: task.error || null,
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

function makePersonId(name) {
  return `person_${String(name || "unknown").trim().toLowerCase().replace(/\s+/g, "_")}`;
}

async function correctSpeaker(params) {
  const task = await readJson(taskFile(params?.taskId));
  if (!task) throw fail(`找不到任务：${params?.taskId}`, "task_not_found");
  const ids = new Set(params.segmentIds || []);
  const personId = params.personId || makePersonId(params.personName);
  const correction = { correctionId: `correction_${crypto.randomBytes(6).toString("hex")}`, personId, personName: params.personName || personId, segmentIds: [...ids], createdAt: new Date().toISOString() };
  for (const segment of task.segments) {
    if (ids.has(segment.id)) {
      segment.speaker = correction.personName;
      segment.personId = personId;
      segment.corrected = true;
    }
  }
  task.corrections.push(correction);
  task.updatedAt = correction.createdAt;
  await writeJson(taskFile(task.taskId), task);
  return { taskId: task.taskId, correction };
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

async function enrollFromCorrection(params) {
  const task = await readJson(taskFile(params?.taskId));
  if (!task) throw fail(`找不到任务：${params?.taskId}`, "task_not_found");
  if (!params.personName) throw fail("personName 不能为空。", "invalid_person");
  let embedding = params.embedding;
  if (!Array.isArray(embedding)) {
    const camppRuntime = await configureCamppRuntime();
    if (!camppRuntime.exists) throw fail("CAM++ 尚未配置。请设置 ZCODE_CAMPP_COMMAND 并接入 native embedding adapter；当前不会伪造声纹样本。", "campp_not_configured");
    const modelInfo = await resolveModel("ZCODE_CAMPP_MODEL", "cam++.onnx");
    if (!modelInfo.exists && process.env.ZCODE_VOICE_MOCK !== "1") throw fail(`找不到 CAM++ ONNX 模型：${modelInfo.path}。`, "campp_model_not_configured");
    const prepared = process.env.ZCODE_VOICE_MOCK === "1"
      ? { path: task.audioPath, cleanup: async () => {} }
      : await prepareAudio({ audioPath: task.audioPath, dataRoot, taskId: `${task.taskId}-learning` });
    try {
      const result = await campp.call("embed_segments", {
        audioPath: prepared.path,
        segmentIds: params.segmentIds || [],
        segments: task.segments,
        model: modelInfo.path,
      });
      embedding = result?.embedding;
      if (!Array.isArray(embedding) && Array.isArray(result?.embeddings)) {
        const vectors = result.embeddings.map((entry) => Array.isArray(entry) ? entry : entry.embedding || entry.vector).filter(Array.isArray);
        if (vectors.length) {
          const dimension = vectors[0].length;
          if (vectors.every((vector) => vector.length === dimension)) {
            embedding = vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length);
          }
        }
      }
    } finally {
      await prepared.cleanup();
    }
  }
  if (!Array.isArray(embedding)) throw fail("CAM++ adapter 没有返回 embedding。", "invalid_embedding");

  const profiles = await getProfiles();
  const correctedSegment = task.segments.find((segment) =>
    (params.segmentIds || []).includes(segment.id) && segment.corrected && segment.personId,
  );
  const personId = params.personId || correctedSegment?.personId || makePersonId(params.personName);
  const vector = normalize(embedding);
  const previous = profiles.profiles.find((item) => item.personId === personId);
  const learningId = makeLearningId();
  await writeJson(path.join(learningRoot, `${learningId}.json`), { learningId, personId, previousProfile: previous || null, createdAt: new Date().toISOString() });

  const sample = { vector, taskId: task.taskId, segmentIds: params.segmentIds || [], confirmed: true, createdAt: new Date().toISOString() };
  const profile = previous || { personId, name: params.personName, prototype: vector, confirmedSamples: [], candidateSamples: [] };
  profile.name = params.personName;
  const previousPrototype = Array.isArray(profile.prototype) && profile.prototype.length === vector.length ? profile.prototype : vector;
  profile.prototype = normalize(previousPrototype.map((value, index) => value * 0.8 + vector[index] * 0.2));
  profile.confirmedSamples = [...(profile.confirmedSamples || []), sample].slice(-16);
  profile.updatedAt = sample.createdAt;
  const index = profiles.profiles.findIndex((item) => item.personId === personId);
  if (index >= 0) profiles.profiles[index] = profile;
  else profiles.profiles.push(profile);
  await saveProfiles(profiles);

  task.learningIds.push(learningId);
  task.updatedAt = sample.createdAt;
  await writeJson(taskFile(task.taskId), task);
  return { learningId, profile: { ...profile, prototype: undefined }, taskId: task.taskId };
}

async function rollbackLearning(params) {
  const snapshot = await readJson(path.join(learningRoot, `${params?.learningId}.json`));
  if (!snapshot) throw fail(`找不到学习记录：${params?.learningId}`, "learning_not_found");
  const profiles = await getProfiles();
  const index = profiles.profiles.findIndex((item) => item.personId === snapshot.personId);
  if (snapshot.previousProfile) {
    if (index >= 0) profiles.profiles[index] = snapshot.previousProfile;
    else profiles.profiles.push(snapshot.previousProfile);
  } else if (index >= 0) {
    profiles.profiles.splice(index, 1);
  }
  await saveProfiles(profiles);
  return { learningId: params.learningId, profiles };
}

async function getTask(params) {
  const task = await readJson(taskFile(params?.taskId));
  if (!task) throw fail(`找不到任务：${params?.taskId}`, "task_not_found");
  const allSegments = task.segments || [];
  const requestedIds = new Set(params?.segmentIds || []);
  const offset = Math.max(0, Number(params?.offset || 0));
  const limit = Math.min(500, Math.max(1, Number(params?.limit || 200)));
  const selected = requestedIds.size
    ? allSegments.filter((segment) => requestedIds.has(segment.id))
    : allSegments.slice(offset, offset + limit);
  const selectedText = selected.map((segment) => segment.text).filter(Boolean).join("\n");
  return {
    ...task,
    text: params?.includeText ? (selected.length === allSegments.length ? task.text : selectedText) : undefined,
    textScope: params?.includeText ? (selected.length === allSegments.length ? "full" : "selected_segments") : "none",
    segments: selected,
    totalSegments: allSegments.length,
    offset,
    returnedSegments: selected.length,
    hasMoreSegments: selected.length < allSegments.length && !requestedIds.size,
  };
}

async function searchTranscript(params) {
  const task = await readJson(taskFile(params?.taskId));
  if (!task) throw fail(`找不到任务：${params?.taskId}`, "task_not_found");
  const query = String(params?.query || "").trim().toLowerCase();
  const personId = String(params?.personId || "").trim();
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

async function dispatch(method, params) {
  await initializeState();
  if (method === "health") return runtimeStatus();
  if (method === "start_transcription") return startTranscription(params);
  if (method === "get_transcription_status") return transcriptionStatus(params);
  if (method === "read_transcript") return getTask(params);
  if (method === "transcribe") return transcribe(params);
  if (method === "correct_speaker") return correctSpeaker(params);
  if (method === "enroll_from_correction") return enrollFromCorrection(params);
  if (method === "list_speakers") return getProfiles();
  if (method === "get_task") return getTask(params);
  if (method === "search_transcript") return searchTranscript(params);
  if (method === "rollback_learning") return rollbackLearning(params);
  throw fail(`未知方法：${method}`, "method_not_found");
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    const result = await dispatch(request.method, request.params || {});
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: error.code || "engine_error", message: error.message } })}\n`);
  }
});
