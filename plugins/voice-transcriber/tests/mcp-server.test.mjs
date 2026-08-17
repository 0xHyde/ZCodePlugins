import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

function startServer(extraEnv = {}, { keepData = false, entry = "scripts/mcp-server.mjs" } = {}) {
  const dataRoot = extraEnv.ZCODE_VOICE_DATA_DIR || path.join(os.tmpdir(), `voice-transcriber-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const child = spawn(process.execPath, [entry], {
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
      if (response.error) throw Object.assign(new Error(response.error.message || "MCP request failed"), response.error.data || {});
      const value = response.result?.structuredContent;
      if (response.result?.isError) throw Object.assign(new Error(value?.error?.message || "tool failed"), value?.error || {});
      return value;
    },
    async close() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.stdin.end();
        let timeout;
        const graceful = await Promise.race([
          exited.then(() => {
            clearTimeout(timeout);
            return true;
          }),
          new Promise((resolve) => {
            timeout = setTimeout(() => resolve(false), 1000);
            timeout.unref?.();
          }),
        ]);
        if (!graceful && child.exitCode === null) {
          child.kill();
          await exited;
        }
      }
      if (!keepData) await fs.rm(dataRoot, { recursive: true, force: true });
    },
  };
}

function expectedCamppCalls(...methods) {
  return process.platform === "win32" ? methods : methods.flatMap((method) => [method, "closed"]);
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
      "wait_transcription",
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

test("wait_transcription closes the asynchronous task loop without manual polling", async () => {
  const server = startServer({ ZCODE_VOICE_MOCK_DELAY_MS: "120" });
  const audioPath = path.join(server.dataRoot, "wait.wav");
  await fs.mkdir(server.dataRoot, { recursive: true });
  await fs.writeFile(audioPath, "wait audio");
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath });
    const completed = await server.call("wait_transcription", { taskId: started.taskId, timeoutSeconds: 2 });
    assert.equal(completed.status, "completed");
    assert.equal(completed.timedOut, false);
    assert.match(completed.artifacts.json, /transcript\.json$/);
  } finally {
    await server.close();
  }
});

test("built MCP entry completes the same start-wait-read workflow", async () => {
  const server = startServer({}, { entry: "dist/mcp/server.js" });
  const audioPath = path.join(server.dataRoot, "dist.wav");
  await fs.mkdir(server.dataRoot, { recursive: true });
  await fs.writeFile(audioPath, "dist audio");
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath });
    const completed = await server.call("wait_transcription", { taskId: started.taskId, timeoutSeconds: 2 });
    assert.equal(completed.status, "completed");
    const transcript = await server.call("read_transcript", { taskId: started.taskId, includeText: true });
    assert.match(transcript.text, /本地语音引擎/);
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
    assert.ok(["queued", "running", "completed"].includes(started.status));
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
  const callLog = path.join(dataRoot, "campp-calls.log");
  await fs.writeFile(audioOne, "meeting audio one");
  await fs.writeFile(audioTwo, "meeting audio two");
  const adapter = fileURLToPath(new URL("mock-campp-adapter.mjs", import.meta.url));
  const server = startServer({
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
    ZCODE_CAMPP_CALL_LOG: callLog,
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
    assert.equal(correction.learning.taskLinked, true);
    const second = await server.call("start_transcription", { audioPath: audioTwo });
    await waitFor(server, second.taskId);
    const secondTranscript = await server.call("read_transcript", { taskId: second.taskId, includeText: true });
    assert.equal(secondTranscript.segments[0].speaker, "张老师");
    assert.equal(secondTranscript.segments[0].speakerCluster, "cluster_0");
    assert.equal(secondTranscript.speakerAnalysis.algorithmVersion, "speaker-v2");
    assert.doesNotMatch(JSON.stringify(secondTranscript), /prototype|embedding|\[1,0,0,0\]/i);
    let calls = [];
    for (let index = 0; index < 20; index += 1) {
      calls = (await fs.readFile(callLog, "utf8")).trim().split(/\r?\n/);
      if (calls.length >= 4) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(calls, expectedCamppCalls("diarize", "diarize"));
  } finally {
    await server.close();
  }
});

test("speaker v2 correction expands to clean segments in the same cluster", async () => {
  const server = startServer();
  const taskId = `task_${"c".repeat(20)}`;
  await fs.mkdir(path.join(server.dataRoot, "tasks"), { recursive: true });
  await fs.writeFile(path.join(server.dataRoot, "tasks", `${taskId}.json`), JSON.stringify({
    taskId,
    status: "completed",
    audioPath: path.join(server.dataRoot, "cluster.wav"),
    options: { outputFormat: "markdown", speakerProfile: true },
    text: "甲乙丙",
    revision: 1,
    segments: [
      { id: "seg_0001", start: 0, end: 2, text: "甲", speaker: "cluster_0", speakerCluster: "cluster_0", speakerPurity: 0.95, mixedSpeaker: false },
      { id: "seg_0002", start: 2, end: 4, text: "乙", speaker: "cluster_0", speakerCluster: "cluster_0", speakerPurity: 0.92, mixedSpeaker: false },
      { id: "seg_0003", start: 4, end: 6, text: "丙", speaker: "cluster_0", speakerCluster: "cluster_0", speakerPurity: 0.55, mixedSpeaker: true },
    ],
    _speakerAnalysis: {
      algorithmVersion: "speaker-v2",
      clusters: [{ clusterId: "cluster_0", size: 3, prototype: [1, 0, 0, 0] }],
    },
  }));
  try {
    await server.initialize();
    const corrected = await server.call("correct_speaker", {
      taskId,
      segmentIds: ["seg_0001"],
      personName: "王老师",
      autoLearn: false,
    });
    assert.deepEqual(corrected.correction.requestedSegmentIds, ["seg_0001"]);
    assert.deepEqual(corrected.correction.segmentIds, ["seg_0001", "seg_0002"]);
    const transcript = await server.call("read_transcript", { taskId });
    assert.deepEqual(transcript.segments.map((segment) => segment.speaker), ["王老师", "王老师", "cluster_0"]);
  } finally {
    await server.close();
  }
});

test("rolling back one learning event preserves later confirmed samples", async () => {
  const server = startServer();
  await fs.mkdir(path.join(server.dataRoot, "tasks"), { recursive: true });
  const makeTask = async (suffix, prototype) => {
    const taskId = `task_${suffix.repeat(20)}`;
    await fs.writeFile(path.join(server.dataRoot, "tasks", `${taskId}.json`), JSON.stringify({
      taskId,
      status: "completed",
      audioPath: path.join(server.dataRoot, `${suffix}.wav`),
      options: { outputFormat: "markdown", speakerProfile: true },
      text: suffix,
      revision: 1,
      segments: [{ id: "seg_0001", start: 0, end: 2, text: suffix, speaker: "cluster_0", speakerCluster: "cluster_0", speakerPurity: 0.95, mixedSpeaker: false }],
      _speakerAnalysis: {
        algorithmVersion: "speaker-v2",
        clusters: [{ clusterId: "cluster_0", size: 2, windowCount: 2, prototype }],
      },
    }));
    return taskId;
  };
  try {
    await server.initialize();
    const firstTaskId = await makeTask("d", [1, 0, 0, 0]);
    const secondTaskId = await makeTask("e", [0.99, 0.01, 0, 0]);
    const [first, second] = await Promise.all([
      server.call("correct_speaker", {
        taskId: firstTaskId,
        segmentIds: ["seg_0001"],
        personId: "person_teacher",
        personName: "老师",
      }),
      server.call("correct_speaker", {
        taskId: secondTaskId,
        segmentIds: ["seg_0001"],
        personId: "person_teacher",
        personName: "老师",
      }),
    ]);
    assert.equal(first.learning.applied, true);
    assert.equal(second.learning.applied, true);
    await server.call("rollback_speaker_learning", { learningId: first.learning.learningId });
    const speakers = await server.call("list_speakers");
    assert.equal(speakers.profiles.length, 1);
    assert.equal(speakers.profiles[0].confirmedSampleCount, 1);
    const stored = JSON.parse(await fs.readFile(path.join(server.dataRoot, "profiles.json"), "utf8"));
    assert.equal(stored.profiles[0].confirmedSamples[0].learningId, second.learning.learningId);
  } finally {
    await server.close();
  }
});

test("speaker backend failure keeps the transcription usable", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-speaker-fallback-"));
  const audioPath = path.join(dataRoot, "speaker-fallback.wav");
  const modelPath = path.join(dataRoot, "cam++.onnx");
  const adapter = path.join(dataRoot, "failing-adapter.mjs");
  await fs.writeFile(audioPath, "speaker fallback audio");
  await fs.writeFile(modelPath, "mock model");
  await fs.writeFile(adapter, [
    'import readline from "node:readline";',
    'const input = readline.createInterface({ input: process.stdin });',
    'input.on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "backend_failed", message: "speaker crashed" } })}\\n`);',
    '});',
  ].join("\n"));
  const server = startServer({
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
    ZCODE_CAMPP_MODEL: modelPath,
  });
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath });
    const completed = await waitFor(server, started.taskId);
    assert.equal(completed.status, "completed");
    assert.match(completed.warnings.join("\n"), /说话人分析失败/);
    const transcript = await server.call("read_transcript", { taskId: started.taskId, includeText: true });
    assert.match(transcript.text, /本地语音引擎/);
    assert.equal(transcript.segments[0].speaker, "unknown");
    assert.equal(transcript.speakerAnalysis.status, "failed");
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
    assert.equal(page.cacheIdentity, undefined);
    assert.match(page.artifacts.json, /transcript\.json$/);
    assert.match(page.artifacts.text, /transcript\.txt$/);
    assert.equal((await fs.readFile(page.artifacts.text, "utf8")).trim(), "长".repeat(80001));
    const cached = await server.call("start_transcription", { audioPath, outputFormat: "json" });
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.status, "completed");
    assert.equal(cached.totalCharacters, 80001);
    assert.equal(cached.text, undefined);
    assert.equal(cached.segments, undefined);
    assert.equal(cached.cacheIdentity, undefined);
    assert.ok(cached.preview.length <= 1200);
  } finally {
    await server.close();
  }
});

