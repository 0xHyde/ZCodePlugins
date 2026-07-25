// Native CAM++ JSONL adapter.
//
// The feature extractor and ONNX wrapper are provided by the Apache-2.0
// licensed 3D-Speaker runtime at build time.  Keeping this process separate
// from the MCP sidecar lets the model stay resident for a short idle window,
// while the sidecar remains small and releases the process when unused.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <onnxruntime_cxx_api.h>

#include "feature/feature_common.h"
#include "feature/feature_fbank.h"
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

struct Segment {
    std::string id;
    double start = 0.0;
    double end = 0.0;
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
    std::ifstream file(path, std::ios::binary);
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

std::vector<float> read_audio_range(const std::string &path, const WavInfo &info, size_t begin, size_t end) {
    if (end <= begin) return {};
    const size_t max_samples = info.data_bytes / sizeof(int16_t);
    begin = std::min(begin, max_samples);
    end = std::min(end, max_samples);
    if (end <= begin) return {};
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("cannot open WAV segment");
    file.seekg(info.data_offset + static_cast<std::streamoff>(begin * sizeof(int16_t)));
    std::vector<int16_t> samples(end - begin);
    file.read(reinterpret_cast<char *>(samples.data()), static_cast<std::streamsize>(samples.size() * sizeof(int16_t)));
    if (file.gcount() != static_cast<std::streamsize>(samples.size() * sizeof(int16_t))) throw std::runtime_error("truncated WAV data");
    std::vector<float> audio(samples.size());
    for (size_t i = 0; i < samples.size(); ++i) audio[i] = static_cast<float>(samples[i]) / 32767.0f;
    return audio;
}

std::vector<Segment> parse_segments(const json &params, double duration) {
    std::vector<Segment> result;
    if (!params.contains("segments") || !params["segments"].is_array()) return result;
    int index = 0;
    for (const auto &item : params["segments"]) {
        Segment segment;
        segment.id = string_value(item, "id", "seg_" + std::to_string(++index));
        segment.start = std::max(0.0, number_value(item, "start", 0.0));
        segment.end = number_value(item, "end", duration);
        if (segment.end <= segment.start) segment.end = duration;
        segment.end = std::min(duration, segment.end);
        if (segment.end > segment.start) result.push_back(segment);
    }
    return result;
}

std::string temporary_wav_path(int index) {
    std::filesystem::path directory = std::filesystem::temp_directory_path();
    return (directory / ("zcode-campp-" + std::to_string(process_id()) + "-" + std::to_string(index) + ".wav")).string();
}

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
    std::ofstream file(path, std::ios::binary);
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

double cosine(const std::vector<float> &left, const std::vector<float> &right) {
    if (left.empty() || right.empty() || left.size() != right.size()) return -1.0;
    double value = 0.0;
    for (size_t i = 0; i < left.size(); ++i) value += static_cast<double>(left[i]) * right[i];
    return value;
}

class NativeOnnxModel {
public:
    explicit NativeOnnxModel(const std::string &model_path)
        : env_(ORT_LOGGING_LEVEL_WARNING, "zcode-campp"), session_options_() {
        session_options_.SetIntraOpNumThreads(1);
        session_options_.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
        session_ = std::make_unique<Ort::Session>(env_, model_path.c_str(), session_options_);
        Ort::AllocatorWithDefaultOptions allocator;
        char *input_name = session_->GetInputName(0, allocator);
        char *output_name = session_->GetOutputName(0, allocator);
        input_name_ = input_name;
        output_name_ = output_name;
        allocator.Free(input_name);
        allocator.Free(output_name);
    }

