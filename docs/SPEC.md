# awce 实现规格

> 依据：AutoWonder 社区版 1.0.0 `docs/scheduler-executor-protocol.md`（462 行）+ `WsDispatchTransport.java` 源码实测 + 本地部署验证。
> 目标：最小可用执行器，跑通"派发→执行→回传"主环。

## 1. 运行模型

```
main.ts
  └─ WsClient(url, executorId, token)         // 连接循环：指数退避 1s→×2→≤30s
       ├─ 每 30s 发 HEARTBEAT（可选 protocolFeatures）
       ├─ on TASK_DISPATCH → handleDispatch(frame)
       │    ├─ ① sendTaskAck(dispatchId)                    // 立即 ACK（下载前）
       │    ├─ ② Capsule.download(frame)                    // GET downloadUrl, md5 校验, 解压
       │    ├─ ③ sendTaskProgress("capsule.ready")          // ACKED→RUNNING
       │    ├─ ④ Runner.run(capsule, frame)                 // 拉起 Claude Code
       │    │      ├─ 事件 → sendTaskProgress(resultSummary)
       │    │      └─ 产出 artifacts/ 目录
       │    ├─ ⑤ Artifacts.upload(frame, artifactsDir)      // HTTP 中转通道
       │    ├─ ⑥ sendTaskResult(success, resultSummary, error)
       │    └─ ⑦ handoff-proposal.json 存在 → sendTaskHandoff(...)
       └─ on close/ping 异常 → 重连
```

关键顺序（协议硬约束）：
- ACK 在下载之前（服务端 DISPATCHED→ACKED 只看帧，不看下载）；
- TASK_PROGRESS 首帧会触发 ACKED→RUNNING；
- TASK_RESULT 驱动 SdlcDriver 排下一棒，是唯一终态触发器；
- TASK_HANDOFF 在 TASK_RESULT 之后发送（handoff 记录不阻塞主环）；
- 同 dispatchId 幂等：重复 TASK_DISPATCH 忽略（防重复执行）。

## 2. 配置（环境变量）

| 变量 | 必填 | 说明 |
|---|---|---|
| `AWCE_WS_URL` | ✓ | 如 `ws://127.0.0.1:7001/ws/executor` |
| `AWCE_EXECUTOR_ID` | ✓ | 平台签发的执行器 ID |
| `AWCE_EXECUTOR_TOKEN` | ✓ | 平台签发的执行器 token（明文，随 WS query 传输） |
| `AWCE_AGENT_BIN` | ✗ | 引擎命令，默认 `node::default`（自动解析：优先本机 Claude Code 构建，否则官方 `claude`）；也可 `node::<path>` 或任意命令串（如 `npx -y @anthropic-ai/claude-code`） |
| `AWCE_AGENT_MODEL` | ✗ | 传给 agent 的 `--model`（中转部署需要，如 `GLM-5.1`） |
| `AWCE_WORKSPACE_ROOT` | ✗ | capsule 根目录，默认 `~/.awce/capsules/` |
| `AWCE_LOG_LEVEL` | ✗ | debug/info/warn/error，默认 info |

## 3. TASK_DISPATCH 帧字段（源码 `WsDispatchTransport.buildFrame`，比协议文档多）