test("rejects traversal and malformed task, learning, segment, and person identifiers", async () => {
  const server = startServer();
  const validTaskId = `task_${"a".repeat(20)}`;
  await fs.mkdir(path.join(server.dataRoot, "tasks"), { recursive: true });
  await fs.writeFile(path.join(server.dataRoot, "tasks", `${validTaskId}.json`), JSON.stringify({
    taskId: validTaskId,
    status: "completed",
    options: { outputFormat: "markdown", speakerProfile: true },
    text: "安全测试",
    segments: [{ id: "seg_0001", text: "安全测试", speaker: "unknown" }],
    corrections: [],
    learningIds: [],
  }));
  try {
    await server.initialize();
    await assert.rejects(
      server.call("get_transcription_status", { taskId: "../../profiles" }),
      (error) => error.code === "invalid_task_id" || /taskId|invalid/i.test(error.message),
    );
    await assert.rejects(
      server.call("read_transcript", { taskId: validTaskId, segmentIds: ["../seg_0001"] }),
      (error) => error.code === "invalid_segment_id" || /segmentIds|invalid/i.test(error.message),
    );
    await assert.rejects(
      server.call("search_transcript", { taskId: validTaskId, personId: "person_../../secret" }),
      (error) => error.code === "invalid_person_id" || /personId|invalid/i.test(error.message),
    );
    await assert.rejects(
      server.call("rollback_speaker_learning", { learningId: "../../profiles" }),
      (error) => error.code === "invalid_learning_id" || /learningId|invalid/i.test(error.message),
    );
    const transcript = await server.call("read_transcript", { taskId: validTaskId, segmentIds: ["seg_0001"] });
    assert.equal(transcript.returnedSegments, 1);
  } finally {
    await server.close();
  }
});

