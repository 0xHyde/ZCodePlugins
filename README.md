# ZCodePlugins

面向 ZCode 的本地能力插件市场。仓库采用 monorepo，后续插件统一放在 `plugins/` 下。

## 插件

| 插件 | 功能 | 平台 |
| --- | --- | --- |
| [`voice-transcriber`](plugins/voice-transcriber) | 本地录音转写、说话人区分、无感注册与自动匹配 | Windows x64、macOS arm64 |

## 安装

在 ZCode 中将以下仓库添加为 Marketplace 源：

```text
https://github.com/0xHyde/ZCodePlugins
```

安装并启用 `voice-transcriber`。插件安装包包含 macOS ARM64 和 Windows x64 运行时，但不携带模型；第一次真正转写时会自动完成准备：

1. 从模型 manifest 获取下载地址，优先从 ModelScope 下载官方模型，失败时回退 Hugging Face；
2. 校验文件大小和 SHA256 后保存到 ZCode 插件数据目录；
3. 后续离线复用，不重复下载。

当前发布候选版本：v0.4.0-rc.1

## voice-transcriber

面向会议、访谈和调研录音：

- SenseVoiceSmall Q8 本地转写，支持 MP3、M4A、WAV 等常见格式；
- FSMN-VAD 自动分段并保留时间戳；
- CAM++ 区分说话人并匹配本地声纹档案；
- 用户修正说话人后自动注册确认片段，支持回滚；
- MCP 使用 `start_transcription → wait_transcription → read_transcript` 闭环，长录音不会阻塞一次工具调用；
- 完整全文保存在本地，ZCode 通过分页接口读取，不会丢失全文；
- 长录音每个分块成功后立即保存部分结果，失败或进程中断后可复用已完成的 ASR checkpoint；
- 完成后始终保存并返回 `transcript.txt` 全文文件，同时提供 JSON、Markdown、SRT/VTT（按配置）文件；
- 不上传录音，不内置摘要大模型，纪要和后续分析由 ZCode 完成；
- 转写结束后释放 SenseVoice，每次说话人分析或学习结束后立即释放 CAM++；
- ASR 与说话人分析独立缓存，缓存键包含模型和 runtime SHA；修改档案、匹配阈值或输出格式不会重复执行昂贵推理。

首次使用大约下载 284 MB 模型。模型只在首次转写时下载，默认数据目录由 ZCode 的 `${CLAUDE_PLUGIN_DATA}` 提供：

```text
${CLAUDE_PLUGIN_DATA}/
├── models/       # SenseVoice、FSMN-VAD、CAM++
├── runtimes/     # 旧版本运行时缓存（v0.3.0 通常不使用）
├── artifacts/    # 完整转写文件
├── tasks/        # 任务索引
├── cache/        # 分阶段 ASR / Speaker 缓存
├── learning/     # 可回滚的学习记录
└── profiles.json # 本地说话人档案
```

## 开发

开发构建需要 Node.js 22、npm，以及 Git、CMake 和平台 C/C++ 工具链。普通用户不需要单独安装 Node.js。

```bash
npm run test:voice-transcriber
npm run validate
npm run build:voice-plugin
npm run build:sensevoice -- --ref runtime-llamacpp-v0.1.9
npm run build:campp -- --ref 065629c313eaf1a01c65c640c46d77e61e9607b4
```

目录约定：

```text
plugins/   ZCode 插件
docs/      跨插件和架构文档
tools/     构建、校验和发布工具
packages/  未来插件共享包
```

Linux 暂不在当前发布范围内。

## 许可证

本仓库代码按 [Apache License 2.0](LICENSE) 发布。模型权重不随插件包分发；插件及随包运行时的第三方组件与模型来源说明见
[`plugins/voice-transcriber/THIRD_PARTY_NOTICES.md`](plugins/voice-transcriber/THIRD_PARTY_NOTICES.md)。
