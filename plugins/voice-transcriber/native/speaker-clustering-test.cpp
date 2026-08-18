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
    assert(result.transient_cluster_count >= 1);
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
    assert(result.trusted_speaker_count == 0);
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

void test_two_overlapping_windows_are_not_a_public_speaker() {
    const std::vector<EmbeddingPoint> points{
        {"pair-a", 0, 5.0, 6.5, {1.0f, 0.0f}},
        {"pair-b", 1, 5.75, 7.25, {0.99f, 0.02f}},
    };
    ClusterOptions options;
    options.max_speakers = 64;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.forced_merge_count == 0);
    assert(result.trusted_speaker_count == 0);
    assert(result.clusters.empty() || result.clusters.front().stability == "transient");
}

void test_short_outliers_do_not_become_public_speakers() {
    std::vector<EmbeddingPoint> points{
        point("a-1", 0, {1.0f, 0.0f, 0.0f}),
        point("a-2", 1, {0.99f, 0.02f, 0.0f}),
        point("a-3", 2, {0.98f, 0.03f, 0.0f}),
        point("a-4", 3, {0.97f, 0.04f, 0.0f}),
    };
    points[0].start = 0.0; points[0].end = 1.5;
    points[1].start = 1.5; points[1].end = 3.0;
    points[2].start = 3.0; points[2].end = 4.5;
    points[3].start = 4.5; points[3].end = 6.0;
    for (int index = 0; index < 80; ++index) {
        EmbeddingPoint outlier;
        outlier.key = "out-" + std::to_string(index);
        outlier.source_index = static_cast<std::size_t>(4 + index);
        outlier.start = 20.0 + index * 3.0;
        outlier.end = outlier.start + 0.4;
        outlier.embedding = {0.01f, 1.0f, static_cast<float>(index) * 0.02f};
        points.push_back(std::move(outlier));
    }
    ClusterOptions options;
    options.max_speakers = 8;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.trusted_speaker_count <= 1);
    assert(result.forced_merge_count == 0);
    assert(result.private_candidate_count > result.trusted_speaker_count);
}

void test_speaker_can_reappear_after_a_long_gap() {
    const std::vector<EmbeddingPoint> points{
        {"early-1", 0, 0.0, 1.5, {1.0f, 0.02f, 0.0f}},
        {"early-2", 1, 1.5, 3.0, {0.99f, 0.01f, 0.0f}},
        {"early-3", 2, 3.0, 4.5, {0.98f, 0.03f, 0.0f}},
        {"early-4", 3, 4.5, 6.0, {0.99f, 0.02f, 0.0f}},
        {"other-1", 4, 20.0, 21.5, {0.0f, 1.0f, 0.02f}},
        {"other-2", 5, 21.5, 23.0, {0.02f, 0.99f, 0.0f}},
        {"other-3", 6, 23.0, 24.5, {0.01f, 0.98f, 0.03f}},
        {"other-4", 7, 24.5, 26.0, {0.0f, 0.99f, 0.02f}},
        {"late-1", 8, 2400.0, 2401.5, {0.99f, 0.03f, 0.0f}},
        {"late-2", 9, 2401.5, 2403.0, {1.0f, 0.01f, 0.0f}},
        {"late-3", 10, 2403.0, 2404.5, {0.98f, 0.02f, 0.0f}},
        {"late-4", 11, 2404.5, 2406.0, {0.99f, 0.00f, 0.01f}},
    };
    ClusterOptions options;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(label_for_key(points, result, "early-1") == label_for_key(points, result, "late-1"));
    assert(label_for_key(points, result, "early-1") != label_for_key(points, result, "other-1"));
    assert(result.forced_merge_count == 0);
}

