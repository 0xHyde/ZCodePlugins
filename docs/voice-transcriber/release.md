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
SenseVoice、llama.cpp、3D-Speaker、nlohmann/json 与 ONNX Runtime 许可证
ONNX Runtime 第三方声明
FFMPEG_LICENSE.txt
```

模型不进入插件包。Release 发布：

- `model-manifest.json`
- `voice-transcriber-plugin-v<version>.zip`，内含本次构建的 `dist/mcp/server.js`、可选 ZCode 使用提示和两个平台的 runtime
- 插件根目录的 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`，以及 runtime 内各第三方组件的许可证/声明
- 模型权重不进入插件包，安装后首次转写时按 manifest 下载
- 旧版 runtime manifest 资产仅作为兼容/诊断材料，不是当前插件安装路径的必需依赖

## 发布流程

1. 统一 Marketplace、插件 manifest 和 package 版本，在本地运行完整测试与校验；
2. 提交源码候选后，先运行 Windows x64 与 macOS arm64 的 runtime 构建工作流；
3. 下载两个平台产物，同步回 `plugins/voice-transcriber/bin/`，再次校验并提交。Marketplace 当前安装的是仓库内相对目录，因此 tag 中跟踪的 runtime 必须就是本版源码构建且通过测试的版本；
4. 仅在上述同步完成后创建 tag。Release workflow 会再次独立构建两个平台，验证 SenseVoice、CAM++ 和 ffmpeg 可启动，并运行 Speaker 纯算法测试与 CAM++ 协议 smoke test；
5. publish job 重新构建 MCP，清空插件副本中的旧平台目录，装入本次构建产物；
6. 解压最终 ZIP，按本次 runtime manifest 逐文件核对 SHA，并检查入口、`node_modules` 和模型权重；
7. 发布 GitHub Release，并从公开 URL 回读 model manifest 和插件包。

带连字符的语义化版本 tag（例如 `v0.4.0-rc.1`）按 prerelease 发布，并明确不设为 latest；稳定版本 tag 按普通 Release 发布。工作流要求 tag、package、插件 manifest 和 Marketplace 四处版本完全一致。

macOS ARM 使用 native 优化构建；Windows 使用可移植 CPU 构建，避免把 GitHub runner 的指令集要求带到用户电脑。

稳定版发布前还必须在最终 ZIP 上分别完成 macOS ARM64 与真实 Windows x64 的模型推理 smoke test。当前 CI 的协议测试只能证明程序和动态库能够启动，不能替代 Windows 真实录音的准确率、峰值内存与长录音验证。

`v0.4.0-rc.1` 候选的源码、Windows x64 和 macOS ARM64 runtime 已由对应源码提交的 GitHub Actions 构建、验证并同步回仓库；本次 Release 仍按 prerelease 发布，不设为 latest。真实 Windows 模型推理、中文路径和曾触发 GGML 内存崩溃的长录音验证仍是稳定版门槛。Apache-2.0 项目的版权主体为 0xHyde。

## 发布边界

- 推理、说话人档案和全文均保存在本地；
- FFmpeg 作为独立进程随 runtime 分发，许可证随包提供；
- 项目代码使用 Apache-2.0；模型不随包分发，其来源和许可证边界记录在插件第三方声明中；
- 当前未提供商业代码签名或 macOS notarization；
- Linux 暂不发布。