```ts
interface TaskDispatchFrame {
  type: 'TASK_DISPATCH';
  dispatchId: number; executorId: number; tenantId: number; workitemId: number;
  agentId: number; agentVersionId: number; sdlcStepId: number; attempt: number;
  downloadUrl: string;            // OSS presigned GET (600s)
  md5: string; size: number;
  packageId: string;              // "pkg_<dispatchId>"
  checksum: string;               // "sha256:<hex>"（整包，Phase 2 才强校验）
  checksumAlgorithm: 'sha256'; checksumScope: 'zip_archive';
  // 包签名（TASK_PACKAGE_SIGNATURE_V1 能力位协商后才下发，MVP 跳过验签）
  issuer?: string; signatureRef?: string; signature?: string;
  signatureAlgorithm?: string; signaturePublicKey?: string; expiresAt?: string;
  // 策略位
  allowCommit: boolean; allowPush: boolean; allowNetwork: boolean;
  // 现成 HTTP 通道（全部带 ?token=<executorToken> 鉴权）
  packageRefreshPath: string;     // POST 刷新下载地址
  artifactUploadPath: string;     // POST 产物上传（multipart）
  checkpointUploadPath: string;   // POST checkpoint
  memorySnapshotPath: string;     // 记忆快照/变更/召回（MVP 用 MCP 替代）
  memoryChangesPath: string; memoryMutationPath: string; memoryRecallPath: string;
  memoryStartingRevisions: Record<string, unknown>;
  // ★ dispatch MCP 凭证：直接可注入 Claude Code mcp-config
  dispatchMcpToken: string;       // awdispatch_…，24h TTL
  debugLog?: { enabled: boolean; maxBytes: number };  // 需心跳声明 DEBUG_LOG_V1
}
```

## 4. capsule（任务包）

目录（解压到 `<AWCE_WORKSPACE_ROOT>/<tenantId>/<workitemId>/<dispatchId>/<attempt>/`）：

```
manifest.json          # schemaVersion=autoWonder.taskPackage.v1, fileDigests(每文件 sha256)
workitem.md            # 工单标题+正文
clarification.md?      # 澄清材料
identity.json          # 数字员工身份 name/roleCode/职责/操作规则
sdlc.json              # 当前 SDLC 步骤定义+产物契约+完成门
skills.json + skills/<name>/SKILL.md
repos.json             # 仓库+凭据/检出方式
roster.json            # 队友（handoff 决策依据）
memory/mem_id_<id>.md  # 记忆（注意：按 memoryId 命名，勿按序号构造路径）
context/comments-index.json?  # 可选评论索引（autowonder.commentIndex.v1）
context/comments/<id>.md?
comments.md            # 聚合评论（legacy，始终存在）
teammates/<role>/conclusion.md + artifacts/*
```

校验：整包 md5（帧字段）；逐文件 sha256（manifest.fileDigests，不含 manifest 自身）。

## 5. Runner（Claude Code 无头执行）

### 5.1 prompt 组装（prompt.ts）

按材料渲染系统提示（英文指令 + 原文材料原样嵌入）：

1. identity.json → "You are `<roleName>` (`<roleCode>`)… 职责/操作规则"
2. sdlc.json 当前步 → "Your task for THIS step: `<stepName>` … 产物契约（期望产出文件清单）… 完成门"
3. workitem.md + comments.md → 工单全文
4. roster.json → 队友清单（供 handoff 决策）
5. memory/*.md → 注入为参考记忆（≤50 条已在包内）
6. teammates/*/conclusion.md → 上一轮结论
7. 输出契约 → "完成后把交付物写入 `artifacts/deliverables/`；如需交接，写 `artifacts/handoff-proposal.json`（字段 nextOwner/nextRole/summary）"

### 5.2 agent 拉起

```sh
node $CLAUDE_CODE_CLI -p "<prompt>" \
  --mcp-config "<capsule>/mcp.config.json" \    # 渲染：autowonder → <server>/api/mcp + Bearer dispatchMcpToken
  --allowedTools "mcp__autowonder__*" \
  --model "$AWCE_AGENT_MODEL" \                 # 可选
  --cwd "<capsule>/workspace"                    # 工作区：repo 检出 + artifacts 输出
```

mcp.config.json（我们生成）：
```json
{ "mcpServers": { "autowonder": {
    "type": "http", "url": "http://<server>/api/mcp",
    "headers": { "Authorization": "Bearer <dispatchMcpToken>" } } } }
```

### 5.3 事件→TASK_PROGRESS 映射

ccb/claude 输出流（`--output-format stream-json`）逐事件转发：

| agent 事件 | TASK_PROGRESS resultSummary |
|---|---|
| system init | `agent.started model=<model>` |
| tool_use | `step.progress tool=<name>` |
| 文本增量（节流 5s） | `step.progress chars=<n>` |
| result | `agent.finished stop_reason=<reason>` |