void test_max_speakers_still_does_not_force_merges() {
    std::vector<EmbeddingPoint> points;
    for (int speaker = 0; speaker < 6; ++speaker) {
        for (int sample = 0; sample < 4; ++sample) {
            std::vector<float> embedding(6, 0.01f);
            embedding[speaker] = 1.0f;
            EmbeddingPoint item;
            item.key = "s" + std::to_string(speaker) + "-" + std::to_string(sample);
            item.source_index = points.size();
            item.start = speaker * 20.0 + sample * 1.6;
            item.end = item.start + 1.5;
            item.embedding = embedding;
            points.push_back(std::move(item));
        }
    }
    ClusterOptions options;
    options.max_speakers = 2;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.forced_merge_count == 0);
    assert(result.private_candidate_count >= 6);
    assert(result.trusted_speaker_count <= 2);
    assert(result.speaker_count_exceeded);
}

std::vector<float> speaker_basis(int speaker_id) {
    std::vector<float> values(16, 0.03f);
    values[static_cast<std::size_t>(speaker_id % 16)] += 5.0f;
    values[static_cast<std::size_t>((speaker_id * 3 + 5) % 16)] += 1.4f;
    values[static_cast<std::size_t>((speaker_id * 7 + 11) % 16)] += 0.6f;
    double squared = 0.0;
    for (float value : values) squared += static_cast<double>(value) * value;
    const double norm = std::sqrt(squared);
    for (float &value : values) value = static_cast<float>(value / norm);
    return values;
}

std::vector<float> drifted_basis(const std::vector<float> &base, double time) {
    std::vector<float> values = base;
    for (std::size_t index = 0; index < values.size(); ++index) {
        values[index] = static_cast<float>(values[index] + 0.06 * std::sin((time / 1800.0) + static_cast<double>(index) * 0.35));
    }
    double squared = 0.0;
    for (float value : values) squared += static_cast<double>(value) * value;
    const double norm = std::sqrt(squared);
    for (float &value : values) value = static_cast<float>(value / norm);
    return values;
}

void append_turn(std::vector<EmbeddingPoint> &points, int speaker_id, double start, const std::string &prefix) {
    const auto base = speaker_basis(speaker_id);
    for (int sample = 0; sample < 4; ++sample) {
        EmbeddingPoint item;
        item.key = prefix + "-" + std::to_string(sample);
        item.source_index = points.size();
        item.start = start + sample * 1.6;
        item.end = item.start + 1.5;
        item.embedding = drifted_basis(base, item.start);
        points.push_back(std::move(item));
    }
}

void test_long_meeting_does_not_publish_dozens_of_identities() {
    std::vector<EmbeddingPoint> points;
    for (int cycle = 0; cycle < 4; ++cycle) {
        for (int speaker = 0; speaker < 10; ++speaker) {
            append_turn(points, speaker, cycle * 220.0 + speaker * 20.0, "spk" + std::to_string(speaker) + "-c" + std::to_string(cycle));
        }
    }
    ClusterOptions options;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.forced_merge_count == 0);
    assert(result.trusted_speaker_count >= 8);
    assert(result.trusted_speaker_count <= 14);
    assert(result.private_candidate_count >= result.trusted_speaker_count);
}

void test_similar_speakers_remain_separate() {
    const auto first = speaker_basis(1);
    auto second = speaker_basis(2);
    for (std::size_t index = 0; index < second.size(); ++index) {
        second[index] = static_cast<float>(second[index] + 0.22 * first[index]);
    }
    double squared = 0.0;
    for (float value : second) squared += static_cast<double>(value) * value;
    const double norm = std::sqrt(squared);
    for (float &value : second) value = static_cast<float>(value / norm);
    std::vector<EmbeddingPoint> points;
    for (int sample = 0; sample < 5; ++sample) {
        points.push_back({"a-" + std::to_string(sample), static_cast<std::size_t>(sample), sample * 1.6, sample * 1.6 + 1.5, drifted_basis(first, sample)});
        points.push_back({"b-" + std::to_string(sample), static_cast<std::size_t>(10 + sample), 24.0 + sample * 1.6, 24.0 + sample * 1.6 + 1.5, drifted_basis(second, sample)});
    }
    ClusterOptions options;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    assert(result.trusted_speaker_count == 2);
    assert(label_for_key(points, result, "a-0") == label_for_key(points, result, "a-4"));
    assert(label_for_key(points, result, "b-0") == label_for_key(points, result, "b-4"));
    assert(label_for_key(points, result, "a-0") != label_for_key(points, result, "b-0"));
    assert(result.forced_merge_count == 0);
}

