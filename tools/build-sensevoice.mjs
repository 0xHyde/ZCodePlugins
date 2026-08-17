import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "voice-transcriber");
const repository = "https://github.com/QwenAudio/SenseVoice.git";
const defaultRef = "runtime-llamacpp-v0.1.9";
const defaultCommit = "73ccdd3577db37e92dbf22a4a9fc323b038cf13b";
const defaultLlamaCppCommit = "8086439a4cea94c71a5dfb8fe4ad1546aebd640f";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

async function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = await exec(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

async function findFile(directory, filename) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename);
      if (nested) return nested;
    }
  }
  return null;
}

async function addSegmentOutput(source) {
  const file = path.join(source, "runtime", "llama.cpp", "funasr-sensevoice", "funasr-sensevoice.cpp");
  let code = (await fs.readFile(file, "utf8")).replace(/\r\n/g, "\n");
  const replacements = [
    [
      "  auto run_seg=[&](const std::vector<float>& fb,int T){",
      "  auto run_seg=[&](const std::vector<float>& fb,int T)->std::string {",
    ],
    [
      "#include <cstdio>\n#include <cstring>",
      "#include <cstdio>\n#include <cstdlib>\n#include <cstring>",
    ],
    [
      "  bool emit_ids = ids_mode || vocab.empty();   // fall back to ids if the gguf has no vocab\n\n  // NOTE:",
      "  bool emit_ids = ids_mode || vocab.empty();   // fall back to ids if the gguf has no vocab\n  ggml_backend_t be=ggml_backend_cpu_init();\n  int nthreads=4;\n  if(const char* env=getenv(\"ZCODE_VOICE_THREADS\")){ int requested=atoi(env); if(requested>0 && requested<=64)nthreads=requested; }\n  ggml_backend_cpu_set_n_threads(be,nthreads);\n  std::vector<uint8_t> ggml_ctx_buffer((size_t)256*1024*1024);\n\n  // NOTE:",
    ],
    [
      "    ggml_backend_t be=ggml_backend_cpu_init();\n    ggml_init_params cp=",
      "    ggml_init_params cp=",
    ],
    [
      "    ggml_init_params cp={(size_t)1024*1024*1024,nullptr,true};",
      "    // Reuse a bounded metadata arena for every VAD segment.\n    ggml_init_params cp={ggml_ctx_buffer.size(),ggml_ctx_buffer.data(),true};",
    ],
    [
      "    if(emit_ids){ for(int id:seg_ids) printf(\"%d \",id); }\n    else { std::string t=detok_sv(seg_ids,vocab,keep_tags); printf(\"%s\",t.c_str()); }",
      "    if(emit_ids){ for(int id:seg_ids) printf(\"%d \",id); return std::string(); }\n    return detok_sv(seg_ids,vocab,keep_tags);",
    ],
    [
      "      std::vector<float> seg(wav.begin()+off,wav.begin()+end); int t=0; auto fb=compute_fbank(seg,t); run_seg(fb,t); }",
      "      std::vector<float> seg(wav.begin()+off,wav.begin()+end); int t=0; auto fb=compute_fbank(seg,t);\n      std::string text=run_seg(fb,t);\n      if(!emit_ids && !text.empty()) printf(\"[%.3f-%.3f] %s\\n\", s.first/1000.0, s.second/1000.0, text.c_str()); }",
    ],
    [
      "    run_seg(fb,T);\n  }\n  printf(\"\\n\");",
      "    std::string text=run_seg(fb,T);\n    if(!emit_ids) printf(\"%s\", text.c_str());\n  }\n  printf(\"\\n\");",
    ],
    [
      "    ggml_backend_tensor_set(x,inp.data(),0,ggml_nbytes(x)); ggml_backend_cpu_set_n_threads(be,8);",
      "    ggml_backend_tensor_set(x,inp.data(),0,ggml_nbytes(x));",
    ],
    [
      "    ggml_gallocr_free(ga); ggml_free(c); ggml_backend_free(be);",
      "    ggml_gallocr_free(ga); ggml_free(c);",
    ],
    [
      "  if(m.ctx_w) ggml_free(m.ctx_w);\n  return 0;",
      "  ggml_backend_free(be);\n  if(m.ctx_w) ggml_free(m.ctx_w);\n  return 0;",
    ],
  ];
  for (const [from, to] of replacements) {
    if (!code.includes(from)) throw new Error(`官方 SenseVoice runtime 源码结构发生变化，无法应用分段输出适配：${from.slice(0, 48)}`);
    code = code.replace(from, to);
  }
  await fs.writeFile(file, code, "utf8");
  return file;
}

async function patchLegacyMacosAccelerate(llamaCppSource, deploymentTarget) {
  if (process.platform !== "darwin") return false;
  const [major, minor = 0] = String(deploymentTarget).split(".").map(Number);
  if (major > 13 || (major === 13 && minor >= 3)) return false;
  const patches = [
    {
      file: path.join(llamaCppSource, "ggml", "src", "ggml-blas", "CMakeLists.txt"),
      lines: [
        "        add_compile_definitions(ACCELERATE_NEW_LAPACK)\n",
        "        add_compile_definitions(ACCELERATE_LAPACK_ILP64)\n",
      ],
    },
    {
      file: path.join(llamaCppSource, "ggml", "src", "ggml-cpu", "CMakeLists.txt"),
      lines: [
        "            target_compile_definitions(${GGML_CPU_NAME} PRIVATE ACCELERATE_NEW_LAPACK)\n",
        "            target_compile_definitions(${GGML_CPU_NAME} PRIVATE ACCELERATE_LAPACK_ILP64)\n",
      ],
    },
  ];
  for (const patch of patches) {
    let code = (await fs.readFile(patch.file, "utf8")).replace(/\r\n/g, "\n");
    for (const line of patch.lines) {
      if (!code.includes(line)) throw new Error(`llama.cpp Accelerate 兼容补丁无法匹配：${path.relative(llamaCppSource, patch.file)}`);
      code = code.replace(line, "");
    }
    await fs.writeFile(patch.file, code, "utf8");
  }
  return true;
}

