import assert from "node:assert/strict";
import test from "node:test";
import {
  SPEAKER_ALGORITHM_VERSION,
  finalizeSpeakerAnalysis,
  publicSpeakerAnalysis,
} from "../scripts/speaker-analyzer.mjs";

function nativeLike({ segments, clusters, metrics = {}, quality }) {
  return {
    algorithmVersion: SPEAKER_ALGORITHM_VERSION,
    segments,
    clusters,
    metrics: { forcedMergeCount: 0, speakerCountExceeded: false, ...metrics },
    quality,
  };
}

function trustedCluster(id, extras = {}) {
  return {
    clusterId: id,
    size: 12,
    windowCount: 12,
    voicedSeconds: 14,
    independentEvidence: 8,
    coherence: 0.9,
    stability: "stable",
    trusted: true,
    strong: true,
    prototype: [1, 0, 0, 0],
    ...extras,
  };
}

test("speaker-v5 public presentation keeps mixed segments mixed", () => {
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [{
      id: "seg_mixed",
      start: 0,
      end: 10,
      text: "both",
      speaker: "mixed",
      dominantSpeaker: "cluster_0",
      speakerMatch: "mixed",
      mixedSpeaker: true,
      speakerSpans: [
        { start: 0, end: 5, speaker: "cluster_0", confidence: 0.9 },
        { start: 5, end: 10, speaker: "cluster_1", confidence: 0.84 },
      ],
    }],
    clusters: [trustedCluster("cluster_0"), trustedCluster("cluster_1", { prototype: [0, 1, 0, 0] })],
    quality: { state: "reliable", trustedSpeakerCount: 2, trustedCoverage: 1, unknownRatio: 0, mixedRatio: 1, reasonCodes: [] },
  }));
  assert.equal(finalized.segments[0].speaker, "mixed");
  assert.equal(finalized.segments[0].mixedSpeaker, true);
  assert.equal("speakerCluster" in finalized.segments[0], false);
  assert.equal(finalized.publicAnalysis.algorithmVersion, SPEAKER_ALGORITHM_VERSION);
  assert.equal(finalized.publicAnalysis.quality.state, "reliable");
  assert.equal(finalized.publicAnalysis.clusters.length, 2);
});

test("speaker-v5 never publishes untrusted identities just because quality is reliable", () => {
  const finalized = finalizeSpeakerAnalysis({
    algorithmVersion: SPEAKER_ALGORITHM_VERSION,
    segments: [{ id: "x", speaker: "candidate_x", speakerCluster: "candidate_x" }],
    clusters: [{
      clusterId: "candidate_x",
      size: 1,
      windowCount: 1,
      voicedSeconds: 0.5,
      independentEvidence: 1,
      coherence: 0.9,
      stability: "transient",
      trusted: false,
    }],
    quality: {
      state: "reliable",
      trustedSpeakerCount: 0,
      trustedCoverage: 1,
      unknownRatio: 0,
      mixedRatio: 0,
      reasonCodes: [],
    },
  });
  assert.equal(finalized.segments[0].speaker, "unknown");
  assert.equal("speakerCluster" in finalized.segments[0], false);
  assert.equal(finalized.publicAnalysis.clusters.length, 0);
  assert.equal(finalized.publicAnalysis.quality.trustedSpeakerCount, 0);
  assert.equal(finalized.publicAnalysis.quality.state, "unusable");
  assert.ok(finalized.publicAnalysis.quality.reasonCodes.includes("inconsistent_quality_summary"));
});

test("speaker-v5 mixed segment stays mixed when only one allowed span remains", () => {
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [{
      id: "seg_mixed_tail",
      start: 0,
      end: 10,
      text: "both",
      speaker: "mixed",
      dominantSpeaker: "cluster_0",
      speakerMatch: "mixed",
      mixedSpeaker: true,
      speakerCluster: "cluster_0",
      personId: "person_should_not_leak",
      speakerSpans: [
        { start: 0, end: 7, speaker: "cluster_0", confidence: 0.92 },
        { start: 7, end: 10, speaker: "candidate_x", confidence: 0.4 },
      ],
    }],
    clusters: [
      trustedCluster("cluster_0", { strong: true }),
      {
        clusterId: "candidate_x",
        size: 1,
        windowCount: 1,
        voicedSeconds: 0.8,
        independentEvidence: 1,
        stability: "transient",
        trusted: false,
        strong: false,
        prototype: [0, 1, 0, 0],
      },
    ],
    quality: {
      state: "degraded",
      trustedSpeakerCount: 1,
      trustedCoverage: 0.7,
      unknownRatio: 0.3,
      mixedRatio: 1,
      reasonCodes: ["high_unknown_ratio"],
    },
  }));
  const segment = finalized.segments[0];
  assert.equal(segment.speaker, "mixed");
  assert.equal(segment.speakerMatch, "mixed");
  assert.equal(segment.mixedSpeaker, true);
  assert.equal("speakerCluster" in segment, false);
  assert.equal("personId" in segment, false);
  assert.equal(segment.dominantSpeaker, "cluster_0");
  assert.deepEqual(segment.speakerSpans.map((span) => span.speaker), ["cluster_0", "unknown"]);
  assert.doesNotMatch(JSON.stringify(finalized.publicAnalysis), /prototype|embedding|person_should_not_leak/i);
});

