import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDiarization, parseRttm } from "../../../tools/speaker-diarization-metrics.mjs";

const reference = [
  { start: 0, end: 1, speaker: "alice" },
  { start: 1, end: 2, speaker: "bob" },
];

test("diarization metrics optimally maps arbitrary speaker labels", () => {
  const result = evaluateDiarization(reference, [
    { start: 0, end: 1, speaker: "cluster_7" },
    { start: 1, end: 2, speaker: "cluster_2" },
  ]);
  assert.equal(result.der, 0);
  assert.equal(result.jer, 0);
  assert.equal(result.speakerCountError, 0);
  assert.deepEqual(new Set(Object.values(result.mapping)), new Set(["alice", "bob"]));
});

test("diarization metrics detects merged speakers as confusion", () => {
  const result = evaluateDiarization(reference, [{ start: 0, end: 2, speaker: "cluster_0" }]);
  assert.equal(result.der, 0.5);
  assert.equal(result.confusionSpeakerSeconds, 1);
  assert.equal(result.speakerCountError, -1);
});

test("diarization metrics measures missed and false-alarm speaker time", () => {
  const result = evaluateDiarization(
    [{ start: 0, end: 2, speaker: "alice" }],
    [
      { start: 0.5, end: 2, speaker: "cluster_0" },
      { start: 2, end: 2.5, speaker: "cluster_0" },
    ],
  );
  assert.equal(result.missedSpeakerSeconds, 0.5);
  assert.equal(result.falseAlarmSpeakerSeconds, 0.5);
  assert.equal(result.der, 0.5);
});

test("RTTM parser supports selecting one recording", () => {
  const result = parseRttm([
    "SPEAKER meeting 1 0.00 1.25 <NA> <NA> alice <NA> <NA>",
    "SPEAKER other 1 0.00 2.00 <NA> <NA> ignored <NA> <NA>",
    "SPEAKER meeting 1 1.25 0.75 <NA> <NA> bob <NA> <NA>",
  ].join("\n"), { uri: "meeting" });
  assert.deepEqual(result, [
    { start: 0, end: 1.25, speaker: "alice" },
    { start: 1.25, end: 2, speaker: "bob" },
  ]);
});
