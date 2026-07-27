import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

function startServer(extraEnv = {}) {
  const dataRoot = extraEnv.ZCODE_VOICE_DATA_DIR || path.join(os.tmpdir(), `voice-transcriber-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const child = spawn(process.execPath, ["scripts/mcp-server.mjs"], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ZCODE_VOICE_DATA_DIR: dataRoot, ZCODE_VOICE_MOCK: "1", ...extraEnv },
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const item = pending.get(message.id);
    if (item) {
      pending.delete(message.id);
      item(message);
    }
  });
  let nextId = 1;
  return {
    child,
    dataRoot,
    stderr,
    async initialize() {
      await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    request(method, params = {}) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve) => {
        pending.set(id, resolve);
      });
    },
    async call(name, args = {}) {
      const response = await this.request("tools/call", { name, arguments: args });
      const value = response.result?.structuredContent;
      if (response.result?.isError) throw Object.assign(new Error(value?.error?.message || "tool failed"), value?.error || {});
      return value;
    },
    async close() {
      child.kill();
      await fs.rm(dataRoot, { recursive: true, force: true });
    },
  };
}

async function waitFor(server, taskId) {
  for (let index = 0; index < 80; index += 1) {
    const status = await server.call("get_transcription_status", { taskId });
    if (status.status === "completed" || status.status === "failed") return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("task did not finish in test window");
}

test("ZCode MCP server exposes the asynchronous local voice workflow", async () => {
  const server = startServer();
  try {
    await server.initialize();
    const response = await server.request("tools/list");
    assert.deepEqual(response.result.tools.map((tool) => tool.name), [
      "start_transcription",
      "get_transcription_status",
      "read_transcript",
      "correct_speaker",
      "list_speakers",
      "rollback_speaker_learning",
      "search_transcript",
    ]);
  } finally {
    await server.close();
  }
});

test("async mock transcription creates a task and reads the completed transcript", async () => {
  const server = startServer();
  const audioPath = path.join(server.dataRoot, "sample.wav");
  await fs.mkdir(server.dataRoot, { recursive: true });
  await fs.writeFile(audioPath, "test audio");
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath, outputFormat: "json" });
    assert.match(started.taskId, /^task_/);
    assert.ok(["queued", "preparing_audio", "completed"].includes(started.status));
    const status = await waitFor(server, started.taskId);
    assert.equal(status.status, "completed");
    const transcript = await server.call("read_transcript", { taskId: started.taskId, includeText: true });
    assert.match(transcript.text, /本地语音引擎/);
    assert.equal(transcript.totalSegments, 1);
  } finally {
    await server.close();
  }
});

test("corrected meeting segments enroll and auto-match on a later recording", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-learning-"));
  const audioOne = path.join(dataRoot, "meeting-one.wav");
  const audioTwo = path.join(dataRoot, "meeting-two.wav");
  await fs.writeFile(audioOne, "meeting audio one");
  await fs.writeFile(audioTwo, "meeting audio two");
  const adapter = fileURLToPath(new URL("mock-campp-adapter.mjs", import.meta.url));
  const server = startServer({
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
  });
  try {
    await server.initialize();
    const first = await server.call("start_transcription", { audioPath: audioOne });
    await waitFor(server, first.taskId);
    const firstTranscript = await server.call("read_transcript", { taskId: first.taskId, includeText: true });
    const correction = await server.call("correct_speaker", {
      taskId: first.taskId,
      segmentIds: [firstTranscript.segments[0].id],
      personName: "张老师",
    });
    assert.equal(correction.correction.personName, "张老师");
    assert.equal(correction.learning.applied, true);
    const second = await server.call("start_transcription", { audioPath: audioTwo });
    await waitFor(server, second.taskId);
    const secondTranscript = await server.call("read_transcript", { taskId: second.taskId, includeText: true });
    assert.equal(secondTranscript.segments[0].speaker, "张老师");
  } finally {
    await server.close();
  }
});

test("long transcript remains local and can be read as a page", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-long-"));
  const audioPath = path.join(dataRoot, "long.wav");
  await fs.writeFile(audioPath, "long audio");
  const server = startServer({ ZCODE_VOICE_DATA_DIR: dataRoot, ZCODE_VOICE_MOCK_TEXT: "长".repeat(80001) });
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath, outputFormat: "json" });
    await waitFor(server, started.taskId);
    const page = await server.call("read_transcript", { taskId: started.taskId, includeText: true, limit: 1 });
    assert.equal(page.text.length, 80001);
    assert.match(page.artifacts.json, /transcript\.json$/);
    assert.match(page.artifacts.text, /transcript\.txt$/);
    assert.equal((await fs.readFile(page.artifacts.text, "utf8")).trim(), "长".repeat(80001));
  } finally {
    await server.close();
  }
});