test("speaker-v5 mixed segment stays mixed when no allowed spans remain", () => {
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [{
      id: "seg_mixed_empty",
      start: 0,
      end: 4,
      text: "both",
      speaker: "mixed",
      dominantSpeaker: "cluster_0",
      mixedSpeaker: true,
      speakerCluster: "cluster_0",
      personId: "person_hidden",
      speakerSpans: [
        { start: 0, end: 2, speaker: "cluster_0", confidence: 0.5 },
        { start: 2, end: 4, speaker: "cluster_1", confidence: 0.5 },
      ],
    }],
    clusters: [
      { clusterId: "cluster_0", size: 2, windowCount: 2, voicedSeconds: 1, independentEvidence: 1, stability: "transient", trusted: false, prototype: [1, 0, 0, 0] },
      { clusterId: "cluster_1", size: 2, windowCount: 2, voicedSeconds: 1, independentEvidence: 1, stability: "transient", trusted: false, prototype: [0, 1, 0, 0] },
    ],
    quality: { state: "unusable", trustedSpeakerCount: 0, trustedCoverage: 0, unknownRatio: 1, mixedRatio: 1, reasonCodes: ["no_trusted_speakers"] },
  }));
  const segment = finalized.segments[0];
  assert.equal(segment.speaker, "mixed");
  assert.equal(segment.speakerMatch, "mixed");
  assert.equal(segment.mixedSpeaker, true);
  assert.equal(segment.dominantSpeaker, null);
  assert.equal("speakerCluster" in segment, false);
  assert.equal("personId" in segment, false);
  assert.ok(segment.speakerSpans.every((span) => span.speaker === "unknown"));
});

test("speaker-v5 respects explicit native strong false in degraded mode", () => {
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [{ id: "seg", start: 0, end: 20, text: "long", speaker: "cluster_0", speakerCluster: "cluster_0", mixedSpeaker: false }],
    clusters: [trustedCluster("cluster_0", {
      strong: false,
      voicedSeconds: 40,
      independentEvidence: 20,
      windowCount: 30,
      size: 30,
    })],
    quality: {
      state: "degraded",
      trustedSpeakerCount: 1,
      trustedCoverage: 0.5,
      unknownRatio: 0.5,
      mixedRatio: 0,
      reasonCodes: ["high_unknown_ratio"],
    },
  }));
  assert.equal(finalized.privateAnalysis.clusters[0].strong, false);
  assert.equal(finalized.segments[0].speaker, "unknown");
  assert.equal(finalized.publicAnalysis.clusters.length, 0);
  assert.equal(finalized.publicAnalysis.quality.trustedSpeakerCount, 0);
});

test("speaker-v5 mixed reconstruction from private analysis stays mixed and public", () => {
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [{
      id: "seg_mixed",
      start: 0,
      end: 10,
      text: "both",
      speaker: "mixed",
      dominantSpeaker: "cluster_0",
      mixedSpeaker: true,
      speakerSpans: [
        { start: 0, end: 5, speaker: "cluster_0", confidence: 0.9 },
        { start: 5, end: 10, speaker: "cluster_1", confidence: 0.84 },
      ],
    }],
    clusters: [trustedCluster("cluster_0"), trustedCluster("cluster_1", { prototype: [0, 1, 0, 0] })],
    quality: { state: "reliable", trustedSpeakerCount: 2, trustedCoverage: 1, unknownRatio: 0, mixedRatio: 1, reasonCodes: [] },
  }));
  const reconstructed = publicSpeakerAnalysis(finalized.privateAnalysis);
  assert.equal(finalized.segments[0].speaker, "mixed");
  assert.equal(finalized.segments[0].mixedSpeaker, true);
  assert.equal(reconstructed.clusters.length, 2);
  assert.equal(reconstructed.quality.trustedSpeakerCount, reconstructed.clusters.length);
  assert.doesNotMatch(JSON.stringify(reconstructed), /prototype|embedding|vector/i);
  assert.equal("publicClusterIds" in finalized.privateAnalysis, false);
});

