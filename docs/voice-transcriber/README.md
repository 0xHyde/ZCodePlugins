# voice-transcriber 文档

`voice-transcriber` 是一个本地 MCP 插件，附带可选的 ZCode 使用提示。当前发布候选版本为 `v0.4.0-rc.1`，支持 Windows x64 和 macOS arm64：插件包内带推理 runtime，模型仍在首次使用时按需下载。

用户只需要把录音文件交给 ZCode。MCP 自己承担 `start → wait → read` 异步闭环、全文产物、说话人修正和本地档案；Skill 不承担状态机，只用于帮助旧版 ZCode 选择正确工具。录音、模型、任务状态和说话人档案都留在本机。

- [`models.md`](models.md)：模型选择、来源和下载策略
- [`native-runtime.md`](native-runtime.md)：本地 runtime、性能与资源生命周期
- [`runtime.md`](runtime.md)：runtime 打包方式与旧版 manifest 兼容说明
- [`release.md`](release.md)：发布资产和验收要求
- [`implementation-v0.4.md`](implementation-v0.4.md)：v0.4 架构、三模型分工、里程碑和上线门槛

用户侧的简明安装说明见插件目录的 [`README.md`](../../plugins/voice-transcriber/README.md)。
