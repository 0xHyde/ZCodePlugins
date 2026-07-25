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

const tools = [
  {
    name: "start_transcription",
    description: "创建本地录音转写任务。首次使用会在本地准备模型；返回 taskId 后请查询 get_transcription_status。",
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
    name: "get_transcription_status",
    description: "查询本地转写任务状态和阶段。任务未完成时继续轮询，完成后使用 read_transcript。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_transcript",
    description: "分页读取已完成任务的完整转写，避免把长录音全文一次性塞入上下文。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        offset: { type: "integer", minimum: 0, description: "片段起始位置" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "本次最多返回片段数" },
        includeText: { type: "boolean", description: "是否返回当前页文字" },
        segmentIds: { type: "array", items: { type: "string" } },
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
        taskId: { type: "string" },
        segmentIds: { type: "array", items: { type: "string" } },
        personId: { type: "string" },
        personName: { type: "string" },
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
      properties: { learningId: { type: "string" } },
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
        taskId: { type: "string" },
        query: { type: "string" },
        personId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
];

const sidecar = new SidecarClient({ packageRoot });

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function errorResult(error) {
  const value = {
    error: {
      code: error?.code || "voice_transcriber_error",
      message: error?.message || String(error),
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

async function callTool(name, args = {}) {
  if (name === "start_transcription") return sidecar.call("start_transcription", args);
  if (name === "get_transcription_status") return sidecar.call("get_transcription_status", args);
  if (name === "read_transcript") return sidecar.call("read_transcript", args);
  if (name === "list_speakers") return sidecar.call("list_speakers", {});
  if (name === "search_transcript") return sidecar.call("search_transcript", args);
  if (name === "rollback_speaker_learning") return sidecar.call("rollback_learning", args);
  if (name === "correct_speaker") {
    const correction = await sidecar.call("correct_speaker", args);
    if (args.autoLearn === false) return correction;
    try {
      const learning = await sidecar.call("enroll_from_correction", args);
      return { ...correction, learning: { learningId: learning.learningId, applied: true } };
    } catch (error) {
      return { ...correction, learning: { applied: false, code: error.code, reason: error.message } };
    }
  }
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

function shutdown() {
  sidecar.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
