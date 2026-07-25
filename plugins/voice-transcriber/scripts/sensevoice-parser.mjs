const timestampPattern = /^\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]\s*(.*)$/;
const metadataPattern = /<\|[^>]+\|>/g;

function cleanText(value) {
  return String(value || "").replace(metadataPattern, "").replace(/\s+/g, " ").trim();
}

export function parseSenseVoiceOutput(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const segments = [];
  const plain = [];
  for (const line of lines) {
    const match = line.trim().match(timestampPattern);
    if (match) {
      const text = cleanText(match[3]);
      if (text) {
        segments.push({
          id: `seg_${String(segments.length + 1).padStart(4, "0")}`,
          start: Number(match[1]),
          end: Number(match[2]),
          text,
          speaker: "unknown",
          confidence: null,
        });
      }
      continue;
    }
    const text = cleanText(line);
    if (text && !/^\$\$/.test(text) && !/^(?:main:|system_info:|sense_voice_|ggml_)/.test(text)) plain.push(text);
  }
  const text = (segments.length ? segments.map((segment) => segment.text) : plain).join(" ").trim();
  return { text, segments: segments.length ? segments : null };
}
