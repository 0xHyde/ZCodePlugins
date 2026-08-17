// Native CAM++ JSONL adapter.
//
// The feature extractor and ONNX wrapper are provided by the Apache-2.0
// licensed 3D-Speaker runtime at build time.  Keeping this process separate
// from the MCP sidecar lets one analysis batch reuse the loaded model while the
// sidecar stays small and releases the process when that stage finishes.

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

#include <nlohmann/json.hpp>
#include <onnxruntime_cxx_api.h>

#include "feature/feature_common.h"
#include "feature/feature_fbank.h"
#include "speaker-clustering.hpp"
#include "utils/wav_reader.h"

#if defined(_WIN32)
#include <process.h>
static int process_id() { return _getpid(); }
#else
#include <unistd.h>
static int process_id() { return getpid(); }
#endif

using json = nlohmann::json;

namespace {

std::filesystem::path path_from_utf8(const std::string &value) {
    const auto *begin = reinterpret_cast<const char8_t *>(value.data());
    return std::filesystem::path(std::u8string(begin, begin + value.size()));
}

std::string path_as_utf8(const std::filesystem::path &value) {
    const auto encoded = value.u8string();
    return std::string(reinterpret_cast<const char *>(encoded.data()), encoded.size());
}

void remove_utf8_file(const std::string &value) {
    std::error_code error;
    std::filesystem::remove(path_from_utf8(value), error);
}

struct Segment {
    std::string id;
    double start = 0.0;
    double end = 0.0;
    std::size_t input_index = 0;
};

struct WavInfo {
    std::streamoff data_offset = 0;
    uint32_t data_bytes = 0;
    uint16_t channels = 0;
    uint32_t sample_rate = 0;
    uint16_t bits_per_sample = 0;
};

class Silence {
public:
    Silence() : old_out_(std::cout.rdbuf(sink_.rdbuf())), old_err_(std::cerr.rdbuf(sink_.rdbuf())) {}
    ~Silence() {
        std::cout.rdbuf(old_out_);
        std::cerr.rdbuf(old_err_);
    }

private:
    std::ostringstream sink_;
    std::streambuf *old_out_;
    std::streambuf *old_err_;
};

std::string string_value(const json &object, const char *key, const std::string &fallback = {}) {
    if (!object.is_object() || !object.contains(key) || object[key].is_null()) return fallback;
    return object[key].is_string() ? object[key].get<std::string>() : fallback;
}

double number_value(const json &object, const char *key, double fallback) {
    if (!object.is_object() || !object.contains(key) || !object[key].is_number()) return fallback;
    return object[key].get<double>();
}

uint16_t read_le16(const char *bytes) {
    return static_cast<uint16_t>(static_cast<unsigned char>(bytes[0])) |
           static_cast<uint16_t>(static_cast<unsigned char>(bytes[1]) << 8);
}

uint32_t read_le32(const char *bytes) {
    return static_cast<uint32_t>(static_cast<unsigned char>(bytes[0])) |
           (static_cast<uint32_t>(static_cast<unsigned char>(bytes[1])) << 8) |
           (static_cast<uint32_t>(static_cast<unsigned char>(bytes[2])) << 16) |
           (static_cast<uint32_t>(static_cast<unsigned char>(bytes[3])) << 24);
}

WavInfo read_wav_info(const std::string &path) {
    std::ifstream file(path_from_utf8(path), std::ios::binary);
    if (!file) throw std::runtime_error("cannot open WAV file");
    char header[12]{};
    file.read(header, sizeof(header));
    if (file.gcount() != sizeof(header) || std::string(header, 4) != "RIFF" || std::string(header + 8, 4) != "WAVE") {
        throw std::runtime_error("invalid WAV header");
    }
    WavInfo info;
    bool has_fmt = false;
    bool has_data = false;
    while (file) {
        char chunk_header[8]{};
        file.read(chunk_header, sizeof(chunk_header));
        if (file.gcount() != sizeof(chunk_header)) break;
        const std::string chunk(chunk_header, 4);
        const uint32_t size = read_le32(chunk_header + 4);
        const std::streamoff chunk_data = file.tellg();
        if (chunk == "fmt ") {
            if (size < 16) throw std::runtime_error("invalid WAV fmt chunk");
            std::vector<char> fmt(size);
            file.read(fmt.data(), size);
            if (file.gcount() != static_cast<std::streamsize>(size)) throw std::runtime_error("truncated WAV fmt chunk");
            if (read_le16(fmt.data()) != 1) throw std::runtime_error("CAM++ requires PCM WAV");
            info.channels = read_le16(fmt.data() + 2);
            info.sample_rate = read_le32(fmt.data() + 4);
            info.bits_per_sample = read_le16(fmt.data() + 14);
            has_fmt = true;
        } else if (chunk == "data") {
            info.data_offset = chunk_data;
            info.data_bytes = size;
            file.seekg(size, std::ios::cur);
            has_data = true;
        } else {
            file.seekg(size, std::ios::cur);
        }
        if (size % 2) file.seekg(1, std::ios::cur);
    }
    if (!has_fmt || !has_data || info.channels != 1 || info.sample_rate != 16000 || info.bits_per_sample != 16) {
        throw std::runtime_error("CAM++ requires a 16kHz mono 16-bit WAV");
    }
    return info;
}

class WavAudioSource {
public:
    WavAudioSource(const std::string &path, const WavInfo &info)
        : info_(info), file_(path_from_utf8(path), std::ios::binary) {
        if (!file_) throw std::runtime_error("cannot open WAV audio source");
    }

