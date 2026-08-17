import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const verifier = path.join(workspaceRoot, "tools", "verify-runtime-tree.mjs");
const releaseWorkflow = path.join(workspaceRoot, ".github", "workflows", "release-voice-transcriber.yml");
const senseVoiceBuilder = path.join(workspaceRoot, "tools", "build-sensevoice.mjs");
const camppBuilder = path.join(workspaceRoot, "tools", "build-campp.mjs");
const runtimeBuildWorkflows = [
  path.join(workspaceRoot, ".github", "workflows", "build-windows.yml"),
  path.join(workspaceRoot, ".github", "workflows", "build-macos.yml"),
];

test("release runtime verifier accepts exact files and rejects stale packaged binaries", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-release-verify-"));
  const runtimeDir = path.join(directory, "bin", "darwin", "arm64");
  const runtime = path.join(runtimeDir, "campp-adapter");
  const windowsRuntimeDir = path.join(directory, "bin", "win32", "x64");
  const windowsRuntime = path.join(windowsRuntimeDir, "campp-adapter.exe");
  const manifestFile = path.join(directory, "runtime-manifest.json");
  const payload = Buffer.from("new runtime from this build");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(windowsRuntimeDir, { recursive: true });
  await fs.writeFile(runtime, payload);
  await fs.writeFile(windowsRuntime, payload);
  await fs.writeFile(manifestFile, JSON.stringify({
    version: "test",
    platforms: {
      "darwin-arm64": {
        files: [{
          name: "campp-adapter",
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        }],
      },
      "win32-x64": {
        files: [{
          name: "campp-adapter.exe",
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        }],
      },
    },
  }));
  try {
    const valid = spawnSync(process.execPath, [verifier, "--root", path.join(directory, "bin"), "--manifest", manifestFile], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    const extra = path.join(runtimeDir, "old-runtime");
    await fs.writeFile(extra, "left over from the repository");
    const unexpected = spawnSync(process.execPath, [verifier, "--root", path.join(directory, "bin"), "--manifest", manifestFile], { encoding: "utf8" });
    assert.notEqual(unexpected.status, 0);
    assert.match(unexpected.stderr, /manifest 之外/);
    await fs.rm(extra);
    await fs.writeFile(runtime, "stale runtime from repository");
    const stale = spawnSync(process.execPath, [verifier, "--root", path.join(directory, "bin"), "--manifest", manifestFile], { encoding: "utf8" });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /SHA 不匹配/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("release workflow treats semantic prerelease tags as GitHub prereleases", async () => {
  const workflow = await fs.readFile(releaseWorkflow, "utf8");
  assert.match(workflow, /RELEASE_TAG.*==.*\*-\*/s);
  assert.match(workflow, /--prerelease/);
  assert.match(workflow, /--latest=false/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--json isPrerelease/);
  assert.match(workflow, /publish:[\s\S]*permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /chmod 755[\s\S]*darwin\/arm64\/campp-adapter/);
});

test("release workflow pins audited native inputs and publishes the exact FFmpeg source", async () => {
  const workflow = await fs.readFile(releaseWorkflow, "utf8");
  assert.doesNotMatch(workflow, /vars\.ZCODE_(?:SENSEVOICE|3D_SPEAKER|FFMPEG)/);
  assert.match(workflow, /runtime-llamacpp-v0\.1\.9/);
  assert.match(workflow, /065629c313eaf1a01c65c640c46d77e61e9607b4/);
  assert.match(workflow, /db69d06eeeab4f46da15030a80d539efb4503ca8/);
  assert.match(workflow, /archive\/\$\{FFMPEG_COMMIT\}\.tar\.gz/);
});

test("SenseVoice builder verifies and packages the fetched llama.cpp license", async () => {
  const builder = await fs.readFile(senseVoiceBuilder, "utf8");
  assert.match(builder, /8086439a4cea94c71a5dfb8fe4ad1546aebd640f/);
  assert.match(builder, /path\.join\(build, "_deps", "llama-src"\)/);
  assert.match(builder, /LLAMA_CPP_LICENSE\.txt/);
  assert.match(builder, /CMAKE_OSX_DEPLOYMENT_TARGET/);
  assert.match(builder, /patchLegacyMacosAccelerate/);
  assert.match(builder, /ACCELERATE_NEW_LAPACK/);
});

test("CAM++ builder pins a compatible default macOS deployment target", async () => {
  const builder = await fs.readFile(camppBuilder, "utf8");
  const cmake = await fs.readFile(path.join(workspaceRoot, "plugins", "voice-transcriber", "native", "CMakeLists.txt"), "utf8");
  assert.match(builder, /MACOSX_DEPLOYMENT_TARGET \|\| "12\.0"/);
  assert.match(builder, /CMAKE_OSX_DEPLOYMENT_TARGET/);
  assert.match(cmake, /BUILD_WITH_INSTALL_RPATH TRUE/);
  assert.match(cmake, /BUILD_RPATH "@loader_path"/);
});

test("pre-release runtime workflows clean outputs and pin audited inputs", async () => {
  for (const file of runtimeBuildWorkflows) {
    const workflow = await fs.readFile(file, "utf8");
    assert.match(workflow, /Start with an empty/);
    assert.doesNotMatch(workflow, /vars\.ZCODE_(?:SENSEVOICE|3D_SPEAKER|FFMPEG)/);
    assert.match(workflow, /runtime-llamacpp-v0\.1\.9/);
    assert.match(workflow, /065629c313eaf1a01c65c640c46d77e61e9607b4/);
    assert.match(workflow, /db69d06eeeab4f46da15030a80d539efb4503ca8/);
    assert.match(workflow, /ctest --test-dir/);
    assert.match(workflow, /ORT_THIRD_PARTY_NOTICES\.txt/);
  }
  const macosWorkflow = await fs.readFile(runtimeBuildWorkflows[1], "utf8");
  assert.match(macosWorkflow, /minos 12\.0/);
  assert.match(macosWorkflow, /test "\$rpaths" = "@loader_path"/);
});
