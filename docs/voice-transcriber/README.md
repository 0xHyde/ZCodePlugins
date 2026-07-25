# voice-transcriber 文档

这里集中放置不参与 ZCode 插件加载的设计、模型、运行时和发布资料。

- [native runtime 与 CAM++ adapter](native-runtime.md)
- [模型清单与管理](models.md)
- [跨平台发布布局](release.md)

## 发布状态

当前 `v0.1.0` 已发布 Windows x64 与 macOS arm64 runtime。MCP 工具、任务缓存、说话人修正、无感注册、自动匹配和回滚已经具备；真实模型端到端质量/性能验收、模型下载源、代码签名和声纹数据保护仍需继续完善。

插件只负责本地音频理解。会议摘要、纪要、行动项和调研分析由 ZCode Agent 使用转写产物完成，不在插件内重复引入大模型。