test("speaker-v5 degraded public clusters match strong segments and trusted count", () => {
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [
      { id: "seg_strong", start: 0, end: 20, text: "strong", speaker: "cluster_0", speakerCluster: "cluster_0", mixedSpeaker: false },
      { id: "seg_weak", start: 24, end: 30, text: "weak", speaker: "cluster_1", speakerCluster: "cluster_1", mixedSpeaker: false },
    ],
    clusters: [
      trustedCluster("cluster_0", { strong: true, voicedSeconds: 20, independentEvidence: 10 }),
      trustedCluster("cluster_1", { strong: false, voicedSeconds: 4, independentEvidence: 3, prototype: [0, 1, 0, 0] }),
    ],
    quality: {
      state: "degraded",
      trustedSpeakerCount: 2,
      trustedCoverage: 0.6,
      unknownRatio: 0.4,
      mixedRatio: 0,
      reasonCodes: ["high_unknown_ratio"],
    },
  }));
  assert.equal(finalized.segments[0].speaker, "cluster_0");
  assert.equal(finalized.segments[1].speaker, "unknown");
  assert.deepEqual(finalized.publicAnalysis.clusters.map((cluster) => cluster.clusterId), ["cluster_0"]);
  assert.equal(finalized.publicAnalysis.quality.trustedSpeakerCount, finalized.publicAnalysis.clusters.length);
  assert.equal(finalized.publicAnalysis.quality.trustedSpeakerCount, 1);
  assert.doesNotMatch(JSON.stringify(finalized.publicAnalysis), /prototype|embedding/i);
  assert.ok(finalized.privateAnalysis.clusters.some((cluster) => Array.isArray(cluster.prototype) && cluster.clusterId === "cluster_1"));
});

test("speaker-v5 maps untrusted and transient evidence to unknown", () => {
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [{
      id: "seg_short",
      start: 0,
      end: 0.8,
      text: "hi",
      speaker: "unknown",
      speakerMatch: "unknown",
      mixedSpeaker: false,
      speakerSpans: [{ start: 0, end: 0.8, speaker: "unknown", confidence: 0 }],
    }],
    clusters: [{
      clusterId: "cluster_0",
      size: 2,
      windowCount: 2,
      voicedSeconds: 2.25,
      independentEvidence: 1,
      stability: "transient",
      trusted: false,
      prototype: [1, 0, 0, 0],
    }],
    metrics: { privateCandidateCount: 1, trustedSpeakerCount: 0, forcedMergeCount: 0 },
    quality: { state: "unusable", trustedSpeakerCount: 0, trustedCoverage: 0, unknownRatio: 1, mixedRatio: 0, reasonCodes: ["no_trusted_speakers"] },
  }));
  assert.equal(finalized.segments[0].speaker, "unknown");
  assert.equal(finalized.publicAnalysis.clusters.length, 0);
  assert.equal(finalized.publicAnalysis.quality.state, "unusable");
  assert.equal(finalized.privateAnalysis.metrics.forcedMergeCount, 0);
});

test("speaker-v5 two overlapping windows in a native result do not become a public speaker", () => {
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [{ id: "seg", start: 5, end: 7.25, text: "hi", speaker: "unknown", mixedSpeaker: false }],
    clusters: [{
      clusterId: "cluster_0",
      size: 2,
      windowCount: 2,
      voicedSeconds: 2.25,
      independentEvidence: 1,
      stability: "transient",
      trusted: false,
      prototype: [0.2, 0.8, 0, 0],
    }],
    quality: { state: "unusable", trustedSpeakerCount: 0, trustedCoverage: 0, unknownRatio: 1, mixedRatio: 0, reasonCodes: ["no_trusted_speakers"] },
  }));
  assert.equal(finalized.publicAnalysis.clusters.length, 0);
  assert.equal(finalized.segments[0].speaker, "unknown");
});

test("speaker-v5 hundreds of private candidates cannot become excessive public labels", () => {
  const clusters = [
    trustedCluster("cluster_0"),
    ...Array.from({ length: 80 }, (_, index) => ({
      clusterId: `candidate_${index}`,
      size: 2,
      windowCount: 2,
      voicedSeconds: 1.2,
      independentEvidence: 1,
      stability: "transient",
      trusted: false,
      prototype: [0, 1, 0, index],
    })),
  ];
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [{ id: "seg", start: 0, end: 16, text: "main", speaker: "cluster_0", speakerCluster: "cluster_0", mixedSpeaker: false }],
    clusters,
    metrics: { privateCandidateCount: clusters.length, trustedSpeakerCount: 1, forcedMergeCount: 0, speakerCountExceeded: true },
    quality: {
      state: "degraded",
      trustedSpeakerCount: 1,
      trustedCoverage: 0.7,
      unknownRatio: 0.3,
      mixedRatio: 0,
      reasonCodes: ["excessive_private_candidates", "speaker_count_exceeded"],
    },
  }));
  assert.equal(finalized.publicAnalysis.clusters.length, 1);
  assert.equal(finalized.privateAnalysis.metrics.forcedMergeCount, 0);
  assert.ok(finalized.privateAnalysis.metrics.privateCandidateCount > finalized.publicAnalysis.clusters.length);
  assert.equal(finalized.publicAnalysis.quality.state, "degraded");
});

