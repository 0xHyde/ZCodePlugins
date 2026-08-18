#include "speaker-clustering.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <set>
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
    std::size_t version = 0;
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

struct ClusterSupport {
    double union_voiced_seconds = 0.0;
    std::size_t independent_evidence = 0;
    double coherence = 0.0;
    std::vector<float> prototype;
};

double clamp_unit(double value) {
    return std::max(-1.0, std::min(1.0, value));
}

double safe_threshold(double value, double fallback) {
    if (!std::isfinite(value)) return fallback;
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

double union_voiced_seconds(const std::vector<std::size_t> &members, const std::vector<EmbeddingPoint> &points) {
    std::vector<std::pair<double, double>> intervals;
    intervals.reserve(members.size());
    for (const std::size_t member : members) {
        if (points[member].end > points[member].start) intervals.emplace_back(points[member].start, points[member].end);
    }
    if (intervals.empty()) return 0.0;
    std::sort(intervals.begin(), intervals.end());
    double total = 0.0;
    double cursor_start = intervals.front().first;
    double cursor_end = intervals.front().second;
    for (std::size_t index = 1; index < intervals.size(); ++index) {
        if (intervals[index].first <= cursor_end) {
            cursor_end = std::max(cursor_end, intervals[index].second);
        } else {
            total += cursor_end - cursor_start;
            cursor_start = intervals[index].first;
            cursor_end = intervals[index].second;
        }
    }
    return total + (cursor_end - cursor_start);
}

std::size_t independent_evidence_count(const std::vector<std::size_t> &members,
                                       const std::vector<EmbeddingPoint> &points,
                                       double minimum_duration) {
    std::vector<std::pair<double, double>> intervals;
    for (const std::size_t member : members) {
        const double duration = points[member].end - points[member].start;
        if (duration >= minimum_duration) intervals.emplace_back(points[member].start, points[member].end);
    }
    std::sort(intervals.begin(), intervals.end());
    std::size_t count = 0;
    double last_end = -std::numeric_limits<double>::infinity();
    for (const auto &interval : intervals) {
        if (interval.first >= last_end - 1e-9) {
            ++count;
            last_end = interval.second;
        }
    }
    return count;
}

std::vector<float> mean_prototype(const std::vector<std::size_t> &members,
                                  const std::vector<std::vector<float>> &normalized_points) {
    if (members.empty()) return {};
    const std::size_t dimensions = normalized_points[members.front()].size();
    if (dimensions == 0) return {};
    std::vector<float> prototype(dimensions, 0.0f);
    std::size_t used = 0;
    for (const std::size_t member : members) {
        if (normalized_points[member].size() != dimensions) continue;
        ++used;
        for (std::size_t dimension = 0; dimension < dimensions; ++dimension) {
            prototype[dimension] += normalized_points[member][dimension];
        }
    }
    return used == 0 ? std::vector<float>{} : normalized(prototype);
}

double percentile(std::vector<double> values, double fraction) {
    if (values.empty()) return kMinimumCosine;
    std::sort(values.begin(), values.end());
    const std::size_t index = static_cast<std::size_t>(std::max<double>(
        0.0, std::min<double>(static_cast<double>(values.size() - 1),
                              std::floor(static_cast<double>(values.size() - 1) * fraction))));
    return values[index];
}

ClusterSupport cluster_support(const std::vector<std::size_t> &members,
                               const std::vector<EmbeddingPoint> &points,
                               const std::vector<std::vector<float>> &normalized_points) {
    ClusterSupport support;
    support.prototype = mean_prototype(members, normalized_points);
    support.union_voiced_seconds = union_voiced_seconds(members, points);
    support.independent_evidence = independent_evidence_count(members, points, 1.0);
    if (support.prototype.empty()) return support;
    double total = 0.0;
    std::size_t count = 0;
    for (const std::size_t member : members) {
        const double score = cosine(normalized_points[member], support.prototype);
        if (score > kMinimumCosine) {
            total += score;
            ++count;
        }
    }
    support.coherence = count == 0 ? 0.0 : total / static_cast<double>(count);
    return support;
}

bool is_trusted(const ClusterSupport &support, const ClusterOptions &options) {
    return support.independent_evidence >= options.min_independent_evidence &&
           support.union_voiced_seconds >= options.min_union_voiced_seconds &&
           support.coherence >= options.min_coherence &&
           (support.union_voiced_seconds >= options.min_trusted_union_seconds ||
            support.independent_evidence >= options.min_independent_evidence + 1);
}

bool is_strong(const ClusterSupport &support, const ClusterOptions &options) {
    return support.independent_evidence >= options.strong_independent_evidence &&
           support.union_voiced_seconds >= options.strong_union_voiced_seconds &&
           support.coherence >= options.min_coherence;
}

std::vector<WorkingCluster> time_local_micro_clusters(const std::vector<std::size_t> &valid_indices,
                                                      const std::vector<EmbeddingPoint> &points,
                                                      const std::vector<std::vector<float>> &normalized_points,
                                                      const ClusterOptions &options) {
    const std::size_t count = valid_indices.size();
    std::vector<std::size_t> parent(count);
    std::vector<std::size_t> rank(count, 0);
    std::iota(parent.begin(), parent.end(), 0);
    const auto find = [&parent](std::size_t index) {
        while (parent[index] != index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    };
    const auto unite = [&](std::size_t left, std::size_t right) {
        std::size_t a = find(left);
        std::size_t b = find(right);
        if (a == b) return;
        if (rank[a] < rank[b]) parent[a] = b;
        else if (rank[a] > rank[b]) parent[b] = a;
        else {
            parent[b] = a;
            ++rank[a];
        }
    };

    std::vector<std::size_t> order(count);
    std::iota(order.begin(), order.end(), 0);
    std::sort(order.begin(), order.end(), [&](std::size_t left, std::size_t right) {
        const EmbeddingPoint &left_point = points[valid_indices[left]];
        const EmbeddingPoint &right_point = points[valid_indices[right]];
        if (left_point.start != right_point.start) return left_point.start < right_point.start;
        const std::string left_key = point_key(left_point, valid_indices[left]);
        const std::string right_key = point_key(right_point, valid_indices[right]);
        if (left_key != right_key) return left_key < right_key;
        return left < right;
    });

    const std::size_t locality = std::max<std::size_t>(4, options.local_neighbor_count);
    for (std::size_t position = 0; position < order.size(); ++position) {
        const std::size_t current = order[position];
        const EmbeddingPoint &current_point = points[valid_indices[current]];
        for (std::size_t lookback = 1; lookback <= locality && position >= lookback; ++lookback) {
            const std::size_t previous = order[position - lookback];
            const EmbeddingPoint &previous_point = points[valid_indices[previous]];
            if (current_point.start - previous_point.end > options.local_time_window_seconds) break;
            if (cosine(normalized_points[valid_indices[current]],
                       normalized_points[valid_indices[previous]]) >= options.micro_threshold) {
                unite(current, previous);
            }
        }
    }

    std::map<std::size_t, WorkingCluster> grouped;
    for (std::size_t index = 0; index < count; ++index) {
        WorkingCluster &cluster = grouped[find(index)];
        cluster.members.push_back(valid_indices[index]);
    }
    std::vector<WorkingCluster> clusters;
    clusters.reserve(grouped.size());
    for (auto &[root, cluster] : grouped) {
        (void)root;
        std::string canonical = point_key(points[cluster.members.front()], cluster.members.front());
        for (const std::size_t member : cluster.members) {
            canonical = std::min(canonical, point_key(points[member], member));
        }
        cluster.canonical_key = canonical;
        clusters.push_back(std::move(cluster));
    }
    std::sort(clusters.begin(), clusters.end(), [](const WorkingCluster &left, const WorkingCluster &right) {
        return left.canonical_key < right.canonical_key;
    });
    return clusters;
}

double cluster_start(const WorkingCluster &cluster, const std::vector<EmbeddingPoint> &points) {
    double start = std::numeric_limits<double>::infinity();
    for (const std::size_t member : cluster.members) start = std::min(start, points[member].start);
    return start;
}

std::vector<std::size_t> sample_members(const std::vector<std::size_t> &members,
                                        const std::vector<EmbeddingPoint> &points,
                                        std::size_t limit) {
    if (members.size() <= limit) return members;
    std::vector<std::size_t> ordered = members;
    std::sort(ordered.begin(), ordered.end(), [&points](std::size_t left, std::size_t right) {
        const std::string left_key = point_key(points[left], left);
        const std::string right_key = point_key(points[right], right);
        if (left_key != right_key) return left_key < right_key;
        return left < right;
    });
    std::vector<std::size_t> sampled;
    sampled.reserve(limit);
    const double stride = static_cast<double>(ordered.size()) / static_cast<double>(limit);
    for (std::size_t index = 0; index < limit; ++index) {
        const std::size_t pick = static_cast<std::size_t>(std::floor(index * stride));
        sampled.push_back(ordered[std::min(pick, ordered.size() - 1)]);
    }
    return sampled;
}

float lookup_score(const std::vector<std::map<std::size_t, float>> &scores, std::size_t left, std::size_t right) {
    if (left == right) return 1.0f;
    if (right < left) std::swap(left, right);
    const auto found = scores[left].find(right);
    return found == scores[left].end() ? -1.0f : found->second;
}

void store_score(std::vector<std::map<std::size_t, float>> &scores,
                 std::vector<std::set<std::size_t>> &neighbors,
                 std::size_t left,
                 std::size_t right,
                 float score) {
    if (left == right) return;
    if (right < left) std::swap(left, right);
    scores[left][right] = score;
    neighbors[left].insert(right);
    neighbors[right].insert(left);
}

bool can_merge(std::size_t left_id,
               std::size_t right_id,
               float score,
               const std::vector<WorkingCluster> &clusters,
               const std::vector<std::map<std::size_t, float>> &scores,
               const std::vector<std::set<std::size_t>> &neighbors,
               const std::vector<EmbeddingPoint> &points,
               const std::vector<std::vector<float>> &normalized_points,
               const ClusterOptions &options) {
    const WorkingCluster &left = clusters[left_id];
    const WorkingCluster &right = clusters[right_id];
    const std::size_t sample_limit = std::max<std::size_t>(4, options.merge_sample_size);
    const std::vector<std::size_t> left_sample = sample_members(left.members, points, sample_limit);
    const std::vector<std::size_t> right_sample = sample_members(right.members, points, sample_limit);
    std::vector<std::size_t> sampled = left_sample;
    sampled.insert(sampled.end(), right_sample.begin(), right_sample.end());
    const std::vector<float> prototype = mean_prototype(sampled, normalized_points);
    std::vector<double> internal;
    internal.reserve(sampled.size());
    for (const std::size_t member : sampled) internal.push_back(cosine(normalized_points[member], prototype));
    if (percentile(internal, options.consolidate_percentile) < options.consolidate_floor) return false;

    std::vector<double> cross;
    cross.reserve(left_sample.size() * right_sample.size());
    for (const std::size_t left_member : left_sample) {
        for (const std::size_t right_member : right_sample) {
            cross.push_back(cosine(normalized_points[left_member], normalized_points[right_member]));
        }
    }
    if (!cross.empty() && percentile(cross, options.consolidate_percentile) < options.consolidate_floor) return false;

    double competing = kMinimumCosine;
    std::set<std::size_t> related = neighbors[left_id];
    related.insert(neighbors[right_id].begin(), neighbors[right_id].end());
    for (const std::size_t other : related) {
        if (other == left_id || other == right_id || !clusters[other].active) continue;
        competing = std::max(competing, static_cast<double>(lookup_score(scores, left_id, other)));
        competing = std::max(competing, static_cast<double>(lookup_score(scores, right_id, other)));
    }
    if (score < options.established_merge_threshold && competing > kMinimumCosine &&
        static_cast<double>(score) - competing < options.consolidate_margin) {
        return false;
    }

    const ClusterSupport left_support = cluster_support(left.members, points, normalized_points);
    const ClusterSupport right_support = cluster_support(right.members, points, normalized_points);
    const bool either_established =
        (left_support.independent_evidence >= 2 && left_support.union_voiced_seconds >= 2.0) ||
        (right_support.independent_evidence >= 2 && right_support.union_voiced_seconds >= 2.0);
    if (either_established && score < options.established_merge_threshold) return false;
    return true;
}

struct Consolidation {
    std::vector<WorkingCluster> clusters;
    std::size_t candidate_count = 0;
};

Consolidation consolidate_clusters(std::vector<WorkingCluster> micro_clusters,
                                   const std::vector<EmbeddingPoint> &points,
                                   const std::vector<std::vector<float>> &normalized_points,
                                   const ClusterOptions &options) {
    Consolidation result;
    if (micro_clusters.size() <= 1) {
        result.clusters = std::move(micro_clusters);
        return result;
    }
    const std::size_t count = micro_clusters.size();
    std::vector<std::vector<float>> prototypes(count);
    for (std::size_t index = 0; index < count; ++index) {
        prototypes[index] = cluster_support(micro_clusters[index].members, points, normalized_points).prototype;
    }

    std::vector<std::size_t> time_order(count);
    std::iota(time_order.begin(), time_order.end(), 0);
    std::sort(time_order.begin(), time_order.end(), [&](std::size_t left, std::size_t right) {
        const double left_start = cluster_start(micro_clusters[left], points);
        const double right_start = cluster_start(micro_clusters[right], points);
        if (left_start != right_start) return left_start < right_start;
        if (micro_clusters[left].canonical_key != micro_clusters[right].canonical_key) {
            return micro_clusters[left].canonical_key < micro_clusters[right].canonical_key;
        }
        return left < right;
    });

    std::set<std::size_t> anchors;
    const std::size_t max_anchors = std::max<std::size_t>(8, options.consolidate_max_anchors);
    const std::size_t stride = std::max<std::size_t>(1, (count + max_anchors - 1) / max_anchors);
    for (std::size_t position = 0; position < time_order.size(); position += stride) {
        anchors.insert(time_order[position]);
    }
    std::vector<std::size_t> by_size(count);
    std::iota(by_size.begin(), by_size.end(), 0);
    std::sort(by_size.begin(), by_size.end(), [&](std::size_t left, std::size_t right) {
        if (micro_clusters[left].members.size() != micro_clusters[right].members.size()) {
            return micro_clusters[left].members.size() > micro_clusters[right].members.size();
        }
        if (micro_clusters[left].canonical_key != micro_clusters[right].canonical_key) {
            return micro_clusters[left].canonical_key < micro_clusters[right].canonical_key;
        }
        return left < right;
    });
    const std::size_t largest = std::min<std::size_t>(32, count);
    for (std::size_t index = 0; index < largest; ++index) anchors.insert(by_size[index]);

    const std::size_t local_k = std::max<std::size_t>(4, options.consolidate_knn);
    const std::size_t local_window = std::max(local_k, options.local_neighbor_count);
    std::vector<std::map<std::size_t, float>> scores(count);
    std::vector<std::set<std::size_t>> neighbors(count);
    std::set<std::pair<std::size_t, std::size_t>> seen;

    const auto consider = [&](std::size_t left, std::size_t right) {
        if (left == right) return;
        if (right < left) std::swap(left, right);
        if (!seen.insert({left, right}).second) return;
        const float score = static_cast<float>(cosine(prototypes[left], prototypes[right]));
        if (score >= options.consolidate_threshold) store_score(scores, neighbors, left, right, score);
    };

    for (std::size_t position = 0; position < time_order.size(); ++position) {
        const std::size_t current = time_order[position];
        const std::size_t begin = position > local_window ? position - local_window : 0;
        for (std::size_t lookback = begin; lookback < position; ++lookback) consider(current, time_order[lookback]);
        for (const std::size_t anchor : anchors) consider(current, anchor);
    }

    std::priority_queue<PairCandidate, std::vector<PairCandidate>, PairWorseFirst> queue;
    for (std::size_t left = 0; left < count; ++left) {
        for (const auto &[right, score] : scores[left]) {
            if (score >= options.consolidate_threshold) {
                queue.push({score, left, right, micro_clusters[left].version, micro_clusters[right].version});
            }
        }
    }
    for (const auto &row : scores) result.candidate_count += row.size();

    while (!queue.empty()) {
        const PairCandidate candidate = queue.top();
        queue.pop();
        if (candidate.left >= count || candidate.right >= count) continue;
        if (!micro_clusters[candidate.left].active || !micro_clusters[candidate.right].active ||
            micro_clusters[candidate.left].version != candidate.left_version ||
            micro_clusters[candidate.right].version != candidate.right_version ||
            candidate.score < options.consolidate_threshold) {
            continue;
        }
        if (!can_merge(candidate.left, candidate.right, candidate.score, micro_clusters, scores, neighbors,
                       points, normalized_points, options)) {
            continue;
        }
        const std::size_t keep = std::min(candidate.left, candidate.right);
        const std::size_t drop = std::max(candidate.left, candidate.right);
        const double keep_size = static_cast<double>(micro_clusters[keep].members.size());
        const double drop_size = static_cast<double>(micro_clusters[drop].members.size());
        const double merged_size = keep_size + drop_size;
        micro_clusters[keep].members.insert(micro_clusters[keep].members.end(),
                                            micro_clusters[drop].members.begin(), micro_clusters[drop].members.end());
        micro_clusters[keep].canonical_key = std::min(micro_clusters[keep].canonical_key, micro_clusters[drop].canonical_key);
        micro_clusters[drop].active = false;
        ++micro_clusters[keep].version;
        ++micro_clusters[drop].version;

        std::set<std::size_t> related = neighbors[keep];
        related.insert(neighbors[drop].begin(), neighbors[drop].end());
        neighbors[keep].erase(drop);
        neighbors[drop].clear();
        scores[keep].erase(drop);
        for (const std::size_t other : related) {
            if (other == keep || other == drop || !micro_clusters[other].active) continue;
            const float left_score = lookup_score(scores, keep, other);
            const float right_score = lookup_score(scores, drop, other);
            if (left_score < 0.0f && right_score < 0.0f) {
                neighbors[keep].erase(other);
                neighbors[other].erase(keep);
                continue;
            }
            const float merged = left_score < 0.0f
                ? right_score
                : right_score < 0.0f
                    ? left_score
                    : static_cast<float>((keep_size * left_score + drop_size * right_score) / merged_size);
            store_score(scores, neighbors, keep, other, merged);
            neighbors[other].erase(drop);
            if (merged >= options.consolidate_threshold) {
                queue.push({merged, keep, other, micro_clusters[keep].version, micro_clusters[other].version});
            }
        }
    }

    for (auto &cluster : micro_clusters) {
        if (cluster.active) result.clusters.push_back(std::move(cluster));
    }
    return result;
}

} // namespace

ClusterResult cluster_embeddings(const std::vector<EmbeddingPoint> &points,
                                 const ClusterOptions &requested_options) {
    ClusterOptions options = requested_options;
    options.cluster_threshold = safe_threshold(options.cluster_threshold, 0.45);
    options.micro_threshold = safe_threshold(options.micro_threshold, 0.72);
    options.consolidate_threshold = safe_threshold(options.consolidate_threshold, 0.38);
    options.established_merge_threshold = safe_threshold(options.established_merge_threshold, 0.58);
    options.min_cluster_size = std::max<std::size_t>(1, options.min_cluster_size);
    options.min_speakers = std::max<std::size_t>(1, options.min_speakers);
    options.max_speakers = std::max(options.min_speakers, options.max_speakers);
    options.consolidate_knn = std::max<std::size_t>(4, options.consolidate_knn);
    options.consolidate_max_anchors = std::max<std::size_t>(8, options.consolidate_max_anchors);
    options.merge_sample_size = std::max<std::size_t>(4, options.merge_sample_size);
    // Older callers only expose cluster_threshold.  A raised value still
    // blocks low-confidence merges without becoming a forced-merge cap.
    if (options.cluster_threshold > options.established_merge_threshold) {
        options.established_merge_threshold = options.cluster_threshold;
    }
    if (options.cluster_threshold > options.micro_threshold) {
        options.micro_threshold = options.cluster_threshold;
    }

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

    std::vector<WorkingCluster> micro_clusters =
        time_local_micro_clusters(valid_indices, points, normalized_points, options);
    result.micro_cluster_count = micro_clusters.size();
    Consolidation consolidated = consolidate_clusters(
        std::move(micro_clusters), points, normalized_points, options);
    result.consolidation_candidate_count = consolidated.candidate_count;
    std::vector<WorkingCluster> clusters = std::move(consolidated.clusters);

    std::sort(clusters.begin(), clusters.end(), [](const WorkingCluster &left, const WorkingCluster &right) {
        if (left.canonical_key != right.canonical_key) return left.canonical_key < right.canonical_key;
        return left.members.front() < right.members.front();
    });

    struct PreparedCluster {
        WorkingCluster cluster;
        ClusterSupport support;
        bool trusted = false;
        bool strong = false;
        bool publication_capped = false;
    };
    std::vector<PreparedCluster> prepared;
    prepared.reserve(clusters.size());
    for (auto &cluster : clusters) {
        ClusterSupport support = cluster_support(cluster.members, points, normalized_points);
        const bool trusted = is_trusted(support, options) && cluster.members.size() >= options.min_cluster_size;
        prepared.push_back({std::move(cluster), std::move(support), trusted, false, false});
        prepared.back().strong = prepared.back().trusted && is_strong(prepared.back().support, options);
    }

    std::vector<std::size_t> trusted_indexes;
    for (std::size_t index = 0; index < prepared.size(); ++index) {
        if (prepared[index].trusted) trusted_indexes.push_back(index);
    }
    if (trusted_indexes.size() > options.max_speakers) {
        std::sort(trusted_indexes.begin(), trusted_indexes.end(), [&prepared](std::size_t left, std::size_t right) {
            if (prepared[left].support.union_voiced_seconds != prepared[right].support.union_voiced_seconds) {
                return prepared[left].support.union_voiced_seconds > prepared[right].support.union_voiced_seconds;
            }
            if (prepared[left].support.independent_evidence != prepared[right].support.independent_evidence) {
                return prepared[left].support.independent_evidence > prepared[right].support.independent_evidence;
            }
            return prepared[left].cluster.canonical_key < prepared[right].cluster.canonical_key;
        });
        for (std::size_t index = options.max_speakers; index < trusted_indexes.size(); ++index) {
            prepared[trusted_indexes[index]].trusted = false;
            prepared[trusted_indexes[index]].strong = false;
            prepared[trusted_indexes[index]].publication_capped = true;
        }
        result.speaker_count_exceeded = true;
    }

    result.post_threshold_cluster_count = prepared.size();
    result.private_candidate_count = prepared.size();
    result.speaker_count_exceeded = result.speaker_count_exceeded || prepared.size() > options.max_speakers;
    result.forced_merge_count = 0;

    int next_id = 0;
    for (auto &item : prepared) {
        const std::string stability = item.trusted ? "stable" : "transient";
        if (!item.trusted) ++result.transient_cluster_count;
        else ++result.trusted_speaker_count;
        result.clusters.push_back({
            next_id,
            item.cluster.members.size(),
            item.cluster.canonical_key,
            item.support.prototype,
            stability,
            item.support.union_voiced_seconds,
            item.support.independent_evidence,
            item.support.coherence,
            item.trusted,
            item.strong,
        });
        for (const std::size_t member : item.cluster.members) {
            result.labels[member] = next_id;
            result.scores[member] = cosine(normalized_points[member], item.support.prototype);
        }
        ++next_id;
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
    if (!std::isfinite(options.short_isolation_seconds) || options.short_isolation_seconds < 0.0) {
        options.short_isolation_seconds = 1.0;
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

    for (std::size_t index = 0; index < global.size(); ++index) {
        RawSpan &span = *global[index].span;
        const double duration = span.end - span.start;
        if (span.stability != Stability::transient || span.presentation_cluster >= 0 ||
            duration >= options.short_isolation_seconds) continue;
        const RawSpan *left = index > 0 ? global[index - 1].span : nullptr;
        const RawSpan *right = index + 1 < global.size() ? global[index + 1].span : nullptr;
        const bool left_ok = left && left->stability == Stability::stable && left->presentation_cluster >= 0 &&
                             std::max(0.0, span.start - left->end) <= options.bridge_max_gap_seconds;
        const bool right_ok = right && right->stability == Stability::stable && right->presentation_cluster >= 0 &&
                              std::max(0.0, right->start - span.end) <= options.bridge_max_gap_seconds;
        if (left_ok && right_ok && left->presentation_cluster != right->presentation_cluster) continue;
        const RawSpan *inherit = left_ok ? left : right_ok ? right : nullptr;
        if (!inherit) continue;
        span.presentation_cluster = inherit->presentation_cluster;
        span.confidence = inherit->confidence;
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

QualitySummary evaluate_speaker_quality(const ClusterResult &clustering,
                                        const TimelineResult &timeline,
                                        const ClusterOptions &options) {
    QualitySummary quality;
    double voiced = 0.0;
    double trusted = 0.0;
    double unknown = 0.0;
    std::size_t scored_segments = 0;
    std::size_t mixed_segments = 0;
    for (const auto &assignment : timeline.assignments) {
        bool has_span = false;
        for (const auto &span : assignment.speaker_spans) {
            const double duration = std::max(0.0, span.end - span.start);
            if (duration <= 0.0) continue;
            has_span = true;
            voiced += duration;
            if (span.cluster >= 0) trusted += duration;
            else unknown += duration;
        }
        if (has_span) ++scored_segments;
        if (assignment.mixed_speaker) ++mixed_segments;
    }
    quality.trusted_coverage = voiced > 0.0 ? trusted / voiced : 0.0;
    quality.unknown_ratio = voiced > 0.0 ? unknown / voiced : 0.0;
    quality.mixed_ratio = scored_segments > 0 ? static_cast<double>(mixed_segments) / static_cast<double>(scored_segments) : 0.0;
    quality.trusted_speaker_count = clustering.trusted_speaker_count;

    if (clustering.trusted_speaker_count == 0 && clustering.private_candidate_count > 0) {
        quality.reason_codes.emplace_back("no_trusted_speakers");
    }
    if (quality.trusted_coverage < 0.20 && clustering.private_candidate_count > 0) {
        quality.reason_codes.emplace_back("low_trusted_coverage");
    }
    if (quality.unknown_ratio > 0.55) quality.reason_codes.emplace_back("high_unknown_ratio");
    if (quality.mixed_ratio > 0.40) quality.reason_codes.emplace_back("high_mixed_ratio");
    if (clustering.speaker_count_exceeded) quality.reason_codes.emplace_back("speaker_count_exceeded");
    if (clustering.private_candidate_count > std::max<std::size_t>(24, clustering.trusted_speaker_count * 4) &&
        clustering.trusted_speaker_count > 0) {
        quality.reason_codes.emplace_back("excessive_private_candidates");
    }

    quality.state = "reliable";
    const bool no_trusted = std::find(quality.reason_codes.begin(), quality.reason_codes.end(), "no_trusted_speakers") != quality.reason_codes.end();
    if (no_trusted || (quality.trusted_coverage < 0.20 && clustering.trusted_speaker_count == 0)) {
        quality.state = "unusable";
    } else if (quality.trusted_coverage < 0.55 || quality.unknown_ratio > 0.35 ||
               std::find(quality.reason_codes.begin(), quality.reason_codes.end(), "excessive_private_candidates") != quality.reason_codes.end()) {
        quality.state = "degraded";
    }
    (void)options;
    return quality;
}

} // namespace zcode::speaker
