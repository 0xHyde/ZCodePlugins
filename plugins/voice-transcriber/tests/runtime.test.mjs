import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundledRuntimeCandidates, commandAvailable, downloadedRuntimeCandidates, resolveRuntimeCommand } from "../scripts/runtime.mjs";

test("runtime resolver prefers a bundled platform binary", async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-runtime-"));
  const candidate = bundledRuntimeCandidates(pluginRoot, "llama-funasr-sensevoice")[0];
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.writeFile(candidate, "binary placeholder");

  const result = await resolveRuntimeCommand({
    pluginRoot,
    configured: "llama-funasr-sensevoice",
    defaultName: "llama-funasr-sensevoice",
  });
  assert.equal(result.command, candidate);
  assert.equal(result.source, "bundled");
  assert.equal(result.exists, true);

  await fs.rm(pluginRoot, { recursive: true, force: true });
});

test("runtime resolver reports an unavailable command without throwing", async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-runtime-missing-"));
  const result = await resolveRuntimeCommand({
    pluginRoot,
    configured: "definitely-not-installed-zcode-runtime",
    defaultName: "llama-funasr-sensevoice",
  });
  assert.equal(result.command, "definitely-not-installed-zcode-runtime");
  assert.equal(result.exists, false);
  assert.equal(await commandAvailable(result.command), false);
  await fs.rm(pluginRoot, { recursive: true, force: true });
});

test("runtime resolver finds an automatically downloaded platform binary", async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-runtime-plugin-"));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-runtime-data-"));
  const candidate = downloadedRuntimeCandidates(dataRoot, "ffmpeg")[0];
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.writeFile(candidate, "binary placeholder");

  const result = await resolveRuntimeCommand({ pluginRoot, dataRoot, configured: "ffmpeg", defaultName: "ffmpeg" });
  assert.equal(result.command, candidate);
  assert.equal(result.source, "downloaded");
  assert.equal(result.exists, true);

  await fs.rm(pluginRoot, { recursive: true, force: true });
  await fs.rm(dataRoot, { recursive: true, force: true });
});
