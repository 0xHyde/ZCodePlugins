import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EPSILON = 1e-9;

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number`);
  return number;
}

export function normalizeSpeakerSegments(segments, { source = "segments" } = {}) {
  if (!Array.isArray(segments)) throw new Error(`${source} must be an array`);
  return segments.map((segment, index) => {
    const start = finiteNumber(segment.start, `${source}[${index}].start`);
    const end = finiteNumber(segment.end, `${source}[${index}].end`);
    const speaker = String(segment.speaker ?? segment.personId ?? "").trim();
    if (start < 0 || end <= start) throw new Error(`${source}[${index}] has an invalid time range`);
    if (!speaker) throw new Error(`${source}[${index}] is missing speaker`);
    return { start, end, speaker };
  }).sort((left, right) => left.start - right.start || left.end - right.end || left.speaker.localeCompare(right.speaker));
}

export function parseRttm(text, { uri = null } = {}) {
  const segments = [];
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 8 || fields[0] !== "SPEAKER") {
      throw new Error(`RTTM line ${index + 1} is invalid`);
    }
    if (uri && fields[1] !== uri) continue;
    const start = finiteNumber(fields[3], `RTTM line ${index + 1} start`);
    const duration = finiteNumber(fields[4], `RTTM line ${index + 1} duration`);
    if (start < 0 || duration <= 0) throw new Error(`RTTM line ${index + 1} has an invalid time range`);
    segments.push({ start, end: start + duration, speaker: fields[7], uri: fields[1] });
  }
  return normalizeSpeakerSegments(segments, { source: "RTTM" });
}

function activeSpeakers(segments, midpoint) {
  const active = new Set();
  for (const segment of segments) {
    if (segment.start - EPSILON <= midpoint && segment.end > midpoint + EPSILON) active.add(segment.speaker);
  }
  return active;
}

function uniqueSpeakers(segments) {
  return [...new Set(segments.map((segment) => segment.speaker))].sort();
}

function intervals(reference, hypothesis) {
  const boundaries = [...new Set([...reference, ...hypothesis].flatMap((segment) => [segment.start, segment.end]))]
    .sort((left, right) => left - right);
  const result = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end - start <= EPSILON) continue;
    result.push({ start, end, duration: end - start, midpoint: (start + end) / 2 });
  }
  return result;
}

// Maximum-weight one-to-one assignment using a square Hungarian matrix.
function maximumAssignment(weights) {
  const rows = weights.length;
  const columns = weights.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const size = Math.max(rows, columns);
  if (!size) return [];
  const maximum = weights.reduce((outer, row) => Math.max(outer, ...row, 0), 0);
  const cost = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => maximum - (weights[row]?.[column] || 0)));

  const u = Array(size + 1).fill(0);
  const v = Array(size + 1).fill(0);
  const matchedRow = Array(size + 1).fill(0);
  const previousColumn = Array(size + 1).fill(0);

  for (let row = 1; row <= size; row += 1) {
    matchedRow[0] = row;
    let column0 = 0;
    const minimum = Array(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array(size + 1).fill(false);
    do {
      used[column0] = true;
      const row0 = matchedRow[column0];
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const current = cost[row0 - 1][column - 1] - u[row0] - v[column];
        if (current < minimum[column]) {
          minimum[column] = current;
          previousColumn[column] = column0;
        }
        if (minimum[column] < delta) {
          delta = minimum[column];
          column1 = column;
        }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          u[matchedRow[column]] += delta;
          v[column] -= delta;
        } else {
          minimum[column] -= delta;
        }
      }
      column0 = column1;
    } while (matchedRow[column0] !== 0);

    do {
      const column1 = previousColumn[column0];
      matchedRow[column0] = matchedRow[column1];
      column0 = column1;
    } while (column0 !== 0);
  }

  const assignment = Array(rows).fill(-1);
  for (let column = 1; column <= size; column += 1) {
    const row = matchedRow[column] - 1;
    if (row >= 0 && row < rows && column - 1 < columns) assignment[row] = column - 1;
  }
  return assignment;
}

function rounded(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function evaluateDiarization(referenceInput, hypothesisInput, { ignoreOverlap = false } = {}) {
  const reference = normalizeSpeakerSegments(referenceInput, { source: "reference" });
  const hypothesis = normalizeSpeakerSegments(hypothesisInput, { source: "hypothesis" });
  const referenceSpeakers = uniqueSpeakers(reference);
  const hypothesisSpeakers = uniqueSpeakers(hypothesis);
  const timeline = intervals(reference, hypothesis);

  const overlap = hypothesisSpeakers.map(() => referenceSpeakers.map(() => 0));
  for (const interval of timeline) {
    const referenceActive = activeSpeakers(reference, interval.midpoint);
    if (ignoreOverlap && referenceActive.size > 1) continue;
    const hypothesisActive = activeSpeakers(hypothesis, interval.midpoint);
    for (const hypothesisSpeaker of hypothesisActive) {
      for (const referenceSpeaker of referenceActive) {
        overlap[hypothesisSpeakers.indexOf(hypothesisSpeaker)][referenceSpeakers.indexOf(referenceSpeaker)] += interval.duration;
      }
    }
  }

  const assignment = maximumAssignment(overlap);
  const mapping = new Map();
  assignment.forEach((referenceIndex, hypothesisIndex) => {
    if (referenceIndex >= 0 && referenceIndex < referenceSpeakers.length && overlap[hypothesisIndex][referenceIndex] > 0) {
      mapping.set(hypothesisSpeakers[hypothesisIndex], referenceSpeakers[referenceIndex]);
    }
  });

  let referenceSpeakerTime = 0;
  let scoredTimelineSeconds = 0;
  let missedSpeakerTime = 0;
  let falseAlarmSpeakerTime = 0;
  let confusionSpeakerTime = 0;
  for (const interval of timeline) {
    const referenceActive = activeSpeakers(reference, interval.midpoint);
    if (ignoreOverlap && referenceActive.size > 1) continue;
    const hypothesisActive = activeSpeakers(hypothesis, interval.midpoint);
    const mappedHypothesis = new Set([...hypothesisActive].map((speaker) => mapping.get(speaker)).filter(Boolean));
    const correct = [...referenceActive].filter((speaker) => mappedHypothesis.has(speaker)).length;
    const referenceCount = referenceActive.size;
    const hypothesisCount = hypothesisActive.size;
    referenceSpeakerTime += referenceCount * interval.duration;
    scoredTimelineSeconds += interval.duration;
    missedSpeakerTime += Math.max(0, referenceCount - hypothesisCount) * interval.duration;
    falseAlarmSpeakerTime += Math.max(0, hypothesisCount - referenceCount) * interval.duration;
    confusionSpeakerTime += (Math.min(referenceCount, hypothesisCount) - correct) * interval.duration;
  }

  const jerErrors = referenceSpeakers.map((referenceSpeaker) => {
    const hypothesisSpeaker = [...mapping].find(([, mapped]) => mapped === referenceSpeaker)?.[0];
    if (!hypothesisSpeaker) return 1;
    let intersection = 0;
    let union = 0;
    for (const interval of timeline) {
      const referenceActive = activeSpeakers(reference, interval.midpoint);
      if (ignoreOverlap && referenceActive.size > 1) continue;
      const hypothesisActive = activeSpeakers(hypothesis, interval.midpoint);
      const inReference = referenceActive.has(referenceSpeaker);
      const inHypothesis = hypothesisActive.has(hypothesisSpeaker);
      if (inReference && inHypothesis) intersection += interval.duration;
      if (inReference || inHypothesis) union += interval.duration;
    }
    return union > 0 ? 1 - intersection / union : 1;
  });

  const denominator = referenceSpeakerTime || 1;
  const diarizationErrorRate = (missedSpeakerTime + falseAlarmSpeakerTime + confusionSpeakerTime) / denominator;
  const mappingObject = Object.fromEntries(hypothesisSpeakers.map((speaker) => [speaker, mapping.get(speaker) || null]));
  return {
    referenceSpeakerCount: referenceSpeakers.length,
    hypothesisSpeakerCount: hypothesisSpeakers.length,
    speakerCountError: hypothesisSpeakers.length - referenceSpeakers.length,
    mapping: mappingObject,
    scoredTimelineSeconds: rounded(scoredTimelineSeconds),
    referenceSpeakerSeconds: rounded(referenceSpeakerTime),
    missedSpeakerSeconds: rounded(missedSpeakerTime),
    falseAlarmSpeakerSeconds: rounded(falseAlarmSpeakerTime),
    confusionSpeakerSeconds: rounded(confusionSpeakerTime),
    der: rounded(diarizationErrorRate),
    jer: rounded(jerErrors.length ? jerErrors.reduce((sum, value) => sum + value, 0) / jerErrors.length : 0),
    ignoreOverlap,
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const referencePath = value("--reference");
  const hypothesisPath = value("--hypothesis");
  if (!referencePath || !hypothesisPath) {
    console.error("用法：node tools/speaker-diarization-metrics.mjs --reference reference.rttm --hypothesis transcript.json [--uri recording] [--ignore-overlap]");
    process.exitCode = 2;
    return;
  }
  const reference = parseRttm(await fs.readFile(referencePath, "utf8"), { uri: value("--uri") });
  const hypothesisDocument = JSON.parse(await fs.readFile(hypothesisPath, "utf8"));
  const hypothesis = hypothesisDocument.segments || hypothesisDocument.result?.segments;
  const metrics = evaluateDiarization(reference, hypothesis, { ignoreOverlap: args.includes("--ignore-overlap") });
  process.stdout.write(`${JSON.stringify({ reference: path.resolve(referencePath), hypothesis: path.resolve(hypothesisPath), ...metrics }, null, 2)}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await runCli();