    std::vector<std::vector<float>> run_batch(const std::vector<speakerlab::Feature> &features) {
        if (features.empty()) return {};
        const size_t dimensions = 80;
        size_t max_frames = 0;
        for (const auto &feature : features) max_frames = std::max(max_frames, feature.size());
        if (max_frames == 0) return std::vector<std::vector<float>>(features.size());
        std::vector<float> values;
        values.reserve(features.size() * max_frames * dimensions);
        for (const auto &feature : features) {
            const std::vector<float> fallback = feature.empty() ? std::vector<float>(dimensions, 0.0f) : feature.back();
            for (size_t frame = 0; frame < max_frames; ++frame) {
                const auto &source = frame < feature.size() ? feature[frame] : fallback;
                values.insert(values.end(), source.begin(), source.end());
            }
        }
        const std::array<int64_t, 3> shape{
            static_cast<int64_t>(features.size()), static_cast<int64_t>(max_frames), static_cast<int64_t>(dimensions),
        };
        Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
        Ort::Value input = Ort::Value::CreateTensor<float>(memory_info, values.data(), values.size(), shape.data(), shape.size());
        const char *input_names[] = {input_name_.c_str()};
        const char *output_names[] = {output_name_.c_str()};
        auto outputs = session_->Run(Ort::RunOptions{nullptr}, input_names, &input, 1, output_names, 1);
        if (outputs.empty() || !outputs.front().IsTensor()) return {};
        const auto info = outputs.front().GetTensorTypeAndShapeInfo();
        const size_t count = info.GetElementCount();
        const float *data = outputs.front().GetTensorData<float>();
        const size_t embedding_dimensions = count / features.size();
        std::vector<std::vector<float>> result(features.size());
        for (size_t batch = 0; batch < features.size(); ++batch) {
            result[batch] = std::vector<float>(data + batch * embedding_dimensions, data + (batch + 1) * embedding_dimensions);
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
    std::vector<std::vector<float>> embeddings(const std::string &audio_path, const WavInfo &wav_info,
                                               const std::vector<Segment> &segments, const std::string &model_path) {
        load_model(model_path);
        const double duration = static_cast<double>(wav_info.data_bytes / sizeof(int16_t)) / wav_info.sample_rate;
        std::vector<speakerlab::Feature> features;
        features.reserve(segments.size());
        for (size_t index = 0; index < segments.size(); ++index) {
            const auto &segment = segments[index];
            const double start = std::max(0.0, std::min(segment.start, duration));
            const double end = std::max(start, std::min(segment.end, duration));
            // A small context window makes short VAD/ASR segments more stable.
            const double context_start = std::max(0.0, start - 0.20);
            const double context_end = std::min(duration, end + 0.20);
            const size_t begin = static_cast<size_t>(context_start * wav_info.sample_rate);
            const size_t finish = std::min(static_cast<size_t>(wav_info.data_bytes / sizeof(int16_t)), static_cast<size_t>(context_end * wav_info.sample_rate));
            if (finish <= begin || finish - begin < wav_info.sample_rate * 0.25) {
                features.emplace_back();
                continue;
            }

            const std::string segment_path = temporary_wav_path(static_cast<int>(index));
            const auto audio = read_audio_range(audio_path, wav_info, begin, finish);
            write_segment_wav(segment_path, audio, wav_info.sample_rate, 0, audio.size());
            try {
                Silence silence;
                speakerlab::WavReader segment_wav(segment_path);
                speakerlab::Feature feature = fbank_->compute_feature(segment_wav);
                speakerlab::subtract_feature_mean(feature);
                features.push_back(std::move(feature));
            } catch (...) {
                std::remove(segment_path.c_str());
                throw;
            }
            std::remove(segment_path.c_str());
        }

        std::vector<std::vector<float>> result;
        {
            Silence silence;
            result = model_->run_batch(features);
        }
        for (size_t i = 0; i < result.size(); ++i) {
            if (i >= features.size() || features[i].empty()) result[i].clear();
            else result[i] = normalize(std::move(result[i]));
        }
        return result;
    }

private:
    void load_model(const std::string &model_path) {
        if (model_path.empty()) throw std::runtime_error("CAM++ model path is empty");
        if (model_ && model_path_ == model_path) return;
        Silence silence;
        speakerlab::FbankOptions options;
        options.frame_opts.sample_freq = 16000;
        options.frame_opts.frame_shift_ms = 10.0;
        options.frame_opts.frame_length_ms = 25.0;
        options.frame_opts.dither = 0.0;
        options.mel_opts.num_bins = 80;
        fbank_ = std::make_unique<speakerlab::FbankComputer>(options);
        model_ = std::make_unique<NativeOnnxModel>(model_path);
        model_path_ = model_path;
    }

    std::string model_path_;
    std::unique_ptr<speakerlab::FbankComputer> fbank_;
    std::unique_ptr<NativeOnnxModel> model_;
};

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
    if (method == "embed_segments" && params.contains("segmentIds") && params["segmentIds"].is_array()) {
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
    std::vector<std::pair<std::string, std::vector<float>>> entries;
    const auto vectors = engine.embeddings(audio_path, wav_info, segments, model_path);
    for (size_t i = 0; i < segments.size() && i < vectors.size(); ++i) {
        if (!vectors[i].empty()) entries.emplace_back(segments[i].id, vectors[i]);
    }

    if (method == "embed_segments") {
        json response{{"embeddings", embedding_entries(entries)}};
        if (!entries.empty()) {
            std::vector<float> mean(entries.front().second.size(), 0.0f);
            for (const auto &[id, vector] : entries) {
                if (vector.size() != mean.size()) continue;
                for (size_t i = 0; i < vector.size(); ++i) mean[i] += vector[i];
            }
            for (float &value : mean) value /= static_cast<float>(entries.size());
            response["embedding"] = normalize(std::move(mean));
        }
        return response;
    }

    if (method == "diarize") {
        const double threshold = std::getenv("ZCODE_CAMPP_CLUSTER_THRESHOLD")
            ? std::atof(std::getenv("ZCODE_CAMPP_CLUSTER_THRESHOLD")) : 0.35;
        std::map<std::string, std::vector<float>> by_id;
        for (auto &[id, vector] : entries) by_id.emplace(id, std::move(vector));
        std::vector<std::vector<float>> prototypes;
        std::vector<int> assignments;
        std::vector<double> assignment_scores;
        for (const auto &segment : segments) {
            const auto found = by_id.find(segment.id);
            int cluster = -1;
            double best = -1.0;
            if (found != by_id.end()) {
                for (size_t i = 0; i < prototypes.size(); ++i) {
                    const double score = cosine(found->second, prototypes[i]);
                    if (score > best) {
                        best = score;
                        cluster = static_cast<int>(i);
                    }
                }
                if (cluster < 0 || best < threshold) {
                    cluster = static_cast<int>(prototypes.size());
                    prototypes.push_back(found->second);
                } else {
                    auto &prototype = prototypes[cluster];
                    for (size_t i = 0; i < prototype.size(); ++i) prototype[i] = prototype[i] * 0.75f + found->second[i] * 0.25f;
                    prototype = normalize(std::move(prototype));
                }
            }
            assignments.push_back(cluster);
            assignment_scores.push_back(best >= 0.0 ? best : 0.5);
        }

        json response{{"segments", json::array()}};
        const auto input_segments = params.value("segments", json::array());
        for (size_t i = 0; i < input_segments.size(); ++i) {
            json item = input_segments[i];
            const int cluster = i < assignments.size() ? assignments[i] : -1;
            if (cluster >= 0) {
                item["speaker"] = "cluster_" + std::to_string(cluster);
                item["speakerMatch"] = "cluster";
                item["speakerConfidence"] = i < assignment_scores.size() ? assignment_scores[i] : 0.5;
            } else {
                item["speaker"] = "unknown";
                item["speakerMatch"] = "unknown";
            }
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
