import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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

test("runtime bootstrap rejects redirects outside approved GitHub hosts", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-runtime-redirect-"));
  const manifestUrl = "https://raw.githubusercontent.com/example/runtime/main/runtime-manifest.json";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 302,
    ok: false,
    headers: { get: (name) => name.toLowerCase() === "location" ? "https://example.invalid/runtime-manifest.json?token=secret-runtime-token" : null },
  });
  try {
    let caught = null;
    await assert.rejects(
      ensureRuntime({ dataRoot, manifestUrl, platform: "win32", arch: "x64" }),
      (error) => {
        caught = error;
        return error.code === "invalid_runtime_source";
      },
    );
    assert.doesNotMatch(caught.message, /secret-runtime-token/);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("runtime bootstrap rejects Windows-style path traversal on every host OS", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-runtime-path-"));
  const manifestUrl = "https://raw.githubusercontent.com/example/runtime/main/runtime-manifest.json";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      version: "test-path-1",
      platforms: {
        "win32-x64": { files: [{ name: "..\\escape.exe", sha256: "0".repeat(64) }] },
      },
    }),
  });
  try {
    await assert.rejects(
      ensureRuntime({ dataRoot, manifestUrl, platform: "win32", arch: "x64" }),
      (error) => error.code === "invalid_runtime_manifest",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("runtime bootstrap repairs a locally modified recorded binary", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-runtime-repair-"));
  const manifestUrl = "https://raw.githubusercontent.com/example/runtime/main/runtime-manifest.json";
  const runtimeUrl = "https://github.com/example/runtime/releases/download/test-2/campp-adapter.exe";
  const payload = Buffer.from("trusted-runtime");
  const manifest = {
    version: "test-2",
    platforms: {
      "win32-x64": {
        files: [{
          name: "campp-adapter.exe",
          url: runtimeUrl,
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
          size: payload.length,
        }],
      },
    },
  };
  const originalFetch = globalThis.fetch;
  let fileRequests = 0;
  globalThis.fetch = async (url) => {
    if (url === manifestUrl) return { status: 200, ok: true, json: async () => manifest };
    fileRequests += 1;
    return { status: 200, ok: true, body: Readable.toWeb(Readable.from([payload])) };
  };
  try {
    await ensureRuntime({ dataRoot, manifestUrl, platform: "win32", arch: "x64" });
    const binary = path.join(runtimeDataDir(dataRoot, "win32", "x64"), "campp-adapter.exe");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(binary, "altered-runtime");
    const repaired = await ensureRuntime({ dataRoot, manifestUrl, platform: "win32", arch: "x64" });
    assert.deepEqual(repaired.downloaded, ["campp-adapter.exe"]);
    assert.equal(fileRequests, 2);
    assert.equal(await fs.readFile(binary, "utf8"), payload.toString());
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("runtime bootstrap immediately reclaims a fresh lock owned by a dead process", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-runtime-abandoned-lock-"));
  const runtimeDir = runtimeDataDir(dataRoot, "win32", "x64");
  const lockFile = path.join(runtimeDir, ".download.lock");
  const manifestUrl = "https://raw.githubusercontent.com/example/runtime/main/runtime-manifest.json";
  const runtimeUrl = "https://github.com/example/runtime/releases/download/test-lock/runtime.exe";
  const payload = Buffer.from("runtime after stale lock");
  const manifest = {
    version: "test-lock",
    platforms: {
      "win32-x64": {
        files: [{
          name: "runtime.exe",
          url: runtimeUrl,
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
          size: payload.length,
        }],
      },
    },
  };
  await fs.mkdir(runtimeDir, { recursive: true });
  const deadPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.once("error", reject);
    child.once("exit", () => resolve(child.pid));
  });
  await fs.writeFile(lockFile, `${JSON.stringify({ pid: deadPid, token: "abandoned" })}\n`);
  const originalFetch = globalThis.fetch;
  const originalTimeoutMs = process.env.ZCODE_RUNTIME_LOCK_TIMEOUT_MS;
  process.env.ZCODE_RUNTIME_LOCK_TIMEOUT_MS = "1000";
  globalThis.fetch = async (url) => url === manifestUrl
    ? { ok: true, status: 200, json: async () => manifest }
    : { ok: true, status: 200, body: Readable.toWeb(Readable.from([payload])) };

  try {
    const result = await ensureRuntime({ dataRoot, manifestUrl, platform: "win32", arch: "x64" });
    assert.equal(result.ready, true);
    assert.equal(await fs.access(lockFile).then(() => true).catch(() => false), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeoutMs === undefined) delete process.env.ZCODE_RUNTIME_LOCK_TIMEOUT_MS;
    else process.env.ZCODE_RUNTIME_LOCK_TIMEOUT_MS = originalTimeoutMs;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
