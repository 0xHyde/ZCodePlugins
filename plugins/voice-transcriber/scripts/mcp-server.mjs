import readline from "node:readline";
import fs from "node:fs/promises";
import { SidecarClient } from "./sidecar.mjs";

const pluginPackage = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const serverInfo = {
  name: "voice-transcriber",
  version: pluginPackage.version,
};

const tools = [
  {
    name: "transcribe_audio",
    description: "轻量本地语音入口：转写录音、识别说话人，并在需要时处理修正、全文读取和说话人学习。用户通常只需提供 audioPath。",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["transcribe", "correct_speaker", "read", "search", "list_speakers", "rollback", "status"],
          description: "内部操作，默认 transcribe；由 Agent 自动填写，用户无需理解。",
        },
        audioPath: { type: "string", description: "本地音频或视频文件绝对路径" },
        language: { type: "string", description: "auto、zh、en 等，默认 auto" },
        outputFormat: { type: "string", enum: ["markdown", "json", "srt", "vtt"] },
        speakerProfile: { type: "boolean", description: "是否匹配本地说话人档案" },
        taskId: { type: "string" },
        segmentIds: { type: "array", items: { type: "string" } },
        personId: { type: "string" },
        personName: { type: "string" },
        autoLearn: { type: "boolean", description: "修正后自动把确认片段加入说话人学习；默认 true" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        includeText: { type: "boolean" },
        query: { type: "string" },
        learningId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

const sidecar = new SidecarClient();
const inlineTextLimit = Number(process.env.ZCODE_VOICE_INLINE_MAX_CHARS || 80000);
const inlineSegmentLimit = Number(process.env.ZCODE_VOICE_INLINE_MAX_SEGMENTS || 400);

function compactTask(task) {
  const segments = task?.segments || [];
  const text = String(task.text || "");
  const fullTextInline = text.length <= inlineTextLimit;
  const segmentsInline = segments.length <= inlineSegmentLimit;
  const visibleSegments = segmentsInline ? segments : segments.slice(0, 20);
  return {
    taskId: task.taskId,
    status: task.status,
    cacheHit: Boolean(task.cacheHit),
    audio: task.audio,
    options: task.options,
    backend: task.backend,
    artifacts: task.artifacts,
    segmentCount: segments.length,
    speakerCount: new Set(segments.map((segment) => segment.personId || segment.speaker).filter((speaker) => speaker && speaker !== "unknown")).size,
    speakers: [...new Map(segments.filter((segment) => segment.speaker && segment.speaker !== "unknown").map((segment) => [segment.personId || segment.speaker, { personId: segment.personId, name: segment.speaker }])).values()],
    uncertainSegments: segments.filter((segment) => segment.speakerMatch === "unknown" || segment.confidence !== null && segment.confidence < 0.6).map((segment) => segment.id).slice(0, 20),
    text: fullTextInline ? text : undefined,
    totalCharacters: text.length,
    textTruncated: !fullTextInline,
    preview: text.slice(0, 1200),
    segments: visibleSegments,
    hasMoreSegments: !segmentsInline,
    inlineLimits: { maxCharacters: inlineTextLimit, maxSegments: inlineSegmentLimit },
    warnings: task.warnings || [],
  };
}

function compactProfiles(result) {
  return {
    version: result?.version || 1,
    profiles: (result?.profiles || []).map((profile) => ({
      personId: profile.personId,
      name: profile.name,
      updatedAt: profile.updatedAt,
      confirmedSampleCount: profile.confirmedSamples?.length || 0,
    })),
  };
}

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

async function callTool(name, args = {}) {
  if (name !== "transcribe_audio") throw new Error(`Unknown tool: ${name}`);
  const operation = args.operation || "transcribe";

  if (operation === "transcribe") {
    const result = await sidecar.call("transcribe", {
      audioPath: args.audioPath,
      language: args.language || "auto",
      outputFormat: args.outputFormat || "markdown",
      speakerProfile: args.speakerProfile !== false,
    });
    if (!result?.taskId) throw new Error("voice-engine returned no taskId");
    return compactTask(result);
  }

  if (operation === "correct_speaker") {
    const correction = await sidecar.call("correct_speaker", args);
    if (args.autoLearn === false || !args.personName) return correction;
    try {
      const learning = await sidecar.call("enroll_from_correction", args);
      return { ...correction, learning: { learningId: learning.learningId, applied: true } };
    } catch (error) {
      return { ...correction, learning: { applied: false, reason: error.message } };
    }
  }

  if (operation === "list_speakers") return compactProfiles(await sidecar.call("list_speakers", {}));
  if (operation === "status") return sidecar.call("health", {});
  if (operation === "read") return sidecar.call("get_task", args);
  if (operation === "search") return sidecar.call("search_transcript", args);

  if (operation === "rollback") {
    const result = await sidecar.call("rollback_learning", args);
    return result?.profiles ? { ...result, profiles: compactProfiles(result.profiles) } : result;
  }

  throw new Error(`Unknown operation: ${operation}`);
}

async function handle(message) {
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    return ok(message.id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo,
    });
  }
  if (message.method === "tools/list") return ok(message.id, { tools });
  if (message.method === "tools/call") {
    try {
      return ok(message.id, textResult(await callTool(message.params?.name, message.params?.arguments || {})));
    } catch (error) {
      return fail(message.id, -32000, error.message);
    }
  }
  if (message.id === undefined) return null;
  return fail(message.id, -32601, `Method not found: ${message.method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const response = await handle(JSON.parse(line));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(fail(null, -32700, error.message))}\n`);
  }
});

function shutdown() {
  sidecar.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