test("read_transcript pagination uses offset plus returned segment count", async () => {
  const server = startServer();
  const taskId = `task_${"b".repeat(20)}`;
  await fs.mkdir(path.join(server.dataRoot, "tasks"), { recursive: true });
  await fs.writeFile(path.join(server.dataRoot, "tasks", `${taskId}.json`), JSON.stringify({
    taskId,
    status: "completed",
    text: "一二三",
    segments: ["一", "二", "三"].map((text, index) => ({ id: `seg_${String(index + 1).padStart(4, "0")}`, text })),
  }));
  try {
    await server.initialize();
    const middle = await server.call("read_transcript", { taskId, offset: 1, limit: 1 });
    assert.equal(middle.hasMoreSegments, true);
    const end = await server.call("read_transcript", { taskId, offset: 3, limit: 1 });
    assert.equal(end.returnedSegments, 0);
    assert.equal(end.hasMoreSegments, false);
  } finally {
    await server.close();
  }
});

test("correct_speaker atomically refreshes full transcript artifacts", async () => {
  const server = startServer();
  const audioPath = path.join(server.dataRoot, "correction.wav");
  await fs.mkdir(server.dataRoot, { recursive: true });
  await fs.writeFile(audioPath, "test audio");
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath, outputFormat: "json" });
    await waitFor(server, started.taskId);
    const before = await server.call("read_transcript", { taskId: started.taskId });
    const corrected = await server.call("correct_speaker", {
      taskId: started.taskId,
      segmentIds: [before.segments[0].id],
      personName: "王老师",
      autoLearn: false,
    });
    assert.notEqual(corrected.artifacts.json, before.artifacts.json);
    assert.equal(corrected.revision, 2);
    const artifactJson = JSON.parse(await fs.readFile(corrected.artifacts.json, "utf8"));
    const artifactMarkdown = await fs.readFile(corrected.artifacts.markdown, "utf8");
    assert.equal(artifactJson.segments[0].speaker, "王老师");
    assert.match(artifactMarkdown, /王老师/);
    const task = JSON.parse(await fs.readFile(path.join(server.dataRoot, "tasks", `${started.taskId}.json`), "utf8"));
    assert.deepEqual(task.artifacts, corrected.artifacts);
    assert.equal(task.revision, 2);
  } finally {
    await server.close();
  }
});

test("correct_speaker rejects missing segments and preserves transcript text that looks like JSON", async () => {
  const mockText = '讨论字段示例："vector":[1,2,3]，正文不能被脱敏器修改。';
  const server = startServer({ ZCODE_VOICE_MOCK_TEXT: mockText });
  const audioPath = path.join(server.dataRoot, "literal-vector.wav");
  await fs.mkdir(server.dataRoot, { recursive: true });
  await fs.writeFile(audioPath, "test audio");
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath });
    await waitFor(server, started.taskId);
    const transcript = await server.call("read_transcript", { taskId: started.taskId, includeText: true });
    assert.equal(transcript.text, mockText);
    await assert.rejects(
      server.call("correct_speaker", {
        taskId: started.taskId,
        segmentIds: ["seg_missing"],
        personName: "测试人",
        autoLearn: false,
      }),
      (error) => error.code === "segment_not_found",
    );
  } finally {
    await server.close();
  }
});

test("concurrent corrections use independent atomic temporary files", async () => {
  const server = startServer();
  const audioPath = path.join(server.dataRoot, "concurrent-correction.wav");
  await fs.mkdir(server.dataRoot, { recursive: true });
  await fs.writeFile(audioPath, "test audio");
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath });
    await waitFor(server, started.taskId);
    const transcript = await server.call("read_transcript", { taskId: started.taskId });
    const segmentIds = [transcript.segments[0].id];
    const results = await Promise.all([
      server.call("correct_speaker", { taskId: started.taskId, segmentIds, personName: "甲", autoLearn: false }),
      server.call("correct_speaker", { taskId: started.taskId, segmentIds, personName: "乙", autoLearn: false }),
    ]);
    assert.equal(results.length, 2);
    const stored = JSON.parse(await fs.readFile(results[0].artifacts.json, "utf8"));
    assert.equal(stored.segments.length, 1);
    assert.ok(["甲", "乙"].includes(stored.segments[0].speaker));
    const residue = (await fs.readdir(path.dirname(results[0].artifacts.json))).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(residue, []);
  } finally {
    await server.close();
  }
});

test("speaker enrollment and listing never expose voiceprint vectors through MCP", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-private-"));
  const audioPath = path.join(dataRoot, "private.wav");
  const modelPath = path.join(dataRoot, "cam++.onnx");
  await fs.writeFile(audioPath, "private audio");
  await fs.writeFile(modelPath, "mock model");
  const adapter = fileURLToPath(new URL("mock-campp-adapter.mjs", import.meta.url));
  const server = startServer({
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
    ZCODE_CAMPP_MODEL: modelPath,
  });
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath });
    await waitFor(server, started.taskId);
    const transcript = await server.call("read_transcript", { taskId: started.taskId });
    const correction = await server.call("correct_speaker", {
      taskId: started.taskId,
      segmentIds: [transcript.segments[0].id],
      personName: "李老师",
    });
    const speakers = await server.call("list_speakers");
    for (const value of [correction, speakers]) {
      const serialized = JSON.stringify(value);
      assert.doesNotMatch(serialized, /"(?:prototype|embedding|embeddings|vector)"/i);
      assert.doesNotMatch(serialized, /\[1,0,0,0\]/);
    }
    const stored = JSON.parse(await fs.readFile(path.join(dataRoot, "profiles.json"), "utf8"));
    assert.deepEqual(stored.profiles[0].prototype, [1, 0, 0, 0]);
    assert.deepEqual(stored.profiles[0].confirmedSamples[0].vector, [1, 0, 0, 0]);
  } finally {
    await server.close();
  }
});