    std::size_t sample_count() const { return info_.data_bytes / sizeof(int16_t); }

    std::vector<float> read_range(std::size_t begin, std::size_t end) {
        if (end <= begin) return {};
        begin = std::min(begin, sample_count());
        end = std::min(end, sample_count());
        if (end <= begin) return {};
        file_.clear();
        file_.seekg(info_.data_offset + static_cast<std::streamoff>(begin * sizeof(int16_t)));
        if (!file_) throw std::runtime_error("cannot seek WAV audio source");
        std::vector<int16_t> samples(end - begin);
        file_.read(reinterpret_cast<char *>(samples.data()), static_cast<std::streamsize>(samples.size() * sizeof(int16_t)));
        if (file_.gcount() != static_cast<std::streamsize>(samples.size() * sizeof(int16_t))) {
            throw std::runtime_error("truncated WAV data");
        }
        std::vector<float> audio(samples.size());
        for (std::size_t index = 0; index < samples.size(); ++index) {
            audio[index] = static_cast<float>(samples[index]) / 32767.0f;
        }
        return audio;
    }

private:
    WavInfo info_;
    std::ifstream file_;
};

std::vector<Segment> parse_segments(const json &params, double duration) {
    std::vector<Segment> result;
    if (!params.contains("segments") || !params["segments"].is_array()) return result;
    std::size_t index = 0;
    for (const auto &item : params["segments"]) {
        Segment segment;
        segment.input_index = static_cast<std::size_t>(index);
        segment.id = string_value(item, "id", "seg_" + std::to_string(index + 1));
        segment.start = std::max(0.0, number_value(item, "start", 0.0));
        segment.end = number_value(item, "end", duration);
        if (segment.end <= segment.start) segment.end = duration;
        segment.end = std::min(duration, segment.end);
        if (segment.end > segment.start) result.push_back(segment);
        ++index;
    }
    return result;
}

std::atomic<std::uint64_t> temporary_scope_counter{0};

class TemporaryWavDirectory {
public:
    TemporaryWavDirectory() {
        const auto timestamp = std::chrono::steady_clock::now().time_since_epoch().count();
        const auto sequence = temporary_scope_counter.fetch_add(1, std::memory_order_relaxed);
        const std::filesystem::path root = std::filesystem::temp_directory_path();
        for (std::size_t attempt = 0; attempt < 32; ++attempt) {
            directory_ = root / ("zcode-campp-" + std::to_string(process_id()) + "-" +
                                std::to_string(timestamp) + "-" + std::to_string(sequence) + "-" +
                                std::to_string(attempt));
            std::error_code error;
            if (std::filesystem::create_directory(directory_, error) && !error) return;
        }
        throw std::runtime_error("cannot create unique CAM++ temporary directory");
    }

