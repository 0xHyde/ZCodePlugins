import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { ensureModels } from "../scripts/model-bootstrap.mjs";

test("model bootstrap reports missing models without a configured manifest", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-"));
  const result = await ensureModels({ dataRoot });

  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ["sense-voice-small-q8_0.gguf", "fsmn-vad.gguf"]);
  assert.match(result.modelDir, /models$/);

  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("model bootstrap downloads and verifies a GitHub manifest exactly once", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-download-"));
  const payload = Buffer.from("fake sensevoice model");
  const checksum = crypto.createHash("sha256").update(payload).digest("hex");
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const manifest = {
    version: "test-1",
    baseUrl: "https://github.com/example/models/releases/download/test-1/",
    files: [{ name: "sense-voice-small-q8_0.gguf", sha256: checksum, required: true }],
  };
  const originalFetch = globalThis.fetch;
  let modelRequests = 0;
  globalThis.fetch = async (url) => {
    if (url === manifestUrl) return { ok: true, status: 200, json: async () => manifest };
    modelRequests += 1;
    return {
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from([payload])),
    };
  };

  try {
    const first = await ensureModels({ dataRoot, manifestUrl });
    const second = await ensureModels({ dataRoot, manifestUrl });
    assert.deepEqual(first.downloaded, ["sense-voice-small-q8_0.gguf"]);
    assert.deepEqual(second.downloaded, []);
    assert.equal(modelRequests, 1);
    assert.equal(await fs.readFile(path.join(first.modelDir, "sense-voice-small-q8_0.gguf"), "utf8"), payload.toString());
    assert.equal((await fs.stat(path.join(first.modelDir, "installed.json"))).isFile(), true);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("model bootstrap rejects a downloaded file with the wrong declared size", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-size-"));
  const payload = Buffer.from("fake model");
  const checksum = crypto.createHash("sha256").update(payload).digest("hex");
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const manifest = {
    version: "test-size-1",
    baseUrl: "https://github.com/example/models/releases/download/test-size-1/",
    files: [{ name: "sense-voice-small-q8_0.gguf", sha256: checksum, size: payload.length + 1, required: true }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => url === manifestUrl
    ? { ok: true, status: 200, json: async () => manifest }
    : { ok: true, status: 200, body: Readable.toWeb(Readable.from([payload])) };

  try {
    await assert.rejects(
      () => ensureModels({ dataRoot, manifestUrl }),
      (error) => error.code === "model_size_mismatch",
    );
    assert.equal(await fs.access(path.join(dataRoot, "models", "sense-voice-small-q8_0.gguf")).then(() => true).catch(() => false), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("model bootstrap falls back across approved ModelScope and Hugging Face mirrors", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-mirrors-"));
  const payload = Buffer.from("mirror model");
  const checksum = crypto.createHash("sha256").update(payload).digest("hex");
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const primary = "https://www.modelscope.cn/models/example/model/resolve/master/model.gguf";
  const backup = "https://huggingface.co/example/model/resolve/main/model.gguf?download=true";
  const manifest = {
    version: "test-mirrors-1",
    files: [{ name: "sense-voice-small-q8_0.gguf", url: primary, urls: [backup], sha256: checksum, size: payload.length }],
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url === manifestUrl) return { ok: true, status: 200, json: async () => manifest };
    if (url === primary) return { ok: false, status: 503 };
    return { ok: true, status: 200, body: Readable.toWeb(Readable.from([payload])) };
  };

  try {
    const result = await ensureModels({ dataRoot, manifestUrl });
    assert.deepEqual(result.downloaded, ["sense-voice-small-q8_0.gguf"]);
    assert.deepEqual(requests, [manifestUrl, primary, backup]);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("model bootstrap does not block transcription when an optional speaker model is unavailable", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-optional-"));
  const requiredPayload = Buffer.from("required model");
  const requiredChecksum = crypto.createHash("sha256").update(requiredPayload).digest("hex");
  const optionalChecksum = crypto.createHash("sha256").update("optional model").digest("hex");
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const requiredUrl = "https://www.modelscope.cn/models/example/asr/resolve/master/asr.gguf";
  const optionalUrl = "https://www.modelscope.cn/models/example/speaker/resolve/master/campp.onnx";
  const manifest = {
    version: "test-optional-1",
    files: [
      { name: "sense-voice-small-q8_0.gguf", url: requiredUrl, sha256: requiredChecksum, size: requiredPayload.length, required: true },
      { name: "cam++.onnx", url: optionalUrl, sha256: optionalChecksum, required: false },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === manifestUrl) return { ok: true, status: 200, json: async () => manifest };
    if (url === requiredUrl) return { ok: true, status: 200, body: Readable.toWeb(Readable.from([requiredPayload])) };
    return { ok: false, status: 503 };
  };

  try {
    const result = await ensureModels({ dataRoot, manifestUrl });
    assert.equal(result.ready, true);
    assert.deepEqual(result.downloaded, ["sense-voice-small-q8_0.gguf"]);
    assert.deepEqual(result.optionalMissing, ["cam++.onnx"]);
    assert.equal(result.optionalFailures[0].name, "cam++.onnx");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("model bootstrap skips optional speaker models when they are not requested", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-required-only-"));
  const requiredPayload = Buffer.from("required only model");
  const requiredChecksum = crypto.createHash("sha256").update(requiredPayload).digest("hex");
  const optionalChecksum = crypto.createHash("sha256").update("optional").digest("hex");
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const requiredUrl = "https://www.modelscope.cn/models/example/asr/resolve/master/asr.gguf";
  const optionalUrl = "https://www.modelscope.cn/models/example/speaker/resolve/master/campp.onnx";
  const manifest = {
    version: "test-required-only-1",
    files: [
      { name: "sense-voice-small-q8_0.gguf", url: requiredUrl, sha256: requiredChecksum, size: requiredPayload.length, required: true },
      { name: "cam++.onnx", url: optionalUrl, sha256: optionalChecksum, required: false },
    ],
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url === manifestUrl) return { ok: true, status: 200, json: async () => manifest };
    if (url === requiredUrl) return { ok: true, status: 200, body: Readable.toWeb(Readable.from([requiredPayload])) };
    throw new Error(`unexpected optional request: ${url}`);
  };

  try {
    const result = await ensureModels({ dataRoot, manifestUrl, includeOptional: false });
    assert.equal(result.ready, true);
    assert.deepEqual(result.downloaded, ["sense-voice-small-q8_0.gguf"]);
    assert.deepEqual(requests, [manifestUrl, requiredUrl]);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("model bootstrap rejects redirects outside approved model hosts", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-redirect-"));
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 302,
    headers: { get: (name) => name.toLowerCase() === "location" ? "https://example.invalid/model-manifest.json?auth_key=secret-model-token" : null },
  });

  try {
    let caught = null;
    await assert.rejects(
      () => ensureModels({ dataRoot, manifestUrl }),
      (error) => {
        caught = error;
        return error.code === "invalid_model_source";
      },
    );
    assert.doesNotMatch(caught.message, /secret-model-token/);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("model bootstrap rejects Windows-style path traversal on every host OS", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-path-"));
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      version: "test-path-1",
      files: [{ name: "..\\escape.gguf", sha256: "0".repeat(64), required: true }],
    }),
  });
  try {
    await assert.rejects(
      () => ensureModels({ dataRoot, manifestUrl }),
      (error) => error.code === "invalid_model_manifest",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("concurrent model bootstrap calls share one download", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-concurrent-"));
  const payload = Buffer.from("one concurrent model download");
  const checksum = crypto.createHash("sha256").update(payload).digest("hex");
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const modelUrl = "https://www.modelscope.cn/models/example/asr/resolve/master/asr.gguf";
  const manifest = {
    version: "test-concurrent-1",
    files: [{ name: "sense-voice-small-q8_0.gguf", url: modelUrl, sha256: checksum, size: payload.length, required: true }],
  };
  const originalFetch = globalThis.fetch;
  let modelRequests = 0;
  globalThis.fetch = async (url) => {
    if (url === manifestUrl) return { ok: true, status: 200, json: async () => manifest };
    modelRequests += 1;
    return { ok: true, status: 200, body: Readable.toWeb(Readable.from([payload])) };
  };

  try {
    const [first, second] = await Promise.all([
      ensureModels({ dataRoot, manifestUrl }),
      ensureModels({ dataRoot, manifestUrl }),
    ]);
    assert.equal(first.ready, true);
    assert.equal(second.ready, true);
    assert.equal(modelRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("model bootstrap immediately reclaims a fresh lock owned by a dead process", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-abandoned-lock-"));
  const modelDir = path.join(dataRoot, "models");
  const lockFile = path.join(modelDir, ".download.lock");
  const payload = Buffer.from("model after stale lock");
  const checksum = crypto.createHash("sha256").update(payload).digest("hex");
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const manifest = {
    version: "test-stale-lock-1",
    files: [{ name: "sense-voice-small-q8_0.gguf", sha256: checksum, size: payload.length, required: true }],
  };
  await fs.mkdir(modelDir, { recursive: true });
  const deadPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.once("error", reject);
    child.once("exit", () => resolve(child.pid));
  });
  await fs.writeFile(lockFile, `${JSON.stringify({ pid: deadPid, token: "abandoned" })}\n`);
  const originalFetch = globalThis.fetch;
  const originalTimeoutMs = process.env.ZCODE_MODEL_LOCK_TIMEOUT_MS;
  process.env.ZCODE_MODEL_LOCK_TIMEOUT_MS = "1000";
  globalThis.fetch = async (url) => url === manifestUrl
    ? { ok: true, status: 200, json: async () => manifest }
    : { ok: true, status: 200, body: Readable.toWeb(Readable.from([payload])) };

  try {
    const result = await ensureModels({ dataRoot, manifestUrl, includeOptional: false });
    assert.equal(result.ready, true);
    assert.equal(await fs.access(lockFile).then(() => true).catch(() => false), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeoutMs === undefined) delete process.env.ZCODE_MODEL_LOCK_TIMEOUT_MS;
    else process.env.ZCODE_MODEL_LOCK_TIMEOUT_MS = originalTimeoutMs;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("model bootstrap replaces an outdated same-name model from the manifest", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-bootstrap-upgrade-"));
  const modelDir = path.join(dataRoot, "models");
  const modelPath = path.join(modelDir, "sense-voice-small-q8_0.gguf");
  const manifestUrl = "https://raw.githubusercontent.com/example/models/main/model-manifest.json";
  const modelUrl = "https://www.modelscope.cn/models/example/asr/resolve/master/asr.gguf";
  const payload = Buffer.from("new official model");
  const manifest = {
    version: "upgrade-2",
    files: [{
      name: "sense-voice-small-q8_0.gguf",
      url: modelUrl,
      sha256: crypto.createHash("sha256").update(payload).digest("hex"),
      size: payload.length,
    }],
  };
  await fs.mkdir(modelDir, { recursive: true });
  await fs.writeFile(modelPath, "old model bytes");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => url === manifestUrl
    ? { ok: true, status: 200, json: async () => manifest }
    : { ok: true, status: 200, body: Readable.toWeb(Readable.from([payload])) };
  try {
    const result = await ensureModels({ dataRoot, manifestUrl, includeOptional: false });
    assert.deepEqual(result.downloaded, ["sense-voice-small-q8_0.gguf"]);
    assert.equal(await fs.readFile(modelPath, "utf8"), payload.toString());
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
