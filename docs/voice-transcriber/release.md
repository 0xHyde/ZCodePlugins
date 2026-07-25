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

- P0：完成 SenseVoice.cpp 的真实 native runtime，确认 WAV 输入和 MP3、M4A 等格式的预处理链路。
- P0：为 macOS、Windows、Linux 发布合规的 ffmpeg 音频转换器，或提供等价的内置解码实现。
- P0：建立合规的 GitHub Release 模型源，发布 `model-manifest.json`、SHA256 和版本号；插件安装后首次转写自动下载，下载失败给出可操作错误。
- P0：完成 CAM++ ONNX Runtime adapter，并提供 macOS、Windows 构建产物。当前已经完成原生协议、macOS arm64 构建和空闲释放；Windows 已加入 GitHub Actions 构建流程，仍需 CI 实际跑通和真实音频验收。
- P0：在常见个人电脑上完成真实音频基准，记录冷启动、实时率、内存和长录音稳定性。
- P1：用带时间戳的真实会议录音验证 VAD、说话人分离、自动匹配和误识别回退。
- P1：增加声纹档案加密、文件权限、数据删除和版本迁移。
- P1：完成模型/运行时许可证、代码签名、安装升级和 ZCode Marketplace 发布验收。
