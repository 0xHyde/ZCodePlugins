import readline from "node:readline";

const embedding = [1, 0, 0, 0];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "diarize") {
    const segments = (request.params.segments || []).map((segment) => {
      const start = Number.isFinite(segment.start) ? segment.start : 0;
      const end = Number.isFinite(segment.end) && segment.end > start ? segment.end : start + 2;
      return {
        ...segment,
        start,
        end,
        // Deliberately include the legacy cluster field.  The v4 projection
        // must remove it when a segment is mixed.
        speaker: "cluster_0",
        speakerCluster: "cluster_0",
        dominantSpeaker: "cluster_0",
        speakerPurity: 0.5,
        mixedSpeaker: true,
        speakerMatch: "mixed",
        speakerSpans: [
          { start, end: (start + end) / 2, speaker: "cluster_0", confidence: 0.91 },
          { start: (start + end) / 2, end, speaker: "cluster_1", confidence: 0.84 },
        ],
        speakerWindowCount: 2,
      };
    });
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        algorithmVersion: "speaker-v5",
        segments,
        clusters: [
          { clusterId: "cluster_0", size: 8, windowCount: 8, voicedSeconds: 8, independentEvidence: 5, coherence: 0.9, stability: "stable", trusted: true, strong: true, prototype: embedding },
          { clusterId: "cluster_1", size: 8, windowCount: 8, voicedSeconds: 8, independentEvidence: 5, coherence: 0.88, stability: "stable", trusted: true, strong: true, prototype: embedding },
        ],
        quality: {
          state: "reliable",
          trustedSpeakerCount: 2,
          trustedCoverage: 1,
          unknownRatio: 0,
          mixedRatio: 1,
          reasonCodes: [],
        },
        metrics: {
          windowCount: 2,
          validWindowCount: 2,
          noiseWindowCount: 0,
          clusterCount: 2,
          postThresholdClusterCount: 2,
          speakerCountExceeded: false,
          forcedMergeCount: 0,
          transientClusterCount: 0,
          rawTransientSpanCount: 0,
          microNoiseSpanCount: 0,
          bridgedTransientSpanCount: 0,
          suppressedTransientSpanCount: 0,
          rawMixedSegmentCount: 1,
          presentationMixedSegmentCount: 1,
          batchCount: 1,
        },
      },
    })}\n`);
    return;
  }
  if (request.method === "embed_segments") {
    const entries = (request.params.segmentIds || []).map((segmentId) => ({ segmentId, embedding }));
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { embeddings: entries, embedding },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: "method_not_found", message: request.method },
  })}\n`);
});
