#include "speaker-clustering.hpp"

#include <algorithm>
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
using zcode::speaker::TimelineResult;
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

ClusterResult timeline_clusters(std::vector<int> labels,
                                std::vector<std::string> stabilities,
                                std::vector<double> scores = {}) {
    ClusterResult result;
    result.labels = std::move(labels);
    result.scores = std::move(scores);
    for (std::size_t index = 0; index < stabilities.size(); ++index) {
        result.clusters.push_back({static_cast<int>(index), 2, "cluster-" + std::to_string(index), {}, stabilities[index]});
    }
    return result;
}

TimelineResult assign(const std::vector<TimelineWindow> &windows,
                      std::vector<int> labels,
                      std::vector<std::string> stabilities,
                      std::size_t segment_count,
                      std::vector<double> scores = {}) {
    return zcode::speaker::assign_speaker_timeline(
        windows, timeline_clusters(std::move(labels), std::move(stabilities), std::move(scores)), segment_count);
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

void test_small_outlier_remains_transient_without_polluting_stable_clusters() {
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
    assert(result.clusters.size() == 3);
    assert(label_for_key(points, result, "outlier") >= 0);
    const auto transient = std::find_if(result.clusters.begin(), result.clusters.end(), [](const auto &cluster) {
        return cluster.canonical_key == "outlier";
    });
    assert(transient != result.clusters.end());
    assert(transient->stability == "transient");
}

void test_mixed_segment_mapping_reports_purity() {
    const std::vector<TimelineWindow> windows{
        {0, "seg-a:w0", 0.0, 1.5},
        {0, "seg-a:w1", 1.5, 3.0},
        {1, "seg-b:w0", 3.0, 4.5},
    };
    const auto timeline = assign(windows, {0, 1, 1}, {"stable", "stable"}, 2);
    const auto &mapped = timeline.assignments;
    assert(mapped.size() == 2);
    assert(mapped[0].cluster == 0);
    assert(mapped[0].mixed_speaker);
    assert(std::abs(mapped[0].speaker_purity - 0.5) < 1e-9);
    assert(mapped[0].window_count == 2);
    assert(mapped[1].cluster == 1);
    assert(!mapped[1].mixed_speaker);
}

void test_max_speakers_is_warning_only() {
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
    assert(result.clusters.size() == 3);
    assert(result.post_threshold_cluster_count == 3);
    assert(result.speaker_count_exceeded);
    assert(result.forced_merge_count == 0);
    assert(result.labels[0] != result.labels[1]);
    assert(result.labels[1] != result.labels[2]);
    assert(result.labels[0] != result.labels[2]);
}

void test_singleton_is_not_absorbed_by_threshold_slack() {
    const std::vector<EmbeddingPoint> points{
        point("a-1", 0, {1.0f, 0.0f}),
        point("a-2", 1, {0.99f, 0.03f}),
        point("b-1", 2, {0.0f, 1.0f}),
        point("b-2", 3, {0.03f, 0.99f}),
        point("short-interruption", 4, {0.85f, 0.5267827f}),
    };
    ClusterOptions options;
    options.cluster_threshold = 0.90;
    options.min_cluster_size = 2;
    options.max_speakers = 64;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.clusters.size() == 3);
    assert(result.transient_cluster_count == 1);
    assert(label_for_key(points, result, "short-interruption") >= 0);
    assert(label_for_key(points, result, "short-interruption") != label_for_key(points, result, "a-1"));
    const auto transient = std::find_if(result.clusters.begin(), result.clusters.end(), [](const auto &cluster) {
        return cluster.canonical_key == "short-interruption";
    });
    assert(transient != result.clusters.end());
    assert(transient->stability == "transient");
}

void test_invalid_embedding_is_noise() {
    const std::vector<EmbeddingPoint> points{
        point("a-1", 0, {1.0f, 0.0f}),
        point("a-2", 1, {0.99f, 0.03f}),
        point("invalid", 2, {}),
    };
    ClusterOptions options;
    options.cluster_threshold = 0.90;
    options.min_cluster_size = 2;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.labels[2] == -1);
    assert(result.noise_window_count == 1);
    assert(result.transient_cluster_count == 0);
}

