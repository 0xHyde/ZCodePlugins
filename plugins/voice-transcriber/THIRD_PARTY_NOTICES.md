# Third-party notices

`voice-transcriber` is distributed under Apache License 2.0. The published
plugin ZIP also contains third-party software. This file records the components
that are bundled directly or compiled into the release. It does not replace the
license files shipped beside each native runtime.

Copyright (c) 2026 0xHyde for the `voice-transcriber` project and its original
source and documentation.

## Native runtime

| Component | Release input | License | Packaged notice |
| --- | --- | --- | --- |
| QwenAudio SenseVoice runtime | `QwenAudio/SenseVoice`, tag `runtime-llamacpp-v0.1.9`, commit `73ccdd3577db37e92dbf22a4a9fc323b038cf13b` | MIT | `SENSEVOICE_LICENSE.txt` |
| llama.cpp / GGML runtime code | `ggml-org/llama.cpp`, commit `8086439a4cea94c71a5dfb8fe4ad1546aebd640f`, pinned by the SenseVoice CMake build | MIT | `LLAMA_CPP_LICENSE.txt` |
| 3D-Speaker CAM++ feature/runtime code | `modelscope/3D-Speaker`, commit `065629c313eaf1a01c65c640c46d77e61e9607b4` | Apache-2.0 | `3D_SPEAKER_LICENSE.txt` |
| ONNX Runtime | v1.12.0 official CPU package | MIT plus upstream third-party terms | `ORT_LICENSE.txt`, `ORT_THIRD_PARTY_NOTICES.txt` |
| JSON for Modern C++ | nlohmann/json v3.11.3 single header | MIT | `NLOHMANN_JSON_LICENSE.txt` |
| FFmpeg | n7.1.1, commit `db69d06eeeab4f46da15030a80d539efb4503ca8`, minimal LGPL configuration | LGPL-2.1-or-later | `FFMPEG_LICENSE.txt`; corresponding source archive is a GitHub Release asset |

The release build pins source revisions and archive SHA-256 values. Each
platform runtime manifest records the SHA-256 of the files actually packaged.
The macOS SenseVoice build keeps Accelerate/BLAS enabled but selects Apple's
legacy LP64 interface when targeting macOS 12, because the pinned llama.cpp
revision otherwise opts into the newer macOS 13.3 LAPACK interface.

## Models downloaded after installation

Model weights are not part of the plugin ZIP or this repository. The immutable
release `model-manifest.json` records each model's source, size, SHA-256 and
declared license. The current official FunAudioLLM SenseVoiceSmall GGUF,
FSMN-VAD GGUF and CAM++ ONNX model pages declare Apache-2.0. Re-check the model
cards and update this notice whenever a manifest source or checksum changes.

## JavaScript bundled into `dist/mcp/server.js`

The following packages are bundled into the single MCP entry file by esbuild:

| Package | Version | License |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-uri` | 3.1.4 | BSD-3-Clause |
| `json-schema-traverse` | 1.0.0 | MIT |
| `zod` | 4.4.3 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |

### MIT-licensed JavaScript notices

Copyright (c) 2024 Anthropic, PBC

Copyright (c) 2015-2021 Evgeny Poberezkin (`ajv`)

Copyright (c) 2020 Evgeny Poberezkin (`ajv-formats`)

Copyright (c) 2017 Evgeny Poberezkin (`fast-deep-equal` and
`json-schema-traverse`)

Copyright (c) 2025 Colin McDonnell (`zod`)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### `fast-uri` BSD-3-Clause notice

Copyright (c) 2011-2021, Gary Court until
https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae

Copyright (c) 2021-present The Fastify team
<https://github.com/fastify/fastify#team>

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. The names of any contributors may not be used to endorse or promote
   products derived from this software without specific prior written
   permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

### `zod-to-json-schema` ISC notice

Copyright (c) 2020, Stefan Terdell

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
