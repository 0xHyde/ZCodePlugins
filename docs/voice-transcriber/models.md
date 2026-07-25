# 模型管理

模型权重不提交到 Git，也不随插件 runtime 打包。插件支持三类来源：GitHub、ModelScope 和 Hugging Face。当前默认清单由 GitHub 仓库托管，模型文件优先从官方 ModelScope/Hugging Face 下载，必要时可以配置 GitHub Release 镜像。

插件支持两种使用方式：

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
      "url": "https://www.modelscope.cn/models/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/master/sensevoice-small-q8.gguf",
      "urls": [
        "https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/main/sensevoice-small-q8.gguf?download=true"
      ],
      "sha256": "64 位十六进制 SHA256",
      "size": 123456789,
      "required": true
    },
    {
      "name": "cam++.onnx",
      "url": "https://www.modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/campplus.onnx",
      "urls": [
        "https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/campplus.onnx?download=true"
      ],
      "sha256": "64 位十六进制 SHA256",
      "size": 123456789,
      "required": false
    }
  ]
}
```

下载器会检查：

- manifest 和模型 URL 必须是 GitHub、ModelScope 或 Hugging Face HTTPS 地址
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

如果使用 GitHub 镜像，将带 `models-` 前缀的模型资产和 `model-manifest.json` 一起上传到对应 GitHub Release；也可以直接使用仓库内的默认清单：

```text
ZCODE_VOICE_MODEL_MANIFEST_URL=https://raw.githubusercontent.com/0xHyde/ZCodePlugins/main/model-manifest.json
```

默认清单已经接入官方来源；下载时仍会校验 SHA256 和文件大小。模型卡片和许可证以各上游仓库为准，项目不重新分发模型权利。SenseVoice、FSMN-VAD 和 CAM++ 的来源记录在仓库根目录 [`model-manifest.json`](../../model-manifest.json)。

## Runtime manifest

运行时清单和模型清单分开：runtime manifest 管理可执行文件和动态库，model manifest 管理模型权重。当前正式 runtime manifest：

```text
https://github.com/0xHyde/ZCodePlugins/releases/download/v0.1.0/runtime-manifest.json
```