const ref = option("ref", process.env.ZCODE_SENSEVOICE_REF || defaultRef);
const nativeOption = option(
  "native",
  process.env.ZCODE_SENSEVOICE_NATIVE || (process.platform === "darwin" ? "on" : "off"),
).toLowerCase();
if (!["on", "off"].includes(nativeOption)) throw new Error("--native 只能是 on 或 off。");
const output = path.resolve(option(
  "output",
  path.join(pluginRoot, "bin", process.platform, process.arch),
));
const macosDeploymentTarget = process.env.MACOSX_DEPLOYMENT_TARGET || "12.0";
const jobs = String(Math.max(1, Number(option("jobs", process.env.ZCODE_BUILD_JOBS || Math.min(4, os.cpus().length || 1)))));
const keepBuild = process.env.ZCODE_KEEP_BUILD === "1";
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-sensevoice-build-"));
const source = path.join(temporaryRoot, "SenseVoice.cpp");
const build = path.join(temporaryRoot, "build");

try {
  await run("git", ["clone", "--depth", "1", "--branch", ref, "--recurse-submodules", repository, source], root);
  if (ref === defaultRef) {
    const revision = (await run("git", ["rev-parse", "HEAD"], source)).stdout.trim();
    if (revision !== defaultCommit) throw new Error(`SenseVoice ${defaultRef} 提交不匹配：${revision}`);
  }
  const senseVoiceLicense = path.join(source, "LICENSE");
  if (!(await fs.stat(senseVoiceLicense).catch(() => null))?.isFile()) {
    throw new Error(`SenseVoice 源码缺少许可证文件：${senseVoiceLicense}`);
  }
  await addSegmentOutput(source);
  const cmakeSource = path.join(source, "runtime", "llama.cpp");
  const cmakeSourceText = await fs.readFile(path.join(cmakeSource, "CMakeLists.txt"), "utf8");
  const expectedLlamaCppCommit = /GIT_TAG\s+([a-f0-9]{40})/i.exec(cmakeSourceText)?.[1]?.toLowerCase();
  if (!expectedLlamaCppCommit) throw new Error("SenseVoice CMake 缺少固定的 llama.cpp 提交。");
  if (ref === defaultRef && expectedLlamaCppCommit !== defaultLlamaCppCommit) {
    throw new Error(`SenseVoice ${defaultRef} 的 llama.cpp 提交不匹配：${expectedLlamaCppCommit}`);
  }
  const cmakeConfigureArgs = [
    "-S", cmakeSource,
    "-B", build,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DGGML_NATIVE=${nativeOption === "on" ? "ON" : "OFF"}`,
  ];
  if (process.platform === "darwin") cmakeConfigureArgs.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${macosDeploymentTarget}`);
  await run("cmake", cmakeConfigureArgs, root);
  const llamaCppSource = path.join(build, "_deps", "llama-src");
  const llamaCppRevision = (await run("git", ["rev-parse", "HEAD"], llamaCppSource)).stdout.trim().toLowerCase();
  if (llamaCppRevision !== expectedLlamaCppCommit) {
    throw new Error(`llama.cpp 提交不匹配：${llamaCppRevision}`);
  }
  const patchedLegacyAccelerate = await patchLegacyMacosAccelerate(llamaCppSource, macosDeploymentTarget);
  if (patchedLegacyAccelerate) await run("cmake", cmakeConfigureArgs, root);
  const llamaCppLicense = path.join(llamaCppSource, "LICENSE");
  if (!(await fs.stat(llamaCppLicense).catch(() => null))?.isFile()) {
    throw new Error(`llama.cpp 源码缺少许可证文件：${llamaCppLicense}`);
  }
  await run("cmake", [
    "--build", build,
    "--config", "Release",
    "--target", "llama-funasr-sensevoice",
    "--parallel", jobs,
  ], root);

  const binaryName = process.platform === "win32" ? "llama-funasr-sensevoice.exe" : "llama-funasr-sensevoice";
  const binary = await findFile(build, binaryName);
  if (!binary) throw new Error(`构建完成但找不到 ${binaryName}。`);
  await fs.mkdir(output, { recursive: true });
  const destination = path.join(output, binaryName);
  await fs.copyFile(binary, destination);
  await fs.copyFile(senseVoiceLicense, path.join(output, "SENSEVOICE_LICENSE.txt"));
  await fs.copyFile(llamaCppLicense, path.join(output, "LLAMA_CPP_LICENSE.txt"));
  if (process.platform !== "win32") await fs.chmod(destination, 0o755);
  console.log(JSON.stringify({
    repository,
    ref,
    output: destination,
    jobs,
    native: nativeOption,
    segmentOutput: true,
    macosDeploymentTarget: process.platform === "darwin" ? macosDeploymentTarget : null,
    legacyMacosAccelerate: patchedLegacyAccelerate,
  }, null, 2));
} finally {
  if (!keepBuild) await fs.rm(temporaryRoot, { recursive: true, force: true });
  else console.log(`保留构建目录：${temporaryRoot}`);
}
