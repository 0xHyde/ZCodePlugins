import readline from "node:readline";
import fs from "node:fs";

const embedding = [1, 0, 0, 0];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const log = (value) => {
  if (process.env.ZCODE_CAMPP_CALL_LOG) fs.appendFileSync(process.env.ZCODE_CAMPP_CALL_LOG, `${value}\n`);
};

process.on("SIGTERM", () => {
  log("closed");
  process.exit(0);
});

input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  log(request.method);
  let result;
  if (request.method === "diarize") {
    result = {
      algorithmVersion: "speaker-v5",
      segments: (request.params.segments || []).map((segment) => {
        const start = Number.isFinite(segment.start) ? segment.start : 0;
        const end = Number.isFinite(segment.end) && segment.end > start ? segment.end : start + 2;
        return {
          ...segment,
          start,
          end,
          speaker: "cluster_0",
          speakerCluster: "cluster_0",
          dominantSpeaker: "cluster_0",
          speakerMatch: "cluster",
          speakerConfidence: 0.9,
          speakerPurity: 0.9,
          mixedSpeaker: false,
          speakerStability: "stable",
          speakerSpans: [{ start, end, speaker: "cluster_0", confidence: 0.9 }],
          speakerWindowCount: 2,
        };
      }),
      clusters: [{ clusterId: 0, size: 8, windowCount: 8, voicedSeconds: 8, independentEvidence: 5, coherence: 0.9, stability: "stable", trusted: true, strong: true, canonicalKey: "seg_0001:w0", prototype: embedding }],
      quality: {
        state: "reliable",
        trustedSpeakerCount: 1,
        trustedCoverage: 1,
        unknownRatio: 0,
        mixedRatio: 0,
        reasonCodes: [],
      },
      metrics: {
        windowCount: 8,
        validWindowCount: 8,
        noiseWindowCount: 0,
        clusterCount: 1,
        postThresholdClusterCount: 1,
        speakerCountExceeded: false,
        forcedMergeCount: 0,
        privateCandidateCount: 1,
        trustedSpeakerCount: 1,
        transientClusterCount: 0,
        rawTransientSpanCount: 0,
        microNoiseSpanCount: 0,
        bridgedTransientSpanCount: 0,
        suppressedTransientSpanCount: 0,
        rawMixedSegmentCount: 0,
        presentationMixedSegmentCount: 0,
        batchCount: 1,
      },
    };
  } else if (request.method === "embed_segments") {
    result = {
      embeddings: (request.params.segmentIds || []).map((segmentId) => ({ segmentId, embedding })),
      embedding,
    };
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "method_not_found", message: request.method } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
