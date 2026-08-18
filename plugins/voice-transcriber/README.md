# voice-transcriber

ZCode 的全本地录音转写 MCP 插件，面向会议、访谈和调研场景。

当前发布候选版本：`v0.4.0-rc.3`。

## 使用体验

用户只需把本地录音文件交给 ZCode。插件会创建本地任务，后台准备模型、转换音频、转写和区分说话人；ZCode 会自动查询任务状态并读取完整全文。ZCode 可以继续生成摘要、纪要、行动项或做内容检索。

说话人修正会把确认过的真实会议片段加入本地声纹档案，后续录音自动匹配；所有学习操作均可回滚。

## 本地组件

- QwenAudio 官方 SenseVoice llama.cpp runtime（macOS ARM64 / Windows x64 随插件提供）
- 官方 SenseVoiceSmall Q8 GGUF（首次使用时下载）
- 官方 FSMN-VAD GGUF（首次使用时下载）
- CAM++ ONNX 模型（首次启用说话人识别时下载）与随包 ONNX Runtime
- 随平台 runtime 发布的 ffmpeg

插件安装包包含 macOS ARM64 和 Windows x64 的运行时，不需要再下载 runtime。插件安装时不下载模型；首次转写时优先从 ModelScope 下载模型，全部文件经过 SHA256 校验。之后可以断网使用。

默认目录：

```text
${CLAUDE_PLUGIN_DATA}/models/
${CLAUDE_PLUGIN_DATA}/artifacts/
${CLAUDE_PLUGIN_DATA}/tasks/
```

不转写时不会常驻 SenseVoice 推理进程；每次说话人分析或学习结束后会立即释放 CAM++ adapter。ASR 和说话人分析分别缓存，阶段键包含对应模型和 runtime SHA；修改说话人档案、匹配阈值或输出格式时不会重复执行昂贵推理。分块转写每完成一块就保存本地 checkpoint，失败或 ZCode 进程中断后重新提交同一录音会继续未完成分块。

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

发布版模型 manifest：

```text
https://github.com/0xHyde/ZCodePlugins/releases/download/v0.4.0-rc.3/model-manifest.json
```

MCP 采用异步任务接口：`start_transcription` 创建任务，`wait_transcription` 在一次有限等待内返回完成结果或当前进度，`read_transcript` 分页读取全文；`get_transcription_status` 继续用于兼容和即时查询。任务完成后，状态中的 `artifacts.text` 返回完整纯文本文件，`artifacts.json` 和 `artifacts.markdown` 返回结构化及 Markdown 文件。

## 开发校验

```bash
npm run test:voice-transcriber
npm run validate
```

架构与发布说明见 [`docs/voice-transcriber/`](../../docs/voice-transcriber/)。

项目代码使用 [Apache License 2.0](LICENSE)。随包组件、模型来源及许可证边界见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
