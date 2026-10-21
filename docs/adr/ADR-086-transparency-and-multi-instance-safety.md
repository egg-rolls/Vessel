---
adr: 86
title: 0.15.0 透明化与多实例安全
status: accepted
date: 2026-10-21
related: [49, 80, 81, 84]
tags: [observability, events, snapshot, queue, self-card, delegate, locking, multi-instance, rpc]
---

## ADR-086：0.15.0 透明化与多实例安全

- **上下文**：0.14 已把可观察性和控制面做成只读骨架，但运行时仍有多处"看得见的事件、看不见的状态"：压缩只在回调里发生、限额只有命中才可见、队列位置只存在于 Host 内存、Self Card 只在 TUI `/agents` 展示而不进入模型上下文。另一边，gateway 多实例 A 只隔离了 PID 与日志：同一 `dataDir` 的命名实例仍共用 `interactions-<tenant>.json`，file 后端的 tenant 锁仍是整租户单写者，同一 session / run 可被两个进程同时写。delegate 事件缺少关联字段，孙 agent 无法 opt-in，`edit` 不受路径边界约束，自定义 `deny_paths` 不参与 bash 命令文本匹配。

- **决策**：
  1. **透明化事件**：新增 `context.compacted`（`auto` / `overflow` / `manual`）、`agent.limit.warning`（80%，每 run 每 key 一次）、`agent.queue.entered` / `agent.queue.left`。事件名保持开放字符串，payload 为冻结的 snake_case 形状。
  2. **快照补齐**：`AgentSnapshot` 增加节点、任务、等待原因、上下文用量、子节点数与最近活动时间；`RunSnapshot` / `SchedulerSnapshot.queued[]` 增加 `waitReason`。Host 能提供时填写，缺省不伪造。
  3. **Self Card 进入 systemPrompt**：`AgentRuntimeOptions.selfCard` / `AgentSpec.selfCard`（additive）；每次 run（含 resume）渲染一次，追加到 systemPrompt，估算 token 截断到 400，不写入持久化 session。MCP 工具名在连接前不可知，不写入。
  4. **delegate 关联与孙 agent opt-in**：delegate 事件补 `tool_call_id` / `parent_session_id` / `parent_delegate_id` / `delegate_path`，完成 / 失败补 `result_ref`。`delegate.allow_nested` 默认 `false`，`delegate.max_descendants` 默认 `16`；开启后 child 获得独立 delegate 实例并新建 Host，避免复用父 run 占用的调度槽；child 继承父级权限与限额，不放大。
  5. **tenant 双层锁**：`exclusive`（`.lock`，sqlite / `--exclusive` / 迁移与清理）与 `shared`（`.members/<pid>-<nonce>.json`，file / memory 默认）共存；发布后互相复查，stale 规则统一。
  6. **session / run 写锁**：`.locks/sessions/<sha16>.lock` 与 `.locks/runs/<sha16>.lock`；跨进程第二写者得到 `conflict`，消息前缀 `session_locked` / `run_locked`。interactions 记录按实例落到 `<dataDir>` 或 `<dataDir>/instances/<instance>`。
  7. **canonical RPC 40 → 44**：`agents.tree`、`tasks.list`、`tasks.get`、`config.set`；`health.get` 补 `runtime`，`runs.list/get` 补错误 envelope 与 `started_at`，`events.list` 读路径补 redactor 与 8 KiB 裁剪。
  8. **工具边界**：`edit` 与 `read` 共用 `evaluatePath`；`bash` 命令文本同时匹配内置 denylist 与配置 `deny_paths`（仍 best-effort）。