test("speaker-v5 adapter failure finalize keeps complete ASR with safe speaker fallback", () => {
  const segments = [
    { id: "seg_0001", start: 0, end: 2, text: "完整转写", speaker: "unknown" },
    { id: "seg_0002", start: 2, end: 4, text: "仍然保留", speaker: "unknown" },
  ];
  const finalized = finalizeSpeakerAnalysis({
    algorithmVersion: SPEAKER_ALGORITHM_VERSION,
    segments,
    clusters: [],
    metrics: { forcedMergeCount: 0 },
    quality: { state: "unusable", trustedSpeakerCount: 0, trustedCoverage: 0, unknownRatio: 1, mixedRatio: 0, reasonCodes: ["adapter_failed"] },
  }, segments);
  assert.deepEqual(finalized.segments.map((segment) => segment.text), ["完整转写", "仍然保留"]);
  assert.ok(finalized.segments.every((segment) => segment.speaker === "unknown"));
  assert.equal(finalized.publicAnalysis.quality.state, "unusable");
  assert.equal(finalized.cacheable, true);
});

test("speaker-v4 native results are not cacheable as speaker-v5", () => {
  const finalized = finalizeSpeakerAnalysis({
    algorithmVersion: "speaker-v4",
    segments: [{ id: "seg", start: 0, end: 2, text: "old", speaker: "cluster_0", speakerCluster: "cluster_0" }],
    clusters: [{ clusterId: "cluster_0", size: 2, windowCount: 2, stability: "stable", prototype: [1, 0, 0, 0] }],
    metrics: { forcedMergeCount: 0 },
  });
  assert.equal(finalized.cacheable, false);
  assert.equal(finalized.privateAnalysis.algorithmVersion, "speaker-v4");
  assert.equal(finalized.publicAnalysis.clusters.length, 0);
});

test("speaker-v5 public analysis omits prototypes and embeddings", () => {
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: [{
      id: "seg",
      start: 0,
      end: 16,
      text: "ok",
      speaker: "cluster_0",
      speakerCluster: "cluster_0",
      mixedSpeaker: false,
    }],
    clusters: [trustedCluster("cluster_0")],
    quality: { state: "reliable", trustedSpeakerCount: 1, trustedCoverage: 1, unknownRatio: 0, mixedRatio: 0, reasonCodes: [] },
  }));
  const published = JSON.stringify(publicSpeakerAnalysis(finalized.privateAnalysis));
  assert.doesNotMatch(published, /prototype|embedding/i);
  assert.ok(finalized.privateAnalysis.clusters.some((cluster) => Array.isArray(cluster.prototype)));
  assert.equal(finalized.publicAnalysis.quality.trustedSpeakerCount, 1);
});

test("speaker-v5 unusable quality never emits low-confidence public identities", () => {
  const clusters = Array.from({ length: 40 }, (_, index) => ({
    clusterId: `cluster_${index}`,
    size: 3,
    windowCount: 3,
    voicedSeconds: 2.1,
    independentEvidence: 2,
    stability: "transient",
    trusted: false,
    prototype: [index, 1, 0, 0],
  }));
  const finalized = finalizeSpeakerAnalysis(nativeLike({
    segments: clusters.map((cluster, index) => ({
      id: `seg_${index}`,
      start: index,
      end: index + 1,
      text: "x",
      speaker: cluster.clusterId,
      speakerCluster: cluster.clusterId,
    })),
    clusters,
    quality: { state: "unusable", trustedSpeakerCount: 0, trustedCoverage: 0.05, unknownRatio: 0.95, mixedRatio: 0, reasonCodes: ["no_trusted_speakers", "low_trusted_coverage"] },
  }));
  assert.equal(finalized.publicAnalysis.clusters.length, 0);
  assert.ok(finalized.segments.every((segment) => segment.speaker === "unknown"));
  assert.doesNotMatch(JSON.stringify(finalized.publicAnalysis), /prototype|embedding/i);
});