服务端只做幂等状态机推进 + 结构化展示（`stepOrder/stepId/stepName` 可选，MVP 先发字符串）。

## 6. 产物上传（Artifacts）

`POST <server><frame.artifactUploadPath>?token=<executorToken>`（multipart）：
- `artifacts/deliverables/**` → artifactType=DELIVERABLE
- `artifacts/handoff-proposal.json` → HANDOFF_PROPOSAL
- `learning_delta/memory_delta.json`（如 agent 产出）→ LEARNING_DELTA

（请求体格式以 `DaemonArtifactController` 实测为准——首个真实派发时抓包核对；协议文档 §5.8 提到 filesMetadata 带 sha256+sizeBytes、逐文件 ACCEPTED/REJECTED 回执。）

## 7. 状态机（daemon 视角）

```
IDLE ─TASK_DISPATCH→ ACKING ─(send ACK)→ DOWNLOADING ─(md5 ok)→ MOUNTING
    ─(capsule ready)→ RUNNING ─(agent exit 0)→ UPLOADING ─(upload ok)→ REPORTING
    ─(send RESULT[+HANDOFF])→ IDLE
任何阶段失败 → REPORTING(success=false, error=<阶段名+原因>) → IDLE
```

- WS 断线：执行中的 dispatch 继续跑完，RESULT 缓存待重连后补发（服务端按 dispatchId 幂等收敛）。
- 进程被杀：服务端 onTimeout 兜底；重连后同 dispatchId 的重复 TASK_DISPATCH 忽略（attempt 不变）。

## 8. MVP 边界（明确不做）

- 包签名验证（TASK_PACKAGE_SIGNATURE_V1）——v1.1
- 整包 sha256 强校验（服务端已下发 checksum，但文档标注 Phase 2 才强校验）——v1.1 可先做
- debug log 上传（DEBUG_LOG_V1）——v1.2
- checkpoint 上传 / memory HTTP 通道（用 MCP dispatch token 替代）
- repos.json 的仓库检出（MVP：sdlc 步骤若不依赖 repo 则可空跑；repo 检出 v1.1）
- Scheduled Task Run 特殊语义（线协议与工单一致，直接兼容，不做专门处理）

## 9. 验证计划（本地 AutoWonder 1.0.0）

1. **单元**：帧编解码、md5 校验、capsule 解压、prompt 渲染快照
2. **集成**（需要本地栈）：注册执行器 → WS 在线 → 指派工单 → 观察平台状态机推进
3. **端到端验收**：BugHunt-Lab 工作区创建一个真实缺陷工单 → SDLC 单步（agent handler）→ awce 完成 → 平台显示 SUCCEEDED + 产物可见 + handoff 记录

## 10. 开发顺序

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| M1 | frames/config/ws（含重连+心跳） | WS 在线：平台执行器列表 ONLINE |
| M2 | capsule（下载/校验/解压） | 收到真实 TASK_DISPATCH 并解出完整 capsule |
| M3 | runner + prompt + mcp-config | Claude Code 拿到包材料跑完一步（日志可见） |
| M4 | artifacts + result + handoff | 平台工单显示 SUCCEEDED，产物/交接记录可见 |
| M5 | 验证记录 + README 快速开始 | 第三方可按文档复现 |


## M5 实测发现（社区版 1.0.0 源码级验证）

1. **SdlcDriver 是存根**：`onSuccess/onFail` 恒返回 stop——`NEXT_STEP/GOTO_STEP` 自动推进是企业版能力。社区版的唯一接力机制是 `TASK_HANDOFF`（InboundFrameRouter → HandoffService）：按 roleCode 解析在线 agent → 改绑工单到目标 agent 的默认 SDLC 首步 → enqueueHandoff 派发。
2. **包内 sdlc.json 不含 onSuccess/onFail 字段**：执行器无法从 capsule 判断步骤推进策略；因此 awce 无条件转发 agent 的 handoff 提案（社区版下不会与自动推进冲突）。
3. **任务包可含非 ASCII 路径**（`teammates/<角色中文名>/…`）：macOS 自带 Info-ZIP unzip 报 Illegal byte sequence；解压优先走 `python3 -m zipfile`（EFS UTF-8 正确），unzip 仅兜底。
4. **上游交付物随包流至下游**：`deliverables/*` 会被打包进下游 capsule 的 teammates 目录（防递归膨胀的排除规则见 PackageContextAssembler.isTeammateHandoffArtifact）。
5. **TASK_HANDOFF_RESULT 回执帧**：status=AGENT_DISPATCHED 时带 downstreamDispatchId；人类回交为 HUMAN_ASSIGNED(REQUESTED_HUMAN)。


