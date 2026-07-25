# 模型管理

模型权重不提交到 Git，也不随插件 runtime 打包。插件支持三类来源：GitHub、ModelScope 和 Hugging Face。当前默认清单由 GitHub 仓库托管，模型文件优先从官方 ModelScope/Hugging Face 下载，必要时可以配置 GitHub Release 镜像。

插件支持两种使用方式：

1. 用户在 ZCode 配置中填写模型路径；
2. 配置一个 GitHub 模型 manifest，首次转写时按需下载。

默认目录由 ZCode 通过 `${ZCODE_PLUGIN_DATA}` 注入：

```text
${ZCODE_PLUGIN_DATA}/models/
├── sense-voice-small-q8_0.gguf
├── fsmn-vad.gguf
└── cam++.onnx
```

SenseVoice 和 FSMN-VAD 是必需模型。CAM++ 用于说话人识别、注册和自动匹配；它下载失败时不会阻塞纯转写。

## Manifest 格式

完整示例见 [`model-manifest.example.json`](model-manifest.example.json)。最小格式如下：

```json
{
  "version": "models-v0.3.0",
  "baseUrl": "https://github.com/OWNER/REPO/releases/download/models-v0.3.0/",
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
  --version models-v0.3.0 \
  --repository OWNER/REPO \
  --asset-prefix models- \
  --optional cam++.onnx \
  --output model-manifest.json
```

如果使用 GitHub 镜像，将带 `models-` 前缀的模型资产和 `model-manifest.json` 一起上传到对应 GitHub Release；也可以直接使用仓库内的默认清单：

```text
ZCODE_VOICE_MODEL_MANIFEST_URL=https://github.com/0xHyde/ZCodePlugins/releases/download/v0.3.0/model-manifest.json
```

默认清单已经接入 FunAudioLLM 官方来源；三个模型均标记为 Apache-2.0。下载时仍会校验 SHA256 和文件大小，项目只发布清单，不重新托管模型权重。SenseVoice、FSMN-VAD 和 CAM++ 的来源记录在仓库根目录 [`model-manifest.json`](../../model-manifest.json)。

## Runtime

从 `v0.3.0` 起，macOS arm64 和 Windows x64 的 runtime 随插件包发布，安装后无需再下载可执行文件；模型仍由上面的 model manifest 懒加载。仓库保留 runtime manifest 代码用于旧版迁移和发布诊断，但新安装不依赖它。
