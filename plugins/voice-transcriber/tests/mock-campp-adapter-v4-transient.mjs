import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method !== "diarize") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: "method_not_found", message: request.method },
    })}\n`);
    return;
  }
  const segments = (request.params.segments || []).map((segment) => {
    const start = Number.isFinite(segment.start) ? segment.start : 0;
    const end = Number.isFinite(segment.end) && segment.end > start ? segment.end : start + 1;
    return {
      ...segment,
      start,
      end,
      speaker: "unknown",
      dominantSpeaker: null,
      speakerMatch: "unknown",
      speakerConfidence: null,
      speakerStability: "unknown",
      speakerPurity: 0,
      mixedSpeaker: false,
      speakerSpans: [{ start, end, speaker: "unknown", confidence: 0 }],
      speakerWindowCount: 1,
    };
  });
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      algorithmVersion: "speaker-v4",
      segments,
      clusters: [{
        clusterId: "cluster_0",
        size: 1,
        windowCount: 1,
        stability: "transient",
        prototype: [1, 0, 0, 0],
      }],
      metrics: {
        windowCount: 1,
        validWindowCount: 1,
        noiseWindowCount: 0,
        clusterCount: 1,
        postThresholdClusterCount: 1,
        speakerCountExceeded: false,
        forcedMergeCount: 0,
        transientClusterCount: 1,
        rawTransientSpanCount: 1,
        microNoiseSpanCount: 0,
        bridgedTransientSpanCount: 0,
        suppressedTransientSpanCount: 1,
        rawMixedSegmentCount: 0,
        presentationMixedSegmentCount: 0,
        batchCount: 1,
      },
    },
  })}\n`);
});
