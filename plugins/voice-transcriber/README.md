# voice-transcriber

ZCode 的全本地录音转写插件，面向会议、访谈和调研场景。

## 能做什么

- SenseVoice 本地语音转文字，保留时间戳和完整全文
- CAM++ 说话人匹配、注册、修正和回滚
- 从 VAD 自动切出的片段中无感积累说话人样本
- 将修正结果写回本地档案，让后续录音逐步变准
- MCP 返回适合 Agent 消费的摘要片段，同时保留本地完整转写产物
- 不上传录音，不内置摘要大模型

## 运行方式

插件通过 `.mcp.json` 启动本地 Node.js MCP 服务。首次转写时按需准备：

1. 音频转换器（MP3/M4A 等格式通常需要 ffmpeg）
2. SenseVoice native runtime
3. SenseVoice 模型
4. 可选的 CAM++ runtime 和模型

不转写时不会保持推理进程；CAM++ adapter 空闲一段时间后自动退出。

已发布 runtime 会从 GitHub Release 按当前平台下载并校验 SHA256。模型不随插件或 runtime 发布，需要手动配置或使用独立模型 manifest。

## 配置

常用配置项：

```text
ZCODE_SENSEVOICE_MODEL=/path/to/sense-voice-small-q8_0.gguf
ZCODE_CAMPP_MODEL=/path/to/cam++.onnx
ZCODE_SENSEVOICE_BINARY=llama-funasr-sensevoice
ZCODE_VOICE_THREADS=4
ZCODE_CAMPP_COMMAND=/path/to/campp-adapter
ZCODE_AUDIO_CONVERTER=ffmpeg
ZCODE_VOICE_MODEL_MANIFEST_URL=https://raw.githubusercontent.com/0xHyde/ZCodePlugins/main/model-manifest.json
ZCODE_VOICE_RUNTIME_MANIFEST_URL=https://github.com/0xHyde/ZCodePlugins/releases/download/v0.1.0/runtime-manifest.json
```

模型默认目录是 `~/.zcode/voice-transcriber/models/`，运行时默认目录是 `~/.zcode/voice-transcriber/runtimes/<platform>-<arch>/`。

## 开发

在插件目录外执行：

```bash
npm run test:voice-transcriber
npm run validate
```

native runtime 构建：

```bash
npm run build:sensevoice -- --ref runtime-llamacpp-v0.1.9
npm run build:campp -- --ref main
```

模型清单生成：

```bash
node tools/create-model-manifest.mjs \
  --input /path/to/model-assets \
  --version models-v0.1.0 \
  --repository OWNER/REPO \
  --asset-prefix models- \
  --optional cam++.onnx \
  --output model-manifest.json
```

更多说明见 [`docs/voice-transcriber/`](../../docs/voice-transcriber/)。
