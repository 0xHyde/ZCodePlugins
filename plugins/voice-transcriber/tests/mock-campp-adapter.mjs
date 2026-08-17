import readline from "node:readline";
import fs from "node:fs";

const embedding = [1, 0, 0, 0];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let closed = false;
const log = (value) => {
  if (process.env.ZCODE_CAMPP_CALL_LOG) fs.appendFileSync(process.env.ZCODE_CAMPP_CALL_LOG, `${value}\n`);
};
const markClosed = () => {
  if (closed) return;
  closed = true;
  log("closed");
};

process.on("SIGTERM", () => {
  markClosed();
  process.exit(0);
});
input.on("close", () => {
  markClosed();
  process.exit(0);
});

input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  log(request.method);
  let result;
  if (request.method === "diarize") {
    result = {
      algorithmVersion: "speaker-v2",
      segments: (request.params.segments || []).map((segment) => ({
        ...segment,
        speaker: "cluster_0",
        speakerMatch: "cluster",
        speakerConfidence: 0.9,
        speakerPurity: 0.9,
        mixedSpeaker: false,
        speakerWindowCount: 2,
      })),
      clusters: [{ clusterId: 0, size: 2, canonicalKey: "seg_0001:w0", prototype: embedding }],
      metrics: { windowCount: 2, clusterCount: 1, batchCount: 1 },
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
