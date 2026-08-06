# ADR-019: EventType 新增 ReplayStarted / ReplayCompleted

**状态**：已接受  
**日期**：2026-08-06  
**决策者**：@lirui15970745019  

## 背景

Issue #79 要求实现事件回放（event replay）功能：从持久化的 JSONL 事件日志中读取历史事件，通过 EventStream 重新发布，使 TUI 和其他订阅者能够回看历史 run 的执行过程。

SPEC §3.3 规定 "trace / replay / TUI 流式渲染订阅同一流"——replay 是 EventStream 的内置使用场景。

## 决策

在 `EventType` 枚举中新增两个成员：

```typescript
ReplayStarted = 'replay.started',
ReplayCompleted = 'replay.completed',
```

并新增对应的 payload 接口：

```typescript
export interface ReplayStartedPayload extends BaseEventPayload {
  run_id: string;
  event_count: number;
}

export interface ReplayCompletedPayload extends BaseEventPayload {
  run_id: string;
  event_count: number;
  duration_ms: number;
}
```

## 理由

1. **Core freeze (ADR-017) 规则 1 明确允许**：新增 EventType/HookType/GuardrailStage 枚举成员属于"扩插座"操作，是 freeze 框架内允许的变更类型。

2. **回放边界信号必要**：TUI 需要知道当前渲染的是"正在直播"还是"历史回放"——ReplayStarted/ReplayCompleted 提供明确的开始/结束信号，使 TUI 能显示回放进度条、暂停按钮、速度控制等。

3. **保留原始事件不做修改**：不往 `RunEvent` 上加 `isReplay` 字段——那样会改变核心数据结构。回放事件本身不变，只在外层包标记事件。

4. **与现有 EventType 设计一致**：RunStarted/RunCompleted 是独立的事件对，ReplayStarted/ReplayCompleted 采用相同模式。

## 影响

- **Core**: `packages/core/src/types/event.ts` 新增 2 个枚举值 + 2 个 payload 接口 + 更新 EventPayload 联合类型
- **新增模块**: `packages/core/src/events/file-event-store.ts`（JSONL 存储）、`packages/core/src/events/replay.ts`（回放函数）
- **不修改**: EventStream 接口、MemoryEventStream、AgentRuntime tool-calling loop

## 替代方案

- **方案 B**：不加任何 EventType，只通过原始 ts 值让 TUI 检测回放（ts 远小于 Date.now()）。降低架构复杂度但丢失显式信号，TUI 无法准确判断回放边界。
- **方案 C**：加一个 RunReplayed 事件 + phase 字段（start/end）。减少枚举数量但 payload 语义不统一。

选择当前方案的理由：与现有 EventType 双事件对（Started/Completed）模式一致，消费端代码无需特殊判断 phase 字段。
