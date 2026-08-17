# Platform runtimes

The published plugin includes `llama-funasr-sensevoice`, `campp-adapter`, ffmpeg,
and the matching ONNX Runtime library under `bin/<platform>/<arch>/`.

Models are intentionally not included here. They are downloaded on the first
transcription and stored under the ZCode plugin data directory.

The repository marketplace installs this plugin directory directly, so the
tracked macOS arm64 and Windows x64 runtime files must be rebuilt, tested, and
synced before a release tag is created. Release CI independently rebuilds both
platforms again, replaces the runtime files in the final ZIP, and verifies every
file against the manifest produced by that build. macOS x64 and Linux are
intentionally out of scope for the current release.