- **冻结契约**：
  - `context.compacted` data 固定 `{ run_id, session_id, removed, remaining, reason }`，`reason` 只取 `auto|overflow|manual`；`removed === 0` 不发。
  - `agent.limit.warning` data 固定 `{ scope, key, current, max, source, threshold, hint }`，`threshold` 为 `0.8`，同一 run 同一 key 最多一次；达到硬上限交给 `limit.blocked`，不重复预警。
  - `agent.queue.entered/left` data 固定 `{ agent_id, run_id, position, wait_reason, since }`，`position` 从 1 起；直接启动的任务没有 `entered` / `left`。
  - `WaitReason` 取 `capacity|per_agent_serial|paused|dependency|quota`；core 只产出前两个。
  - `SelfCardOptions` 顶层字段为 `parent_id` / `how_to_ask`；渲染上限 400 估算 token；每次 run 只生成一次，hook 改写 systemPrompt 后 Card 仍只出现一次。
  - delegate 事件关联字段与 `result_ref: { kind: 'run', id }` 为 additive；嵌套转发保留内层 `delegate_path`，外层不覆盖。
  - tenant 锁的 stale 规则：死 pid、不可解析超过 5s、跨主机超过 24h；回收必须持 `.reclaim` 守卫（守卫超过 10s 可清理）；释放要求 `pid + started_at + host` 全等。
  - session / run 锁冲突的主码是 `conflict`，不得新增 RPC 主码；锁文件 `0600`，内容包含 `pid` / `started_at` / `host`。
  - `config.set` 只写白名单键，仅 default tenant；未知键 / 值返回 `invalid_params`，非 default tenant 返回 `forbidden`。

- **非目标**：
  - 不做 Phase 2 owner 选举、attach、durable outbox；不做 0.16 的 `pause/resume/broadcast/reassign`、持久任务账本、advisory claim/lease。
  - 不把 shared tenant 锁升级为全租户单写者；需要独占时显式 `--exclusive` 或 sqlite。
  - 不做跨进程的队列状态持久化；`tasks.*` 仍是从事件派生的只读视图。
  - 不把 `bash` 命令文本检查做成 shell 解析或沙箱。
  - 不新增事件名常量 / 枚举，不改已有事件 payload（只做 additive）。
  - 不做 Self Card 的 provider 精确 token 计数，不把 MCP 工具写入 Card。

- **验证**：
  - core：`packages/core/__tests__/` 的事件 / 快照 / Self Card 用例（压缩 reason、预警每 key 一次、队列事件配对、Self Card 截断与只出现一次）。
  - ext：`plugins/tools/delegate-task/__tests__/nested-events.test.ts`、`self-card.test.ts`；`plugins/tools/basic-tools/__tests__/basic-tools.test.ts`（`edit` 边界、`deny_paths` 命令文本）。
  - asm：`src/__tests__/tenant-lock-shared-0.15.test.ts`、`session-lock-0.15.test.ts`、`interactions-dir-0.15.test.ts`、`port-in-use-0.15.test.ts`、`logs-command-0.15.test.ts`、`control-commands-0.15.test.ts`。
  - serve/web：`packages/serve/__tests__/gateway.transparency-0.15.test.ts`、`rpc.result-schema.test.ts`；`agents.tree` / `tasks.*` / `health.get` / `config.set` 结果形状。
  - 文档门禁：`bun run scripts/check-docs.ts`、`bun run scripts/check-rpc-methods.ts`、`bunx @biomejs/biome ci .`。

- **已知限制**：`max_runtime` 预警基于 wall clock；`childrenCount` 依赖上层父子关系；`tasks.*` 重启丢失；Self Card 为估算 token 截断；嵌套 delegate 会额外创建进程内 Host；shared tenant 锁不阻止两个进程写同一个 tenant 的不同 session。

- **关联**：ADR-049（多租户隔离）、ADR-080（可观察性 / 控制面 / 多实例 A）、ADR-081（Host 对等与可序列化快照）、ADR-084（限额可见性）；实现见 `packages/core/src/runtime/agent-runtime.ts`、`packages/core/src/kernel/scheduler.ts`、`plugins/tools/delegate-task/src/index.ts`、`src/tenant-lock.ts`、`src/session-lock.ts`、`packages/serve/src/gateway/methods/agents.ts`。
