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
    double cluster_threshold = 0.35;
    // Clusters smaller than this are attached to a nearby stable cluster or
    // reported as noise.  A single-point input is always kept usable.
    std::size_t min_cluster_size = 2;
    // AHC never merges below this many evidence-backed clusters.  It does not
    // invent speakers when the embeddings contain fewer distinct groups.
    std::size_t min_speakers = 1;
    // If threshold-based clustering leaves more clusters, the best remaining
    // average-link pairs are merged until this cap is met.
    std::size_t max_speakers = 15;
};

struct ClusterSummary {
    int id = -1;
    std::size_t size = 0;
    std::string canonical_key;
    std::vector<float> prototype;
};

struct ClusterResult {
    // One label per input point.  -1 means invalid/noise and should not be
    // presented as a speaker cluster.
    std::vector<int> labels;
    // Cosine similarity to the final prototype for each non-noise point.
    std::vector<double> scores;
    // Stable IDs are assigned by canonical_key, not by input order.
    std::vector<ClusterSummary> clusters;
};

struct TimelineWindow {
    std::size_t segment_index = 0;
    std::string key;
    double start = 0.0;
    double end = 0.0;
};

struct SegmentAssignment {
    int cluster = -1;
    double speaker_purity = 0.0;
    bool mixed_speaker = false;
    std::size_t window_count = 0;
};

// Deterministic, global average-link agglomerative clustering over cosine
// similarity.  The result is invariant to input permutation when point keys
// are stable.  No numerical dependency or audio/runtime type leaks through
// this interface.
ClusterResult cluster_embeddings(const std::vector<EmbeddingPoint> &points,
                                 const ClusterOptions &options = {});

// Map overlapping analysis windows back to caller-provided speech/ASR
// segments using duration-weighted majority voting.  Mixed or uncertain
// segments remain visible through speaker_purity/mixed_speaker.
std::vector<SegmentAssignment> map_windows_to_segments(const std::vector<TimelineWindow> &windows,
                                                       const std::vector<int> &window_labels,
                                                       std::size_t segment_count);

} // namespace zcode::speaker
