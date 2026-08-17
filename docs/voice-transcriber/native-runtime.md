# voice-engine native sidecar

这是 ZCode 插件内部的本地推理进程接口。对 ZCode 来说，入口是插件包内编译后的 `dist/mcp/server.js`；MCP server 再启动 Node sidecar，sidecar 调用随插件发布的各平台 native runtime。模型权重不打包，首次转写时懒加载。

## 运行时方案

- SenseVoiceSmall GGUF：QwenAudio 官方 llama.cpp runtime，配合官方 FSMN-VAD
- CAM++：3D-Speaker 导出的 ONNX，使用 ONNX Runtime
- 聚类、缓存、增量学习：Node sidecar 负责任务和本地状态；CAM++ adapter 负责 ONNX 推理
- 通信：JSON Lines over stdin/stdout

开发或诊断阶段可以直接运行：

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

SenseVoice 运行时会优先自动查找插件内的：

```text
bin/<platform>/<arch>/llama-funasr-sensevoice[.exe]
```

找不到时再使用 `ZCODE_SENSEVOICE_BINARY` 或系统 `PATH`。因此正式发布包直接带上对应平台 runtime，不需要用户再配置二进制下载地址。

## sidecar 协议

底层 sidecar 请求：

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

ZCode 对外使用的是应用层异步 MCP 接口：先调用 `start_transcription` 获得 `taskId`，再轮询 `get_transcription_status`，完成后用 `read_transcript` 分页读取全文。这样不依赖 ZCode 是否实现 MCP Tasks，也不会让一次长会议请求长期占住单次调用。

## CAM++ adapter 协议

主引擎通过 `ZCODE_CAMPP_COMMAND` 启动一个 JSONL adapter。adapter 接收同样的
JSON-RPC 行协议，并至少实现两个方法：

```json
{"jsonrpc":"2.0","id":1,"method":"diarize","params":{"audioPath":"/tmp/a.wav","segments":[]}}
{"jsonrpc":"2.0","id":2,"method":"embed_segments","params":{"audioPath":"/tmp/a.wav","segmentIds":["seg_0001"],"segments":[]}}
```

`diarize` 返回 `{ "segments": [...] }`；`embed_segments` 返回
`{ "embeddings": [{ "segmentId": "seg_0001", "embedding": [0.1, 0.2] }] }`。
主引擎负责归一化、与本地档案做余弦相似度匹配、阈值/间隔判定以及增量学习和回滚。
这样 ONNX Runtime 只负责模型推理；同一个说话人分析或学习阶段内复用该进程，阶段结束后立即释放。

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

SenseVoice 子进程在一次 ASR 调用结束后退出并释放模型内存；CAM++ adapter 在一次说话人分析或学习阶段结束后立即退出。内部仍保留空闲超时作为异常路径兜底，但它不是正常资源生命周期。

官方 runtime 只直接处理 16kHz、单声道、16-bit WAV。插件会优先复用符合条件的 WAV；对 MP3、M4A 和其他 WAV，调用随插件发布的 `ffmpeg` 转换，任务结束后删除临时 WAV。也可以用 `ZCODE_AUDIO_CONVERTER` 覆盖路径。

## 性能约束

- Node sidecar 常驻；ASR 与 CAM++ native 进程仅在各自阶段运行，空闲时不保留推理模型。
- 压缩音频先在本地统一转换一次；ASR 与 CAM++ 复用同一份 16kHz PCM WAV 和 ASR/VAD 时间线。
- 不把整段长音频加载到内存。
- 线程数由 sidecar 统一管理，不允许每个模型各自占满 CPU。
- `enroll_from_correction` 只能处理缓存片段，不得重新转写整段会议。
- 默认匹配阈值为 `0.62`、最佳与次佳差值为 `0.05`；可用
  `ZCODE_CAMPP_MATCH_THRESHOLD` 和 `ZCODE_CAMPP_MATCH_MARGIN` 调整。