void test_timeline_mapping_uses_center_boundaries_and_unknown_spans() {
    const std::vector<TimelineWindow> windows{
        {0, "seg-a:w2", 12.5, 13.5, 10.0, 14.0},
        {0, "seg-a:w0", 10.0, 11.0, 10.0, 14.0},
        {0, "seg-a:w3", 13.5, 14.0, 10.0, 14.0},
        {0, "seg-a:w1", 11.0, 12.5, 10.0, 14.0},
    };
    const auto timeline = assign(
        windows, {1, 0, -1, 0}, {"stable", "stable"}, 1, {0.84, 0.91, 0.0, 0.89});
    const auto &mapped = timeline.assignments;
    assert(mapped.size() == 1);
    assert(mapped[0].cluster == 0);
    assert(mapped[0].mixed_speaker);
    assert(mapped[0].speaker_spans.size() == 3);
    assert(mapped[0].speaker_spans[0].cluster == 0);
    assert(std::abs(mapped[0].speaker_spans[0].start - 10.0) < 1e-9);
    assert(std::abs(mapped[0].speaker_spans[0].end - 12.375) < 1e-9);
    assert(std::abs(mapped[0].speaker_spans[0].confidence - (2.13625 / 2.375)) < 1e-9);
    assert(mapped[0].speaker_spans[1].cluster == 1);
    assert(std::abs(mapped[0].speaker_spans[1].start - 12.375) < 1e-9);
    assert(std::abs(mapped[0].speaker_spans[1].end - 13.375) < 1e-9);
    assert(mapped[0].speaker_spans[2].cluster == -1);
    assert(std::abs(mapped[0].speaker_spans[2].start - 13.375) < 1e-9);
    assert(std::abs(mapped[0].speaker_spans[2].end - 14.0) < 1e-9);
}

void test_pure_timeline_mapping_remains_compatible() {
    const std::vector<TimelineWindow> windows{
        {0, "seg-pure:w0", 5.0, 6.0, 4.0, 8.0},
    };
    const auto timeline = assign(windows, {1}, {"stable", "stable"}, 1, {0.93});
    const auto &mapped = timeline.assignments;
    assert(mapped[0].cluster == 1);
    assert(!mapped[0].mixed_speaker);
    assert(mapped[0].speaker_spans.size() == 1);
    assert(mapped[0].speaker_spans[0].cluster == 1);
    assert(std::abs(mapped[0].speaker_spans[0].start - 4.0) < 1e-9);
    assert(std::abs(mapped[0].speaker_spans[0].end - 8.0) < 1e-9);
}

void test_same_segment_transient_island_bridges_equal_stable_speaker() {
    const std::vector<TimelineWindow> windows{
        {0, "seg:w0", 0.0, 0.5, 0.0, 3.0},
        {0, "seg:w1", 1.25, 1.75, 0.0, 3.0},
        {0, "seg:w2", 2.5, 3.0, 0.0, 3.0},
    };
    const auto timeline = assign(windows, {0, 1, 0}, {"stable", "transient"}, 1);
    const auto &segment = timeline.assignments[0];
    assert(segment.cluster == 0);
    assert(!segment.mixed_speaker);
    assert(segment.speaker_spans.size() == 1);
    assert(segment.speaker_spans[0].cluster == 0);
    assert(timeline.metrics.raw_transient_span_count == 1);
    assert(timeline.metrics.bridged_transient_span_count == 1);
    assert(timeline.metrics.raw_mixed_segment_count == 1);
    assert(timeline.metrics.presentation_mixed_segment_count == 0);
}

