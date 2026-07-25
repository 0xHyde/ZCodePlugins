# voice-transcriber 文档

`voice-transcriber` 是一个带 ZCode Skill 的本地 MCP 插件。`v0.3.0` 支持 Windows x64 和 macOS arm64：插件包内带推理 runtime，模型仍在首次使用时按需下载。

用户只需要把录音文件交给 ZCode。Skill 会自动调用异步任务接口、等待完成并按页读取全文；需要时再处理说话人修正和无感注册。录音、模型、任务状态和说话人档案都留在本机。

- [`models.md`](models.md)：模型选择、来源和下载策略
- [`native-runtime.md`](native-runtime.md)：本地 runtime、性能与资源生命周期
- [`runtime.md`](runtime.md)：runtime 打包方式与旧版 manifest 兼容说明
- [`release.md`](release.md)：发布资产和验收要求

用户侧的简明安装说明见插件目录的 [`README.md`](../../plugins/voice-transcriber/README.md)。
