export const SPEAKER_ALGORITHM_VERSION = "speaker-v5";

// Quality and public presentation for speaker-v5. Clustering lives only in
// the native adapter; this module never invents identities from embeddings.

export function allowedPublicClusters(clusters, qualityState) {
  if (qualityState === "unusable") return [];
  return (clusters || []).filter((cluster) => (
    cluster?.trusted === true
    && cluster.stability === "stable"
    && cluster.clusterId
    && (qualityState !== "degraded" || cluster.strong === true)
  ));
}

export function finalizeSpeakerAnalysis(nativeResult, segments = []) {
  const algorithmVersion = String(nativeResult?.algorithmVersion || "");
  const sourceClusters = normalizeIncomingClusters(nativeResult?.clusters);
  const sourceSegments = Array.isArray(nativeResult?.segments)
    ? nativeResult.segments
    : segments;
  let quality = nativeResult?.quality && typeof nativeResult.quality === "object"
    ? normalizeQuality(nativeResult.quality, sourceClusters)
    : deriveQuality(sourceClusters, nativeResult?.metrics, sourceSegments);
  let publicClusters = allowedPublicClusters(sourceClusters, quality.state);
  quality = reconcileQuality(quality, sourceClusters, publicClusters);
  publicClusters = allowedPublicClusters(sourceClusters, quality.state);
  const allowedIds = new Set(publicClusters.map((cluster) => cluster.clusterId));
  const projected = sourceSegments.map((segment) => projectSegmentToAllowed(segment, allowedIds));

  const privateAnalysis = {
    status: "completed",
    algorithmVersion: algorithmVersion || SPEAKER_ALGORITHM_VERSION,
    metrics: {
      ...(nativeResult?.metrics && typeof nativeResult.metrics === "object" ? nativeResult.metrics : {}),
      privateCandidateCount: sourceClusters.length,
      trustedSpeakerCount: publicClusters.length,
      forcedMergeCount: Number(nativeResult?.metrics?.forcedMergeCount || 0),
      speakerCountExceeded: Boolean(nativeResult?.metrics?.speakerCountExceeded),
    },
    quality: {
      ...quality,
      trustedSpeakerCount: publicClusters.length,
      ...(quality.state === "unusable" ? { trustedCoverage: 0 } : {}),
    },
    clusters: sourceClusters,
  };
  return {
    segments: projected,
    privateAnalysis,
    publicAnalysis: publicSpeakerAnalysis(privateAnalysis),
    cacheable: algorithmVersion === SPEAKER_ALGORITHM_VERSION,
  };
}

export function publicSpeakerAnalysis(analysis) {
  if (!analysis) return null;
  const qualityState = analysis.quality?.state;
  const allowed = new Set(allowedPublicClusters(analysis.clusters || [], qualityState).map((cluster) => cluster.clusterId));
  const quality = analysis.quality ? {
    state: analysis.quality.state,
    trustedSpeakerCount: allowed.size,
    trustedCoverage: analysis.quality.trustedCoverage,
    unknownRatio: analysis.quality.unknownRatio,
    mixedRatio: analysis.quality.mixedRatio,
    reasonCodes: [...(analysis.quality.reasonCodes || [])],
  } : null;
  return {
    status: analysis.status,
    algorithmVersion: analysis.algorithmVersion || null,
    ...(quality ? { quality } : {}),
    metrics: publicMetrics(analysis.metrics || {}),
    clusters: (analysis.clusters || [])
      .filter((cluster) => allowed.has(cluster.clusterId))
      .map((cluster) => ({
        clusterId: cluster.clusterId,
        size: cluster.size,
        windowCount: cluster.windowCount,
        voicedSeconds: cluster.voicedSeconds,
        independentEvidence: cluster.independentEvidence,
        coherence: cluster.coherence,
        stability: cluster.stability,
      })),
    ...(analysis.code ? { code: analysis.code } : {}),
  };
}

function publicMetrics(metrics) {
  const result = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (/prototype|embedding|vector/i.test(key)) continue;
    result[key] = value;
  }
  return result;
}

function normalizeIncomingClusters(clusters) {
  if (!Array.isArray(clusters)) return [];
  return clusters.map((summary, index) => {
    const voicedSeconds = Number.isFinite(summary?.voicedSeconds) ? summary.voicedSeconds : Number(summary?.unionVoicedSeconds);
    const independentEvidence = Math.max(0, Number(summary?.independentEvidence || 0));
    const trusted = summary?.trusted === true
      || (summary?.trusted !== false && summary?.stability === "stable"
        && (independentEvidence >= 3 || (Number.isFinite(voicedSeconds) && voicedSeconds >= 3)));
    const clusterId = normalizeClusterId(summary?.clusterId ?? summary?.id ?? (trusted ? index : null));
    const strong = typeof summary?.strong === "boolean"
      ? summary.strong
      : trusted && (independentEvidence >= 6 || voicedSeconds >= 6);
    return {
      clusterId,
      privateId: Number.isInteger(summary?.privateId) ? summary.privateId : index,
      size: Math.max(0, Number(summary?.size ?? summary?.windowCount ?? 0) || 0),
      windowCount: Math.max(0, Number(summary?.windowCount ?? summary?.size ?? 0) || 0),
      voicedSeconds: Number.isFinite(voicedSeconds) ? voicedSeconds : null,
      independentEvidence,
      coherence: Number.isFinite(summary?.coherence) ? summary.coherence : null,
      canonicalKey: typeof summary?.canonicalKey === "string" ? summary.canonicalKey : null,
      stability: trusted ? "stable" : "transient",
      trusted,
      strong,
      ...(Array.isArray(summary?.prototype) ? { prototype: summary.prototype } : {}),
    };
  }).filter((cluster) => cluster.clusterId || !cluster.trusted);
}

