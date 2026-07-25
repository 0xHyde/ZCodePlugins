# 发布布局与清单

## Native binaries

按平台放置 `voice-engine`：

```text
bin/darwin/arm64/sense-voice-main
bin/darwin/arm64/campp-adapter
bin/darwin/arm64/libonnxruntime.1.12.0.dylib
```

Windows 采用相同目录约定，并放置对应的 `.exe` 和 `.dll`；也可以通过
`ZCODE_VOICE_ENGINE`、`ZCODE_SENSEVOICE_BINARY` 或 `ZCODE_CAMPP_COMMAND` 指定自定义路径。

SenseVoice 子运行时默认放在同一平台目录下，文件名为 `sense-voice-main`（Windows 为 `.exe`）；CAM++ adapter 默认文件名为 `campp-adapter`（Windows 为 `.exe`），并随同目录放置 ONNX Runtime 动态库，也可以通过环境变量覆盖。

二进制不提交到 Git；发布时由对应平台的打包流程注入。

## 当前发布阻塞项

- 已完成：`v0.1.0` 发布 Windows x64 与 macOS arm64 runtime、合并后的 `runtime-manifest.json`、SHA256 和版本号。
- P0：确认模型来源和许可证后，发布独立的 `model-manifest.json`；模型权重不进入插件仓库或 runtime Release。
- P0：在 Windows 上用真实 SenseVoice Q8、CAM++ 模型和会议录音完成端到端验收；当前 CI 已验证编译、启动、测试和打包，但没有把模型放入 CI。
- P0：确认 ZCode Marketplace 安装流程能够读取 runtime manifest，并在首次转写时自动下载缺失 runtime；模型下载等模型清单发布后再启用。
- P1：确认 Windows 用户没有 ffmpeg 时的自动发现、清晰提示或 ZCode 提供的音频转换能力。
- P1：在常见 CPU / 内存档位上记录冷启动、实时率、内存和长录音稳定性。
- P1：增加声纹档案加密、文件权限、数据删除和版本迁移。
- P1：完成模型/运行时许可证、代码签名和正式 Marketplace 发布验收。