test("speaker backend errors redact embedded voiceprint vectors", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-private-error-"));
  const audioPath = path.join(dataRoot, "private-error.wav");
  const modelPath = path.join(dataRoot, "cam++.onnx");
  const adapter = path.join(dataRoot, "error-adapter.mjs");
  await fs.writeFile(audioPath, "private error audio");
  await fs.writeFile(modelPath, "mock model");
  await fs.writeFile(adapter, [
    'import readline from "node:readline";',
    'const input = readline.createInterface({ input: process.stdin });',
    'input.on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  const message = \'backend rejected {"embedding":[0.11,0.22,0.33]}\';',
    '  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "backend_failed", message } })}\\n`);',
    '});',
  ].join("\n"));
  const server = startServer({
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
    ZCODE_CAMPP_MODEL: modelPath,
  });
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath, speakerProfile: false });
    await waitFor(server, started.taskId);
    const transcript = await server.call("read_transcript", { taskId: started.taskId });
    const correction = await server.call("correct_speaker", {
      taskId: started.taskId,
      segmentIds: [transcript.segments[0].id],
      personName: "隐私测试",
    });
    assert.equal(correction.learning.applied, false);
    assert.doesNotMatch(correction.learning.reason, /0\.11|0\.22|0\.33|"embedding"/);
    assert.match(correction.learning.reason, /redacted/);
  } finally {
    await server.close();
  }
});

test("sensitive directories and files use private POSIX permissions and leave no temporary files", { skip: process.platform === "win32" }, async () => {
  const server = startServer();
  const audioPath = path.join(server.dataRoot, "permissions.wav");
  await fs.mkdir(server.dataRoot, { recursive: true });
  await fs.writeFile(audioPath, "test audio");
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath });
    const completed = await waitFor(server, started.taskId);
    assert.equal(completed.status, "completed");
    for (const directory of [server.dataRoot, path.join(server.dataRoot, "tasks"), path.join(server.dataRoot, "artifacts"), path.dirname(completed.artifacts.json)]) {
      assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    }
    for (const file of [path.join(server.dataRoot, "tasks", `${started.taskId}.json`), ...Object.values(completed.artifacts)]) {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
    const residue = (await fs.readdir(path.dirname(completed.artifacts.json))).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(residue, []);
  } finally {
    await server.close();
  }
});

test("task cache identity is explicitly versioned and separates ASR, speaker, and render configuration", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-cache-"));
  const audioPath = path.join(dataRoot, "cache.wav");
  const modelPath = path.join(dataRoot, "cam++.onnx");
  const asrLog = path.join(dataRoot, "asr-calls.log");
  const camppLog = path.join(dataRoot, "campp-calls.log");
  const adapter = fileURLToPath(new URL("mock-campp-adapter.mjs", import.meta.url));
  await fs.writeFile(audioPath, "cache audio");
  await fs.writeFile(modelPath, "mock model");
  const baseEnv = {
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
    ZCODE_CAMPP_MODEL: modelPath,
    ZCODE_VOICE_ASR_CALL_LOG: asrLog,
    ZCODE_CAMPP_CALL_LOG: camppLog,
  };
  let firstTaskId;
  const firstServer = startServer({ ...baseEnv, ZCODE_CAMPP_MATCH_THRESHOLD: "0.62", ZCODE_CAMPP_CLUSTER_THRESHOLD: "0.35" }, { keepData: true });
  try {
    await firstServer.initialize();
    const first = await firstServer.call("start_transcription", { audioPath, outputFormat: "markdown" });
    firstTaskId = first.taskId;
    await waitFor(firstServer, first.taskId);
    const task = JSON.parse(await fs.readFile(path.join(dataRoot, "tasks", `${first.taskId}.json`), "utf8"));
    assert.match(task.cacheIdentity.pipelineVersion, /^voice-transcriber-v0\.4/);
    assert.match(task.cacheIdentity.pluginVersion, /^0\./);
    assert.equal(task.cacheIdentity.asr.language, "auto");
    assert.equal(task.cacheIdentity.speaker.matchThreshold, 0.62);
    assert.equal(task.cacheIdentity.render.outputFormat, "markdown");
    assert.equal(task.cache.asr.hit, false);
    assert.equal(task.cache.speaker.hit, false);
  } finally {
    await firstServer.close();
  }

  const secondServer = startServer({ ...baseEnv, ZCODE_CAMPP_MATCH_THRESHOLD: "0.70", ZCODE_CAMPP_CLUSTER_THRESHOLD: "0.35" }, { keepData: true });
  try {
    await secondServer.initialize();
    const second = await secondServer.call("start_transcription", { audioPath, outputFormat: "markdown" });
    assert.notEqual(second.taskId, firstTaskId);
    await waitFor(secondServer, second.taskId);
    const task = JSON.parse(await fs.readFile(path.join(dataRoot, "tasks", `${second.taskId}.json`), "utf8"));
    assert.equal(task.cache.asr.hit, true);
    assert.equal(task.cache.speaker.hit, true);
  } finally {
    await secondServer.close();
  }

  const thirdServer = startServer({ ...baseEnv, ZCODE_CAMPP_MATCH_THRESHOLD: "0.70", ZCODE_CAMPP_CLUSTER_THRESHOLD: "0.45" });
  try {
    await thirdServer.initialize();
    const third = await thirdServer.call("start_transcription", { audioPath, outputFormat: "markdown" });
    await waitFor(thirdServer, third.taskId);
    const task = JSON.parse(await fs.readFile(path.join(dataRoot, "tasks", `${third.taskId}.json`), "utf8"));
    assert.equal(task.cache.asr.hit, true);
    assert.equal(task.cache.speaker.hit, false);
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["transcribe"]);
    let camppCalls = [];
    for (let index = 0; index < 20; index += 1) {
      camppCalls = (await fs.readFile(camppLog, "utf8")).trim().split(/\r?\n/);
      if (camppCalls.length >= 4) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(camppCalls, expectedCamppCalls("diarize", "diarize"));
  } finally {
    await thirdServer.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("stage caches follow dependency bytes instead of configured file locations", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-content-cache-"));
  const audioPath = path.join(dataRoot, "content-cache.wav");
  const firstRoot = path.join(dataRoot, "models-a");
  const secondRoot = path.join(dataRoot, "models-b");
  const asrLog = path.join(dataRoot, "asr-calls.log");
  const camppLog = path.join(dataRoot, "campp-calls.log");
  const adapter = fileURLToPath(new URL("mock-campp-adapter.mjs", import.meta.url));
  await fs.mkdir(firstRoot, { recursive: true });
  await fs.mkdir(secondRoot, { recursive: true });
  await fs.writeFile(audioPath, "content cache audio");
  const modelFiles = [
    ["sensevoice.gguf", "same asr model"],
    ["vad.gguf", "same vad model"],
    ["campp.onnx", "same speaker model"],
  ];
  for (const [name, content] of modelFiles) {
    await fs.writeFile(path.join(firstRoot, name), content);
    await fs.writeFile(path.join(secondRoot, name), content);
  }
  const environment = (root) => ({
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_SENSEVOICE_MODEL: path.join(root, "sensevoice.gguf"),
    ZCODE_FSMN_VAD_MODEL: path.join(root, "vad.gguf"),
    ZCODE_CAMPP_MODEL: path.join(root, "campp.onnx"),
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
    ZCODE_VOICE_ASR_CALL_LOG: asrLog,
    ZCODE_CAMPP_CALL_LOG: camppLog,
  });

  let firstTaskId;
  const firstServer = startServer(environment(firstRoot), { keepData: true });
  try {
    await firstServer.initialize();
    const started = await firstServer.call("start_transcription", { audioPath });
    firstTaskId = started.taskId;
    assert.equal((await waitFor(firstServer, started.taskId)).status, "completed");
  } finally {
    await firstServer.close();
  }

  const secondServer = startServer(environment(secondRoot));
  try {
    await secondServer.initialize();
    const started = await secondServer.call("start_transcription", { audioPath });
    assert.notEqual(started.taskId, firstTaskId);
    assert.equal((await waitFor(secondServer, started.taskId)).status, "completed");
    const task = JSON.parse(await fs.readFile(path.join(dataRoot, "tasks", `${started.taskId}.json`), "utf8"));
    assert.equal(task.cache.asr.hit, true);
    assert.equal(task.cache.speaker.hit, true);
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["transcribe"]);
    assert.deepEqual((await fs.readFile(camppLog, "utf8")).trim().split(/\r?\n/), expectedCamppCalls("diarize"));
  } finally {
    await secondServer.close();
  }
});

