# voice-transcriber

ZCode 的全本地录音转写 MCP 插件，面向会议、访谈和调研场景。

## 使用体验

用户只需把本地录音文件交给 ZCode。插件会自动准备运行时和模型、转换音频、转写、区分说话人，并把完整全文保存为本地产物。ZCode 可以继续生成摘要、纪要、行动项或做内容检索。

说话人修正会把确认过的真实会议片段加入本地声纹档案，后续录音自动匹配；所有学习操作均可回滚。

## 本地组件

- QwenAudio 官方 SenseVoice llama.cpp runtime
- 官方 SenseVoiceSmall Q8 GGUF
- 官方 FSMN-VAD GGUF
- CAM++ ONNX 与 ONNX Runtime
- 随平台 runtime 发布的 ffmpeg

插件安装时不下载模型。首次转写时按当前平台从 GitHub Release 下载 runtime，并优先从 ModelScope 下载模型；全部文件经过 SHA256 校验。之后可以断网使用。

默认目录：

```text
~/.zcode/voice-transcriber/models/
~/.zcode/voice-transcriber/runtimes/<platform>-<arch>/
~/.zcode/voice-transcriber/artifacts/
```

不转写时不会常驻 SenseVoice 推理进程；CAM++ adapter 空闲 30 秒后自动退出。

## 高级配置

一般无需配置。需要使用自定义文件时可在 ZCode 插件设置中覆盖：

```text
ZCODE_SENSEVOICE_MODEL=/path/to/sense-voice-small-q8_0.gguf
ZCODE_FSMN_VAD_MODEL=/path/to/fsmn-vad.gguf
ZCODE_CAMPP_MODEL=/path/to/cam++.onnx
ZCODE_SENSEVOICE_BINARY=/path/to/llama-funasr-sensevoice
ZCODE_CAMPP_COMMAND=/path/to/campp-adapter
ZCODE_AUDIO_CONVERTER=/path/to/ffmpeg
ZCODE_VOICE_THREADS=4
```

发布版 manifest：

```text
https://github.com/0xHyde/ZCodePlugins/releases/download/v0.2.0/runtime-manifest.json
https://github.com/0xHyde/ZCodePlugins/releases/download/v0.2.0/model-manifest.json
```

## 开发校验

```bash
npm run test:voice-transcriber
npm run validate
```

架构与发布说明见 [`docs/voice-transcriber/`](../../docs/voice-transcriber/)。
