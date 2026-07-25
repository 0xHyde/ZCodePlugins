# voice-engine native sidecar

这是 ZCode 插件的本地推理进程接口。当前仓库已提供 Node.js JSONL 开发实现；正式发布时替换为平台对应的 native binary。

## 运行时方案

- SenseVoiceSmall GGUF：QwenAudio 官方 llama.cpp runtime，配合官方 FSMN-VAD
- CAM++：3D-Speaker 导出的 ONNX，使用 ONNX Runtime
- 聚类、缓存、增量学习：C++ 或 Rust 实现；Node 版用于开发和协议测试
- 通信：JSON Lines over stdin/stdout

开发阶段可以直接运行：

```bash
node scripts/voice-engine.mjs --stdio
```

构建官方 SenseVoice runtime：

```bash
npm run build:sensevoice -- --ref runtime-llamacpp-v0.1.9
npm run build:campp -- --ref 065629c313eaf1a01c65c640c46d77e61e9607b4
```

macOS ARM 构建使用 `--native on` 以利用 Apple Silicon；Windows x64 构建使用
`--native off`，由 CPU runtime dispatch 适配不同的 AVX/AVX2 机器，避免把构建机的指令集要求带到用户电脑。

构建脚本只编译运行时，不下载模型；正式发布应将 `--ref` 固定到经过验证的提交或版本。

正式运行时可通过 `ZCODE_VOICE_ENGINE` 指定 C++/Rust 二进制。

SenseVoice 运行时会优先自动查找插件内的：

```text
bin/<platform>/<arch>/llama-funasr-sensevoice[.exe]
```

找不到时再使用 `ZCODE_SENSEVOICE_BINARY` 或系统 `PATH`。因此发布包只需要把对应平台的运行时放到自己的目录，不需要修改 JavaScript 代码。

## sidecar 协议

请求：

```json
{"jsonrpc":"2.0","id":1,"method":"transcribe","params":{"audioPath":"/tmp/a.m4a","language":"auto","outputFormat":"markdown","speakerProfile":true}}
```

响应：

```json
{"jsonrpc":"2.0","id":1,"result":{"taskId":"task_001","segments":[],"text":""}}
```

必须支持的方法：

- `transcribe`
- `correct_speaker`
- `enroll_from_correction`
- `rollback_learning`

## CAM++ adapter 协议

主引擎通过 `ZCODE_CAMPP_COMMAND` 启动一个常驻 JSONL adapter。adapter 接收同样的
JSON-RPC 行协议，并至少实现两个方法：

```json
{"jsonrpc":"2.0","id":1,"method":"diarize","params":{"audioPath":"/tmp/a.wav","segments":[]}}
{"jsonrpc":"2.0","id":2,"method":"embed_segments","params":{"audioPath":"/tmp/a.wav","segmentIds":["seg_0001"],"segments":[]}}
```

`diarize` 返回 `{ "segments": [...] }`；`embed_segments` 返回
`{ "embeddings": [{ "segmentId": "seg_0001", "embedding": [0.1, 0.2] }] }`。
主引擎负责归一化、与本地档案做余弦相似度匹配、阈值/间隔判定以及增量学习和回滚。
这样 ONNX Runtime 只负责模型推理，避免每个任务重复加载 CAM++。

SenseVoice 命令可以输出纯文本，也可以输出 `{ "text": "...", "segments": [...] }`
或直接输出 segments 数组；后两种格式会保留 VAD 时间戳，供 CAM++ 分离和修正使用。

## 模型配置

```text
ZCODE_SENSEVOICE_BINARY=llama-funasr-sensevoice
ZCODE_SENSEVOICE_MODEL=/path/to/sense-voice-small-q8_0.gguf
ZCODE_FSMN_VAD_MODEL=/path/to/fsmn-vad.gguf
# 常见个人电脑默认 4 个推理线程；可按 CPU 调整
ZCODE_VOICE_THREADS=4
ZCODE_CAMPP_MODEL=/path/to/campp.onnx
ZCODE_CAMPP_COMMAND=/absolute/path/to/campp-adapter
ZCODE_CAMPP_ARGS='["--model","/path/to/campp.onnx"]'
```

如果没有配置 `ZCODE_CAMPP_COMMAND`，引擎会自动查找
`bin/<platform>/<arch>/campp-adapter[.exe]`；自定义路径优先。

没有配置 SenseVoice 时，`transcribe_audio` 的内部状态检查会报告缺失路径；引擎会自动查找标准本地模型目录。没有 CAM++ 时可以转写，但不会伪造或写入声纹样本。

SenseVoice 子进程在单次转写结束后退出，释放模型内存；CAM++ adapter 为减少重复加载默认常驻，空闲 30 秒后自动退出。

官方 runtime 只直接处理 16kHz、单声道、16-bit WAV。插件会优先复用符合条件的 WAV；对 MP3、M4A 和其他 WAV，调用随平台 runtime 自动下载的 `ffmpeg` 转换，任务结束后删除临时 WAV。也可以用 `ZCODE_AUDIO_CONVERTER` 覆盖路径。

## 性能约束

- 模型只加载一次，sidecar 常驻。
- 音频只解码一次，VAD/ASR/CAM++ 复用 PCM 和 VAD 结果。
- 不把整段长音频加载到内存。
- 线程数由 sidecar 统一管理，不允许每个模型各自占满 CPU。
- `enroll_from_correction` 只能处理缓存片段，不得重新转写整段会议。
- 默认匹配阈值为 `0.62`、最佳与次佳差值为 `0.05`；可用
  `ZCODE_CAMPP_MATCH_THRESHOLD` 和 `ZCODE_CAMPP_MATCH_MARGIN` 调整。
