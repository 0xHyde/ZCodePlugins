# ZCodePlugins

ZCode 插件市场 monorepo。插件放在 `plugins/`，跨插件文档放在 `docs/`，构建和校验脚本放在 `tools/`。

当前插件：

- [`voice-transcriber`](plugins/voice-transcriber)：全本地录音转写、说话人区分、无感注册和自动匹配。

## voice-transcriber

它适合会议、访谈和调研录音：

- 本地运行 SenseVoice，不上传录音
- 自动识别语音片段并保留时间戳
- 通过 CAM++ 做说话人匹配
- 可从真实会议片段中无感积累说话人样本
- 修正说话人后写回本地档案，支持回滚
- 转写全文保存为本地产物，返回给 ZCode 的内容按长度自动压缩
- 不内置摘要大模型；摘要、纪要和行动项由 ZCode Agent 完成

## 安装与发布

仓库地址：[github.com/0xHyde/ZCodePlugins](https://github.com/0xHyde/ZCodePlugins)

当前正式版本：[v0.1.0](https://github.com/0xHyde/ZCodePlugins/releases/tag/v0.1.0)，支持：

- Windows x64
- macOS arm64

运行时二进制通过 [runtime-manifest.json](https://github.com/0xHyde/ZCodePlugins/releases/download/v0.1.0/runtime-manifest.json) 按需下载。模型权重不进入 Git 仓库和 runtime Release，由用户手动提供或通过独立的模型 manifest 下载。

在 ZCode 中将本仓库作为 Marketplace 源，启用 `voice-transcriber` 即可。插件首次真正转写时才初始化缺失的运行时，不转写时不会常驻推理进程。

## 模型配置

默认模型目录：

```text
~/.zcode/voice-transcriber/models/
├── sense-voice-small-q8_0.gguf
└── cam++.onnx
```

可以在 ZCode 插件配置中填写模型路径，也可以设置：

```text
ZCODE_SENSEVOICE_MODEL=/path/to/sense-voice-small-q8_0.gguf
ZCODE_CAMPP_MODEL=/path/to/cam++.onnx
ZCODE_VOICE_MODEL_MANIFEST_URL=https://github.com/OWNER/REPO/releases/download/models-v0.1.0/model-manifest.json
```

模型 manifest 只是一份带下载地址、文件大小和 SHA256 的清单，不包含模型本身。项目提供了示例和生成工具：

```bash
node tools/create-model-manifest.mjs \
  --input /path/to/model-assets \
  --version models-v0.1.0 \
  --repository OWNER/REPO \
  --asset-prefix models- \
  --optional cam++.onnx \
  --output model-manifest.json
```

模型来源和许可证确认前，不会在项目中伪造默认下载地址。

## 本地开发

要求 Node.js 22。常用命令：

```bash
npm run test:voice-transcriber
npm run validate
npm run bench:voice-transcriber -- /absolute/path/to/meeting.wav
```

构建当前平台 native runtime：

```bash
npm run build:sensevoice -- --ref main
npm run build:campp -- --ref main
```

构建需要 Git、CMake 和 C/C++ 工具链；构建过程不会下载模型。

## 目录结构

```text
plugins/voice-transcriber/  插件、MCP 服务、native adapter 和测试
docs/voice-transcriber/    架构、模型、运行时和发布说明
tools/                     构建、manifest、校验和性能工具
packages/                  未来跨插件复用的共享代码
```

## 当前边界

- Linux 暂不纳入当前发布范围
- 模型 manifest 的正式下载源和许可证仍需确认
- ffmpeg 自动发现、代码签名和真实模型端到端性能验收仍需继续完善
