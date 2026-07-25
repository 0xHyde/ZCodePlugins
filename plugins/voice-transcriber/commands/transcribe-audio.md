---
name: transcribe-audio
description: 使用本地引擎将录音转成带说话人和时间戳的文字
argument-hint: <audio-file>
---

调用 `voice-transcriber` 的 `transcribe_audio` 工具处理 `$ARGUMENTS`。

全程本地处理，自动识别说话人并使用已有档案匹配。将结果交给当前 ZCode 任务继续处理，不要要求用户手工处理中间任务 ID。
