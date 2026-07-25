import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function startServer(extraEnv = {}) {
  const dataRoot = extraEnv.ZCODE_VOICE_DATA_DIR || path.join(os.tmpdir(), `voice-transcriber-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const child = spawn(process.execPath, ["scripts/mcp-server.mjs"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ZCODE_VOICE_DATA_DIR: dataRoot, ZCODE_VOICE_MOCK: "1", ...extraEnv },
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const item = pending.get(message.id);
    if (item) {
      pending.delete(message.id);
      item(message);
    }
  });
  return {
    child,
    dataRoot,
    request(method, params = {}) {
      const id = Math.floor(Math.random() * 1e9);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve) => pending.set(id, resolve));
    },
  };
}

test("ZCode MCP server exposes the local voice tools", async () => {
  const server = startServer();
  const response = await server.request("tools/list");
  const names = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["transcribe_audio"]);
  server.child.kill();
  await fs.rm(server.dataRoot, { recursive: true, force: true });
});

test("local engine reports health and caches a mock transcription", async () => {
  const server = startServer();
  const audioPath = path.join(os.tmpdir(), `voice-transcriber-${process.pid}.wav`);
  await fs.writeFile(audioPath, "test audio");

  const health = await server.request("tools/call", { name: "transcribe_audio", arguments: { operation: "status" } });
  assert.equal(health.result.structuredContent.status, "ok");

  const first = await server.request("tools/call", {
    name: "transcribe_audio",
    arguments: { audioPath, outputFormat: "json" },
  });
  const firstTask = first.result.structuredContent;
  assert.match(firstTask.taskId, /^task_/);
  assert.equal(firstTask.backend.asr, "mock");
  assert.match(firstTask.artifacts.json, /transcript\.json$/);

  const second = await server.request("tools/call", {
    name: "transcribe_audio",
    arguments: { audioPath, outputFormat: "json" },
  });
  assert.equal(second.result.structuredContent.cacheHit, true);

  const task = await server.request("tools/call", {
    name: "transcribe_audio",
    arguments: { operation: "read", taskId: firstTask.taskId, includeText: true, limit: 1 },
  });
  assert.equal(task.result.structuredContent.segments.length, 1);
  assert.match(task.result.structuredContent.text, /测试转写结果/);

  const search = await server.request("tools/call", {
    name: "transcribe_audio",
    arguments: { operation: "search", taskId: firstTask.taskId, query: "测试转写" },
  });
  assert.equal(search.result.structuredContent.totalMatches, 1);

  server.child.kill();
  await fs.rm(audioPath, { force: true });
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

  const first = await server.request("tools/call", {
    name: "transcribe_audio",
    arguments: { audioPath: audioOne, outputFormat: "json" },
  });
  const firstTask = first.result.structuredContent;
  assert.equal(firstTask.segments[0].speaker, "cluster_0");

  const correction = await server.request("tools/call", {
    name: "transcribe_audio",
    arguments: {
      operation: "correct_speaker",
      taskId: firstTask.taskId,
      segmentIds: [firstTask.segments[0].id],
      personName: "张老师",
    },
  });
  assert.equal(correction.result.structuredContent.correction.personName, "张老师");
  assert.equal(correction.result.structuredContent.learning.applied, true);
  const learningId = correction.result.structuredContent.learning.learningId;
  assert.match(learningId, /^learn_/);

  const second = await server.request("tools/call", {
    name: "transcribe_audio",
    arguments: { audioPath: audioTwo, outputFormat: "json" },
  });
  const secondTask = second.result.structuredContent;
  assert.equal(secondTask.segments[0].speaker, "张老师");
  assert.equal(secondTask.segments[0].speakerMatch, "known");

  const rollback = await server.request("tools/call", {
    name: "transcribe_audio",
    arguments: { operation: "rollback", learningId },
  });
  assert.deepEqual(rollback.result.structuredContent.profiles.profiles, []);

  server.child.kill();
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("long transcriptions keep the full local artifact but compact the MCP response", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-long-"));
  const audioPath = path.join(dataRoot, "long.wav");
  await fs.writeFile(audioPath, "long audio");
  const server = startServer({
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_VOICE_MOCK_TEXT: "长".repeat(80001),
  });

  const response = await server.request("tools/call", {
    name: "transcribe_audio",
    arguments: { audioPath, outputFormat: "json" },
  });
  const task = response.result.structuredContent;
  assert.equal(task.textTruncated, true);
  assert.equal(task.text, undefined);
  assert.equal(task.totalCharacters, 80001);
  assert.match(task.artifacts.json, /transcript\.json$/);

  const artifact = JSON.parse(await fs.readFile(task.artifacts.json, "utf8"));
  assert.equal(artifact.text.length, 80001);

  server.child.kill();
  await fs.rm(dataRoot, { recursive: true, force: true });
});
