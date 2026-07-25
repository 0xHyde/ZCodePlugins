# Runtime manifest

运行时 manifest 用于让插件在安装后按需下载平台二进制。它不包含模型，也不上传录音。

最小格式：

```json
{
  "version": "v0.2.0",
  "platforms": {
    "win32-x64": {
      "files": [
        {
          "name": "llama-funasr-sensevoice.exe",
          "url": "https://github.com/OWNER/REPO/releases/download/v0.2.0/win32-x64-llama-funasr-sensevoice.exe",
          "sha256": "...",
          "required": true
        },
        {
          "name": "campp-adapter.exe",
          "url": "https://github.com/OWNER/REPO/releases/download/v0.2.0/win32-x64-campp-adapter.exe",
          "sha256": "...",
          "required": true
        },
        {
          "name": "onnxruntime.dll",
          "url": "https://github.com/OWNER/REPO/releases/download/v0.2.0/win32-x64-onnxruntime.dll",
          "sha256": "...",
          "required": true
        },
        {
          "name": "ffmpeg.exe",
          "url": "https://github.com/OWNER/REPO/releases/download/v0.2.0/win32-x64-ffmpeg.exe",
          "sha256": "...",
          "required": true
        }
      ]
    }
  }
}
```

插件只在本地找不到运行时且配置了 manifest 时下载，文件写入用户数据目录的 `runtimes/<platform>-<arch>/`，采用临时文件和 SHA256 校验，失败不会留下半成品。