## M6 实测发现：HEARTBEAT 的完整语义（社区版源码级）

HEARTBEAT 不只是保活。不带 protocolFeatures 时走 legacy 路径（仅上报 runningDispatchIds）；声明 `dispatch_inventory_v1` 后服务端要求（InboundFrameRouter.dispatchSnapshot）：

- `maxConcurrentDispatches`：int 1..50，越界直接 `EXECUTOR_PROTOCOL_INCOMPATIBLE` 关会话
- `dispatchInventoryReady`：boolean，必填
- `runningDispatchIds`（≤50）必须 ⊆ `ownedDispatchIds`（必填，≤1000）
- `runningConversationTurnIds`（≤50）
- `dispatchInventoryError`：仅 `OWNED_DISPATCH_LIMIT_EXCEEDED` 有定义语义（且要求 ready=false、owned==running）

心跳路径副作用：`renewActiveLeases`（按上报的 running 续租，**长任务不报会被判死回收**）；inventoryReady=true 时触发 runtimeReconciler，否则走 drainScheduler。`version`/`model` 字段进平台执行器诊断。

awce 实现：单槽执行 `AWCE_MAX_CONCURRENT`（默认 1，声明容量仅用于协议合规），running=当前派发、owned=累计见过（最新 1000）。

另发现：TASK_RESULT 有服务端回执帧 `TASK_RESULT_ACK {dispatchId, accepted}`（文档未写，靠未知帧日志捕获）。


## M7 实测发现：任务包签名在社区版存在但未接线

`TaskPackageSigner`（Ed25519、进程级密钥对、六行定长 payload）代码完整，但 `ObjectStorageConfig.taskPackager` bean 用**三参构造器**创建 TaskPackager——signer 从未注入，社区版 1.0.0 打出的包 `getSignature()==null`，`WsDispatchTransport` 直接跳过签名块（执行器声明特性与否都一样）。

awce 的立场：**声明 TASK_PACKAGE_SIGNATURE_V1 + 收到即强校验**（向前兼容企业版接线，社区版无签名时放行并记录）。校验内容：
1. `checksum`（sha256:zip 归档摘要）——社区版就带，直接硬校验
2. 签名块：payload 六行逐字节重建 + Ed25519 验签 + `signatureRef` 钉死公钥（sha256(SPKI)）+ `expiresAt` 过期检查

单测 `test/signature.test.mjs` 用 Node 原生 Ed25519 按服务端 Java 格式造签名，覆盖正例/篡改/过期/换钥四类（`npm test`）。


## M8 实测发现：检查点/恢复的社区版真实语义

1. **onFail RETRY 同样被社区版存根挡住**（SdlcDriver.onFail 恒 stop）——服务端自动重试是企业版能力。社区版的恢复路径是**运行时对账**：执行器心跳上报 owned 清单，`DispatchRuntimeReconciler` 发现"ACKED/RUNNING 但未报 owned"→ `recoverAbandonedExecution` 生成替代派发（attempt+1、resumeMode=RECOVERY、resumeFromDispatchId 链回死掉那次）。有 **120 秒自愈宽限**（快照上报时间须晚于派发修改时间+120s）。
2. **resume 字段是扁平的**：TaskDispatchFrame.java 用 `resumeMode/resumeCheckpointUrl/resumeCheckpointSha256/resumeFromDispatchId/resumeCheckpointSeq` 等平铺字段（非嵌套对象），且后端日志 `dispatch urls … resumeCheckpointUrl=…` 可直接对照。
3. **检查点保留策略**：每次 store 后 prune，仅保留最新 RETAIN_CHECKPOINTS 条（实测 2 条）——早期 seq 会被清理，恢复用最新存活检查点。
4. **V2 结果与 COMPLETION 检查点**：服务端仅当 `matchesCompletionReceipt(resultId, checkpointSeq, sha256)` 匹配才接受 V2 成功结果；检查点 blob 内容对服务端不透明（LegacyCheckpointNormalizer 对非 tar.gz 报 ZipException 仅告警）。
5. **agent 失败信号**：无头退出码无法表达"工作失败而进程正常"，awce 约定 `artifacts/FAILURE` 标记文件。