void test_noisy_long_input_stays_sparse_and_does_not_explode() {
    constexpr int count = 4000;
    std::vector<EmbeddingPoint> points;
    points.reserve(count);
    for (int index = 0; index < count; ++index) {
        std::vector<float> embedding(64, 0.0f);
        for (int dimension = 0; dimension < 64; ++dimension) {
            unsigned seed = static_cast<unsigned>(index + 1) * 747796405u ^ static_cast<unsigned>(dimension + 1) * 2891336453u;
            seed ^= seed >> 16;
            seed *= 2246822519u;
            seed ^= seed >> 13;
            seed *= 3266489917u;
            seed ^= seed >> 16;
            embedding[static_cast<std::size_t>(dimension)] = static_cast<float>(static_cast<int>(seed % 2000) - 1000) / 1000.0f;
        }
        EmbeddingPoint item;
        item.key = "noise-" + std::to_string(index);
        item.source_index = static_cast<std::size_t>(index);
        item.start = index * 2.0;
        item.end = item.start + 0.4;
        item.embedding = std::move(embedding);
        points.push_back(std::move(item));
    }
    ClusterOptions options;
    const ClusterResult result = zcode::speaker::cluster_embeddings(points, options);
    const std::size_t bound = static_cast<std::size_t>(count) *
        (std::max(options.consolidate_knn, options.local_neighbor_count) + options.consolidate_max_anchors + 32);
    assert(result.forced_merge_count == 0);
    assert(result.trusted_speaker_count <= 2);
    assert(result.micro_cluster_count >= 3000);
    assert(result.consolidation_candidate_count <= bound);
    assert(result.consolidation_candidate_count < static_cast<std::size_t>(count) * (count - 1) / 4);
}

void test_sparse_anchor_stride_keeps_canonical_speaker_relations() {
    std::vector<EmbeddingPoint> points;
    for (int cycle = 0; cycle < 4; ++cycle) {
        for (int speaker = 0; speaker < 8; ++speaker) {
            append_turn(points, speaker, cycle * 180.0 + speaker * 18.0, "rel" + std::to_string(speaker) + "-c" + std::to_string(cycle));
        }
    }
    ClusterOptions first_options;
    ClusterOptions second_options;
    second_options.local_neighbor_count = 16;
    second_options.consolidate_knn = 8;
    second_options.consolidate_max_anchors = 24;
    const ClusterResult first = zcode::speaker::cluster_embeddings(points, first_options);
    const ClusterResult second = zcode::speaker::cluster_embeddings(points, second_options);
    std::vector<std::string> keys;
    for (int speaker = 0; speaker < 8; ++speaker) {
        for (int cycle = 0; cycle < 4; ++cycle) {
            keys.push_back("rel" + std::to_string(speaker) + "-c" + std::to_string(cycle) + "-0");
        }
    }
    for (std::size_t left = 0; left < keys.size(); ++left) {
        for (std::size_t right = left + 1; right < keys.size(); ++right) {
            const bool first_same = label_for_key(points, first, keys[left]) == label_for_key(points, first, keys[right]);
            const bool second_same = label_for_key(points, second, keys[left]) == label_for_key(points, second, keys[right]);
            assert(first_same == second_same);
        }
    }
    assert(first.forced_merge_count == 0);
    assert(second.forced_merge_count == 0);
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
    test_two_overlapping_windows_are_not_a_public_speaker();
    test_short_outliers_do_not_become_public_speakers();
    test_speaker_can_reappear_after_a_long_gap();
    test_max_speakers_still_does_not_force_merges();
    test_long_meeting_does_not_publish_dozens_of_identities();
    test_similar_speakers_remain_separate();
    test_noisy_long_input_stays_sparse_and_does_not_explode();
    test_sparse_anchor_stride_keeps_canonical_speaker_relations();
    std::cout << "speaker-clustering tests passed\n";
    return 0;
}
