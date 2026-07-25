# 模型管理

模型权重不提交到 Git，也不随插件 runtime 打包。插件支持两种方式：

1. 用户在 ZCode 配置中填写模型路径；
2. 配置一个 GitHub 模型 manifest，首次转写时按需下载。

默认目录：

```text
~/.zcode/voice-transcriber/models/
├── sense-voice-small-q8_0.gguf
└── cam++.onnx
```

SenseVoice 是必需模型。CAM++ 只在需要说话人识别、注册和自动匹配时使用，可以作为可选文件。

## Manifest 格式

完整示例见 [`model-manifest.example.json`](model-manifest.example.json)。最小格式如下：

```json
{
  "version": "models-v0.1.0",
  "baseUrl": "https://github.com/OWNER/REPO/releases/download/models-v0.1.0/",
  "files": [
    {
      "name": "sense-voice-small-q8_0.gguf",
      "url": "https://github.com/OWNER/REPO/releases/download/models-v0.1.0/models-sense-voice-small-q8_0.gguf",
      "sha256": "64 位十六进制 SHA256",
      "size": 123456789,
      "required": true
    },
    {
      "name": "cam++.onnx",
      "url": "https://github.com/OWNER/REPO/releases/download/models-v0.1.0/models-cam%2B%2B.onnx",
      "sha256": "64 位十六进制 SHA256",
      "size": 123456789,
      "required": false
    }
  ]
}
```

下载器会检查：

- manifest 和模型 URL 必须是 GitHub HTTPS 地址
- 文件名只能是当前目录文件名，禁止路径穿越
- 下载后的文件大小和 SHA256 必须匹配
- 下载使用临时文件，失败不会留下半成品
- 已安装且版本、SHA256 一致的模型不会重复下载

## 生成清单

模型文件准备好后，在本地模型目录执行：

```bash
node tools/create-model-manifest.mjs \
  --input /path/to/model-assets \
  --version models-v0.1.0 \
  --repository OWNER/REPO \
  --asset-prefix models- \
  --optional cam++.onnx \
  --output model-manifest.json
```

然后将带 `models-` 前缀的模型资产和 `model-manifest.json` 一起上传到对应 GitHub Release，并在 ZCode 中配置：

```text
ZCODE_VOICE_MODEL_MANIFEST_URL=https://github.com/OWNER/REPO/releases/download/models-v0.1.0/model-manifest.json
```

目前项目没有预置模型下载源。原因是模型权重的来源、许可证和长期托管地址必须先确认，不能仅凭代码仓库公开就自动再分发。

## Runtime manifest

运行时清单和模型清单分开：runtime manifest 管理可执行文件和动态库，model manifest 管理模型权重。当前正式 runtime manifest：

```text
https://github.com/0xHyde/ZCodePlugins/releases/download/v0.1.0/runtime-manifest.json
```
