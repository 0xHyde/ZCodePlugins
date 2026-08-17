---
name: voice-transcription
description: Use the local voice-transcriber MCP for meeting, interview, research, or other audio/video transcription requests. Use when the user provides a local recording or asks to transcribe audio, identify speakers, correct speaker names, register confirmed speaker samples, read a full transcript, or search a completed transcript.
---

# Local voice transcription

Use the plugin MCP tools to complete the workflow. Do not ask the user to install Python, configure model paths, or understand internal task states unless the tool returns an actionable failure.

## Transcribe

1. Call `start_transcription` with the absolute local audio/video path. Enable speaker matching unless the user explicitly asks for transcription only.
2. If the result is not `completed`, call `wait_transcription` with the returned `taskId`. If it times out while still progressing, call it again; use `get_transcription_status` only when an immediate non-waiting snapshot is needed.
3. If waiting returns `interrupted`, call `start_transcription` once more with the same audio path and options, then continue waiting. The stable task ID and local ASR checkpoint resume completed chunks; do not ask the user to repair the task manually.
4. When completed, use `read_transcript` to retrieve the full transcript in pages if it is long. Preserve timestamps and speaker names when producing notes, summaries, minutes, or action items.
5. The MCP stores the complete transcript locally. Do not claim that the full transcript was lost merely because the first response contains a preview.

## Speaker corrections and learning

- If the user gives a corrected speaker name, call `correct_speaker` with the task ID and affected segment IDs.
- Keep `autoLearn` enabled unless the user asks not to learn. Confirmed meeting segments are the speaker sample; do not invent a voice embedding or register an unconfirmed label.
- Use `list_speakers` when the user asks which speakers are registered. Use `rollback_speaker_learning` only when the user explicitly asks to undo a learning change.

## Failures

Read the returned `code`, `stage`, and `message`. Explain the concrete remedy. Retry a failed model download once when the tool marks it retryable; do not repeatedly resubmit the complete audio task. Never upload the recording or use a cloud transcription service.
