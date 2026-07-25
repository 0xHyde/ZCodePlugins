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

模型不进入插件包。Release 发布：

- `model-manifest.json`
- `voice-transcriber-plugin-v0.3.0.zip`，内含 `dist/mcp/server.js`、ZCode Skill 和两个平台的 runtime
- 模型权重不进入插件包，安装后首次转写时按 manifest 下载
- 旧版 runtime manifest 资产仅作为兼容/诊断材料，不是 v0.3.0 安装路径的必需依赖

## 发布流程

1. 统一 Marketplace、插件 manifest 和 package 版本；
2. 运行 JavaScript 测试和插件校验；
3. 在 GitHub Actions 分别构建 Windows x64 与 macOS arm64；
4. 验证 SenseVoice、CAM++ 和 ffmpeg 可启动；
5. 将构建产物放入插件包并检查包内不含 `node_modules` 和模型权重；
6. 发布 GitHub Release，并从公开 URL 回读 model manifest 和插件包。

macOS ARM 使用 native 优化构建；Windows 使用可移植 CPU 构建，避免把 GitHub runner 的指令集要求带到用户电脑。

## 发布边界

- 推理、说话人档案和全文均保存在本地；
- FFmpeg 作为独立进程随 runtime 分发，许可证随包提供；
- 当前未提供商业代码签名或 macOS notarization；
- Linux 暂不发布。