test("speaker projection identity follows profile prototype bytes instead of timestamps alone", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-profile-cache-"));
  const audioPath = path.join(dataRoot, "profile-cache.wav");
  const modelPath = path.join(dataRoot, "cam++.onnx");
  const asrLog = path.join(dataRoot, "asr-calls.log");
  const camppLog = path.join(dataRoot, "campp-calls.log");
  const adapter = fileURLToPath(new URL("mock-campp-adapter.mjs", import.meta.url));
  const fixedTimestamp = "2026-01-01T00:00:00.000Z";
  await fs.writeFile(audioPath, "profile cache audio");
  await fs.writeFile(modelPath, "profile cache model");
  const writeProfile = (prototype) => fs.writeFile(path.join(dataRoot, "profiles.json"), JSON.stringify({
    version: 2,
    profiles: [{
      personId: "person_profile_cache",
      name: "固定姓名",
      prototype,
      confirmedSamples: [],
      candidateSamples: [],
      updatedAt: fixedTimestamp,
    }],
  }));
  await writeProfile([1, 0, 0, 0]);
  const env = {
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
    ZCODE_CAMPP_MODEL: modelPath,
    ZCODE_VOICE_ASR_CALL_LOG: asrLog,
    ZCODE_CAMPP_CALL_LOG: camppLog,
  };
  let firstTaskId;
  const firstServer = startServer(env, { keepData: true });
  try {
    await firstServer.initialize();
    const first = await firstServer.call("start_transcription", { audioPath });
    firstTaskId = first.taskId;
    assert.equal((await waitFor(firstServer, first.taskId)).status, "completed");
    const transcript = await firstServer.call("read_transcript", { taskId: first.taskId });
    assert.equal(transcript.segments[0].speaker, "固定姓名");
  } finally {
    await firstServer.close();
  }

  await writeProfile([0, 1, 0, 0]);
  const secondServer = startServer(env);
  try {
    await secondServer.initialize();
    const second = await secondServer.call("start_transcription", { audioPath });
    assert.notEqual(second.taskId, firstTaskId);
    assert.equal((await waitFor(secondServer, second.taskId)).status, "completed");
    const transcript = await secondServer.call("read_transcript", { taskId: second.taskId });
    assert.equal(transcript.segments[0].speaker, "cluster_0");
    assert.equal(transcript.cache.asr.hit, true);
    assert.equal(transcript.cache.speaker.hit, true);
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["transcribe"]);
    assert.deepEqual((await fs.readFile(camppLog, "utf8")).trim().split(/\r?\n/), expectedCamppCalls("diarize"));
  } finally {
    await secondServer.close();
  }
});

