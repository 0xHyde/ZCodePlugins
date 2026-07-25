import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { ensureRuntime, runtimeDataDir, runtimePlatformKey } from "../scripts/runtime-bootstrap.mjs";

test("runtime bootstrap downloads, verifies, and reuses a platform pack", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-runtime-bootstrap-"));
  const manifestUrl = "https://raw.githubusercontent.com/example/runtime/main/runtime-manifest.json";
  const payloads = {
    "llama-funasr-sensevoice.exe": Buffer.from("sensevoice runtime"),
    "campp-adapter.exe": Buffer.from("campp runtime"),
  };
  const manifest = {
    version: "test-1",
    platforms: {
      "win32-x64": {
        files: Object.entries(payloads).map(([name, payload]) => ({
          name,
          url: `https://github.com/example/runtime/releases/download/test-1/${name}`,
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        })),
      },
    },
  };
  const originalFetch = globalThis.fetch;
  let manifestRequests = 0;
  let fileRequests = 0;
  globalThis.fetch = async (url) => {
    if (url === manifestUrl) {
      manifestRequests += 1;
      return { ok: true, status: 200, json: async () => manifest };
    }
    const name = path.basename(new URL(url).pathname);
    fileRequests += 1;
    return { ok: true, status: 200, body: Readable.toWeb(Readable.from([payloads[name]])) };
  };

  try {
    const first = await ensureRuntime({ dataRoot, manifestUrl, platform: "win32", arch: "x64" });
    assert.equal(first.ready, true);
    assert.deepEqual(first.downloaded.sort(), Object.keys(payloads).sort());
    assert.equal(await fs.readFile(path.join(runtimeDataDir(dataRoot, "win32", "x64"), "llama-funasr-sensevoice.exe"), "utf8"), "sensevoice runtime");

    assert.equal(runtimePlatformKey("win32", "x64"), "win32-x64");

    const second = await ensureRuntime({ dataRoot, manifestUrl, platform: "win32", arch: "x64" });
    assert.deepEqual(second.downloaded, []);
    assert.equal(manifestRequests, 2);
    assert.equal(fileRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
