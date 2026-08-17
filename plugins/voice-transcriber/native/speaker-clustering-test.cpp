#include "speaker-clustering.hpp"

#include <cassert>
#include <cmath>
#include <cstddef>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

namespace {

using zcode::speaker::ClusterOptions;
using zcode::speaker::ClusterResult;
using zcode::speaker::EmbeddingPoint;
using zcode::speaker::TimelineWindow;

EmbeddingPoint point(const std::string &key, std::size_t index, std::vector<float> embedding) {
    return EmbeddingPoint{key, index, static_cast<double>(index), static_cast<double>(index + 1), std::move(embedding)};
}

int label_for_key(const std::vector<EmbeddingPoint> &points, const ClusterResult &result, const std::string &key) {
    for (std::size_t index = 0; index < points.size(); ++index) {
        if (points[index].key == key) return result.labels[index];
    }
    return -2;
}

void test_two_clusters() {
    const std::vector<EmbeddingPoint> points{
        point("a-1", 0, {1.0f, 0.02f, 0.0f}),
        point("b-1", 1, {0.0f, 1.0f, 0.02f}),
        point("a-2", 2, {1.0f, -0.01f, 0.0f}),
        point("b-2", 3, {0.01f, 1.0f, 0.0f}),
    };
    ClusterOptions options;
    options.min_cluster_size = 1;
    options.max_speakers = 4;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.clusters.size() == 2);
    assert(label_for_key(points, result, "a-1") == label_for_key(points, result, "a-2"));
    assert(label_for_key(points, result, "b-1") == label_for_key(points, result, "b-2"));
    assert(label_for_key(points, result, "a-1") != label_for_key(points, result, "b-1"));
}

void test_input_order_does_not_change_clusters() {
    const std::vector<EmbeddingPoint> ordered{
        point("a-1", 0, {1.0f, 0.0f}),
        point("a-2", 1, {0.98f, 0.04f}),
        point("b-1", 2, {0.0f, 1.0f}),
        point("b-2", 3, {0.03f, 0.99f}),
    };
    const std::vector<EmbeddingPoint> shuffled{
        ordered[3], ordered[0], ordered[2], ordered[1],
    };
    ClusterOptions options;
    options.cluster_threshold = 0.80;
    options.min_cluster_size = 1;
    options.max_speakers = 4;
    const ClusterResult first = zcode::speaker::cluster_embeddings(ordered, options);
    const ClusterResult second = zcode::speaker::cluster_embeddings(shuffled, options);
    for (const auto &item : ordered) {
        assert(label_for_key(ordered, first, item.key) == label_for_key(shuffled, second, item.key));
    }
}

void test_small_outlier_is_not_allowed_to_pollute_a_cluster() {
    const std::vector<EmbeddingPoint> points{
        point("a-1", 0, {1.0f, 0.0f}),
        point("a-2", 1, {0.99f, 0.03f}),
        point("b-1", 2, {0.0f, 1.0f}),
        point("b-2", 3, {0.03f, 0.99f}),
        point("outlier", 4, {0.70f, 0.70f}),
    };
    ClusterOptions options;
    options.cluster_threshold = 0.90;
    options.min_cluster_size = 2;
    options.max_speakers = 5;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.clusters.size() == 2);
    assert(label_for_key(points, result, "outlier") == -1);
}

void test_mixed_segment_mapping_reports_purity() {
    const std::vector<TimelineWindow> windows{
        {0, "seg-a:w0", 0.0, 1.5},
        {0, "seg-a:w1", 1.5, 3.0},
        {1, "seg-b:w0", 3.0, 4.5},
    };
    const std::vector<int> labels{0, 1, 1};
    const auto mapped = zcode::speaker::map_windows_to_segments(windows, labels, 2);
    assert(mapped.size() == 2);
    assert(mapped[0].cluster == 0);
    assert(mapped[0].mixed_speaker);
    assert(std::abs(mapped[0].speaker_purity - 0.5) < 1e-9);
    assert(mapped[0].window_count == 2);
    assert(mapped[1].cluster == 1);
    assert(!mapped[1].mixed_speaker);
}

void test_max_speaker_cap_is_deterministic() {
    const std::vector<EmbeddingPoint> points{
        point("a", 0, {1.0f, 0.0f, 0.0f}),
        point("b", 1, {0.0f, 1.0f, 0.0f}),
        point("c", 2, {0.0f, 0.0f, 1.0f}),
    };
    ClusterOptions options;
    options.cluster_threshold = 0.99;
    options.min_cluster_size = 1;
    options.max_speakers = 2;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.clusters.size() == 2);
    assert(result.labels[0] == 0);
}

} // namespace

int main() {
    test_two_clusters();
    test_input_order_does_not_change_clusters();
    test_small_outlier_is_not_allowed_to_pollute_a_cluster();
    test_mixed_segment_mapping_reports_purity();
    test_max_speaker_cap_is_deterministic();
    std::cout << "speaker-clustering tests passed\n";
    return 0;
}