test("completed tasks follow the configured model SHA without repeating the first transcription", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-model-identity-"));
  const audioPath = path.join(dataRoot, "identity.wav");
  const modelPath = path.join(dataRoot, "late-asr.gguf");
  const asrLog = path.join(dataRoot, "asr-calls.log");
  await fs.writeFile(audioPath, "identity audio");
  const baseEnv = {
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_SENSEVOICE_MODEL: modelPath,
    ZCODE_VOICE_ASR_CALL_LOG: asrLog,
  };

  let taskId;
  let firstCacheKey;
  const firstServer = startServer({ ...baseEnv, ZCODE_VOICE_MOCK_DELAY_MS: "120" }, { keepData: true });
  try {
    await firstServer.initialize();
    const started = await firstServer.call("start_transcription", { audioPath, speakerProfile: false });
    taskId = started.taskId;
    await new Promise((resolve) => setTimeout(resolve, 40));
    await fs.writeFile(modelPath, "model-version-one");
    assert.equal((await waitFor(firstServer, taskId)).status, "completed");
    const stored = JSON.parse(await fs.readFile(path.join(dataRoot, "tasks", `${taskId}.json`), "utf8"));
    firstCacheKey = stored.cache.asr.key;
    assert.match(stored.cache.dependencies.asr.model.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await firstServer.close();
  }

  const secondServer = startServer(baseEnv, { keepData: true });
  try {
    await secondServer.initialize();
    const reused = await secondServer.call("start_transcription", { audioPath, speakerProfile: false });
    assert.equal(reused.taskId, taskId);
    assert.equal(reused.status, "completed");
    assert.equal(reused.cacheHit, true);
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["transcribe"]);
  } finally {
    await secondServer.close();
  }

  await fs.writeFile(modelPath, "model-version-two");
  const thirdServer = startServer(baseEnv);
  try {
    await thirdServer.initialize();
    const restarted = await thirdServer.call("start_transcription", { audioPath, speakerProfile: false });
    assert.equal(restarted.taskId, taskId);
    assert.notEqual(restarted.cacheHit, true);
    assert.equal((await waitFor(thirdServer, taskId)).status, "completed");
    const stored = JSON.parse(await fs.readFile(path.join(dataRoot, "tasks", `${taskId}.json`), "utf8"));
    assert.notEqual(stored.cache.asr.key, firstCacheKey);
    assert.equal(stored.revision, 2);
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["transcribe", "transcribe"]);
  } finally {
    await thirdServer.close();
  }
});

test("restart marks work interrupted and reuses its completed ASR checkpoint", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-restart-"));
  const audioPath = path.join(dataRoot, "restart.wav");
  const modelPath = path.join(dataRoot, "cam++.onnx");
  const adapter = path.join(dataRoot, "recovering-adapter.mjs");
  const releaseFile = path.join(dataRoot, "release-speaker");
  const asrLog = path.join(dataRoot, "asr-calls.log");
  await fs.writeFile(audioPath, "restart audio");
  await fs.writeFile(modelPath, "speaker model");
  await fs.writeFile(adapter, [
    'import fs from "node:fs";',
    'import readline from "node:readline";',
    'const releaseFile = process.argv[2];',
    'const input = readline.createInterface({ input: process.stdin });',
    'input.on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  if (!fs.existsSync(releaseFile)) return;',
    '  const segment = request.params.segments[0];',
    '  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { algorithmVersion: "speaker-v2", segments: [{ ...segment, speaker: "cluster_0", speakerCluster: "cluster_0" }], clusters: [{ clusterId: "cluster_0", prototype: [1, 0, 0, 0], windowCount: 2 }], metrics: { clusterCount: 1 } } })}\\n`);',
    '});',
  ].join("\n"));
  const env = {
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_VOICE_ASR_CALL_LOG: asrLog,
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter, releaseFile]),
    ZCODE_CAMPP_MODEL: modelPath,
  };

  let taskId;
  const firstServer = startServer(env, { keepData: true });
  try {
    await firstServer.initialize();
    taskId = (await firstServer.call("start_transcription", { audioPath })).taskId;
    for (let index = 0; index < 80; index += 1) {
      const status = await firstServer.call("get_transcription_status", { taskId });
      if (status.progress.stage === "identifying_speakers") {
        assert.equal(status.status, "running");
        break;
      }
      if (index === 79) throw new Error("speaker stage did not start");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await firstServer.close();
  }

  await fs.writeFile(releaseFile, "ready");
  const secondServer = startServer(env);
  try {
    await secondServer.initialize();
    const interrupted = await secondServer.call("get_transcription_status", { taskId });
    assert.equal(interrupted.status, "interrupted");
    const restarted = await secondServer.call("start_transcription", { audioPath });
    assert.equal(restarted.taskId, taskId);
    assert.ok(["queued", "running"].includes(restarted.status));
    assert.equal((await waitFor(secondServer, taskId)).status, "completed");
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["transcribe"]);
  } finally {
    await secondServer.close();
  }
});

