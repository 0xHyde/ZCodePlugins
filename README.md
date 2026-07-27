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

当前修复版本：v0.3.3（Windows 长录音低内存修复）

## voice-transcriber

面向会议、访谈和调研录音：

- SenseVoiceSmall Q8 本地转写，支持 MP3、M4A、WAV 等常见格式；
- FSMN-VAD 自动分段并保留时间戳；
- CAM++ 区分说话人并匹配本地声纹档案；
- 用户修正说话人后自动注册确认片段，支持回滚；
- MCP 使用异步任务，长录音不会阻塞一次工具调用；
- 完整全文保存在本地，ZCode 通过分页接口读取，不会丢失全文；
- 长录音每个分块成功后立即保存部分结果，低内存失败时仍可读取已完成内容；
- 不上传录音，不内置摘要大模型，纪要和后续分析由 ZCode 完成；
- 转写结束后释放 SenseVoice，CAM++ 空闲 30 秒后退出。

首次使用大约下载 284 MB 模型。模型只在首次转写时下载，默认数据目录由 ZCode 的 `${ZCODE_PLUGIN_DATA}` 提供：

```text
${ZCODE_PLUGIN_DATA}/
├── models/       # SenseVoice、FSMN-VAD、CAM++
├── runtimes/     # 旧版本运行时缓存（v0.3.0 通常不使用）
├── artifacts/    # 完整转写文件
├── tasks/        # 任务索引
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
