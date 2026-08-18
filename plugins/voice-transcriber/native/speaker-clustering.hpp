#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace zcode::speaker {

// A point is deliberately independent of audio and ONNX.  The clustering
// module only needs a stable key, an optional source segment index, and a
// normalized (or normalizable) embedding.
struct EmbeddingPoint {
    std::string key;
    std::size_t source_index = 0;
    double start = 0.0;
    double end = 0.0;
    std::vector<float> embedding;
};

struct ClusterOptions {
    // Average-link cosine similarity required for an ordinary merge.
    // With 1.5s/0.75s windows this is the calibrated baseline for the
    // bundled CAM++ checkpoint. It is intentionally different from the old
    // segment-level greedy threshold because the evidence unit changed.
    double cluster_threshold = 0.45;
    // Valid clusters smaller than this remain transient instead of being
    // attached to another speaker.
    std::size_t min_cluster_size = 2;
    // AHC never merges below this many evidence-backed clusters.  It does not
    // invent speakers when the embeddings contain fewer distinct groups.
    std::size_t min_speakers = 1;
    // Compatibility guardrail only.  It never forces a merge or changes
    // threshold-backed labels.
    std::size_t max_speakers = 64;
};

struct ClusterSummary {
    int id = -1;
    std::size_t size = 0;
    std::string canonical_key;
    std::vector<float> prototype;
    std::string stability = "stable";
};

struct ClusterResult {
    // One label per input point.  -1 means invalid/noise and should not be
    // presented as a speaker cluster.
    std::vector<int> labels;
    // Cosine similarity to the final prototype for each non-noise point.
    std::vector<double> scores;
    // Stable IDs are assigned by canonical_key, not by input order.
    std::vector<ClusterSummary> clusters;
    // Private diagnostics for the speaker pipeline.  max_speakers is a
    // warning ceiling; forced_merge_count is intentionally always zero.
    std::size_t post_threshold_cluster_count = 0;
    bool speaker_count_exceeded = false;
    std::size_t forced_merge_count = 0;
    std::size_t noise_window_count = 0;
    std::size_t transient_cluster_count = 0;
};

struct TimelineWindow {
    std::size_t segment_index = 0;
    std::string key;
    double start = 0.0;
    double end = 0.0;
    double segment_start = 0.0;
    double segment_end = 0.0;
};

struct SpeakerSpan {
    double start = 0.0;
    double end = 0.0;
    int cluster = -1;
    double confidence = 0.0;
};

struct SegmentAssignment {
    int cluster = -1;
    double speaker_purity = 0.0;
    bool mixed_speaker = false;
    std::size_t window_count = 0;
    std::vector<SpeakerSpan> speaker_spans;
};

struct TimelineOptions {
    // Transient evidence shorter than this is presented as noise.
    double micro_noise_max_seconds = 0.40;
    // A transient island no longer than this may bridge equal stable speakers.
    double transient_bridge_max_seconds = 1.50;
    // Cross-segment context must be this close on each side of the island.
    double bridge_max_gap_seconds = 0.50;
};

struct TimelineMetrics {
    std::size_t raw_transient_span_count = 0;
    std::size_t micro_noise_span_count = 0;
    std::size_t bridged_transient_span_count = 0;
    std::size_t suppressed_transient_span_count = 0;
    std::size_t raw_mixed_segment_count = 0;
    std::size_t presentation_mixed_segment_count = 0;
};

struct TimelineResult {
    std::vector<SegmentAssignment> assignments;
    TimelineMetrics metrics;
};

// Deterministic, global average-link agglomerative clustering over cosine
// similarity.  The result is invariant to input permutation when point keys
// are stable.  No numerical dependency or audio/runtime type leaks through
// this interface.
ClusterResult cluster_embeddings(const std::vector<EmbeddingPoint> &points,
                                 const ClusterOptions &options = {});

// Assign overlapping analysis windows to one global presentation timeline,
// then project the stabilized spans back onto the original ASR segments.
// Clustering evidence remains unchanged in ClusterResult.
TimelineResult assign_speaker_timeline(const std::vector<TimelineWindow> &windows,
                                       const ClusterResult &clustering,
                                       std::size_t segment_count,
                                       const TimelineOptions &options = {});

} // namespace zcode::speaker