test("simultaneous ZCode sessions share one active transcription without interrupting or duplicating it", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-two-sessions-"));
  const audioPath = path.join(dataRoot, "shared.wav");
  const asrLog = path.join(dataRoot, "asr-calls.log");
  await fs.writeFile(audioPath, "shared session audio");
  const env = {
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_VOICE_ASR_CALL_LOG: asrLog,
    ZCODE_VOICE_MOCK_DELAY_MS: "350",
  };
  const firstServer = startServer(env, { keepData: true });
  const secondServer = startServer(env, { keepData: true });
  try {
    await firstServer.initialize();
    const first = await firstServer.call("start_transcription", { audioPath, speakerProfile: false });
    for (let index = 0; index < 40; index += 1) {
      const status = await firstServer.call("get_transcription_status", { taskId: first.taskId });
      if (status.status === "running") break;
      if (index === 39) throw new Error("first shared task did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await secondServer.initialize();
    const observed = await secondServer.call("get_transcription_status", { taskId: first.taskId });
    assert.equal(observed.status, "running");
    const duplicate = await secondServer.call("start_transcription", { audioPath, speakerProfile: false });
    assert.equal(duplicate.taskId, first.taskId);
    assert.equal(duplicate.status, "running");
    assert.equal((await waitFor(secondServer, first.taskId)).status, "completed");
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["transcribe"]);
  } finally {
    await Promise.all([firstServer.close(), secondServer.close()]);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("simultaneous ZCode sessions serialize different heavy transcriptions", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-shared-engine-"));
  const firstAudio = path.join(dataRoot, "first-session.wav");
  const secondAudio = path.join(dataRoot, "second-session.wav");
  const asrLog = path.join(dataRoot, "asr-calls.log");
  await fs.writeFile(firstAudio, "first session audio");
  await fs.writeFile(secondAudio, "second session audio");
  const env = {
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_VOICE_ASR_CALL_LOG: asrLog,
    ZCODE_VOICE_MOCK_DELAY_MS: "300",
  };
  const firstServer = startServer(env, { keepData: true });
  const secondServer = startServer(env, { keepData: true });
  try {
    await Promise.all([firstServer.initialize(), secondServer.initialize()]);
    const first = await firstServer.call("start_transcription", { audioPath: firstAudio, speakerProfile: false });
    for (let index = 0; index < 40; index += 1) {
      const calls = await fs.readFile(asrLog, "utf8").catch(() => "");
      if (calls.trim()) break;
      if (index === 39) throw new Error("first session did not enter ASR");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = await secondServer.call("start_transcription", { audioPath: secondAudio, speakerProfile: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await secondServer.call("get_transcription_status", { taskId: second.taskId })).status, "queued");
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["transcribe"]);
    assert.equal((await waitFor(firstServer, first.taskId)).status, "completed");
    assert.equal((await waitFor(secondServer, second.taskId)).status, "completed");
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["transcribe", "transcribe"]);
  } finally {
    await Promise.all([firstServer.close(), secondServer.close()]);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("simultaneous ZCode sessions preserve independent speaker corrections and learning samples", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-two-session-learning-"));
  const taskRoot = path.join(dataRoot, "tasks");
  await fs.mkdir(taskRoot, { recursive: true });
  const taskIds = [`task_${"a".repeat(20)}`, `task_${"b".repeat(20)}`];
  for (const [index, taskId] of taskIds.entries()) {
    await fs.writeFile(path.join(taskRoot, `${taskId}.json`), JSON.stringify({
      taskId,
      status: "completed",
      audioPath: path.join(dataRoot, `learning-${index}.wav`),
      options: { outputFormat: "markdown", speakerProfile: true },
      text: `样本${index + 1}`,
      revision: 1,
      segments: [{
        id: "seg_0001",
        start: 0,
        end: 2,
        text: `样本${index + 1}`,
        speaker: "cluster_0",
        speakerCluster: "cluster_0",
        speakerPurity: 0.95,
        mixedSpeaker: false,
      }],
      _speakerAnalysis: {
        algorithmVersion: "speaker-v2",
        clusters: [{
          clusterId: "cluster_0",
          prototype: index === 0 ? [1, 0, 0, 0] : [0.99, 0.01, 0, 0],
          windowCount: 2,
        }],
      },
      corrections: [],
      learningIds: [],
    }));
  }
  const env = { ZCODE_VOICE_DATA_DIR: dataRoot };
  const firstServer = startServer(env, { keepData: true });
  const secondServer = startServer(env, { keepData: true });
  try {
    await Promise.all([firstServer.initialize(), secondServer.initialize()]);
    const corrections = await Promise.all([
      firstServer.call("correct_speaker", {
        taskId: taskIds[0],
        segmentIds: ["seg_0001"],
        personId: "person_shared",
        personName: "同一位受访者",
      }),
      secondServer.call("correct_speaker", {
        taskId: taskIds[1],
        segmentIds: ["seg_0001"],
        personId: "person_shared",
        personName: "同一位受访者",
      }),
    ]);
    assert.ok(corrections.every((result) => result.learning.applied));
    const speakers = await firstServer.call("list_speakers");
    assert.equal(speakers.profiles.length, 1);
    assert.equal(speakers.profiles[0].confirmedSampleCount, 2);
    const storedProfiles = JSON.parse(await fs.readFile(path.join(dataRoot, "profiles.json"), "utf8"));
    assert.equal(storedProfiles.profiles[0].confirmedSamples.length, 2);
    for (const taskId of taskIds) {
      const task = JSON.parse(await fs.readFile(path.join(taskRoot, `${taskId}.json`), "utf8"));
      assert.equal(task.revision, 2);
      assert.equal(task.learningIds.length, 1);
    }
  } finally {
    await Promise.all([firstServer.close(), secondServer.close()]);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("failed chunked transcription resumes by ASR identity after speaker profiles change", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-chunk-resume-"));
  const audioPath = path.join(dataRoot, "chunk-resume.wav");
  const failOnceFile = path.join(dataRoot, "failed-once");
  const asrLog = path.join(dataRoot, "asr-chunks.log");
  await fs.writeFile(audioPath, "chunk resume audio");
  const env = {
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_VOICE_ASR_CALL_LOG: asrLog,
    ZCODE_VOICE_MOCK_CHUNKS: "3",
    ZCODE_VOICE_MOCK_FAIL_AFTER_CHUNKS: "1",
    ZCODE_VOICE_MOCK_FAIL_ONCE_FILE: failOnceFile,
  };

  const firstServer = startServer(env, { keepData: true });
  let taskId;
  try {
    await firstServer.initialize();
    taskId = (await firstServer.call("start_transcription", { audioPath })).taskId;
    const failed = await waitFor(firstServer, taskId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.partialAvailable, true);
    assert.equal(failed.partial.resumable, true);
    const partial = await firstServer.call("read_transcript", { taskId, includeText: true });
    assert.equal(partial.returnedSegments, 1);
    await assert.rejects(
      firstServer.call("correct_speaker", { taskId, segmentIds: [partial.segments[0].id], personName: "过早修正" }),
      (error) => error.code === "task_not_completed",
    );
  } finally {
    await firstServer.close();
  }

  await fs.writeFile(path.join(dataRoot, "profiles.json"), JSON.stringify({
    version: 2,
    profiles: [{
      personId: "person_checkpoint_change",
      name: "新档案",
      prototype: [1, 0, 0, 0],
      confirmedSamples: [],
      candidateSamples: [],
      updatedAt: new Date().toISOString(),
    }],
  }));

  const secondServer = startServer(env);
  try {
    await secondServer.initialize();
    const restarted = await secondServer.call("start_transcription", { audioPath });
    assert.notEqual(restarted.taskId, taskId);
    assert.equal((await waitFor(secondServer, restarted.taskId)).status, "completed");
    const transcript = await secondServer.call("read_transcript", { taskId: restarted.taskId, includeText: true });
    assert.equal(transcript.totalSegments, 3);
    assert.match(transcript.warnings.join("\n"), /checkpoint/);
    assert.deepEqual((await fs.readFile(asrLog, "utf8")).trim().split(/\r?\n/), ["chunk:1", "chunk:2", "chunk:3"]);
    assert.equal(await fs.access(path.join(dataRoot, "cache", "checkpoints", `${taskId}.json`)).then(() => true).catch(() => false), false);
    assert.equal(await fs.access(path.join(dataRoot, "cache", "checkpoints", `${restarted.taskId}.json`)).then(() => true).catch(() => false), false);
  } finally {
    await secondServer.close();
  }
});

test("heavy transcription jobs run FIFO with one global worker while status remains responsive", async () => {
  const server = startServer({ ZCODE_VOICE_MOCK_DELAY_MS: "180" });
  const firstAudio = path.join(server.dataRoot, "first.wav");
  const secondAudio = path.join(server.dataRoot, "second.wav");
  await fs.mkdir(server.dataRoot, { recursive: true });
  await fs.writeFile(firstAudio, "first");
  await fs.writeFile(secondAudio, "second");
  try {
    await server.initialize();
    const first = await server.call("start_transcription", { audioPath: firstAudio });
    const duplicate = await server.call("start_transcription", { audioPath: firstAudio });
    const second = await server.call("start_transcription", { audioPath: secondAudio });
    assert.equal(duplicate.taskId, first.taskId);
    const startedAt = Date.now();
    const secondStatus = await server.call("get_transcription_status", { taskId: second.taskId });
    assert.equal(secondStatus.status, "queued");
    assert.ok(Date.now() - startedAt < 120, "status request should not wait for the heavy queue");
    const queueStartedAt = Date.now();
    assert.equal((await waitFor(server, first.taskId)).status, "completed");
    assert.equal((await waitFor(server, second.taskId)).status, "completed");
    assert.ok(Date.now() - queueStartedAt >= 250, "two delayed jobs should execute serially");
  } finally {
    await server.close();
  }
});

test("a failed heavy job does not stop the next queued transcription", async () => {
  const server = startServer({ ZCODE_VOICE_MOCK_DELAY_MS: "40", ZCODE_VOICE_MOCK_FAIL_PATTERN: "fails" });
  const failedAudio = path.join(server.dataRoot, "fails.wav");
  const goodAudio = path.join(server.dataRoot, "good.wav");
  await fs.mkdir(server.dataRoot, { recursive: true });
  await fs.writeFile(failedAudio, "fails");
  await fs.writeFile(goodAudio, "good");
  try {
    await server.initialize();
    const failed = await server.call("start_transcription", { audioPath: failedAudio });
    const good = await server.call("start_transcription", { audioPath: goodAudio });
    assert.equal((await waitFor(server, failed.taskId)).status, "failed");
    assert.equal((await waitFor(server, good.taskId)).status, "completed");
  } finally {
    await server.close();
  }
});

test("speakerProfile false skips CAM++ and reports the speaker backend as disabled", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-no-speaker-"));
  const audioPath = path.join(dataRoot, "no-speaker.wav");
  const adapter = fileURLToPath(new URL("mock-campp-adapter.mjs", import.meta.url));
  await fs.writeFile(audioPath, "no speaker audio");
  const server = startServer({
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
  });
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath, speakerProfile: false });
    const completed = await waitFor(server, started.taskId);
    const transcript = await server.call("read_transcript", { taskId: started.taskId });
    assert.equal(completed.status, "completed");
    assert.equal(transcript.backend.speaker, "disabled");
    assert.equal(transcript.segments[0].speaker, "unknown");
  } finally {
    await server.close();
  }
});

test("completed backend metadata is resolved after model preparation", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcriber-metadata-"));
  const audioPath = path.join(dataRoot, "metadata.wav");
  const modelPath = path.join(dataRoot, "late-campp.onnx");
  const adapter = fileURLToPath(new URL("mock-campp-adapter.mjs", import.meta.url));
  await fs.writeFile(audioPath, "metadata audio");
  const server = startServer({
    ZCODE_VOICE_DATA_DIR: dataRoot,
    ZCODE_VOICE_MOCK_DELAY_MS: "120",
    ZCODE_CAMPP_COMMAND: process.execPath,
    ZCODE_CAMPP_ARGS: JSON.stringify([adapter]),
    ZCODE_CAMPP_MODEL: modelPath,
  });
  try {
    await server.initialize();
    const started = await server.call("start_transcription", { audioPath });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await fs.writeFile(modelPath, "late model");
    await waitFor(server, started.taskId);
    const transcript = await server.call("read_transcript", { taskId: started.taskId });
    assert.equal(transcript.backend.speaker, "available");
    assert.equal(transcript.backend.speakerModelExists, true);
  } finally {
    await server.close();
  }
});
