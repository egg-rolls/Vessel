---
adr: 32
title: 事件回放——FileEventStore + replayRun
status: accepted
date: null
related: [17, 25, 27, 30]
---

## ADR-032：事件回放——FileEventStore + replayRun

- **上下文**：[#79](https://github.com/egg-rolls/Vessel/issues/79) 要求实现事件回放（event replay）：从持久化的 JSONL 事件日志读取历史事件，经 `EventStream.publish()` 重新发布，使 TUI/订阅者通过同一 `subscribe()` 回看历史 run，不区分 live/replay。SPEC §3.3 规定"trace / replay / TUI 流式渲染订阅同一流"——replay 是 EventStream 的内置场景。ADR-030 后事件名开放（新增事件零 core 事件类型变更），但"从哪读、如何回放"仍需持久化存储与回放函数。
- **决策**：
  1. 新增 `FileEventStore`（`packages/core/src/events/file-event-store.ts`）：JSONL 持久化（一行一事件），提供 `append` / `readRun` / `listRunIds` / `deleteRun`。与 `FileSessionBackend` / `SQLiteSessionBackend` 同为 core 基础设施的持久化参考实现（ADR-025 先例）。
  2. 新增 `replayRun(store, runId, eventStream, { delayMs })`（`packages/core/src/events/replay.ts`）：读指定 run 事件，先发布 `replay.started`，按序发布原始事件（保留原始 `ts`），最后发布 `replay.completed`；返回原始事件数。
  3. 事件名 `replay.started` / `replay.completed` 为**开放字符串字面量**（ADR-030）——不定义枚举/常量、不新增 `EventPayload` 类型，payload schema 见 [EVENT-SYSTEM.md §3](../api/EVENT-SYSTEM.md)。
  4. `FileEventStore.append` 用追加模式（O(1)，避免整文件重写）；`append` 与 `deleteRun` 是独立 IO 操作，多进程并发写同一文件可能数据竞争——假定单进程写入。
- **理由**：
  1. **为何进 core**：replay 是 EventStream 内置场景（SPEC §3.3）；`FileEventStore` 与已进 core 的 `FileSessionBackend` / `SQLiteSessionBackend` 对称，同为 SPEC 规划的持久化参考实现——按 ADR-025，完成既定参考实现不构成解冻；存储是 runtime 回放链路的近邻，打成插件增加加载顺序与类型引用摩擦。
  2. **为何开放字符串事件名**：与 `run.started` / `run.completed` 同构；TUI 需要"直播 vs 回放"显式边界信号（进度/暂停/调速），优于靠 `ts` 远小于 `Date.now()` 猜测（否决方案 B）。
  3. **不往 `RunEvent` 加 `isReplay` 字段**：回放事件本身不变，只在外层包标记事件，核心数据结构零改动。
- **备选**：(a) 不加边界信号，靠原始 `ts` 检测回放——丢失显式边界，TUI 无法准确渲染回放进度/暂停/速度；(b) 单事件 `run.replayed` + `phase` 字段——payload 语义不统一。均不取。
- **后果**：订阅者经同一 `subscribe()` 接收 live 与 replay 事件；回放进度/暂停/调速由 TUI 订阅标记事件实现；新增事件零 core 事件类型变更（ADR-030）。限制：`FileEventStore` 是唯一后端实现，未来若出现 SQLite/内存事件存储，需提取 `EventStore` 接口（预留，不阻断）。
- **关联**：ADR-017（解冻说明：本 ADR 不修改冻结接口/loop，仅新增参考实现模块）、ADR-025（参考实现先例）、ADR-027、ADR-030；[EVENT-SYSTEM.md](../api/EVENT-SYSTEM.md)；[#79](https://github.com/egg-rolls/Vessel/issues/79)。
