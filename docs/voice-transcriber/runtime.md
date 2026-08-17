# Runtime manifest

这是运行时 manifest 的格式说明。`v0.4.0-rc.1` 起，macOS arm64 和 Windows x64 的 runtime 已随插件包发布，正常安装不需要下载 runtime manifest；本文件只用于旧版本迁移、离线诊断或未来扩展其他平台。它不包含模型，也不上传录音。

最小格式：

```json
{
  "version": "v0.4.0-rc.1",
  "platforms": {
    "win32-x64": {
      "files": [
        {
          "name": "llama-funasr-sensevoice.exe",
          "url": "https://github.com/0xHyde/ZCodePlugins/releases/download/v0.4.0-rc.1/win32-x64-llama-funasr-sensevoice.exe",
          "sha256": "...",
          "required": true
        },
        {
          "name": "campp-adapter.exe",
          "url": "https://github.com/0xHyde/ZCodePlugins/releases/download/v0.4.0-rc.1/win32-x64-campp-adapter.exe",
          "sha256": "...",
          "required": true
        },
        {
          "name": "onnxruntime.dll",
          "url": "https://github.com/0xHyde/ZCodePlugins/releases/download/v0.4.0-rc.1/win32-x64-onnxruntime.dll",
          "sha256": "...",
          "required": true
        },
        {
          "name": "ffmpeg.exe",
          "url": "https://github.com/0xHyde/ZCodePlugins/releases/download/v0.4.0-rc.1/win32-x64-ffmpeg.exe",
          "sha256": "...",
          "required": true
        }
      ]
    }
  }
}
```

插件只在本地找不到运行时且配置了 manifest 时下载，文件写入用户数据目录的 `runtimes/<platform>-<arch>/`，采用临时文件和 SHA256 校验，失败不会留下半成品。
