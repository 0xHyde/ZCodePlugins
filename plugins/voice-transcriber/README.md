# voice-transcriber

ZCode 本地录音转写与说话人学习插件。

设计、模型和发布说明见根目录 [`docs/voice-transcriber/`](../../docs/voice-transcriber/)。

当前已完成：

- 使用 ZCode 原生 `.zcode-plugin/plugin.json` 清单
- ZCode MCP stdio 服务注册
- 转写、说话人修正、无感注册、任务查询、声纹学习回滚工具契约
- 本地任务和说话人元数据存储
- native voice-engine sidecar 协议
- 可直接启动的 Node.js 开发版 voice-engine
- SenseVoice.cpp 命令适配，支持时间戳输出
- 文件哈希任务缓存和缓存命中
- 单一 `transcribe_audio` MCP 入口，内部自动处理状态、读取、搜索和无感学习
- 发布版首次转写时按项目 GitHub Release manifest 自动下载模型，并校验 SHA256
- CAM++ JSONL adapter 协议、已确认片段注册、自动匹配和可回滚学习
- CAM++ 原生 ONNX Runtime adapter 构建脚本，macOS arm64 已完成真实构建和端到端验证
- Windows x64 原生 runtime 已由 GitHub Actions 成功编译、验证并打包
- 可选的 GitHub Release runtime manifest；缺少平台二进制时按需下载并校验 SHA256
- 可供 ZCode Agent 消费的 JSON/Markdown 转写产物、分页读取和本地搜索

仍需完成的发布工作：

- 创建第一个正式 GitHub Release，并配置 runtime/model manifest
- 在 Windows 上使用真实模型和会议音频完成端到端验收；Linux 暂不纳入当前发布范围
- 在常见 CPU / 内存档位上补齐端到端性能基准
- 完成 ffmpeg 依赖发现、代码签名和 Marketplace 安装验收

## 本地运行

ZCode 启用插件后会通过 `.mcp.json` 启动：

```text
node scripts/mcp-server.mjs
```

开发版默认使用插件内的 Node.js sidecar。正式 native sidecar 可以通过 `ZCODE_VOICE_ENGINE` 指定，例如：

```text
ZCODE_VOICE_ENGINE=/absolute/path/to/voice-engine
```

SenseVoice.cpp 后端配置：

```text
ZCODE_SENSEVOICE_BINARY=sense-voice-main
ZCODE_SENSEVOICE_MODEL=/absolute/path/to/sense-voice-small-q8_0.gguf
ZCODE_AUDIO_CONVERTER=ffmpeg
ZCODE_CAMPP_MODEL=/absolute/path/to/campp.onnx
ZCODE_CAMPP_COMMAND=/absolute/path/to/campp-adapter
ZCODE_CAMPP_ARGS='["--model","/absolute/path/to/campp.onnx"]'
ZCODE_VOICE_MODEL_MANIFEST_URL=https://raw.githubusercontent.com/OWNER/REPO/main/model-manifest.json
ZCODE_VOICE_RUNTIME_MANIFEST_URL=https://raw.githubusercontent.com/OWNER/REPO/main/runtime-manifest.json
```

SenseVoice.cpp 自带 Silero-VAD；默认使用最多 4 个线程，可通过 `ZCODE_VOICE_THREADS` 调整。CAM++ adapter 默认空闲 30 秒后自动关闭，可通过 `ZCODE_CAMPP_IDLE_MS` 调整。

也可以在 ZCode 插件配置中填写“模型下载 manifest”。插件安装后不主动占用网络；第一次真正转写时才下载缺失模型。下载地址必须是项目方提供的 GitHub Release 或 raw 文件地址，模型授权和发布由项目方负责。

运行时 manifest 同样是可选配置。只有找不到本地或插件内的 SenseVoice/CAM++ runtime 时，插件才会下载当前平台文件到本地数据目录；下载后会校验 SHA256，闲置时 CAM++ 进程仍会自动释放。

CAM++ adapter 接入前，转写仍可运行，但会明确标记说话人识别未配置；不会生成伪造声纹。摘要、会议纪要和调研分析由 ZCode Agent 完成，本插件不内置摘要大模型。

构建当前平台的 CAM++ native adapter：

```text
npm run build:campp
```

构建过程会临时下载 3D-Speaker、ONNX Runtime 和 nlohmann/json，模型文件仍由用户通过 GitHub Release manifest 下载。

在 native sidecar 尚未安装时，MCP 工具会返回明确的运行时缺失错误；工具列表和插件加载不依赖模型文件。

## ZCode 组件

- `/transcribe-audio <audio-file>`：转写本地录音
- `voice-transcriber` MCP：提供转写、修正、注册、查询和回滚
- `voice-transcription` Skill：指导 Agent 使用本地引擎和增量学习

## 数据位置

默认位于：

```text
~/.zcode/voice-transcriber/
```

可通过 `ZCODE_VOICE_DATA_DIR` 覆盖。声纹向量正式接入后需要改为加密存储。

## 性能基准

对真实本地音频运行：

```text
npm run bench:voice-transcriber -- /absolute/path/to/meeting.wav
```

基准工具会用临时数据目录测量首次推理和缓存命中耗时，不会覆盖正式的本地档案。