void test_cross_segment_transient_island_bridges_equal_stable_speaker() {
    const std::vector<TimelineWindow> windows{
        {0, "a:w0", 0.0, 1.0, 0.0, 1.0},
        {1, "t:w0", 1.2, 2.2, 1.2, 2.2},
        {2, "a2:w0", 2.4, 3.4, 2.4, 3.4},
    };
    const auto timeline = assign(windows, {0, 1, 0}, {"stable", "transient"}, 3);
    for (const auto &segment : timeline.assignments) {
        assert(segment.cluster == 0);
        assert(!segment.mixed_speaker);
        assert(segment.speaker_spans.size() == 1);
        assert(segment.speaker_spans[0].cluster == 0);
    }
    assert(timeline.metrics.bridged_transient_span_count == 1);
}

void test_micro_transient_is_noise_not_speaker() {
    const std::vector<TimelineWindow> windows{{0, "micro:w0", 5.0, 5.26, 5.0, 5.26}};
    const auto timeline = assign(windows, {0}, {"transient"}, 1);
    const auto &segment = timeline.assignments[0];
    assert(segment.cluster == -1);
    assert(!segment.mixed_speaker);
    assert(segment.speaker_spans.size() == 1);
    assert(segment.speaker_spans[0].cluster == -1);
    assert(timeline.metrics.micro_noise_span_count == 1);
    assert(timeline.metrics.suppressed_transient_span_count == 0);
}

void test_stable_island_is_never_bridged() {
    const std::vector<TimelineWindow> windows{
        {0, "seg:w0", 0.0, 0.5, 0.0, 3.0},
        {0, "seg:w1", 1.25, 1.75, 0.0, 3.0},
        {0, "seg:w2", 2.5, 3.0, 0.0, 3.0},
    };
    const auto timeline = assign(windows, {0, 1, 0}, {"stable", "stable"}, 1);
    assert(timeline.assignments[0].mixed_speaker);
    assert(timeline.assignments[0].speaker_spans.size() == 3);
    assert(timeline.metrics.bridged_transient_span_count == 0);
}

void test_transient_between_different_stable_speakers_remains_mixed() {
    const std::vector<TimelineWindow> windows{
        {0, "seg:w0", 0.0, 0.5, 0.0, 3.0},
        {0, "seg:w1", 1.25, 1.75, 0.0, 3.0},
        {0, "seg:w2", 2.5, 3.0, 0.0, 3.0},
    };
    const auto timeline = assign(windows, {0, 2, 1}, {"stable", "stable", "transient"}, 1);
    const auto &segment = timeline.assignments[0];
    assert(segment.mixed_speaker);
    assert(segment.speaker_spans.size() == 3);
    assert(segment.speaker_spans[1].cluster == -1);
    assert(timeline.metrics.suppressed_transient_span_count == 1);
}

void test_three_stable_speakers_plus_transient_keeps_three_trusted_speakers() {
    const std::vector<TimelineWindow> windows{
        {0, "seg:w0", 0.0, 0.5, 0.0, 4.0},
        {0, "seg:w1", 1.0, 1.5, 0.0, 4.0},
        {0, "seg:w2", 2.0, 2.5, 0.0, 4.0},
        {0, "seg:w3", 3.5, 4.0, 0.0, 4.0},
    };
    const auto timeline = assign(windows, {0, 1, 3, 2}, {"stable", "stable", "stable", "transient"}, 1);
    const auto &segment = timeline.assignments[0];
    assert(segment.mixed_speaker);
    std::vector<int> trusted;
    for (const auto &span : segment.speaker_spans) {
        if (span.cluster >= 0 && std::find(trusted.begin(), trusted.end(), span.cluster) == trusted.end()) {
            trusted.push_back(span.cluster);
        }
    }
    assert(trusted.size() == 3);
    assert(timeline.metrics.raw_transient_span_count == 1);
    assert(timeline.metrics.suppressed_transient_span_count == 1);
}