    ~TemporaryWavDirectory() {
        std::error_code error;
        std::filesystem::remove_all(directory_, error);
    }

    std::string path_for(std::size_t index) const {
        return path_as_utf8(directory_ / ("window-" + std::to_string(index) + ".wav"));
    }

private:
    std::filesystem::path directory_;
};

void write_le16(std::ofstream &file, uint16_t value) {
    char bytes[2] = {static_cast<char>(value & 0xff), static_cast<char>((value >> 8) & 0xff)};
    file.write(bytes, sizeof(bytes));
}

void write_le32(std::ofstream &file, uint32_t value) {
    char bytes[4] = {
        static_cast<char>(value & 0xff),
        static_cast<char>((value >> 8) & 0xff),
        static_cast<char>((value >> 16) & 0xff),
        static_cast<char>((value >> 24) & 0xff),
    };
    file.write(bytes, sizeof(bytes));
}

void write_segment_wav(const std::string &path, const std::vector<float> &audio, uint32_t sample_rate,
                       size_t begin, size_t end) {
    if (end <= begin) throw std::runtime_error("empty audio segment");
    std::ofstream file(path_from_utf8(path), std::ios::binary);
    if (!file) throw std::runtime_error("cannot create temporary segment wav");
    const uint32_t data_size = static_cast<uint32_t>((end - begin) * sizeof(int16_t));
    file.write("RIFF", 4);
    write_le32(file, 36 + data_size);
    file.write("WAVE", 4);
    file.write("fmt ", 4);
    write_le32(file, 16);
    write_le16(file, 1);
    write_le16(file, 1);
    write_le32(file, sample_rate);
    write_le32(file, sample_rate * sizeof(int16_t));
    write_le16(file, sizeof(int16_t));
    write_le16(file, 16);
    file.write("data", 4);
    write_le32(file, data_size);
    for (size_t i = begin; i < end; ++i) {
        const float clipped = std::max(-1.0f, std::min(1.0f, audio[i]));
        const auto sample = static_cast<int16_t>(std::lrint(clipped * 32767.0f));
        write_le16(file, static_cast<uint16_t>(sample));
    }
}

std::vector<float> normalize(std::vector<float> vector) {
    double sum = 0.0;
    for (const float value : vector) sum += static_cast<double>(value) * value;
    const double norm = std::sqrt(sum);
    if (!std::isfinite(norm) || norm == 0.0) return {};
    for (float &value : vector) value = static_cast<float>(value / norm);
    return vector;
}

struct EmbeddingRun {
    std::vector<std::vector<float>> embeddings;
    std::size_t batch_count = 0;
};

class NativeOnnxModel {
public:
    NativeOnnxModel(const std::string &model_path, std::size_t threads)
        : env_(ORT_LOGGING_LEVEL_WARNING, "zcode-campp"), session_options_() {
        session_options_.SetIntraOpNumThreads(static_cast<int>(std::max<std::size_t>(1, threads)));
        session_options_.SetInterOpNumThreads(1);
        session_options_.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
#if defined(_WIN32)
        // ONNX Runtime's Windows C++ API exposes the model-path overload as
        // wchar_t*. Convert the UTF-8 path received from JSON without losing
        // non-ASCII user/model directory names.
        const auto native_model_path = std::filesystem::u8path(model_path).wstring();
        session_ = std::make_unique<Ort::Session>(env_, native_model_path.c_str(), session_options_);
#else
        session_ = std::make_unique<Ort::Session>(env_, model_path.c_str(), session_options_);
#endif
        Ort::AllocatorWithDefaultOptions allocator;
        char *input_name = session_->GetInputName(0, allocator);
        char *output_name = session_->GetOutputName(0, allocator);
        input_name_ = input_name;
        output_name_ = output_name;
        allocator.Free(input_name);
        allocator.Free(output_name);
    }

