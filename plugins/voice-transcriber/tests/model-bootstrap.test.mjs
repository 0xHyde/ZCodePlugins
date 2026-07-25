import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
