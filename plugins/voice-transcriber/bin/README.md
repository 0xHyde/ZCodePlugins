# Platform runtimes

Release packages place `sense-voice-main`, `campp-adapter`, and the matching
ONNX Runtime dynamic library under `bin/<platform>/<arch>/`. Development builds
are generated with `npm run build:sensevoice` and `npm run build:campp`.

The repository intentionally does not commit platform binaries. CI or the
release packager must build and attach them for macOS arm64/x64 and Windows x64.
Linux is intentionally out of scope for the current release.
