# voice-transcriber v0.4 实施方案

> 本文是设计与验收计划，不是已发布功能清单。当前工作区已完成 speaker-v2、MCP `start → wait → read`、模型/runtime SHA 阶段缓存、分块 checkpoint 恢复、声纹输出隔离及最终 ZIP runtime SHA 校验。尚未完成的验收项包括真实 Windows 长录音与峰值内存测试、3/4 人标注集评测、运行中主动取消、商业签名和 macOS notarization。

## 1. 目标

`v0.4` 的目标不是增加更多功能，而是把现有原型收敛为一个轻量、无感、可发布的本地转写插件：

- 用户只需把录音文件交给 ZCode；
- 插件异步完成模型准备、转写、说话人分析和全文落盘；
- ZCode 可以在同一次任务中等待完成并继续读取全文，无需用户手工找文件；
- 用户修正说话人后，全文产物立即同步，可靠样本自动进入本地档案；
- 所有音频、转写、声纹和模型都留在本机；
- macOS 与 Windows 使用同一 MCP 行为，平台差异只留在 native adapter 内部；
- 空闲时不保留 ASR/CAM++ 推理资源。

本版本不引入大语言模型、不依赖 Python、不默认支持 Linux，也不把模型权重打进插件包。GitHub Release 托管不可变 manifest，模型在首次需要时以魔搭为主源、Hugging Face 为备用源下载；也支持用户提供带 GitHub Release 镜像的自定义 manifest，所有镜像必须对应同一个 SHA-256。

## 2. 当前基线与发布判断

当前工作区已将 package、插件 manifest 与 Marketplace 统一为 `v0.4.0-rc.1`。源码候选与 macOS ARM64、Windows x64 runtime 均已由同一源码提交的 GitHub Actions 构建并通过 CI 门禁，产物也已同步回仓库；最终 tag 必须指向这次 runtime 更新后的提交，并按 prerelease 发布。真实 Windows 模型推理、中文路径、长录音和峰值内存验证仍是稳定版门槛。Apache-2.0 版权主体为 0xHyde；稳定版另外需要 3/4 人标注集质量评测。

## 3. 产品闭环

默认用户路径只包含四个动作：

1. `start_transcription(audioPath)`：快速返回 `taskId`，不返回超长正文；
2. `wait_transcription(taskId, timeoutSeconds)`：有限时长等待，返回进度或完成结果；
3. `read_transcript(taskId, cursor)`：按页读取；完成结果始终同时返回本地全文文件路径；
4. `correct_speaker(taskId, segmentIds, personName)`：原子完成修正、产物重写和可用样本学习。

现有 `get_transcription_status` 保持兼容。`wait_transcription` 是有限时长 long-poll，不依赖 MCP 主动向 ZCode 推送；一次等待最长应低于宿主 MCP 超时。管理类能力如说话人列表和学习回滚保留为次级工具，不进入默认流程。

成功任务必须生成：

```text
artifacts/<taskId>/revisions/<revision>/transcript.json
artifacts/<taskId>/revisions/<revision>/transcript.txt
artifacts/<taskId>/revisions/<revision>/transcript.md
artifacts/<taskId>/revisions/<revision>/transcript.srt|vtt  # 按需
```

完成响应返回 `artifacts`、文字预览、片段总数和下一页游标。ZCode 应自动继续读取或直接处理全文文件，不能要求用户把结果重新交回来。

## 4. 模块设计

外部保持一个小而深的 MCP interface，复杂性集中在本地转写 module 内：

```text
ZCode
  -> MCP adapter
    -> LocalTranscription module
       -> Task store adapter
       -> Model depot adapter
       -> Process/runtime adapter
       -> SenseVoice ASR adapter
       -> Speaker analysis adapter
       -> Profile store adapter
       -> Artifact writer adapter
```

只有同时存在生产实现和测试实现的地方建立 seam。MCP adapter 只负责参数校验、调用和安全输出，不保存业务状态。`LocalTranscription` 统一拥有以下不变量：

- 同一音频和同一阶段版本不会重复执行重计算；
- 一个任务在任意时刻只有一个写入者；
- 任务 JSON 和全文产物属于同一个 revision；
- 失败、取消和进程退出都能落到可恢复状态；
- 声纹向量永远不穿过 MCP interface；
- 重任务默认全局并发为 1，状态查询和分页读取不受阻塞。

## 5. 分阶段缓存

不能继续用一个 task key 同时代表 ASR、说话人、档案匹配和输出格式。缓存拆成四层：

| 阶段 | 缓存输入 | 变化后的动作 |
|---|---|---|
| ASR | 音频指纹、ASR 模型 SHA、runtime 版本、语言、VAD/分块配置、`ASR_PIPELINE_VERSION` | 重新转写 |
| Speaker | ASR/VAD 时间线、CAM++ 模型 SHA、聚类配置、`SPEAKER_PIPELINE_VERSION` | 只重跑说话人分析 |
| Profile match | Speaker cluster prototype、档案 revision、匹配配置 | 只重匹配已知人 |
| Render | 当前 transcript revision、输出格式 | 只重写产物 |

