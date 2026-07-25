---
name: voice-transcription
description: 将本地录音转换为带时间戳和说话人的文字；支持从会议中的修正片段无感注册和增量更新说话人声纹。适用于录音、采访、会议、课程和字幕生成。
---

# 本地语音转写

当用户提供本地录音或视频并要求转写、整理、查找内容时，调用 `voice-transcriber` MCP。

- 插件只负责本地转写、时间戳和说话人识别；摘要、纪要和分析由 ZCode Agent 完成。
- 短录音直接使用返回的全文；长录音自动按片段读取，不要求用户手工分段。
- 用户修正说话人时自动把确认片段作为学习样本；如果用户明确说“不用记住”，再设置 `autoLearn=false`。
- 全程处理本地文件，不上传录音；不要向用户展示 taskId 或内部工具流程，除非用户主动询问。

内部操作统一通过同一个 `transcribe_audio` 工具完成：长文使用 `operation=read`，定位内容使用 `operation=search`，修正使用 `operation=correct_speaker`。修正默认自动学习，不需要再次调用记住说话人的操作；默认转写时不填写 operation。
