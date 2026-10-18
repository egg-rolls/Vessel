---
adr: 40
title: Durable run——RunStore port、checkpoint 与 resume
status: accepted
date: null
related: [25, 32, 37]
---

## ADR-040：Durable run——RunStore port、checkpoint 与 resume

- **上下文**：`SessionBackend` 以 session 为键保存最后一份 `RunState`；进程崩溃后无法按 run 恢复。0.2 的 Host run 状态在内存，重启即丢。需求是「本机可恢复」，不是 workflow / 跨机器调度。
- **决策**：
  1. **port 与类型位置**：`RunCheckpoint` / `RunStore` 定义在 `packages/core/src/types/run-store.ts`，`packages/core/src/session/run-store.ts` 实现并 re-export；公开导入路径与名字仍为 `@vessel/core/session` 与根入口。签名严格按 DECISION-008 §4.1。
  2. **定位**：`RunStore` 是 module port，不是第 10 个核心扩展接口；9 个扩展接口与 loop 拓扑不变。
  3. **后端**：`MemoryRunStore` 与 `FileRunStore({ dir })`。File 后端一个 run 一个 JSON 文件；同一 run 的写入串行化；临时文件 + rename 原子替换；Windows 下 rename 失败重试 3 次，仍失败则整文件直写（绝不写半截 JSON）——文档标注 **best-effort**，不做跨进程写协调。
  4. **list**：按 `updated_at` 倒序、同值按 `run_id` 升序；支持 `status` / `session_id` / `limit`；默认 `limit=50`、最大 `200`；gateway 与 CLI 同规则。
  5. **checkpoint 时机**：run 开始、每完成一轮 tool-call 后、run 结束（completed / failed / cancelled）；每次写入发 `run.checkpoint`。
  6. **写者**：**只有一个写者 `AgentRuntime`**。Host 模式把 Host 的 `runStore` 注入成员 runtime；同时给 Host 与 runtime 两个 store 时 **Host 优先，禁止双写**。单 agent 模式使用 `AgentRuntimeOptions.runStore`。
  7. **接线（additive）**：`RuntimeOptions.runStore?`、`AgentRuntimeOptions.runStore?` / `agentId?`、`InProcessRuntimeHostOptions.runStore?`；`AgentRuntime.resume(runId, opts?): Promise<string>`；`RunnableAgent.resume?(runId, opts?): Promise<RunHandle>`；`RuntimeHost.resume?(runId): Promise<RunHandle>`。
  8. **resume 语义**：恢复消息 / usage / iteration 到上下文，发 `run.resumed`，继续 loop；`RunHandle.id` 与原 `run_id` 相同。Host resume **不经 Scheduler**（保持 run_id 不变）；若该成员已有 active run → `run_already_running`。resume 不受全局并发上限约束（已知行为）。同一 run 同时只允许一个恢复，首个成功，后续（含重复 resume）→ `run_already_running`。
  9. **错误**：`RunResumeError extends Error`，字段 `code: 'run_not_found' | 'run_not_resumable' | 'run_already_running' | 'run_store_required' | 'agent_not_found'` 与 `runId`。terminal 状态一律 `run_not_resumable`；未知 id `run_not_found`；未配置 store `run_store_required`；Host 模式未知成员 `agent_not_found`。gateway 映射：`run_store_required → durable_disabled`，`agent_not_found → agent_not_found`，其余同名。
  10. **范围**：只做本机 file / memory；不做跨机器恢复、分布式锁、多进程并发写协调；File 后端假定单进程写入。无保留 / 清理策略（list 可能增长），写为已知限制。
  11. **与 SessionBackend 正交**：Session 是会话对话持久化，RunStore 是 run 执行检查点；resume 不重放事件（事件回放仍归 `FileEventStore` / `replayRun`）。
  12. **事件**：`run.checkpoint` / `run.resumed`，开放字符串，不建常量。
- **备选**：(a) 扩展 `SessionBackend` 承载 run——键语义冲突（session vs run）；(b) 从事件日志重建 run——事件不携带完整模型状态；(c) 直接做 workflow / 跨机器 durable——非目标。均不取。
- **后果**：本机崩溃后可恢复；每次 checkpoint 有 IO 成本；`MemoryRunStore` 进程退出即丢。resume 绕过 Scheduler 是刻意取舍：恢复保持原 run_id、不受全局并发上限约束，调用方需自行避免与调度器的并发争用。
- **已知限制（qa C1-09b / DECISION-008 §8 A-2）**：resume 并发守卫仅为 **per-Host / per-store-instance**；多 Host 共享同一 `FileRunStore`、或跨进程同时恢复同一 run，不在 0.3 的协调范围，属部署错误。
- **关联**：ADR-025（参考实现先例）、ADR-032（事件回放）、ADR-037、DECISION-008 §4.1 / §8 Addendum A / §9.2。
