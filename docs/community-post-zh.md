# 我逆向了 AutoWonder 的调度协议，给它造了个开源 Claude Code 执行器

## 一句话

[AutoWonder](https://github.com/aliyun/alibabacloud-landing-zone/tree/main/ai-sdlc/auto-wonder)（阿里云开源的多 Agent 软件交付平台）社区版的官方执行器是**闭源**的，平台也只允许新建两种官方 CLI 类型。我精读了它的调度协议文档和源码，用 Node/TypeScript 实现了一个协议完全兼容的第三方执行器 **awce**，引擎换成 Claude Code（无头模式），已在真实部署上把整个协议面全部跑通——包括连杀进程验证的崩溃恢复。

- GitHub：https://github.com/kittimzhe/autowonder-claude-executor
- 一键体验：`npx autowonder-claude-executor`（需本地 AutoWonder 部署）

## 它能干什么

AutoWonder 的架构是：调度器 ←WebSocket→ 执行器（daemon）→ 本地 CLI agent。执行器负责下载任务包、组装上下文、拉起 agent、回收产物。awce 把这层完整开源实现：

| 协议面 | 状态 |
|---|---|
| 派发主环（DISPATCH/ACK/PROGRESS/RESULT V1+V2） | ✅ 实测 |
| 多 Agent 接力（TASK_HANDOFF，AGENT+HUMAN 双变体） | ✅ 三跳接力实测 |
| 库存心跳（dispatch_inventory_v1，租约续期） | ✅ 实测 |
| 任务包 Ed25519 验签（TASK_PACKAGE_SIGNATURE_V1） | ✅ 单测 6 例 |
| 检查点 + 崩溃恢复（RECOVERY/COMPLETION + 对账恢复） | ✅ kill -9 实测闭环 |
| 原生会话续跑（--resume + 优雅降级） | ✅ 实测 |
| 并发池（容量语义） | ✅ 双派发 44ms 并行实测 |
| 暂停→恢复闭环（TASK_PAUSE + 检查点接力续跑） | ✅ 单工单全生命周期实测 |

## 逆向过程中挖到的协议真相（好玩的来了）

这部分是做这个项目最值钱的收获，全部有源码出处，写在仓库 SPEC.md 里：

1. **平台 ONLINE 状态看的是心跳落库时间戳，不是 WS 会话**——连上不算在线，发心跳才算（我在平台列表里 OFFLINE 了半小时才发现）。
2. **社区版的 SdlcDriver 是个存根**：`onSuccess/onFail` 永远返回 stop，自动推进下一步和服务端重试都是企业版能力。多步流转的唯一社区路径是 TASK_HANDOFF——把工单按角色重新绑给下一个 agent 的默认流程首步。
3. **onFail RETRY 也是存根**，那检查点恢复靠什么？靠**运行时对账**：执行器心跳上报 owned 清单，服务端发现"ACKED/RUNNING 但你没报"，过了 120 秒自愈宽限就生成带检查点 URL 的替代派发。我 kill -9 自己的 daemon 验证了完整闭环。
4. **声明并发容量 N，正式任务只能用 N−1**：选择器给交互/恢复工作预留了一槽。声明 2 严格串行，声明 3 才真并行。
5. **社区版打包器没接签名器**：TaskPackageSigner 是 Ed25519 的，但 taskPackager bean 用了三参构造器，signer 根本没注入——社区任务包永远无签名。awce 的策略是声明能力 + 收到签名就强校验。
6. **定制引擎的无头模式可能不落盘会话**：我实测发现某个 Claude Code 定制版 `-p` 模式从不写会话文件，`--resume` 必败，而且失败时 **exit=0**、错误藏在 stream-json 的 `errors[]` 数组里——解析器不读它就丢失败原因。awce 的对策是 resume 秒败自动降级 + 检查点文本注入兜底。
7. **真实 LLM 会无视相对路径契约**：连续两次把 `artifacts/deliverables/` 写成 `deliverables/`。最终方案是 prompt 里钉绝对路径 + 上传前兜底搬迁。
8. **"暂停后续跑"的真相是检查点接力，不是会话复活**：平台下发 `TASK_PAUSE` 后，恢复走的不是让引擎接着原会话跑，而是把 paused 检查点钉死、取消原派发、生成 RECOVERY 替补派发、把检查点文本注入新 prompt。我在一个工单上实测了全链路：暂停（570ms 停掉引擎）→ 恢复派发（attempt+1）→ 检查点注入 → 原生 `--resume` 失败自动降级 → 任务照常跑完交付。**引擎会话死不死根本不影响恢复**——这个设计比"会话续跑"稳得多。

## 快速开始

```bash
# 本地起了 AutoWonder（7001 端口）后：
AWCE_WS_URL=ws://127.0.0.1:7001/ws/executor \
AWCE_EXECUTOR_ID=<id> AWCE_EXECUTOR_TOKEN=<exec_...> \
AWCE_WORKSPACE_ROOT=/tmp/awce-runs \
npx autowonder-claude-executor
# 也有现成 Dockerfile：~238MB 非 root 多阶段镜像，引擎外挂（AWCE_AGENT_BIN 指向你的 claude CLI）
```

在平台建执行器（clientKind 现在只有 QODER_CLI 可选，不影响），把工单指派给对应 agent，看日志走完 `ACK → 验签 → prompt → claude → artifacts → RESULT(V2)`。

引擎默认找官方 `claude` CLI，`AWCE_AGENT_BIN` 可以指到任何命令。仓库里有完整的协议实现规格（含上面 7 条发现的源码级出处）和双语 README。

## 为什么做这个

- 简历需要硬项目（这是实话）
- AutoWonder 社区版缺一个可审计的开源执行器，官方 runtime 闭源意味着你要黑盒信任一个在你机器上跑任意代码的 daemon
- 协议逆向本身太有意思了：每个"为什么不工作"的答案都是一次源码考古

如果你也在玩 AutoWonder 或者做多 Agent 平台的执行器层，欢迎来聊。Issue/PR 都欢迎，特别是协议演进的部分——社区版还在变，我会跟进适配。

---

*声明：非阿里云官方项目。协议依据社区版 1.0.0 公开文档与本地部署实测。*
