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
  assert.deepEqual(result.missing, ["sense-voice-small-q8_0.gguf"]);
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