`v0.3.x` 缓存不得被 `speaker-v2` 直接复用。旧任务文件可以读取，但必须标记 `legacyPipeline`，需要重新分析时生成新 revision。

## 6. Speaker Analysis v2

### 6.1 处理流程

```text
FSMN-VAD 人声区域
  -> 1.5 秒窗口 / 0.75 秒步长
  -> CAM++ 有限批次提取一次 embedding
  -> 全局 AHC 基线聚类
  -> 小簇处理与时间平滑
  -> speaker timeline
  -> 对齐 ASR 片段
  -> cluster 级已知说话人匹配
```

VAD 只表示“有人声”，不承担换人判断。第一版使用可解释、无需重型矩阵依赖的平均链接 AHC；在标注集上建立基线后，再决定是否增加谱聚类实现。不能把调高或调低一个固定阈值当作最终方案。

### 6.2 native adapter 契约

`diarize` 保持旧请求兼容，响应扩展为：

```json
{
  "algorithmVersion": "speaker-v2",
  "segments": [
    {
      "id": "seg_0001",
      "speaker": "cluster_0",
      "speakerMatch": "cluster",
      "speakerConfidence": 0.91,
      "speakerPurity": 0.86,
      "mixedSpeaker": false
    }
  ],
  "clusters": [
    {
      "clusterId": "cluster_0",
      "prototype": [0.0],
      "voicedSeconds": 42.3,
      "windowCount": 31
    }
  ],
  "metrics": {
    "windowCount": 120,
    "clusterCount": 3,
    "batchCount": 2
  }
}
```

`clusters[].prototype` 只允许在 engine 与 native sidecar 的内部 seam 使用，写入本地任务缓存时应放在私有分析记录中；MCP 输出必须移除。

### 6.3 性能约束

- embedding 在一次 speaker 分析中只计算一次；
- 默认 batch size 为 64，并按窗口长度分桶，禁止把全部窗口补齐到全局最长窗口；
- 已知人匹配按 cluster 执行，不再逐 segment 重算；
- 普通电脑默认 CPU 路径，平台专用执行提供器必须通过准确率与内存回归后才能启用；
- native adapter 在任务结束后立即关闭；只有队列中紧接着还有 speaker 任务时才允许短暂复用。

ASR 当前只有片段级文字，没有 token 时间戳。如果一个 ASR 片段跨越多位说话人，`v0.4` 必须设置 `mixedSpeaker` 或使用占比最高者，不能伪装成精确归属。后续可选择按 speaker turn 二次规划 ASR 片段或增加 token timestamp。

## 7. 说话人档案与无感学习

档案更新以 cluster 为单位：

1. 用户修正一个片段时，先确认它所属的 speaker cluster；
2. 默认将同 cluster 的高置信片段一起修正，响应中列出受影响片段；
3. 只选择有效人声不少于 1.5 秒、非 mixed、聚类置信度足够且与 cluster centroid 一致的窗口；
4. 档案保存多个代表样本、鲁棒 centroid、累计有效时长和模型版本；
5. 匹配必须同时满足绝对阈值和第一/第二候选 margin，否则保留未知；
6. 每次学习写入独立事件，回滚只撤销该事件，不能恢复完整旧快照覆盖后续学习。

纠正事务的提交顺序为：

```text
校验 -> 生成新 transcript revision -> 写临时任务/产物
     -> 写学习事件与档案 revision -> 原子替换 -> 返回结果
```

任一步失败都不能出现任务 JSON 已修正而 Markdown 仍是旧说话人的状态。

## 8. 长录音、并发和资源生命周期

- 根据音频时长和可用内存提前选择分块，不再先整段运行、崩溃后才回退；
- Windows 8 GB 机器默认使用保守分块；Mac 与 Windows 可以使用不同线程/批次，但输出语义一致；
- 每完成一个 ASR 块就保存 checkpoint，并记录音频时间范围；
- 分块边界保留小幅重叠，通过时间与文字规则去重；
- 同一任务内 SenseVoice 模型只加载一次；实现受限时先保证预切块和稳定性，再升级为 task-scoped 常驻 runtime；
- ASR 完成后释放其进程和内存，再启动 CAM++；speaker 完成后立即释放；
- 支持取消 queued/running 任务，杀死子进程并清理本任务临时文件；
- MCP/engine 退出时把 running 任务标记为 interrupted，下次可从 checkpoint 恢复。

## 9. 安全与隐私

- `taskId`、`learningId`、`segmentId`、`personId` 使用 allow-list 格式校验；任何进入路径的值还必须通过 resolved path containment 检查；
- POSIX 数据目录使用 `0700`，任务、档案、学习和转写文件使用 `0600`；Windows 使用当前用户可访问的目录并在发布测试中验证；
- 原子写入临时文件名必须包含 PID、随机数和写入 revision，避免同进程并发覆盖；
- MCP 的 speaker/profile/correction 响应只返回 ID、名称、样本数量、更新时间和置信度，不返回 prototype 或 sample vector；
- 模型下载使用进程锁、临时文件、SHA-256、大小校验、超时和重定向后的 host allow-list；
- 提供清理任务/音频派生产物的保留策略，启动时清理超期临时文件。

