import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs() {
  const configured = process.env.ZCODE_VOICE_ENGINE_ARGS;
  if (!configured) return [];
  const value = JSON.parse(configured);
  if (!Array.isArray(value)) throw new Error("ZCODE_VOICE_ENGINE_ARGS must be a JSON array");
  return value.map(String);
}

export class SidecarClient {
  constructor({ packageRoot: configuredRoot } = {}) {
    this.pluginRoot = configuredRoot || pluginRoot;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.bufferedError = "";
  }

  start() {
    if (this.child) return;
    const customCommand = process.env.ZCODE_VOICE_ENGINE;
    const command = customCommand || process.execPath;
    const args = parseArgs();
    const engineArgs = customCommand
      ? ["--stdio", ...args]
      : [path.join(this.pluginRoot, "scripts", "voice-engine.mjs"), "--stdio", ...args];
    this.child = spawn(command, engineArgs, {
      cwd: this.pluginRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.bufferedError += chunk.toString();
      if (this.bufferedError.length > 8000) {
        this.bufferedError = this.bufferedError.slice(-8000);
      }
    });
    this.child.on("error", (error) => this.#failAll(error));
    this.child.on("exit", (code, signal) => {
      const message = `voice-engine exited (code=${code}, signal=${signal})` +
        (this.bufferedError ? `: ${this.bufferedError.trim()}` : "");
      this.#failAll(new Error(message));
      this.child = null;
    });
  }

  call(method, params) {
    this.start();
    const id = this.nextId++;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(request, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  close() {
    if (this.child) this.child.kill();
    this.child = null;
    this.#failAll(new Error("voice-engine closed"));
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message || "voice-engine error");
      error.code = message.error.code || "voice_engine_error";
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  #failAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
