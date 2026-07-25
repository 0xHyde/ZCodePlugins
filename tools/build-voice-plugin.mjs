import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../plugins/voice-transcriber/node_modules/esbuild/lib/main.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "voice-transcriber");
const outputDir = path.join(pluginRoot, "dist", "mcp");

await fs.mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(pluginRoot, "scripts", "mcp-server.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: path.join(outputDir, "server.js"),
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
  packages: "bundle",
  logLevel: "info",
});
await fs.chmod(path.join(outputDir, "server.js"), 0o755);
console.log(`built ${path.relative(root, path.join(outputDir, "server.js"))}`);
