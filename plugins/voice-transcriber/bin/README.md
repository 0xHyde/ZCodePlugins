# Platform runtimes

The published plugin includes `llama-funasr-sensevoice`, `campp-adapter`, ffmpeg,
and the matching ONNX Runtime library under `bin/<platform>/<arch>/`.

Models are intentionally not included here. They are downloaded on the first
transcription and stored under the ZCode plugin data directory.

The repository intentionally does not commit platform binaries. CI or the
release packager must build and attach them for macOS arm64/x64 and Windows x64.
Linux is intentionally out of scope for the current release.
