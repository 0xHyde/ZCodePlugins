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
  let code = await fs.readFile(file, "utf8");
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
      "  bool emit_ids = ids_mode || vocab.empty();   // fall back to ids if the gguf has no vocab\n  ggml_backend_t be=ggml_backend_cpu_init();\n  int nthreads=4;\n  if(const char* env=getenv(\"ZCODE_VOICE_THREADS\")){ int requested=atoi(env); if(requested>0 && requested<=64)nthreads=requested; }\n  ggml_backend_cpu_set_n_threads(be,nthreads);\n\n  // NOTE:",
    ],
    [
      "    ggml_backend_t be=ggml_backend_cpu_init();\n    ggml_init_params cp=",
      "    ggml_init_params cp=",
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

const ref = option("ref", process.env.ZCODE_SENSEVOICE_REF || "runtime-llamacpp-v0.1.9");
const nativeOption = option(
  "native",
  process.env.ZCODE_SENSEVOICE_NATIVE || (process.platform === "darwin" ? "on" : "off"),
).toLowerCase();
if (!["on", "off"].includes(nativeOption)) throw new Error("--native 只能是 on 或 off。");
const output = path.resolve(option(
  "output",
  path.join(pluginRoot, "bin", process.platform, process.arch),
));
const jobs = String(Math.max(1, Number(option("jobs", process.env.ZCODE_BUILD_JOBS || Math.min(4, os.cpus().length || 1)))));
const keepBuild = process.env.ZCODE_KEEP_BUILD === "1";
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-sensevoice-build-"));
const source = path.join(temporaryRoot, "SenseVoice.cpp");
const build = path.join(temporaryRoot, "build");

try {
  await run("git", ["clone", "--depth", "1", "--branch", ref, "--recurse-submodules", repository, source], root);
  await addSegmentOutput(source);
  const cmakeSource = path.join(source, "runtime", "llama.cpp");
  await run("cmake", [
    "-S", cmakeSource,
    "-B", build,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DGGML_NATIVE=${nativeOption === "on" ? "ON" : "OFF"}`,
  ], root);
  await run("cmake", ["--build", build, "--config", "Release", "-j", jobs], root);

  const binaryName = process.platform === "win32" ? "llama-funasr-sensevoice.exe" : "llama-funasr-sensevoice";
  const binary = await findFile(build, binaryName);
  if (!binary) throw new Error(`构建完成但找不到 ${binaryName}。`);
  await fs.mkdir(output, { recursive: true });
  const destination = path.join(output, binaryName);
  await fs.copyFile(binary, destination);
  if (process.platform !== "win32") await fs.chmod(destination, 0o755);
  console.log(JSON.stringify({ repository, ref, output: destination, jobs, native: nativeOption, segmentOutput: true }, null, 2));
} finally {
  if (!keepBuild) await fs.rm(temporaryRoot, { recursive: true, force: true });
  else console.log(`保留构建目录：${temporaryRoot}`);
}
