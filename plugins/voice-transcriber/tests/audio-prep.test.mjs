import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareAudio } from "../scripts/audio-prep.mjs";

function makeWav() {
  const samples = Buffer.alloc(320);
  const buffer = Buffer.alloc(44 + samples.length);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.length, 40);
  samples.copy(buffer, 44);
  return buffer;
}

test("audio preparation passes through a SenseVoice-compatible WAV", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-audio-prep-"));
  const audioPath = path.join(dataRoot, "input.wav");
  await fs.writeFile(audioPath, makeWav());
  const prepared = await prepareAudio({ audioPath, dataRoot, taskId: "test" });
  assert.equal(prepared.path, audioPath);
  assert.equal(prepared.converted, false);
  await prepared.cleanup();
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("audio preparation reports a missing converter for compressed audio", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-audio-prep-missing-"));
  const audioPath = path.join(dataRoot, "input.mp3");
  await fs.writeFile(audioPath, "not an actual mp3");
  await assert.rejects(
    prepareAudio({ audioPath, dataRoot, taskId: "test", converter: path.join(dataRoot, "missing-ffmpeg") }),
    (error) => error.code === "audio_converter_not_found",
  );
  await fs.rm(dataRoot, { recursive: true, force: true });
});