    EmbeddingRun run_batches(const std::vector<speakerlab::Feature> &features, std::size_t batch_size) {
        EmbeddingRun result;
        result.embeddings.resize(features.size());
        if (features.empty()) return result;
        batch_size = std::max<std::size_t>(1, batch_size);
        const size_t dimensions = 80;
        std::vector<std::size_t> order;
        order.reserve(features.size());
        for (std::size_t index = 0; index < features.size(); ++index) {
            if (!features[index].empty()) order.push_back(index);
        }
        std::sort(order.begin(), order.end(), [&features](std::size_t left, std::size_t right) {
            if (features[left].size() != features[right].size()) return features[left].size() < features[right].size();
            return left < right;
        });
        if (order.empty()) return result;

        for (std::size_t batch_begin = 0; batch_begin < order.size(); batch_begin += batch_size) {
            const std::size_t batch_end = std::min(order.size(), batch_begin + batch_size);
            std::size_t max_frames = 0;
            for (std::size_t position = batch_begin; position < batch_end; ++position) {
                max_frames = std::max(max_frames, features[order[position]].size());
            }
            std::vector<float> values;
            values.reserve((batch_end - batch_begin) * max_frames * dimensions);
            for (std::size_t position = batch_begin; position < batch_end; ++position) {
                const auto &feature = features[order[position]];
                const auto &fallback = feature.back();
                for (std::size_t frame = 0; frame < max_frames; ++frame) {
                    const auto &source = frame < feature.size() ? feature[frame] : fallback;
                    const std::size_t copied = std::min(dimensions, source.size());
                    values.insert(values.end(), source.begin(), source.begin() + static_cast<std::ptrdiff_t>(copied));
                    values.insert(values.end(), dimensions - copied, 0.0f);
                }
            }

            const std::array<int64_t, 3> shape{
                static_cast<int64_t>(batch_end - batch_begin), static_cast<int64_t>(max_frames), static_cast<int64_t>(dimensions),
            };
            Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
            Ort::Value input = Ort::Value::CreateTensor<float>(memory_info, values.data(), values.size(), shape.data(), shape.size());
            const char *input_names[] = {input_name_.c_str()};
            const char *output_names[] = {output_name_.c_str()};
            auto outputs = session_->Run(Ort::RunOptions{nullptr}, input_names, &input, 1, output_names, 1);
            if (outputs.empty() || !outputs.front().IsTensor()) throw std::runtime_error("CAM++ returned no tensor output");
            const auto info = outputs.front().GetTensorTypeAndShapeInfo();
            const size_t count = info.GetElementCount();
            const size_t actual_batch_size = batch_end - batch_begin;
            if (count == 0 || count % actual_batch_size != 0) throw std::runtime_error("CAM++ returned an invalid embedding shape");
            const float *data = outputs.front().GetTensorData<float>();
            const size_t embedding_dimensions = count / actual_batch_size;
            for (std::size_t batch = 0; batch < actual_batch_size; ++batch) {
                const std::size_t original_index = order[batch_begin + batch];
                result.embeddings[original_index] = std::vector<float>(
                    data + batch * embedding_dimensions, data + (batch + 1) * embedding_dimensions);
            }
            ++result.batch_count;
        }
        return result;
    }

private:
    Ort::Env env_;
    Ort::SessionOptions session_options_;
    std::unique_ptr<Ort::Session> session_;
    std::string input_name_;
    std::string output_name_;
};

class CamppEngine {
public:
    EmbeddingRun embeddings(const std::string &audio_path, const WavInfo &wav_info,
                            const std::vector<Segment> &segments, const std::string &model_path,
                            bool allow_context, std::size_t batch_size, std::size_t threads) {
        load_model(model_path, threads);
        const double duration = static_cast<double>(wav_info.data_bytes / sizeof(int16_t)) / wav_info.sample_rate;
        WavAudioSource audio_source(audio_path, wav_info);
        TemporaryWavDirectory temporary_directory;
        std::vector<speakerlab::Feature> features;
        features.reserve(segments.size());
        for (std::size_t index = 0; index < segments.size(); ++index) {
            const auto &segment = segments[index];
            const double start = std::max(0.0, std::min(segment.start, duration));
            const double end = std::max(start, std::min(segment.end, duration));
            // Legacy embed_segments keeps the small context window.  Diarize
            // passes false so a speaker-analysis window can never cross the
            // caller's speech region boundary.
            const double context_start = allow_context ? std::max(0.0, start - 0.20) : start;
            const double context_end = allow_context ? std::min(duration, end + 0.20) : end;
            const std::size_t begin = static_cast<std::size_t>(std::floor(context_start * wav_info.sample_rate));
            const std::size_t finish = std::min(audio_source.sample_count(), static_cast<std::size_t>(std::ceil(context_end * wav_info.sample_rate)));
            if (finish <= begin || finish - begin < wav_info.sample_rate * 0.25) {
                features.emplace_back();
                continue;
            }

            const std::string segment_path = temporary_directory.path_for(index);
            const auto audio = audio_source.read_range(begin, finish);
            write_segment_wav(segment_path, audio, wav_info.sample_rate, 0, audio.size());
            try {
                Silence silence;
                speakerlab::WavReader segment_wav(segment_path);
                speakerlab::Feature feature = fbank_->compute_feature(segment_wav);
                speakerlab::subtract_feature_mean(feature);
                features.push_back(std::move(feature));
            } catch (...) {
                remove_utf8_file(segment_path);
                throw;
            }
            remove_utf8_file(segment_path);
        }

        EmbeddingRun result;
        {
            Silence silence;
            result = model_->run_batches(features, batch_size);
        }
        for (std::size_t index = 0; index < result.embeddings.size(); ++index) {
            if (index >= features.size() || features[index].empty()) result.embeddings[index].clear();
            else result.embeddings[index] = normalize(std::move(result.embeddings[index]));
        }
        return result;
    }

private:
    void load_model(const std::string &model_path, std::size_t threads) {
        if (model_path.empty()) throw std::runtime_error("CAM++ model path is empty");
        threads = std::max<std::size_t>(1, threads);
        if (model_ && model_path_ == model_path && threads_ == threads) return;
        Silence silence;
        speakerlab::FbankOptions options;
        options.frame_opts.sample_freq = 16000;
        options.frame_opts.frame_shift_ms = 10.0;
        options.frame_opts.frame_length_ms = 25.0;
        options.frame_opts.dither = 0.0;
        options.mel_opts.num_bins = 80;
        fbank_ = std::make_unique<speakerlab::FbankComputer>(options);
        model_ = std::make_unique<NativeOnnxModel>(model_path, threads);
        model_path_ = model_path;
        threads_ = threads;
    }

