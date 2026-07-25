import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = path.join(root, "plugins", "voice-transcriber", "scripts", "voice-engine.mjs");
const audioPath = process.argv[2];
const repeats = Math.max(1, Number(process.env.ZCODE_BENCHMARK_REPEATS || 3));

if (!audioPath || !path.isAbsolute(audioPath)) {
  console.error("用法：npm run bench:voice-transcriber -- /absolute/path/to/audio.wav");
  process.exitCode = 2;
} else {
  const stat = await fs.stat(audioPath).catch(() => null);
  if (!stat?.isFile()) {
    console.error(`找不到音频文件：${audioPath}`);
    process.exitCode = 2;
  } else {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-voice-bench-"));
    const child = spawn(process.execPath, [engine, "--stdio"], {
      cwd: root,
      env: { ...process.env, ZCODE_VOICE_DATA_DIR: dataRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    let nextId = 1;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });

    const call = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

    try {
      const samples = [];
      for (let index = 0; index < repeats + 1; index += 1) {
        const started = performance.now();
        const result = await call("transcribe", { audioPath, outputFormat: "json" });
        samples.push({
          run: index + 1,
          kind: index === 0 ? "cold" : "cache",
          elapsedMs: Math.round((performance.now() - started) * 100) / 100,
          cacheHit: Boolean(result.cacheHit),
          taskId: result.taskId,
        });
      }
      console.log(JSON.stringify({
        audioPath,
        audioBytes: stat.size,
        repeats,
        samples,
        stderr: stderr.trim() || undefined,
      }, null, 2));
    } catch (error) {
      console.error(error.message);
      if (stderr.trim()) console.error(stderr.trim());
      process.exitCode = 1;
    } finally {
      child.kill();
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  }
}