## 已验证的崩溃恢复全链路（工单 10014，实杀进程）

attempt 1 强杀（kill -9，检查点 seq=1 已上传）→ 执行器重启（空 owned 库存）→ 心跳对账 + 120s 宽限 → 替代派发 d10016 attempt=2（resumeMode=RECOVERY + 签名检查点 URL）→ awce 下载并 sha256 校验检查点 → 注入 prompt 的 Resume context → agent 按真实检查点内容（phase=context-ready）交付 → V2 结果 accepted=true。


## M9 实测发现：原生会话续跑（providerSessionId → --resume）

1. **会话按 cwd 归档**：Claude Code 系引擎把会话存在 `~/.claude/projects/<编码后的cwd>/<sessionId>.jsonl`，跨目录 `--resume` 直接 "No conversation found"。awce 为每个（工单, 步骤）维护稳定会话工作区 `session-<stepId>/`，同步骤重试共享同一 cwd——引擎支持持久化时原生续跑开箱即用。
2. **定制引擎可能不落盘无头会话**：实测 ccb 2.4.0 在 `-p` 模式从不写会话文件（交互模式才写），`--resume` 必败。
3. **失败信号在 `errors[]` 数组且 exit=0**：resume 失败时 stream-json 返回 `{"type":"result","is_error":true,"errors":["No conversation found …"]}`——没有 `result` 字段、进程正常退出。解析器必须读 `errors[]`，否则失败原因丢失。
4. **awce 降级策略**：先按协议尝试 `--resume`（frame.resumeSessionId），检测到会话类快速失败（errors[] 含 conversation/session）即自动换新会话重跑，连续性由 M8 检查点文本注入兜底。已实测完整链：kill -9 → 恢复派发 → resume 尝试 → 秒败捕获 → 降级重跑 → 按真实检查点内容交付 → V2 accepted。
5. **engine session 即时钉存**：stream-json init 帧的 session_id 在引擎启动 ~1 秒内即可拿到，awce 当场上传 `agent-started` 检查点（providerSessionId=真实引擎会话）——此后任意时刻崩溃，恢复派发都会带上该会话 id。注意回调与后续检查点需从同一原子计数器取 seq（曾因两者同用 seq=2 导致 409 冲突）。


## M10 实测发现：并发容量语义

1. **声明容量 ≠ 可用容量**：`ExecutorSelector.capacityLimit` 对非交互（正式 SDLC）派发取 `maxConcurrentDispatches − 1`（为交互/恢复工作预留 1 槽）；`usedCapacity` = 库存表 running ∪ DB 占用 + 会话轮次。要 N 路正式并行须声明 N+1。实测：声明 2 时两工单严格串行（NO_EXECUTOR_CAPACITY），声明 3 后两个派发 44ms 内并发到达、运行重叠。
2. **awce 并发模型**：单槽 inFlight 布尔改为 runningDispatches 集合池；超声明容量的派发 best-effort 处理（记警告、不丢工作——执行器丢派发没有服务端补偿路径）。
3. **心跳库存是租约事实源**：服务端 `usedCapacity` 同时参考 DB 占用与最新快照 running 并集——执行器少报会误判容量，多报违反协议（RUNNING_DISPATCH_NOT_OWNED 断连）。

## M11 实测发现：下行控制（TASK_PAUSE）与 package-url 刷新