function normalizeClusterId(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (text.startsWith("cluster_")) return text;
  if (/^\d+$/.test(text)) return `cluster_${text}`;
  return text;
}

function normalizeQuality(quality, clusters) {
  const trusted = clusters.filter((cluster) => cluster.trusted);
  return {
    state: ["reliable", "degraded", "unusable"].includes(quality.state) ? quality.state : "reliable",
    trustedSpeakerCount: Number.isFinite(quality.trustedSpeakerCount) ? quality.trustedSpeakerCount : trusted.length,
    trustedCoverage: Number.isFinite(quality.trustedCoverage) ? quality.trustedCoverage : 0,
    unknownRatio: Number.isFinite(quality.unknownRatio) ? quality.unknownRatio : 0,
    mixedRatio: Number.isFinite(quality.mixedRatio) ? quality.mixedRatio : 0,
    reasonCodes: Array.isArray(quality.reasonCodes) ? quality.reasonCodes.map(String) : [],
  };
}

function deriveQuality(clusters, metrics, segments) {
  const trusted = clusters.filter((cluster) => cluster.trusted);
  const mixedRatio = segments.length ? segments.filter((segment) => segment.mixedSpeaker || segment.speaker === "mixed").length / segments.length : 0;
  const unknownRatio = segments.length ? segments.filter((segment) => segment.speaker === "unknown").length / segments.length : 0;
  const reasonCodes = [];
  if (trusted.length === 0 && clusters.length > 0) reasonCodes.push("no_trusted_speakers");
  if (unknownRatio > 0.55) reasonCodes.push("high_unknown_ratio");
  if (mixedRatio > 0.40) reasonCodes.push("high_mixed_ratio");
  if (metrics?.speakerCountExceeded) reasonCodes.push("speaker_count_exceeded");
  if (clusters.length > Math.max(24, trusted.length * 4) && trusted.length > 0) reasonCodes.push("excessive_private_candidates");
  let state = "reliable";
  if (reasonCodes.includes("no_trusted_speakers") || (trusted.length === 0 && unknownRatio >= 0.8 && clusters.length > 0)) {
    state = "unusable";
  } else if (unknownRatio > 0.35 || reasonCodes.includes("excessive_private_candidates")) {
    state = "degraded";
  }
  return {
    state,
    trustedSpeakerCount: trusted.length,
    trustedCoverage: roundMetric(Math.max(0, 1 - unknownRatio)),
    unknownRatio: roundMetric(unknownRatio),
    mixedRatio: roundMetric(mixedRatio),
    reasonCodes,
  };
}

function reconcileQuality(quality, sourceClusters, publicClusters) {
  if (quality.state === "reliable" && sourceClusters.length > 0 && publicClusters.length === 0) {
    const reasonCodes = [...(quality.reasonCodes || [])];
    if (!reasonCodes.includes("no_trusted_speakers")) reasonCodes.push("no_trusted_speakers");
    if (!reasonCodes.includes("inconsistent_quality_summary")) reasonCodes.push("inconsistent_quality_summary");
    return {
      ...quality,
      state: "unusable",
      trustedSpeakerCount: 0,
      trustedCoverage: 0,
      reasonCodes,
    };
  }
  return quality;
}

function roundMetric(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1e6) / 1e6;
}

function projectSegmentToAllowed(segment, allowedIds) {
  const spans = Array.isArray(segment.speakerSpans)
    ? segment.speakerSpans.map((span) => (
      allowedIds.has(span.speaker) ? span : { ...span, speaker: "unknown", confidence: 0 }
    ))
    : [];
  const spanSpeakers = [...new Set(spans.map((span) => span.speaker).filter((speaker) => allowedIds.has(speaker)))];
  const wasMixed = segment.mixedSpeaker === true || segment.speaker === "mixed";
  if (wasMixed) {
    const { speakerCluster: _speakerCluster, personId: _personId, ...clean } = segment;
    const dominant = allowedIds.has(segment.dominantSpeaker)
      ? segment.dominantSpeaker
      : (spanSpeakers[0] || null);
    return {
      ...clean,
      speaker: "mixed",
      dominantSpeaker: dominant,
      speakerMatch: "mixed",
      speakerConfidence: null,
      speakerStability: "mixed",
      mixedSpeaker: true,
      speakerSpans: spans,
    };
  }

  const speaker = allowedIds.has(segment.speaker)
    ? segment.speaker
    : allowedIds.has(segment.speakerCluster)
      ? segment.speakerCluster
      : null;
  if (speaker) {
    return {
      ...segment,
      speaker,
      speakerCluster: speaker,
      dominantSpeaker: allowedIds.has(segment.dominantSpeaker) ? segment.dominantSpeaker : speaker,
      speakerSpans: spans.length ? spans : segment.speakerSpans,
    };
  }
  return unknownSegment(segment, spans);
}

function unknownSegment(segment, spans) {
  const { speakerCluster: _speakerCluster, personId: _personId, ...clean } = segment;
  return {
    ...clean,
    speaker: "unknown",
    dominantSpeaker: null,
    speakerMatch: "unknown",
    speakerConfidence: null,
    speakerStability: "unknown",
    mixedSpeaker: false,
    speakerSpans: spans.length ? spans : (segment.speakerSpans || []).map((span) => ({ ...span, speaker: "unknown", confidence: 0 })),
  };
}
