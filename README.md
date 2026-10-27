# autowonder-claude-executor (awce)

> AutoWonder 社区版的首个第三方开源执行器 —— 用 Claude Code（或任意 MCP 兼容 CLI agent）作为执行引擎。

[English](#english) | 中文

## 这是什么

[AutoWonder](https://github.com/aliyun/alibabacloud-landing-zone/tree/main/ai-sdlc/auto-wonder) 是阿里云的多 Agent 软件交付平台（AI Native SDLC Platform）。它的调度器通过 WebSocket 协议把工单派发给"执行器"（executor daemon），执行器拉起本地 CLI agent 完成工作。

社区版的限制：

- 官方执行器 runtime（`autowonder` npm 包内的 Go daemon）**闭源**；
- 平台新建执行器只开放 `QODER_CLI` / `QODER_CN_CLI` 两种类型。

本项目实现与官方调度器完全兼容的开源执行器，把引擎换成 **Claude Code**（无头模式），并向上以 MCP 协议（`awdispatch_` dispatch token）与平台通信：

```
AutoWonder 调度器 (WebSocket /ws/executor?executorId&token)
        │  TASK_DISPATCH {downloadUrl, md5, dispatchMcpToken, artifactUploadPath, ...}
        ▼
awce daemon（本项目，Node/TypeScript）
        │  ① 下载任务包 zip → md5/sha256 校验 → 解压 capsule
        │  ② 组装上下文（workitem/identity/sdlc/roster/memory/teammates）
        │  ③ 渲染 mcp-config（注入 dispatchMcpToken → 平台 /api/mcp）
        │  ④ 拉起 claude（ccb / claude code CLI）无头执行当前 SDLC 步
        ▼
Claude Code ──MCP──▶ AutoWonder（112 个平台工具：记忆/技能/工单…）
        │
        ▼ 产物：deliverables/ + handoff-proposal.json + learning_delta/
awce daemon ──▶ TASK_ACK / TASK_PROGRESS / TASK_RESULT / TASK_HANDOFF
             ──▶ HTTP 上传产物（帧内 artifactUploadPath）
```

## 状态

🚧 **M1–M4 已完成并端到端验证**（立项 2026-10-25）。路线图见 [docs/SPEC.md](docs/SPEC.md)。

- [x] 协议精读与实现规格（[docs/SPEC.md](docs/SPEC.md)）
- [x] MCP 链路验证：Claude Code ↔ AutoWonder `/api/mcp` 端到端打通（112 工具）
- [x] 最小 daemon：WS 接入 + TASK_DISPATCH/ACK/PROGRESS/RESULT 主环（平台显示 ONLINE）
- [x] capsule：任务包下载/校验/解压（整包 md5 + 逐文件 sha256）
- [x] runner：Claude Code 无头执行 + 事件上报
- [x] 产物上传 + handoff 上报（multipart 中继通道，逐文件回执）
- [x] 端到端验证：本地 AutoWonder 真实派发一轮（dispatch 10002 → SUCCEEDED，39s）

## 快速开始（本地 AutoWonder 部署）

```bash
npm install && npm run build

# 1. 平台侧创建执行器（MCP 或 API；clientKind 只有 QODER_CLI/ QODER_CN_CLI 可选）
#    记下返回的 executor id 和 token
# 2. 启动 daemon
AWCE_WS_URL=ws://127.0.0.1:7001/ws/executor \
AWCE_EXECUTOR_ID=<id> AWCE_EXECUTOR_TOKEN=<exec_...> \
AWCE_WORKSPACE_ROOT=/tmp/awce-runs \
node dist/main.js
# 3. 平台执行器列表应显示 ONLINE（依赖首帧心跳，daemon 已内置）
# 4. 指派一个工单给对应 agent → 观察 daemon 日志走完
#    ACK → capsule → prompt → claude → artifacts → RESULT
```

环境变量全表见 [docs/SPEC.md](docs/SPEC.md)。

## 免责与边界

- 本项目不是阿里云官方项目，也不属于 AutoWonder 官方发行。
- 协议依据社区版 1.0.0 的公开文档（`docs/scheduler-executor-protocol.md`）与本地部署实测；协议演进可能导致不兼容，会跟进适配。
- 执行器在平台侧注册为 `QODER_CLI` 类型（平台仅开放该类型的新建），引擎实际为 Claude Code —— 类型仅用于平台元数据/启动命令展示，不影响协议行为。

## English

An open-source, protocol-compatible executor for the AutoWonder community edition that uses Claude Code (headless) as the execution engine. The daemon speaks the platform's WebSocket executor protocol (`TASK_DISPATCH/ACK/PROGRESS/RESULT/HANDOFF`), mounts the task package (capsule), injects the per-dispatch MCP token into Claude Code, and uploads deliverables through the frame-provided HTTP paths. Not an official Alibaba Cloud project. See [docs/SPEC.md](docs/SPEC.md) for the implementation spec (Chinese).