1. **社区版唯一的下行控制帧是 `TASK_PAUSE`**：`WsDispatchControlTransport.pause()` 下发 `{type:"TASK_PAUSE", dispatchId, executorId}`（会话在线走 WS，否则走 Redis 广播频道）。执行器须停掉引擎、落最后一个检查点，回 `TASK_PAUSED {dispatchId, checkpointSeq, checkpointSha256}`；无法满足则回 `TASK_PAUSE_FAILED {dispatchId, error}`。两者服务端都以 result-ack 确认。`EXECUTOR_RESTART_RESULT`/`EXECUTOR_UPGRADE_RESULT` 等上行 case 存在但其下发属企业控制通道，社区版不触发。
2. **暂停触发入口**：MCP 工具 `autowonder.pause_dispatch` 需 `workitemId` + `dispatchId` 双参（只给 dispatchId 报“参数不合法”）；`DispatchPauseService.requestPause` 置 PAUSING 并下发帧。执行器回 `TASK_PAUSE_FAILED` 后状态转 `PAUSE_FAILED`。
3. **awce 暂停实现**：`pauseControllers: Map<dispatchId, AbortController>`；收到 `TASK_PAUSE` 时 abort 对应 run → runner 对子进程发 SIGTERM（5s 后 SIGKILL 兜底）→ 以 `paused:true` 收尾；主流程上传一个 `phase:"paused"` 检查点并回 `TASK_PAUSED`，跳过正常 RESULT。未在本执行器运行的 dispatchId 直接回 `TASK_PAUSE_FAILED`（已实测服务端接受并转 PAUSE_FAILED）。
4. **预签名 package URL 有 600s TTL**：`DaemonTaskPackageController` 暴露 `POST /api/daemon/dispatches/{id}/package-url?token=<executorToken>` → `{downloadUrl, expiresInSeconds}`；状态不可刷新时 409、鉴权失败 401。awce 下载失败时用帧里的 `packageRefreshPath` 刷新一次再重试，覆盖长队列/慢下载导致的 URL 过期。
5. **派发帧构建的隐性协议门**：`WsDispatchTransport.buildFrame` 会调 `DispatchMcpTokenService.issue`（为 dispatch 签发 `awdispatch_` JWT）、`checkpointService.descriptor`（续跑描述符）、`modelSelectionService.freeze`（选中模型且执行器未声明 `TASK_MODEL_SELECTION_V1` 时抛 `ExecutorProtocolCompatibilityException`）。这些在 `requireTaskPackageProtocol` 之后、`dispatch urls` 日志之前执行——任一抛出都会让派发在“dispatch sending”后静默失败（异常进 `runPending failed` / 异步 `SimpleAsyncUncaughtExceptionHandler`）。排障时须对照后端 ERROR 栈，而非只看执行器侧无派发到达。

## M11.5 实测发现：PAUSE→RESUME 全闭环（工单 10027 实测）

1. **恢复入口是 `autowonder.control_delivery` 的 `action:"retry"`**（非 resume_workitem——后者是工单状态机迁移，需 toNodeId，与派发级恢复无关）。REST 等价端点 `POST /{workitemId}/dispatches/{dispatchId}/continue`。两者最终走 `DispatchService.continueDispatch`。
2. **服务端语义**：paused 派发转 `CANCELED(MANUAL_CONTINUE)`，同时创建替补派发（attempt+1，`resumeFromDispatchId=paused id`，`resumeMode=RECOVERY`）。护栏：原执行器在线且派发非终态时拒绝创建并行恢复执行。
3. **执行器侧全链路实测**（d10031→d10032）：下载 paused 检查点（seq=3，65B）注入 prompt → 尝试原生 `--resume`（引擎会话 7cf0dd28…）→ ccb 无头限制失败（No conversation found）→ **自动降级 fresh+checkpoint context** → 新会话跑完 → artifacts 1/1 accepted → V2 completion 检查点 seq=5 → RESULT accepted → SUCCEEDED。
4. **结论**：社区版的"暂停后续跑"= 检查点接力，不依赖引擎原生会话存活性——`TASK_PAUSED` 钉的检查点就是恢复事实源，与崩溃恢复（M8）共用同一套注入机制。