## 10. 三模型协作与写入所有权

| 模型 | 职责 | 首轮写入范围 |
|---|---|---|
| Sol Max | 架构、内部契约、MCP 闭环、缓存分层、纠正学习、最终集成和发布判断 | `docs/**`，随后集成全部变更 |
| Sol High | 高确定性的 JavaScript 正确性、安全、任务队列和回归测试 | `scripts/voice-engine.mjs`、`scripts/mcp-server.mjs`、对应 Node 测试 |
| Luna Max | native Speaker v2、有限批次、全局聚类、纯算法测试 | `native/**` |

协作规则：

- 两个执行模型首轮不修改同一文件；
- 每个执行模型必须附带回归测试和已知限制；
- Sol Max 不直接接受“测试通过”作为合并依据，必须逐项检查 interface、不变量和实际 diff；
- 集成后统一重建 `dist/mcp/server.js`，不得手工修改 dist；
- 所有模型都不得提交、推送或发布，直到完整验收通过。

## 11. 里程碑

### M0：基线冻结

- 固定本方案和 `v0.3.3` 基线；
- 保存官方双人样本、合成多说话人样本及标注格式；
- 建立当前耗时、内存、人数误差和近似 speaker accuracy 数据。

### M1：正确性与安全止血

- 修复分页、产物同步、缓存版本、敏感输出和路径校验；
- 全局重任务并发 1；
- `speakerProfile=false` 完全跳过 CAM++；
- 临时将 VAD/ASR 最大片段调整为 5 秒，但明确这是过渡方案。

### M2：Speaker v2

- native 滑窗、bounded batch、全局 AHC、平滑和 cluster summary；
- Node 只使用一次 embedding 结果完成聚类与已知人匹配；
- 旧 adapter 协议保持兼容，结果带 `algorithmVersion` 和 metrics；
- 在 2/3/4 人标注集上测 DER/JER、speaker count error、RTF 和峰值 RSS。

### M3：无感学习与任务恢复

- cluster 级修正；
- 高质量样本门控、鲁棒档案和事件级回滚；
- 分阶段缓存、checkpoint、取消和恢复；
- `wait_transcription` 完成 ZCode 闭环。

### M4：发布工程

- 测试最终插件 ZIP，而不是源码；
- macOS arm64 和 Windows x64 执行真实 SenseVoice、CAM++、ffmpeg smoke test；
- 发布 job 本次重建 dist，禁止打包仓库陈旧产物；
- 补齐项目 LICENSE、第三方 notices、macOS 公证策略和 Windows 签名策略；
- 文档只描述已实现行为。

## 12. 验收门槛

### 功能

- 60 分钟录音可完成、可读全文、可在重启后恢复；
- 修正说话人后，任务 JSON、Markdown、TXT、SRT/VTT 在同一 revision；
- 同一说话人第二次会议能自动匹配，低置信样本不会污染档案；
- 禁用说话人功能时不下载、不加载 CAM++。

### 质量

- 官方双人样本不再合并为单人；
- 内部 2/3/4 人标注集以 DER/JER 为正式指标，并保存每次版本结果；
- 相比 `v0.3.3`，标注集 aggregate DER 必须显著下降，不能用单条音频调参替代；
- 输入片段顺序变化不能显著改变最终 cluster 关系。

### 性能与稳定性

- speaker 阶段只允许一次 embedding pass；
- 参考机器上 speaker stage RTF 目标不高于 `0.05`，若未达到必须提供阶段耗时解释；
- Windows 8 GB 机器处理 60 分钟音频时总峰值 RSS 目标低于 2 GB且无 native crash；
- 连续两个任务完成后 native 进程退出，内存回落；
- 同时提交多个任务时严格按 FIFO 执行，不发生模型重复加载或任务文件竞争。

### 发布

- Node 单元/集成测试、native 纯算法测试、真实模型 smoke test、最终 ZIP smoke test全部通过；
- 从空数据目录首次启动可以自动下载模型并完成短音频转写；
- 断网但模型已安装时可以正常运行；
- MCP 输出中不存在声纹向量；
- 插件包不包含模型权重，许可证和校验信息完整。

## 13. 回退策略

- 保留 `speaker-v1` adapter 兼容开关，仅用于诊断，不作为默认路径；
- Speaker v2 失败时可以返回纯转写和明确 warning，但不得伪造说话人；
- 每个缓存记录携带 pipeline version，可删除 speaker/profile/render 缓存而保留有效 ASR；
- 发布前任何质量或稳定性门槛未通过，都只发布候选包，不更新 Marketplace 的稳定版本。
