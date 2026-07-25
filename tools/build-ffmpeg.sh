#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
ffmpeg_ref="${ZCODE_FFMPEG_REF:-n7.1.1}"
ffmpeg_commit="${ZCODE_FFMPEG_COMMIT:-db69d06eeeab4f46da15030a80d539efb4503ca8}"
build_jobs="${ZCODE_BUILD_JOBS:-2}"
runtime_platform="${ZCODE_RUNTIME_PLATFORM:-}"
runtime_arch="${ZCODE_RUNTIME_ARCH:-}"

if [[ -z "$runtime_platform" ]]; then
  case "$(uname -s)" in
    Darwin) runtime_platform="darwin" ;;
    MINGW*|MSYS*) runtime_platform="win32" ;;
    *) echo "Unsupported FFmpeg release platform: $(uname -s)" >&2; exit 1 ;;
  esac
fi
if [[ -z "$runtime_arch" ]]; then
  case "$(uname -m)" in
    arm64|aarch64) runtime_arch="arm64" ;;
    x86_64) runtime_arch="x64" ;;
    *) echo "Unsupported FFmpeg release architecture: $(uname -m)" >&2; exit 1 ;;
  esac
fi
if [[ "$runtime_platform-$runtime_arch" != "darwin-arm64" && "$runtime_platform-$runtime_arch" != "win32-x64" ]]; then
  echo "Unsupported FFmpeg release target: $runtime_platform-$runtime_arch" >&2
  exit 1
fi

build_root="$(mktemp -d)"
trap 'rm -rf "$build_root"' EXIT
source_root="$build_root/ffmpeg"
output_root="$repo_root/plugins/voice-transcriber/bin/$runtime_platform/$runtime_arch"

git clone --depth 1 --branch "$ffmpeg_ref" https://github.com/FFmpeg/FFmpeg.git "$source_root"
cd "$source_root"
if [[ "$(git rev-parse HEAD)" != "$ffmpeg_commit" ]]; then
  echo "FFmpeg $ffmpeg_ref commit does not match $ffmpeg_commit" >&2
  exit 1
fi

configure_args=(
  --disable-autodetect
  --disable-everything
  --disable-doc
  --disable-debug
  --disable-network
  --disable-programs
  --disable-shared
  --enable-static
  --enable-small
  --enable-ffmpeg
  --enable-avcodec
  --enable-avformat
  --enable-avfilter
  --enable-swresample
  --enable-protocol=file
  --enable-demuxer=aac,amr,asf,flac,matroska,mov,mp3,ogg,wav
  --enable-decoder=aac,alac,amrnb,amrwb,flac,mp3,opus,vorbis,wmav1,wmav2,wmapro,pcm_u8,pcm_s8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f64le
  --enable-parser=aac,flac,mpegaudio,opus,vorbis
  --enable-encoder=pcm_s16le
  --enable-muxer=wav
  --enable-filter=aformat,aresample
)

if [[ "$runtime_platform" == "darwin" ]]; then
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"
  configure_args+=(
    --arch=arm64
    --extra-cflags=-mmacosx-version-min="$MACOSX_DEPLOYMENT_TARGET"
    --extra-ldflags=-mmacosx-version-min="$MACOSX_DEPLOYMENT_TARGET"
  )
else
  configure_args+=(
    --target-os=mingw32
    --arch=x86_64
    --disable-pthreads
    --enable-w32threads
  )
fi

./configure "${configure_args[@]}"
make -j"$build_jobs" ffmpeg

mkdir -p "$output_root"
if [[ "$runtime_platform" == "win32" ]]; then
  ffmpeg_binary="$output_root/ffmpeg.exe"
  cp ffmpeg.exe "$ffmpeg_binary"
  if objdump -p "$ffmpeg_binary" | grep -Eiq 'DLL Name: (libwinpthread|libgcc|libstdc)'; then
    echo "FFmpeg has an unexpected MinGW runtime dependency" >&2
    exit 1
  fi
else
  ffmpeg_binary="$output_root/ffmpeg"
  cp ffmpeg "$ffmpeg_binary"
  chmod 755 "$ffmpeg_binary"
fi
cp COPYING.LGPLv2.1 "$output_root/FFMPEG_LICENSE.txt"

"$ffmpeg_binary" -version >/dev/null
echo "Staged minimal FFmpeg $ffmpeg_ref at $output_root"
