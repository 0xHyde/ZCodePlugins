# Native CAM++ adapter notices

The adapter is built against the feature extraction implementation from
[modelscope/3D-Speaker](https://github.com/modelscope/3D-Speaker), licensed under
Apache License 2.0, and links the prebuilt ONNX Runtime library from Microsoft.

The build script downloads the Apache-2.0 3D-Speaker source and the MIT-licensed
nlohmann/json single header into a temporary build directory. These sources are
build dependencies and are not bundled into the plugin source tree.

The CAM++ model is a separate user-downloaded artifact. A release must publish
its exact model license and SHA256 in the GitHub Release manifest before enabling
automatic download.
