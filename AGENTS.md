# ZCodePlugins workspace rules

- Keep each ZCode plugin self-contained under `plugins/<name>/`; shared build
  and validation utilities belong under `tools/`.
- `marketplace.json`, `.zcode-plugin/plugin.json`, plugin `package.json` and
  plugin `package-lock.json` must carry the same release version.
- A plugin that declares a license must include its own `LICENSE` because the
  plugin ZIP is distributed independently from the repository root.
- Treat `dist/` as generated output. Rebuild it from source before validation
  and release; do not hand-edit bundled files.
- Do not commit model weights or `node_modules`. Platform runtime binaries may
  be committed only in the explicitly supported `bin/<platform>/<arch>` paths.
- Because Marketplace entries currently use repository-relative plugin paths,
  sync tested macOS ARM64 and Windows x64 runtime artifacts into those tracked
  paths before creating a release tag.
- A voice-transcriber release ZIP must contain the current build's macOS ARM64
  and Windows x64 runtime, runtime license files, and MCP dist; it must not
  contain models or `node_modules`.
- Before handoff, run `npm test`, `npm run build`, `npm run validate`, the native
  clustering test, and a built MCP smoke test. Do not publish until the final
  platform ZIPs have passed their required real-machine checks.
