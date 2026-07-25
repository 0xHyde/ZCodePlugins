# 发布布局与清单

## Native binaries

按平台放置 `voice-engine`：

```text
bin/darwin/arm64/llama-funasr-sensevoice
bin/darwin/arm64/campp-adapter
bin/darwin/arm64/libonnxruntime.1.12.0.dylib
```

Windows 采用相同目录约定，并放置对应的 `.exe` 和 `.dll`；也可以通过
`ZCODE_VOICE_ENGINE`、`ZCODE_SENSEVOICE_BINARY` 或 `ZCODE_CAMPP_COMMAND` 指定自定义路径。

SenseVoice 子运行时默认放在同一平台目录下，文件名为 `llama-funasr-sensevoice`（Windows 为 `.exe`）；CAM++ adapter 默认文件名为 `campp-adapter`（Windows 为 `.exe`），并随同目录放置 ONNX Runtime 动态库，也可以通过环境变量覆盖。

二进制不提交到 Git；发布时由对应平台的打包流程注入。

## 当前发布状态

当前开发版已经切换到 QwenAudio 官方 SenseVoice runtime，并将官方 FSMN-VAD 作为自动分段的必需模型；模型权重仍不进入插件仓库或 runtime Release。

正式发布 `v0.2.0` 前还需要完成：

- 在 Windows x64 上用真实 SenseVoice Q8、FSMN-VAD、CAM++ 模型和会议录音完成端到端验收；
- 发布 `runtime-manifest.json` 和 `model-manifest.json`，确认 ZCode Marketplace 能自动下载并校验；
- 在常见 CPU / 内存档位记录冷启动、实时率、内存和长录音稳定性；
- 完成模型与运行时许可证、代码签名、数据删除和正式 Marketplace 发布验收。
