import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRuntimeCommand } from "./runtime.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function isSenseVoiceWav(audioPath) {
  const handle = await fs.open(audioPath, "r").catch(() => null);
  if (!handle) return false;
  try {
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 12 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") return false;
    let offset = 12;
    while (offset + 8 <= bytesRead) {
      const chunk = header.toString("ascii", offset, offset + 4);
      const size = header.readUInt32LE(offset + 4);
      if (chunk === "fmt " && offset + 8 + size <= bytesRead && size >= 16) {
        const format = header.readUInt16LE(offset + 8);
        const channels = header.readUInt16LE(offset + 10);
        const sampleRate = header.readUInt32LE(offset + 12);
        const bits = header.readUInt16LE(offset + 22);
        return format === 1 && channels === 1 && sampleRate === 16000 && bits === 16;
      }
      offset += 8 + size + (size % 2);
    }
    return false;
  } finally {
    await handle.close();
  }
}

function runConverter(command, input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "-y",
      output,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once("error", (error) => reject(fail(`音频转换器无法启动：${error.message}`, "audio_converter_not_found")));
    child.once("close", (code, signal) => {
      if (code !== 0) reject(fail(`音频转换失败 (code=${code}, signal=${signal})${stderr ? `：${stderr.trim()}` : ""}`, "audio_conversion_failed"));
      else resolve();
    });
  });
}

export async function prepareAudio({ audioPath, dataRoot, taskId, converter = process.env.ZCODE_AUDIO_CONVERTER } = {}) {
  if (await isSenseVoiceWav(audioPath)) return { path: audioPath, converted: false, cleanup: async () => {} };
  const runtime = await resolveRuntimeCommand({
    pluginRoot,
    dataRoot,
    configured: converter,
    defaultName: "ffmpeg",
  });
  if (!runtime.exists) throw fail("当前录音不是官方 SenseVoice runtime 可直接处理的 16kHz 单声道 WAV，且找不到本地 ffmpeg。请安装 ffmpeg 或将其放入插件 bin/<platform>/<arch>/。", "audio_converter_not_found");

  const directory = path.join(dataRoot || os.tmpdir(), "tmp-audio");
  await fs.mkdir(directory, { recursive: true });
  const stem = `${taskId || "audio"}-${process.pid}-${Date.now()}`;
  const output = path.join(directory, `${stem}.wav`);
  try {
    await runConverter(runtime.command, audioPath, output);
    const valid = await isSenseVoiceWav(output);
    if (!valid) throw fail("音频转换器没有生成有效的 16kHz 单声道 WAV。", "audio_conversion_failed");
    return {
      path: output,
      converted: true,
      cleanup: async () => { await fs.rm(output, { force: true }); },
    };
  } catch (error) {
    await fs.rm(output, { force: true });
    throw error;
  }
}