void test_transient_only_without_context_is_unknown() {
    const std::vector<TimelineWindow> windows{{0, "transient:w0", 0.0, 1.0, 0.0, 1.0}};
    const auto timeline = assign(windows, {0}, {"transient"}, 1);
    assert(timeline.assignments[0].cluster == -1);
    assert(!timeline.assignments[0].mixed_speaker);
    assert(timeline.assignments[0].speaker_spans[0].cluster == -1);
    assert(timeline.metrics.suppressed_transient_span_count == 1);
}

void test_invalid_embedding_unknown_is_not_bridged() {
    const std::vector<TimelineWindow> windows{
        {0, "seg:w0", 0.0, 0.5, 0.0, 3.0},
        {0, "seg:w1", 1.25, 1.75, 0.0, 3.0},
        {0, "seg:w2", 2.5, 3.0, 0.0, 3.0},
    };
    const auto timeline = assign(windows, {0, -1, 0}, {"stable"}, 1);
    const auto &spans = timeline.assignments[0].speaker_spans;
    assert(spans.size() == 3);
    assert(spans[0].cluster == 0);
    assert(spans[1].cluster == -1);
    assert(spans[2].cluster == 0);
    assert(timeline.metrics.bridged_transient_span_count == 0);
}

void test_timeline_assignment_is_invariant_to_input_order() {
    const std::vector<TimelineWindow> ordered{
        {0, "a:w0", 0.0, 1.0, 0.0, 1.0},
        {1, "t:w0", 1.2, 2.2, 1.2, 2.2},
        {2, "a2:w0", 2.4, 3.4, 2.4, 3.4},
    };
    const std::vector<TimelineWindow> shuffled{
        {0, "a2:w0", 2.4, 3.4, 2.4, 3.4},
        {1, "a:w0", 0.0, 1.0, 0.0, 1.0},
        {2, "t:w0", 1.2, 2.2, 1.2, 2.2},
    };
    const auto first = assign(ordered, {0, 1, 0}, {"stable", "transient"}, 3);
    const auto second = assign(shuffled, {0, 0, 1}, {"stable", "transient"}, 3);
    const auto assignment_at = [](const TimelineResult &timeline, double start) -> const zcode::speaker::SegmentAssignment & {
        const auto found = std::find_if(timeline.assignments.begin(), timeline.assignments.end(), [start](const auto &assignment) {
            return !assignment.speaker_spans.empty() && std::abs(assignment.speaker_spans.front().start - start) < 1e-9;
        });
        assert(found != timeline.assignments.end());
        return *found;
    };
    for (const double start : {0.0, 1.2, 2.4}) {
        const auto &left = assignment_at(first, start);
        const auto &right = assignment_at(second, start);
        assert(left.cluster == right.cluster);
        assert(left.mixed_speaker == right.mixed_speaker);
        assert(left.speaker_spans.size() == right.speaker_spans.size());
    }
    assert(first.metrics.bridged_transient_span_count == second.metrics.bridged_transient_span_count);
}

} // namespace

int main() {
    test_two_clusters();
    test_input_order_does_not_change_clusters();
    test_small_outlier_remains_transient_without_polluting_stable_clusters();
    test_mixed_segment_mapping_reports_purity();
    test_max_speakers_is_warning_only();
    test_singleton_is_not_absorbed_by_threshold_slack();
    test_invalid_embedding_is_noise();
    test_timeline_mapping_uses_center_boundaries_and_unknown_spans();
    test_pure_timeline_mapping_remains_compatible();
    test_same_segment_transient_island_bridges_equal_stable_speaker();
    test_cross_segment_transient_island_bridges_equal_stable_speaker();
    test_micro_transient_is_noise_not_speaker();
    test_stable_island_is_never_bridged();
    test_transient_between_different_stable_speakers_remains_mixed();
    test_three_stable_speakers_plus_transient_keeps_three_trusted_speakers();
    test_transient_only_without_context_is_unknown();
    test_invalid_embedding_unknown_is_not_bridged();
    test_timeline_assignment_is_invariant_to_input_order();
    std::cout << "speaker-clustering tests passed\n";
    return 0;
}
