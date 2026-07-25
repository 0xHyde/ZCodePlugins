# Workspace tools

- `validate-plugins.mjs`：校验 marketplace、插件清单和组件 frontmatter。
- `benchmark-voice-engine.mjs`：使用临时数据目录测量 voice-transcriber 首次推理与缓存命中耗时。
- `create-model-manifest.mjs`：从本地模型目录生成带 SHA256 和文件大小的模型清单。
- `create-runtime-manifest.mjs`：从平台 runtime 目录生成运行时清单。
- `merge-runtime-manifests.mjs`：合并 Windows 和 macOS 的平台运行时清单。
