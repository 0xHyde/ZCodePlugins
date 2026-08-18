#include "speaker-clustering.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <string>
#include <utility>
#include <vector>

namespace zcode::speaker {
namespace {

constexpr double kMinimumCosine = -1.0;
constexpr double kMixedSpeakerPurity = 0.80;

struct WorkingCluster {
    std::vector<std::size_t> members;
    std::string canonical_key;
    bool active = true;
};

struct PairCandidate {
    float score = -1.0f;
    std::size_t left = 0;
    std::size_t right = 0;
    std::size_t left_version = 0;
    std::size_t right_version = 0;
};

struct PairWorseFirst {
    bool operator()(const PairCandidate &left, const PairCandidate &right) const {
        if (left.score != right.score) return left.score < right.score;
        if (left.left != right.left) return left.left > right.left;
        if (left.right != right.right) return left.right > right.right;
        if (left.left_version != right.left_version) return left.left_version > right.left_version;
        return left.right_version > right.right_version;
    }
};

double safe_threshold(double value) {
    if (!std::isfinite(value)) return 0.45;
    return std::max(-1.0, std::min(1.0, value));
}

std::vector<float> normalized(const std::vector<float> &input) {
    if (input.empty()) return {};
    double squared_norm = 0.0;
    for (const float value : input) {
        if (!std::isfinite(value)) return {};
        squared_norm += static_cast<double>(value) * value;
    }
    const double norm = std::sqrt(squared_norm);
    if (!std::isfinite(norm) || norm <= std::numeric_limits<double>::epsilon()) return {};
    std::vector<float> result = input;
    for (float &value : result) value = static_cast<float>(value / norm);
    return result;
}

double cosine(const std::vector<float> &left, const std::vector<float> &right) {
    if (left.empty() || right.empty() || left.size() != right.size()) return kMinimumCosine;
    double value = 0.0;
    for (std::size_t index = 0; index < left.size(); ++index) {
        value += static_cast<double>(left[index]) * right[index];
    }
    return std::max(-1.0, std::min(1.0, value));
}

std::string point_key(const EmbeddingPoint &point, std::size_t index) {
    return point.key.empty() ? "point_" + std::to_string(index) : point.key;
}

bool valid_pair(const PairCandidate &candidate,
                const std::vector<WorkingCluster> &clusters,
                const std::vector<std::size_t> &versions) {
    return candidate.left < clusters.size() && candidate.right < clusters.size() &&
           clusters[candidate.left].active && clusters[candidate.right].active &&
           versions[candidate.left] == candidate.left_version &&
           versions[candidate.right] == candidate.right_version;
}

void merge_clusters(std::size_t left,
                    std::size_t right,
                    std::vector<WorkingCluster> &clusters,
                    std::vector<std::size_t> &versions,
                    std::vector<float> &average_similarities,
                    std::size_t point_count) {
    if (left == right || !clusters[left].active || !clusters[right].active) return;
    // Initial cluster IDs are assigned in canonical key order.  Retaining the
    // smaller ID makes tie behaviour stable even when the heap sees a pair in
    // the opposite direction.
    if (right < left) std::swap(left, right);

    const double left_size = static_cast<double>(clusters[left].members.size());
    const double right_size = static_cast<double>(clusters[right].members.size());
    const double merged_size = left_size + right_size;
    clusters[left].members.insert(clusters[left].members.end(),
                                  clusters[right].members.begin(), clusters[right].members.end());
    clusters[left].canonical_key = std::min(clusters[left].canonical_key, clusters[right].canonical_key);
    clusters[right].active = false;
    ++versions[left];
    ++versions[right];

    for (std::size_t other = 0; other < clusters.size(); ++other) {
        if (other == left || other == right || !clusters[other].active) continue;
        const double left_average = average_similarities[left * point_count + other];
        const double right_average = average_similarities[right * point_count + other];
        const float merged_average = static_cast<float>((left_size * left_average + right_size * right_average) / merged_size);
        average_similarities[left * point_count + other] = merged_average;
        average_similarities[other * point_count + left] = merged_average;
    }
}

void push_candidate(std::priority_queue<PairCandidate, std::vector<PairCandidate>, PairWorseFirst> &queue,
                    std::size_t left,
                    std::size_t right,
                    const std::vector<WorkingCluster> &clusters,
                    const std::vector<std::size_t> &versions,
                    const std::vector<float> &average_similarities,
                    std::size_t point_count,
                    double threshold) {
    if (left == right || !clusters[left].active || !clusters[right].active) return;
    if (right < left) std::swap(left, right);
    const float score = average_similarities[left * point_count + right];
    if (score < threshold) return;
    queue.push({score, left, right, versions[left], versions[right]});
}

std::size_t active_count(const std::vector<WorkingCluster> &clusters) {
    return static_cast<std::size_t>(std::count_if(clusters.begin(), clusters.end(),
                                                   [](const WorkingCluster &cluster) { return cluster.active; }));
}

std::vector<float> cluster_prototype(const WorkingCluster &cluster,
                                     const std::vector<std::vector<float>> &normalized_points) {
    if (cluster.members.empty()) return {};
    const std::size_t dimensions = normalized_points[cluster.members.front()].size();
    if (dimensions == 0) return {};
    std::vector<float> prototype(dimensions, 0.0f);
    for (const std::size_t member : cluster.members) {
        if (normalized_points[member].size() != dimensions) continue;
        for (std::size_t dimension = 0; dimension < dimensions; ++dimension) {
            prototype[dimension] += normalized_points[member][dimension];
        }
    }
    return normalized(prototype);
}

} // namespace

ClusterResult cluster_embeddings(const std::vector<EmbeddingPoint> &points,
                                 const ClusterOptions &requested_options) {
    ClusterOptions options = requested_options;
    options.cluster_threshold = safe_threshold(options.cluster_threshold);
    options.min_cluster_size = std::max<std::size_t>(1, options.min_cluster_size);
    options.min_speakers = std::max<std::size_t>(1, options.min_speakers);
    options.max_speakers = std::max(options.min_speakers, options.max_speakers);

    ClusterResult result;
    result.labels.assign(points.size(), -1);
    result.scores.assign(points.size(), 0.0);
    if (points.empty()) return result;

    std::vector<std::vector<float>> normalized_points(points.size());
    std::vector<std::size_t> valid_indices;
    valid_indices.reserve(points.size());
    for (std::size_t index = 0; index < points.size(); ++index) {
        normalized_points[index] = normalized(points[index].embedding);
        if (!normalized_points[index].empty()) valid_indices.push_back(index);
    }
    result.noise_window_count = points.size() - valid_indices.size();
    if (valid_indices.empty()) return result;

    std::sort(valid_indices.begin(), valid_indices.end(), [&points](std::size_t left, std::size_t right) {
        const std::string left_key = point_key(points[left], left);
        const std::string right_key = point_key(points[right], right);
        if (left_key != right_key) return left_key < right_key;
        return left < right;
    });

    const std::size_t point_count = valid_indices.size();
    std::vector<WorkingCluster> clusters(point_count);
    for (std::size_t cluster_index = 0; cluster_index < point_count; ++cluster_index) {
        const std::size_t point_index = valid_indices[cluster_index];
        clusters[cluster_index].members.push_back(point_index);
        clusters[cluster_index].canonical_key = point_key(points[point_index], point_index);
    }

    // The matrix stores average-link similarities.  It is float-sized to keep
    // long recordings bounded while the clustering decision remains
    // deterministic.  Feature extraction is already complete at this point.
    std::vector<float> average_similarities(point_count * point_count, -1.0f);
    for (std::size_t left = 0; left < point_count; ++left) {
        average_similarities[left * point_count + left] = 1.0f;
        for (std::size_t right = left + 1; right < point_count; ++right) {
            const float score = static_cast<float>(cosine(normalized_points[valid_indices[left]],
                                                           normalized_points[valid_indices[right]]));
            average_similarities[left * point_count + right] = score;
            average_similarities[right * point_count + left] = score;
        }
    }

    std::vector<std::size_t> versions(point_count, 0);
    std::priority_queue<PairCandidate, std::vector<PairCandidate>, PairWorseFirst> merge_queue;
    for (std::size_t left = 0; left < point_count; ++left) {
        for (std::size_t right = left + 1; right < point_count; ++right) {
            push_candidate(merge_queue, left, right, clusters, versions, average_similarities,
                           point_count, options.cluster_threshold);
        }
    }

    while (active_count(clusters) > options.min_speakers && !merge_queue.empty()) {
        const PairCandidate candidate = merge_queue.top();
        merge_queue.pop();
        if (!valid_pair(candidate, clusters, versions) || candidate.score < options.cluster_threshold) continue;
        merge_clusters(candidate.left, candidate.right, clusters, versions, average_similarities, point_count);
        const std::size_t merged = std::min(candidate.left, candidate.right);
        for (std::size_t other = 0; other < clusters.size(); ++other) {
            if (other != merged && clusters[other].active) {
                push_candidate(merge_queue, merged, other, clusters, versions, average_similarities,
                               point_count, options.cluster_threshold);
            }
        }
    }

    // max_speakers is a compatibility warning ceiling.  Threshold-backed
    // clusters and their labels are intentionally left untouched.
    result.post_threshold_cluster_count = active_count(clusters);
    result.speaker_count_exceeded = result.post_threshold_cluster_count > options.max_speakers;

    std::vector<std::size_t> final_clusters;
    for (std::size_t index = 0; index < clusters.size(); ++index) {
        if (clusters[index].active) final_clusters.push_back(index);
    }
    std::sort(final_clusters.begin(), final_clusters.end(), [&clusters](std::size_t left, std::size_t right) {
        if (clusters[left].canonical_key != clusters[right].canonical_key) {
            return clusters[left].canonical_key < clusters[right].canonical_key;
        }
        return left < right;
    });

    for (std::size_t output_id = 0; output_id < final_clusters.size(); ++output_id) {
        const WorkingCluster &cluster = clusters[final_clusters[output_id]];
        const std::vector<float> prototype = cluster_prototype(cluster, normalized_points);
        const std::string stability = cluster.members.size() < options.min_cluster_size ? "transient" : "stable";
        if (stability == "transient") ++result.transient_cluster_count;
        result.clusters.push_back({static_cast<int>(output_id), cluster.members.size(), cluster.canonical_key, prototype, stability});
        for (const std::size_t member : cluster.members) {
            result.labels[member] = static_cast<int>(output_id);
            result.scores[member] = cosine(normalized_points[member], prototype);
        }
    }

    return result;
}

TimelineResult assign_speaker_timeline(const std::vector<TimelineWindow> &windows,
                                       const ClusterResult &clustering,
                                       std::size_t segment_count,
                                       const TimelineOptions &requested_options) {
    enum class Stability {
        stable,
        transient,
        unknown,
    };
    struct Evidence {
        TimelineWindow window;
        int label = -1;
        double score = 0.0;
        std::size_t source_index = 0;
    };
    struct RawSpan {
        std::size_t segment_index = 0;
        std::string canonical_key;
        double start = 0.0;
        double end = 0.0;
        int raw_cluster = -1;
        int presentation_cluster = -1;
        double confidence = 0.0;
        Stability stability = Stability::unknown;
    };

    TimelineOptions options = requested_options;
    if (!std::isfinite(options.micro_noise_max_seconds) || options.micro_noise_max_seconds < 0.0) {
        options.micro_noise_max_seconds = 0.40;
    }
    if (!std::isfinite(options.transient_bridge_max_seconds) || options.transient_bridge_max_seconds < 0.0) {
        options.transient_bridge_max_seconds = 1.50;
    }
    if (!std::isfinite(options.bridge_max_gap_seconds) || options.bridge_max_gap_seconds < 0.0) {
        options.bridge_max_gap_seconds = 0.50;
    }

    const auto cluster_stability = [&clustering](int label) {
        if (label < 0) return Stability::unknown;
        const auto summary = std::find_if(clustering.clusters.begin(), clustering.clusters.end(), [label](const ClusterSummary &item) {
            return item.id == label;
        });
        if (summary == clustering.clusters.end()) return Stability::unknown;
        return summary->stability == "transient" ? Stability::transient : Stability::stable;
    };

    std::vector<std::vector<Evidence>> evidence(segment_count);
    for (std::size_t index = 0; index < windows.size() && index < clustering.labels.size(); ++index) {
        const TimelineWindow &window = windows[index];
        if (window.segment_index >= segment_count || window.end <= window.start ||
            !std::isfinite(window.start) || !std::isfinite(window.end)) continue;
        evidence[window.segment_index].push_back({
            window,
            clustering.labels[index],
            index < clustering.scores.size() ? clustering.scores[index] : 0.0,
            index,
        });
    }

    TimelineResult result;
    result.assignments.resize(segment_count);
    std::vector<std::vector<RawSpan>> raw_spans(segment_count);
    for (std::size_t segment = 0; segment < segment_count; ++segment) {
        auto &segment_evidence = evidence[segment];
        std::sort(segment_evidence.begin(), segment_evidence.end(), [](const Evidence &left, const Evidence &right) {
            const double left_center = (left.window.start + left.window.end) / 2.0;
            const double right_center = (right.window.start + right.window.end) / 2.0;
            if (left_center != right_center) return left_center < right_center;
            if (left.window.key != right.window.key) return left.window.key < right.window.key;
            if (left.window.start != right.window.start) return left.window.start < right.window.start;
            if (left.window.end != right.window.end) return left.window.end < right.window.end;
            if (left.label != right.label) return left.label < right.label;
            return left.source_index < right.source_index;
        });

        if (segment_evidence.empty()) continue;
        double segment_start = std::numeric_limits<double>::infinity();
        double segment_end = -std::numeric_limits<double>::infinity();
        for (const Evidence &item : segment_evidence) {
            const bool has_segment_bounds = std::isfinite(item.window.segment_start) &&
                                            std::isfinite(item.window.segment_end) &&
                                            item.window.segment_end > item.window.segment_start;
            const double start = has_segment_bounds ? item.window.segment_start : item.window.start;
            const double end = has_segment_bounds ? item.window.segment_end : item.window.end;
            segment_start = std::min(segment_start, start);
            segment_end = std::max(segment_end, end);
        }
        if (!std::isfinite(segment_start) || !std::isfinite(segment_end) || segment_end <= segment_start) continue;

        std::vector<double> span_weights;
        std::vector<double> span_confidence_weights;
        auto &spans = raw_spans[segment];
        spans.reserve(segment_evidence.size());
        span_weights.reserve(segment_evidence.size());
        span_confidence_weights.reserve(segment_evidence.size());
        std::map<int, double> raw_weights;
        double raw_unknown_weight = 0.0;
        for (std::size_t index = 0; index < segment_evidence.size(); ++index) {
            const Evidence &item = segment_evidence[index];
            const double center = (item.window.start + item.window.end) / 2.0;
            const double previous_center = index == 0
                ? segment_start
                : (segment_evidence[index - 1].window.start + segment_evidence[index - 1].window.end) / 2.0;
            const double next_center = index + 1 == segment_evidence.size()
                ? segment_end
                : (segment_evidence[index + 1].window.start + segment_evidence[index + 1].window.end) / 2.0;
            const double left = index == 0
                ? segment_start
                : std::max(segment_start, std::min(segment_end, (previous_center + center) / 2.0));
            const double right = index + 1 == segment_evidence.size()
                ? segment_end
                : std::max(segment_start, std::min(segment_end, (center + next_center) / 2.0));
            if (right <= left) continue;
            const double weight = right - left;
            const int label = item.label >= 0 ? item.label : -1;
            const double confidence = label >= 0 && std::isfinite(item.score)
                ? std::max(0.0, std::min(1.0, item.score))
                : 0.0;
            const Stability stability = cluster_stability(label);
            const int trusted_label = stability == Stability::unknown ? -1 : label;
            ++result.assignments[segment].window_count;
            if (trusted_label >= 0) raw_weights[trusted_label] += weight;
            else raw_unknown_weight += weight;

            if (!spans.empty() && spans.back().raw_cluster == trusted_label && spans.back().stability == stability &&
                std::abs(spans.back().end - left) <= 1e-9) {
                spans.back().end = right;
                spans.back().canonical_key = std::min(spans.back().canonical_key, item.window.key);
                span_weights.back() += weight;
                span_confidence_weights.back() += confidence * weight;
            } else {
                spans.push_back({segment, item.window.key, left, right, trusted_label, trusted_label, confidence, stability});
                span_weights.push_back(weight);
                span_confidence_weights.push_back(confidence * weight);
            }
        }

        for (std::size_t index = 0; index < spans.size(); ++index) {
            if (span_weights[index] > 0.0) {
                spans[index].confidence = span_confidence_weights[index] / span_weights[index];
            }
            if (spans[index].stability == Stability::transient) ++result.metrics.raw_transient_span_count;
        }
        double total_weight = raw_unknown_weight;
        for (const auto &[label, weight] : raw_weights) total_weight += weight;
        double best_weight = -1.0;
        for (const auto &[label, weight] : raw_weights) {
            (void)label;
            best_weight = std::max(best_weight, weight);
        }
        if (total_weight > 0.0 && !raw_weights.empty()) {
            const double raw_purity = best_weight / total_weight;
            const bool raw_mixed = raw_weights.size() > 1 ||
                                   raw_unknown_weight / total_weight >= (1.0 - kMixedSpeakerPurity) ||
                                   raw_purity < kMixedSpeakerPurity;
            if (raw_mixed) ++result.metrics.raw_mixed_segment_count;
        }
    }

    struct SpanReference {
        RawSpan *span = nullptr;
    };
    std::vector<SpanReference> global;
    for (auto &segment_spans : raw_spans) {
        for (auto &span : segment_spans) global.push_back({&span});
    }
    std::sort(global.begin(), global.end(), [](const SpanReference &left_ref, const SpanReference &right_ref) {
        const RawSpan &left = *left_ref.span;
        const RawSpan &right = *right_ref.span;
        if (left.start != right.start) return left.start < right.start;
        if (left.end != right.end) return left.end < right.end;
        if (left.canonical_key != right.canonical_key) return left.canonical_key < right.canonical_key;
        if (left.raw_cluster != right.raw_cluster) return left.raw_cluster < right.raw_cluster;
        return left.segment_index < right.segment_index;
    });

    std::size_t cursor = 0;
    while (cursor < global.size()) {
        RawSpan &first = *global[cursor].span;
        if (first.stability != Stability::transient) {
            ++cursor;
            continue;
        }
        std::size_t island_end = cursor + 1;
        double transient_seconds = first.end - first.start;
        while (island_end < global.size()) {
            const RawSpan &previous = *global[island_end - 1].span;
            const RawSpan &next = *global[island_end].span;
            const double internal_gap = std::max(0.0, next.start - previous.end);
            if (next.stability != Stability::transient || next.raw_cluster != first.raw_cluster ||
                internal_gap > options.bridge_max_gap_seconds) break;
            transient_seconds += next.end - next.start;
            ++island_end;
        }
        const std::size_t island_span_count = island_end - cursor;
        if (transient_seconds < options.micro_noise_max_seconds) {
            for (std::size_t index = cursor; index < island_end; ++index) {
                global[index].span->presentation_cluster = -1;
                global[index].span->confidence = 0.0;
            }
            result.metrics.micro_noise_span_count += island_span_count;
            cursor = island_end;
            continue;
        }

        bool bridged = false;
        if (transient_seconds <= options.transient_bridge_max_seconds && cursor > 0 && island_end < global.size()) {
            const RawSpan &left = *global[cursor - 1].span;
            const RawSpan &right = *global[island_end].span;
            const double left_gap = std::max(0.0, first.start - left.end);
            const double right_gap = std::max(0.0, right.start - global[island_end - 1].span->end);
            bridged = left.stability == Stability::stable && right.stability == Stability::stable &&
                      left.raw_cluster >= 0 && left.raw_cluster == right.raw_cluster &&
                      left_gap <= options.bridge_max_gap_seconds && right_gap <= options.bridge_max_gap_seconds;
            if (bridged) {
                const double context_confidence = (left.confidence + right.confidence) / 2.0;
                for (std::size_t index = cursor; index < island_end; ++index) {
                    global[index].span->presentation_cluster = left.raw_cluster;
                    global[index].span->confidence = context_confidence;
                }
                result.metrics.bridged_transient_span_count += island_span_count;
            }
        }
        if (!bridged) {
            for (std::size_t index = cursor; index < island_end; ++index) {
                global[index].span->presentation_cluster = -1;
                global[index].span->confidence = 0.0;
            }
            result.metrics.suppressed_transient_span_count += island_span_count;
        }
        cursor = island_end;
    }

    for (std::size_t segment = 0; segment < segment_count; ++segment) {
        std::map<int, double> stable_weights;
        double total_weight = 0.0;
        std::vector<double> presentation_weights;
        std::vector<double> presentation_confidence_weights;
        for (const RawSpan &raw : raw_spans[segment]) {
            const double weight = raw.end - raw.start;
            if (weight <= 0.0) continue;
            total_weight += weight;
            if (raw.presentation_cluster >= 0) stable_weights[raw.presentation_cluster] += weight;
            auto &spans = result.assignments[segment].speaker_spans;
            if (!spans.empty() && spans.back().cluster == raw.presentation_cluster &&
                std::abs(spans.back().end - raw.start) <= 1e-9) {
                spans.back().end = raw.end;
                presentation_weights.back() += weight;
                presentation_confidence_weights.back() += raw.confidence * weight;
            } else {
                spans.push_back({raw.start, raw.end, raw.presentation_cluster, raw.confidence});
                presentation_weights.push_back(weight);
                presentation_confidence_weights.push_back(raw.confidence * weight);
            }
        }
        auto &assignment = result.assignments[segment];
        for (std::size_t index = 0; index < assignment.speaker_spans.size(); ++index) {
            if (presentation_weights[index] > 0.0) {
                assignment.speaker_spans[index].confidence =
                    presentation_confidence_weights[index] / presentation_weights[index];
            }
        }
        if (total_weight <= 0.0 || stable_weights.empty()) continue;

        int best_label = -1;
        double best_weight = -1.0;
        for (const auto &[label, weight] : stable_weights) {
            if (weight > best_weight || (weight == best_weight && (best_label < 0 || label < best_label))) {
                best_label = label;
                best_weight = weight;
            }
        }
        assignment.cluster = best_label;
        assignment.speaker_purity = std::max(0.0, std::min(1.0, best_weight / total_weight));
        assignment.mixed_speaker = stable_weights.size() > 1;
        if (assignment.mixed_speaker) ++result.metrics.presentation_mixed_segment_count;
    }
    return result;
}

} // namespace zcode::speaker
