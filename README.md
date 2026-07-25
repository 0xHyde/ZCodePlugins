# ZCodePlugins

ZCode 插件 monorepo。每个插件独立放在 `plugins/` 下，共享实现放在 `packages/`，构建与基准工具放在 `tools/`。

```text
plugins/<plugin>/       ZCode 可加载插件及其运行代码
docs/<plugin>/          架构、模型、native 和发布文档
packages/               多个插件实际复用后再抽取的共享代码
tools/                  工作区级验证和基准工具
```

## 当前插件

- [`voice-transcriber`](plugins/voice-transcriber)：全本地录音转写、说话人识别、无感声纹学习。

## 本地 marketplace

在 ZCode 的 Marketplace 中添加本仓库目录：

```text
/Users/hyde/Documents/ZCodePlugins
```

本仓库已发布到 [0xHyde/ZCodePlugins](https://github.com/0xHyde/ZCodePlugins)，整个仓库作为 ZCode 插件市场源；新增插件只需放入 `plugins/` 并更新 `marketplace.json`。发布版可以在插件配置中预置项目自己的 GitHub Release manifest URL，第一次真正转写时自动下载模型到用户数据目录；当前开发版仍可填写 manifest URL 或手动指定模型路径。需要说话人分离时同样由 manifest 下载 CAM++ ONNX。仓库不提交模型和 native binary。

## 测试

```bash
npm run test:voice-transcriber
```

推送 `v*` 标签会触发 Windows x64 与 macOS arm64 runtime 构建和 GitHub Release 发布流程；Release 同时包含各平台 ZIP、带平台前缀的独立二进制文件和合并后的 `runtime-manifest.json`。模型仍通过独立的模型 manifest 由用户下载。

## 构建 SenseVoice.cpp runtime

需要本机已安装 Git、CMake 和 C++ 编译工具链。构建不会下载模型：

```bash
npm run build:sensevoice -- --ref main
```

生成的二进制会放入当前平台对应的 `plugins/voice-transcriber/bin/<platform>/<arch>/`。
