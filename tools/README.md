# Workspace tools

- `validate-plugins.mjs`：校验 marketplace、插件清单、版本和 Release manifest 地址。
- `benchmark-voice-engine.mjs`：使用临时数据目录测量 voice-transcriber 首次推理与缓存命中耗时。
- `speaker-diarization-metrics.mjs`：将转写 JSON 与 RTTM 标注对比，输出最优说话人映射后的 DER、JER、人数误差和错误时长；运行 `npm run eval:voice-diarization -- --reference reference.rttm --hypothesis transcript.json`。
- `create-model-manifest.mjs`：从本地模型目录生成带 SHA256 和文件大小的模型清单。
- `create-runtime-manifest.mjs`：从平台 runtime 目录生成运行时清单。
- `merge-runtime-manifests.mjs`：合并 Windows 和 macOS 的平台运行时清单。
- `verify-runtime-tree.mjs`：按 runtime manifest 校验最终插件目录中的平台文件 SHA。
- `build-ffmpeg.sh`：从官方源码构建仅包含常用音频解码和 WAV 输出的最小 LGPL FFmpeg。
- `build-sensevoice.mjs`：构建 QwenAudio 官方 SenseVoice llama.cpp runtime。
- `build-campp.mjs`：构建 CAM++ ONNX Runtime adapter。
