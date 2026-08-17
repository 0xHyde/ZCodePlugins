import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SidecarClient } from "./sidecar.mjs";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePackageRoot = path.resolve(serverDirectory, "..");
const bundledPackageRoot = path.resolve(serverDirectory, "..", "..");
const packageRoot = process.env.ZCODE_VOICE_PLUGIN_ROOT ||
  (await fs.access(path.join(sourcePackageRoot, "package.json")).then(() => sourcePackageRoot).catch(() => bundledPackageRoot));
const pluginPackage = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
const serverInfo = { name: "voice-transcriber", version: pluginPackage.version };
const taskIdSchema = { type: "string", pattern: "^task_[a-f0-9]{16,64}$" };
const learningIdSchema = { type: "string", pattern: "^learn_[a-f0-9]{16,64}$" };
const segmentIdSchema = { type: "string", pattern: "^seg_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" };
const personIdSchema = { type: "string", pattern: "^person_[^./\\\\\\s]{1,128}$" };

const tools = [
  {
    name: "start_transcription",
    description: "创建本地录音转写任务。首次使用会在本地准备模型；返回 taskId 后通常直接调用 wait_transcription。",
    inputSchema: {
      type: "object",
      properties: {
        audioPath: { type: "string", description: "本地音频或视频文件的绝对路径" },
        language: { type: "string", description: "auto、zh、en 等，默认 auto" },
        outputFormat: { type: "string", enum: ["markdown", "json", "srt", "vtt"] },
        speakerProfile: { type: "boolean", description: "是否匹配本地说话人档案，默认 true" },
      },
      required: ["audioPath"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_transcription",
    description: "等待本地转写任务进入完成、失败或中断状态；超时会返回当前进度，可继续调用。完成后使用 read_transcript 读取全文或直接处理 artifacts 文件。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: taskIdSchema,
        timeoutSeconds: { type: "number", minimum: 0, maximum: 50, description: "本次最多等待秒数，默认 45 秒" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_transcription_status",
    description: "查询本地转写任务状态和阶段。任务未完成时继续轮询；如果长录音中途失败但已有分块完成，partialAvailable 会为 true，可先用 read_transcript 读取已保存部分。",
    inputSchema: {
      type: "object",
      properties: { taskId: taskIdSchema },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_transcript",
    description: "分页读取转写结果，避免把长录音全文一次性塞入上下文；长录音中途失败时也可读取已保存的部分结果。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: taskIdSchema,
        offset: { type: "integer", minimum: 0, description: "片段起始位置" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "本次最多返回片段数" },
        includeText: { type: "boolean", description: "是否返回当前页文字" },
        segmentIds: { type: "array", items: segmentIdSchema },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "correct_speaker",
    description: "修正转写片段的说话人名称，并默认使用已确认片段更新本地说话人档案。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: taskIdSchema,
        segmentIds: { type: "array", minItems: 1, items: segmentIdSchema },
        personId: personIdSchema,
        personName: { type: "string", minLength: 1, maxLength: 128 },
        autoLearn: { type: "boolean", description: "是否把确认片段加入本地学习档案，默认 true" },
      },
      required: ["taskId", "segmentIds", "personName"],
      additionalProperties: false,
    },
  },
  {
    name: "list_speakers",
    description: "列出本地已注册的说话人档案。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rollback_speaker_learning",
    description: "回滚一次已确认的说话人学习记录。",
    inputSchema: {
      type: "object",
      properties: { learningId: learningIdSchema },
      required: ["learningId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_transcript",
    description: "在本地转写结果中按文字或说话人检索片段。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: taskIdSchema,
        query: { type: "string" },
        personId: personIdSchema,
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
];

const sidecar = new SidecarClient({ packageRoot });

function result(value) {
  const safeValue = sanitizeForMcp(value);
  return {
    content: [{ type: "text", text: JSON.stringify(safeValue, null, 2) }],
    structuredContent: safeValue,
  };
}

function errorResult(error) {
  const value = {
    error: {
      code: error?.code || "voice_transcriber_error",
      message: sanitizeSensitiveText(error?.message || String(error)),
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

function sanitizeForMcp(value) {
  if (Array.isArray(value)) return value.map(sanitizeForMcp);
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return value;
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("_") || ["prototype", "embedding", "embeddings", "vector", "cacheidentity"].includes(key.toLowerCase())) continue;
    sanitized[key] = sanitizeForMcp(item);
  }
  return sanitized;
}

function sanitizeSensitiveText(value) {
  return String(value)
    .replace(/"(?:prototype|embedding|embeddings|vector)"\s*:\s*\[[^\]]*\]/gi, '"voiceprint":"[redacted]"');
}

async function callTool(name, args = {}) {
  if (name === "start_transcription") return sidecar.call("start_transcription", args);
  if (name === "wait_transcription") return sidecar.call("wait_transcription", args);
  if (name === "get_transcription_status") return sidecar.call("get_transcription_status", args);
  if (name === "read_transcript") return sidecar.call("read_transcript", args);
  if (name === "list_speakers") return sidecar.call("list_speakers", {});
  if (name === "search_transcript") return sidecar.call("search_transcript", args);
  if (name === "rollback_speaker_learning") return sidecar.call("rollback_learning", args);
  if (name === "correct_speaker") return sidecar.call("correct_speaker", args);
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: "unknown_tool" });
}

const server = new Server(serverInfo, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return result(await callTool(request.params.name, request.params.arguments || {}));
  } catch (error) {
    return errorResult(error);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  sidecar.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
