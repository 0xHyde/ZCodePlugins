import test from "node:test";
import assert from "node:assert/strict";
import { parseSenseVoiceOutput } from "../scripts/sensevoice-parser.mjs";

test("official SenseVoice runtime output keeps timestamps and removes metadata tags", () => {
  const result = parseSenseVoiceOutput([
    "sense_voice_model_load: loading model",
    "[1.12-3.42] <|zh|><|NEUTRAL|><|Speech|>大家好",
    "[3.87-6.53] <|zh|><|NEUTRAL|><|Speech|>今天开始会议",
    "main: decoder audio use 0.1 s",
  ].join("\n"));
  assert.equal(result.text, "大家好 今天开始会议");
  assert.deepEqual(result.segments.map(({ start, end, text }) => ({ start, end, text })), [
    { start: 1.12, end: 3.42, text: "大家好" },
    { start: 3.87, end: 6.53, text: "今天开始会议" },
  ]);
});

test("SenseVoice parser falls back to plain text output", () => {
  const result = parseSenseVoiceOutput("hello world\n");
  assert.equal(result.text, "hello world");
  assert.equal(result.segments, null);
});
