# Model pack

模型文件不直接提交到 Git。插件会优先使用 ZCode 配置中的路径；未配置时自动查找：

```text
~/.zcode/voice-transcriber/models/
├── sense-voice-small-q8_0.gguf
└── cam++.onnx
```

推荐模型：

- `sense-voice-small-q8_0.gguf`
- `cam++.onnx`

其中 CAM++ ONNX 是由 native adapter 通过 ONNX Runtime 加载的 192 维说话人向量模型；adapter 进程按需启动，空闲后退出，不在未转写时常驻内存。当前构建脚本按平台下载 ONNX Runtime 和 3D-Speaker 的特征提取源码，最终插件只携带编译产物，不携带用户模型。

`fsmn-vad.gguf` 仅用于兼容其他 VAD runtime，不是 SenseVoice.cpp 的必需模型。

配置 GitHub Release 的 `model-manifest.json` 后，首次转写会自动下载缺失模型、校验 SHA256 并写入上述目录；下载失败不会留下半成品文件。也可以手动放入模型文件。插件运行时不上传录音。

这里的 GitHub 地址需要在最终发布前替换为项目方实际维护的 Release/Raw 地址；仓库不伪造默认下载源。模型权重必须先确认对应许可证允许再分发，不能因为代码仓库公开就默认可以打包或镜像。

manifest 最小格式：

```json
{
  "version": "2026.07.1",
  "baseUrl": "https://github.com/OWNER/REPO/releases/download/models-2026.07.1/",
  "files": [
    { "name": "sense-voice-small-q8_0.gguf", "sha256": "...", "required": true },
    { "name": "cam++.onnx", "sha256": "...", "required": false }
  ]
}
```