    std::string model_path_;
    std::size_t threads_ = 0;
    std::unique_ptr<speakerlab::FbankComputer> fbank_;
    std::unique_ptr<NativeOnnxModel> model_;
};

double real_option(const json &params, const char *key, const char *environment_key, double fallback) {
    if (params.contains(key) && params[key].is_number()) return params[key].get<double>();
    const char *environment_value = std::getenv(environment_key);
    if (environment_value && *environment_value) return std::atof(environment_value);
    return fallback;
}

std::size_t size_option(const json &params, const char *key, const char *environment_key, std::size_t fallback,
                        std::size_t maximum = 4096) {
    const double value = real_option(params, key, environment_key, static_cast<double>(fallback));
    if (!std::isfinite(value) || value < 1.0) return fallback;
    return std::min(maximum, static_cast<std::size_t>(value));
}

zcode::speaker::ClusterOptions cluster_options(const json &params) {
    zcode::speaker::ClusterOptions options;
    options.cluster_threshold = real_option(params, "clusterThreshold", "ZCODE_CAMPP_CLUSTER_THRESHOLD", 0.35);
    options.min_cluster_size = size_option(params, "minClusterSize", "ZCODE_CAMPP_MIN_CLUSTER_SIZE", 2);
    options.min_speakers = size_option(params, "minSpeakers", "ZCODE_CAMPP_MIN_SPEAKERS", 1);
    options.max_speakers = size_option(params, "maxSpeakers", "ZCODE_CAMPP_MAX_SPEAKERS", 15);
    return options;
}

std::vector<Segment> make_diarization_windows(const std::vector<Segment> &segments,
                                               std::vector<zcode::speaker::TimelineWindow> &timeline) {
    constexpr double window_duration = 1.5;
    constexpr double window_shift = 0.75;
    constexpr double minimum_duration = 0.25;
    constexpr double epsilon = 1e-7;
    std::vector<Segment> windows;
    for (const auto &segment : segments) {
        const double duration = segment.end - segment.start;
        if (duration < minimum_duration) continue;

        std::vector<double> starts;
        if (duration <= window_duration) {
            starts.push_back(0.0);
        } else {
            for (double offset = 0.0; offset + window_duration <= duration + epsilon; offset += window_shift) {
                starts.push_back(offset);
            }
            const double tail = duration - window_duration;
            if (starts.empty() || std::abs(starts.back() - tail) > epsilon) starts.push_back(tail);
        }
        std::sort(starts.begin(), starts.end());
        starts.erase(std::unique(starts.begin(), starts.end(), [epsilon](double left, double right) {
                          return std::abs(left - right) <= epsilon;
                      }), starts.end());

        for (std::size_t window_index = 0; window_index < starts.size(); ++window_index) {
            const double start = segment.start + starts[window_index];
            const double end = std::min(segment.end, start + window_duration);
            if (end - start < minimum_duration) continue;
            // Segment IDs are the stable identity across the JSONL seam. Do
            // not include the caller's array position: reordering otherwise
            // identical input segments must not change cluster IDs.
            const std::string key = segment.id + ":w" + std::to_string(window_index);
            windows.push_back({key, start, end, segment.input_index});
            timeline.push_back({segment.input_index, key, start, end});
        }
    }
    return windows;
}

json embedding_entries(const std::vector<std::pair<std::string, std::vector<float>>> &entries) {
    json result = json::array();
    for (const auto &[id, vector] : entries) result.push_back({{"segmentId", id}, {"embedding", vector}});
    return result;
}

json handle(const json &request, CamppEngine &engine) {
    const json params = request.value("params", json::object());
    const std::string audio_path = string_value(params, "audioPath");
    const std::string model_path = string_value(params, "model");
    if (audio_path.empty()) throw std::runtime_error("audioPath is required");

    const WavInfo wav_info = read_wav_info(audio_path);
    const double duration = static_cast<double>(wav_info.data_bytes / sizeof(int16_t)) / wav_info.sample_rate;
    auto segments = parse_segments(params, duration);
    const std::string method = string_value(request, "method");
    const std::size_t batch_size = size_option(params, "batchSize", "ZCODE_CAMPP_BATCH_SIZE", 64);
    const std::size_t threads = size_option(params, "threads", "ZCODE_CAMPP_THREADS", 2, 16);

    if (method == "embed_segments") {
        if (params.contains("segmentIds") && params["segmentIds"].is_array()) {
            std::map<std::string, Segment> by_id;
            for (const auto &segment : segments) by_id.emplace(segment.id, segment);
            std::vector<Segment> selected;
            for (const auto &id : params["segmentIds"]) {
                if (!id.is_string()) continue;
                const auto found = by_id.find(id.get<std::string>());
                if (found != by_id.end()) selected.push_back(found->second);
            }
            segments = std::move(selected);
        }

        const EmbeddingRun run = engine.embeddings(audio_path, wav_info, segments, model_path, true, batch_size, threads);
        std::vector<std::pair<std::string, std::vector<float>>> entries;
        for (std::size_t index = 0; index < segments.size() && index < run.embeddings.size(); ++index) {
            if (!run.embeddings[index].empty()) entries.emplace_back(segments[index].id, run.embeddings[index]);
        }
        json response{{"embeddings", embedding_entries(entries)}};
        if (!entries.empty()) {
            std::vector<float> mean(entries.front().second.size(), 0.0f);
            std::size_t compatible_count = 0;
            for (const auto &[id, vector] : entries) {
                if (vector.size() != mean.size()) continue;
                ++compatible_count;
                for (size_t i = 0; i < vector.size(); ++i) mean[i] += vector[i];
            }
            if (compatible_count > 0) {
                for (float &value : mean) value /= static_cast<float>(compatible_count);
                response["embedding"] = normalize(std::move(mean));
            }
        }
        response["metrics"] = {{"batchCount", run.batch_count}};
        return response;
    }

    if (method == "diarize") {
        const auto input_segments = params.value("segments", json::array());
        std::vector<zcode::speaker::TimelineWindow> timeline;
        const std::vector<Segment> windows = make_diarization_windows(segments, timeline);
        zcode::speaker::ClusterResult clustering;
        EmbeddingRun run;
        if (!windows.empty()) {
            run = engine.embeddings(audio_path, wav_info, windows, model_path, false, batch_size, threads);
            std::vector<zcode::speaker::EmbeddingPoint> points;
            points.reserve(windows.size());
            for (std::size_t index = 0; index < windows.size(); ++index) {
                points.push_back({windows[index].id, index, windows[index].start, windows[index].end,
                                  index < run.embeddings.size() ? run.embeddings[index] : std::vector<float>{}});
            }
            clustering = zcode::speaker::cluster_embeddings(points, cluster_options(params));
        } else {
            clustering.labels.assign(timeline.size(), -1);
        }

        const auto assignments = zcode::speaker::map_windows_to_segments(
            timeline, clustering.labels, input_segments.is_array() ? input_segments.size() : 0);
        json response{{"segments", json::array()}, {"algorithmVersion", "speaker-v2"}};
        response["metrics"] = {
            {"windowCount", windows.size()},
            {"clusterCount", clustering.clusters.size()},
            {"batchCount", run.batch_count},
        };
        response["clusters"] = json::array();
        for (const auto &summary : clustering.clusters) {
            response["clusters"].push_back({
                {"clusterId", summary.id},
                {"size", summary.size},
                {"canonicalKey", summary.canonical_key},
                {"prototype", summary.prototype},
            });
        }

        if (!input_segments.is_array()) return response;
        for (std::size_t i = 0; i < input_segments.size(); ++i) {
            json item = input_segments[i];
            const auto assignment = i < assignments.size() ? assignments[i] : zcode::speaker::SegmentAssignment{};
            if (assignment.cluster >= 0) {
                item["speaker"] = "cluster_" + std::to_string(assignment.cluster);
                item["speakerMatch"] = "cluster";
                item["speakerConfidence"] = assignment.speaker_purity;
            } else {
                item["speaker"] = "unknown";
                item["speakerMatch"] = "unknown";
                item["speakerConfidence"] = nullptr;
            }
            item["speakerPurity"] = assignment.speaker_purity;
            item["mixedSpeaker"] = assignment.mixed_speaker;
            item["speakerWindowCount"] = assignment.window_count;
            response["segments"].push_back(std::move(item));
        }
        return response;
    }

    throw std::runtime_error("unsupported CAM++ method: " + method);
}

} // namespace

int main(int argc, char **argv) {
    bool stdio = false;
    for (int index = 1; index < argc; ++index) stdio = stdio || std::string(argv[index]) == "--stdio";
    if (!stdio) {
        std::cerr << "usage: campp-adapter --stdio\n";
        return 2;
    }
    CamppEngine engine;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        json request;
        try {
            request = json::parse(line);
            json response{{"jsonrpc", "2.0"}, {"id", request.contains("id") ? request["id"] : json(nullptr)}};
            try {
                response["result"] = handle(request, engine);
            } catch (const std::exception &error) {
                response.erase("result");
                response["error"] = {{"code", "campp_failed"}, {"message", error.what()}};
            }
            std::cout << response.dump() << std::endl;
        } catch (const std::exception &error) {
            std::cout << json({{"jsonrpc", "2.0"}, {"id", nullptr}, {"error", {{"code", "invalid_request"}, {"message", error.what()}}}}).dump() << std::endl;
        }
    }
    return 0;
}
