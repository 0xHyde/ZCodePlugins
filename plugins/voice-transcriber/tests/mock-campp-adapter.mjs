import readline from "node:readline";

const embedding = [1, 0, 0, 0];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  let result;
  if (request.method === "diarize") {
    result = {
      segments: (request.params.segments || []).map((segment) => ({
        ...segment,
        speaker: "cluster_0",
        confidence: 0.9,
      })),
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
