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
constexpr double kSmallClusterAttachSlack = 0.10;
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
    if (!std::isfinite(value)) return 0.35;
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
                    double threshold,
                    bool force) {
    if (left == right || !clusters[left].active || !clusters[right].active) return;
    if (right < left) std::swap(left, right);
    const float score = average_similarities[left * point_count + right];
    if (!force && score < threshold) return;
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
                           point_count, options.cluster_threshold, false);
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
                               point_count, options.cluster_threshold, false);
            }
        }
    }

    // max_speakers is a hard cap.  This second queue is created only if
    // threshold-based clustering really left too many clusters, so ordinary
    // meeting recordings do not pay for a large all-pairs heap twice.
    if (active_count(clusters) > options.max_speakers) {
        std::priority_queue<PairCandidate, std::vector<PairCandidate>, PairWorseFirst> forced_queue;
        for (std::size_t left = 0; left < point_count; ++left) {
            if (!clusters[left].active) continue;
            for (std::size_t right = left + 1; right < point_count; ++right) {
                if (clusters[right].active) {
                    push_candidate(forced_queue, left, right, clusters, versions, average_similarities,
                                   point_count, options.cluster_threshold, true);
                }
            }
        }
        while (active_count(clusters) > options.max_speakers && !forced_queue.empty()) {
            const PairCandidate candidate = forced_queue.top();
            forced_queue.pop();
            if (!valid_pair(candidate, clusters, versions)) continue;
            merge_clusters(candidate.left, candidate.right, clusters, versions, average_similarities, point_count);
            const std::size_t merged = std::min(candidate.left, candidate.right);
            for (std::size_t other = 0; other < clusters.size(); ++other) {
                if (other != merged && clusters[other].active) {
                    push_candidate(forced_queue, merged, other, clusters, versions, average_similarities,
                                   point_count, options.cluster_threshold, true);
                }
            }
        }
    }

    // Small clusters are treated conservatively.  Attach one only when it is
    // close to a stable cluster; otherwise leave its points as unknown/noise
    // rather than polluting a known speaker prototype.
    bool changed = true;
    while (changed) {
        changed = false;
        std::size_t smallest = point_count;
        for (std::size_t index = 0; index < clusters.size(); ++index) {
            if (!clusters[index].active || clusters[index].members.size() >= options.min_cluster_size) continue;
            if (smallest == point_count || clusters[index].members.size() < clusters[smallest].members.size() ||
                (clusters[index].members.size() == clusters[smallest].members.size() &&
                 clusters[index].canonical_key < clusters[smallest].canonical_key)) {
                smallest = index;
            }
        }
        if (smallest == point_count) break;

        std::size_t best_target = point_count;
        float best_score = -1.0f;
        for (std::size_t target = 0; target < clusters.size(); ++target) {
            if (target == smallest || !clusters[target].active ||
                clusters[target].members.size() < options.min_cluster_size) continue;
            const float score = average_similarities[smallest * point_count + target];
            if (score > best_score || (score == best_score && target < best_target)) {
                best_score = score;
                best_target = target;
            }
        }
        if (best_target != point_count && best_score >= options.cluster_threshold - kSmallClusterAttachSlack) {
            merge_clusters(smallest, best_target, clusters, versions, average_similarities, point_count);
            changed = true;
        } else {
            // No safe target.  Mark this cluster as noise by deactivating it;
            // its member labels remain -1 and cannot influence a prototype.
            clusters[smallest].active = false;
            ++versions[smallest];
            changed = true;
        }
    }

    // If the whole input is shorter than minClusterSize, retaining the
    // canonical largest cluster keeps short recordings useful.  Other tiny
    // clusters stay noise.  This is the only exception to the noise rule.
    if (active_count(clusters) == 0) {
        std::size_t largest = 0;
        for (std::size_t index = 1; index < clusters.size(); ++index) {
            if (clusters[index].members.size() > clusters[largest].members.size() ||
                (clusters[index].members.size() == clusters[largest].members.size() &&
                 clusters[index].canonical_key < clusters[largest].canonical_key)) {
                largest = index;
            }
        }
        clusters[largest].active = true;
    }

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
        result.clusters.push_back({static_cast<int>(output_id), cluster.members.size(), cluster.canonical_key, prototype});
        for (const std::size_t member : cluster.members) {
            result.labels[member] = static_cast<int>(output_id);
            result.scores[member] = cosine(normalized_points[member], prototype);
        }
    }

    return result;
}

std::vector<SegmentAssignment> map_windows_to_segments(const std::vector<TimelineWindow> &windows,
                                                       const std::vector<int> &window_labels,
                                                       std::size_t segment_count) {
    struct Vote {
        std::map<int, double> weights;
        double unknown_weight = 0.0;
        std::size_t count = 0;
    };
    std::vector<Vote> votes(segment_count);
    for (std::size_t index = 0; index < windows.size() && index < window_labels.size(); ++index) {
        const TimelineWindow &window = windows[index];
        if (window.segment_index >= segment_count || window.end <= window.start) continue;
        const double overlap = window.end - window.start;
        Vote &vote = votes[window.segment_index];
        ++vote.count;
        const int label = window_labels[index];
        if (label >= 0) vote.weights[label] += overlap;
        else vote.unknown_weight += overlap;
    }

    std::vector<SegmentAssignment> result(segment_count);
    for (std::size_t segment = 0; segment < segment_count; ++segment) {
        const Vote &vote = votes[segment];
        result[segment].window_count = vote.count;
        double total_weight = vote.unknown_weight;
        for (const auto &[label, weight] : vote.weights) total_weight += weight;
        if (total_weight <= 0.0 || vote.weights.empty()) continue;

        int best_label = -1;
        double best_weight = -1.0;
        for (const auto &[label, weight] : vote.weights) {
            if (weight > best_weight || (weight == best_weight && label < best_label)) {
                best_label = label;
                best_weight = weight;
            }
        }
        result[segment].cluster = best_label;
        result[segment].speaker_purity = std::max(0.0, std::min(1.0, best_weight / total_weight));
        result[segment].mixed_speaker = vote.weights.size() > 1 ||
                                        vote.unknown_weight / total_weight >= (1.0 - kMixedSpeakerPurity) ||
                                        result[segment].speaker_purity < kMixedSpeakerPurity;
    }
    return result;
}

} // namespace zcode::speaker
