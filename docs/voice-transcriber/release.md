# 发布布局与验收

## 支持平台

```text
darwin-arm64
win32-x64
```

每个平台的 runtime 包含：

```text
llama-funasr-sensevoice[.exe]
campp-adapter[.exe]
ffmpeg[.exe]
ONNX Runtime 动态库
FFMPEG_LICENSE.txt
```

模型不进入插件包或 runtime 包。Release 同时发布：

- `runtime-manifest.json`
- `model-manifest.json`
- 两个平台的 runtime zip
- 可供 manifest 单文件下载的 runtime 资产
- `voice-transcriber-plugin-v0.2.0.zip`

## 发布流程

1. 统一 Marketplace、插件 manifest 和 package 版本；
2. 运行 JavaScript 测试和插件校验；
3. 在 GitHub Actions 分别构建 Windows x64 与 macOS arm64；
4. 验证 SenseVoice、CAM++ 和 ffmpeg 可启动；
5. 生成并合并平台 runtime manifest；
6. 发布 GitHub Release，并从公开 URL 回读 manifest 和资产。

macOS ARM 使用 native 优化构建；Windows 使用可移植 CPU 构建，避免把 GitHub runner 的指令集要求带到用户电脑。

## 发布边界

- 推理、说话人档案和全文均保存在本地；
- FFmpeg 作为独立进程随 runtime 分发，许可证随包提供；
- 当前未提供商业代码签名或 macOS notarization；
- Linux 暂不发布。
