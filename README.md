# autowonder-claude-executor (awce)

> AutoWonder 社区版的首个第三方开源执行器 —— 用 Claude Code（或任意 MCP 兼容 CLI agent）作为执行引擎。
> The first open-source third-party executor for the AutoWonder community edition — with Claude Code as the engine.

[English](#english) | 中文

## 这是什么

[AutoWonder](https://github.com/aliyun/alibabacloud-landing-zone/tree/main/ai-sdlc/auto-wonder) 是阿里云的多 Agent 软件交付平台（AI Native SDLC Platform）。它的调度器通过 WebSocket 协议把工单派发给"执行器"（executor daemon），执行器拉起本地 CLI agent 完成工作。

社区版的限制：

- 官方执行器 runtime（`autowonder` npm 包内的 Go daemon）**闭源**；
- 平台新建执行器只开放 `QODER_CLI` / `QODER_CN_CLI` 两种类型。

本项目实现与官方调度器完全兼容的开源执行器，把引擎换成 **Claude Code**（无头模式），并向上以 MCP 协议（`awdispatch_` dispatch token）与平台通信：

```
AutoWonder 调度器 (WebSocket /ws/executor?executorId&token)
        │  TASK_DISPATCH {downloadUrl, md5, signature?, dispatchMcpToken, artifactUploadPath, ...}
        ▼
awce daemon（本项目，Node/TypeScript，零运行时依赖）
        │  ① 下载任务包 zip → md5 + sha256 + Ed25519 验签 → 解压 capsule
        │  ② 组装上下文（workitem/identity/sdlc/roster/memory/teammates + 恢复检查点）
        │  ③ 渲染 mcp-config（注入 dispatchMcpToken → 平台 /api/mcp）
        │  ④ 拉起 claude 无头执行当前 SDLC 步（心跳上报库存，检查点续传）
        ▼
Claude Code ──MCP──▶ AutoWonder（112 个平台工具：记忆/技能/工单…）
        │
        ▼ 产物：deliverables/ + handoff-proposal.json（FAILURE 文件=失败信号）
awce daemon ──▶ TASK_ACK / TASK_PROGRESS / TASK_RESULT(V2) / TASK_HANDOFF
             ──▶ HTTP 上传产物 + 检查点（帧内签名路径）
```

## 状态

✅ **协议面全功能已实现并在真实部署上端到端验证**（社区版 1.0.0，2026-10 立项）。实现规格与协议发现见 [docs/SPEC.md](docs/SPEC.md)。

- [x] 协议精读与实现规格（[docs/SPEC.md](docs/SPEC.md)，含 8 批源码级协议发现）
- [x] MCP 链路验证：Claude Code ↔ AutoWonder `/api/mcp` 端到端打通（112 工具）
- [x] 最小 daemon：WS 接入 + TASK_DISPATCH/ACK/PROGRESS/RESULT 主环（平台显示 ONLINE）
- [x] capsule：任务包下载/校验/解压（整包 md5 + 逐文件 sha256 + UTF-8 安全解压）
- [x] runner：Claude Code 无头执行 + 事件上报 + `artifacts/FAILURE` 失败信号
- [x] 产物上传 + handoff 上报（multipart 中继通道，逐文件回执）
- [x] 端到端验证：本地 AutoWonder 真实派发一轮（dispatch 10002 → SUCCEEDED，39s）
- [x] 多 Agent 接力：TASK_HANDOFF 双变体验证（AGENT_DISPATCHED 跨角色接力 + HUMAN_ASSIGNED 交还人类）
- [x] 库存心跳（dispatch_inventory_v1）：容量/在跑/持有上报，服务端按此续租
- [x] 任务包验签（TASK_PACKAGE_SIGNATURE_V1）：Ed25519 + 公钥钉死 + 过期检查（单测 6 例；社区版打包器未接线签名，收到即强校验）
- [x] 检查点与崩溃恢复：RECOVERY 快照 + V2 结果（COMPLETION 钉住）+ 实杀进程恢复闭环（kill -9 → 库存对账 → 120s 宽限 → 带检查点的替代派发 → 恢复交付）
- [x] 原生会话续跑：providerSessionId → `--resume` 优先，引擎不支持时自动降级 fresh + 检查点文本注入
- [x] 并发池：多派发并行（容量语义实测：声明 N 可用 N−1，服务端为交互/恢复预留一槽）
- [x] 暂停→恢复闭环：TASK_PAUSE 下行（570ms 停引擎 + paused 检查点）→ control_delivery(retry) → RECOVERY 替补派发 → 检查点接力续跑 → SUCCEEDED
- [x] package-url 刷新：预签名 URL 过期自动刷新重试（600s TTL）
- [x] Docker：多阶段构建（~238MB，非 root），容器内 WS 连通实测

## 快速开始（本地 AutoWonder 部署）

```bash
npm install && npm run build

# 1. 平台侧创建执行器（MCP autowonder.create_executor 或 API；
#    clientKind 目前只有 QODER_CLI / QODER_CN_CLI 可选）
#    记下返回的 executor id 和 token
# 2. 启动 daemon
AWCE_WS_URL=ws://127.0.0.1:7001/ws/executor \
AWCE_EXECUTOR_ID=<id> AWCE_EXECUTOR_TOKEN=<exec_...> \
AWCE_WORKSPACE_ROOT=/tmp/awce-runs \
node dist/main.js
# 3. 平台执行器列表应显示 ONLINE（依赖首帧心跳，daemon 已内置）
# 4. 指派一个工单给对应 agent → 观察 daemon 日志走完
#    ACK → capsule(验签) → prompt → claude → artifacts/checkpoint → RESULT(V2)

npm test   # 构建并跑协议单测（Ed25519 验签等）
```

环境变量全表见 [docs/SPEC.md](docs/SPEC.md)（`AWCE_WS_URL / EXECUTOR_ID / EXECUTOR_TOKEN / AGENT_BIN / AGENT_MODEL / WORKSPACE_ROOT / MAX_CONCURRENT / LOG_LEVEL`）。

## Docker

```bash
docker build -t awce .
# 引擎（claude CLI）不打进镜像 —— 挂载或安装后用 AWCE_AGENT_BIN 指向它：
docker run --rm \
  -e AWCE_WS_URL=ws://host.docker.internal:7001/ws/executor \
  -e AWCE_EXECUTOR_ID=<id> -e AWCE_EXECUTOR_TOKEN=<exec_...> \
  -e AWCE_AGENT_BIN=claude \
  -v "$HOME/.claude:/home/node/.claude" \
  -v awce-workspace:/workspace \
  awce
```

多阶段构建（build → prod 依赖 + dist），镜像 ~238MB，非 root 运行。容器内连接宿主机 AutoWonder 用 `host.docker.internal`。

## 免责与边界

- 本项目不是阿里云官方项目，也不属于 AutoWonder 官方发行。
- 协议依据社区版 1.0.0 的公开文档（`docs/scheduler-executor-protocol.md`）与本地部署实测；协议演进可能导致不兼容，会跟进适配。
- 执行器在平台侧注册为 `QODER_CLI` 类型（平台仅开放该类型的新建），引擎实际为 Claude Code —— 类型仅用于平台元数据/启动命令展示，不影响协议行为。
- 社区版 SdlcDriver 的自动推进（NEXT_STEP）与服务端重试（onFail RETRY）为存根；本项目的多步流转经 TASK_HANDOFF 实现（详见 SPEC M5/M8 发现）。

## English

An open-source, protocol-compatible executor for the [AutoWonder](https://github.com/aliyun/alibabacloud-landing-zone/tree/main/ai-sdlc/auto-wonder) community edition that uses Claude Code (headless) as the execution engine. The official runtime is a closed-source Go daemon and the platform only allows creating `QODER_CLI`-kind executors — this project fills that gap with a fully open Node/TypeScript implementation (zero runtime dependencies beyond `ws`).

### What it implements

The complete scheduler↔executor protocol surface, verified end-to-end against a live community deployment:

- **Dispatch loop** — WebSocket `/ws/executor` auth, `TASK_DISPATCH → ACK → PROGRESS → RESULT` with immediate-connect heartbeat (the platform derives ONLINE from the persisted heartbeat timestamp, not the session)
- **Capsule handling** — task-package download, md5 + whole-archive sha256 + per-file sha256 verification, UTF-8-safe extraction (teammate paths carry Chinese role names), path-traversal guard
- **Package signatures** — declares `TASK_PACKAGE_SIGNATURE_V1` and hard-verifies Ed25519 envelopes when present (byte-exact six-line payload rebuild, `signatureRef` key pinning, expiry). The community packager never wires the signer, so community packages arrive unsigned and pass with a note
- **Inventory heartbeats** — `dispatch_inventory_v1`: capacity, running/owned dispatch ids; the server renews active leases from this, so unreported long-running steps get reclaimed as dead
- **Multi-agent relay** — `TASK_HANDOFF` with both variants verified live (AGENT_DISPATCHED cross-role relay + HUMAN_ASSIGNED handback); community edition's step auto-advance is stubbed, so handoff is the relay mechanism
- **Checkpoints & crash recovery** — RECOVERY snapshots mid-run, V2 results (UUID `resultId` + COMPLETION-checkpoint pin, idempotent replay), and a verified kill-9 recovery loop: empty-inventory reconcile + 120s grace → replacement dispatch with a signed checkpoint URL → download/verify → inject Resume context → the agent continues from the real state

### Quick start

```bash
npm install && npm run build
AWCE_WS_URL=ws://127.0.0.1:7001/ws/executor \
AWCE_EXECUTOR_ID=<id> AWCE_EXECUTOR_TOKEN=<exec_...> \
AWCE_WORKSPACE_ROOT=/tmp/awce-runs node dist/main.js
# Assign a workitem to the agent; watch: ACK → capsule → claude → artifacts → RESULT
npm test  # build + protocol unit tests
```

Engine defaults to the official `claude` CLI; point `AWCE_AGENT_BIN` at any command (e.g. `node /path/to/cli.js`). Agents signal step failure by writing `artifacts/FAILURE` (headless exit codes can't express "the work failed").

Not an official Alibaba Cloud project. See [docs/SPEC.md](docs/SPEC.md) for the implementation spec and eight batches of source-level protocol findings (Chinese).
