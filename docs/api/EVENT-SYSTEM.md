# 事件流系统接口（EVENT-SYSTEM）

> **系统职责**：Vessel 的跨组件异步沟通总线——runtime→观测、工具↔TUI、交互暂停。
> **决策**：ADR-027（事件名开放）、ADR-030（事件名一律开放字符串字面量，舍弃常量）。

---

## 1. 系统职责

事件流是 Vessel 的**组件间沟通协作通道**。除「反馈系统」（工具结果直接 `context.add` 写上下文）外，跨组件协作一律通过事件流：

- runtime → TUI/审计/日志（观测）
- 工具 ↔ TUI（交互暂停、ask-user、permission 确认）
- 新事件类型（插件自定义）——零 import、零 core 变更

## 2. 核心接口

```typescript
// ADR-027：事件名 + payload 开放——插件可发布任意字符串事件名，无需改 core
interface EventStream {
  subscribe(handler: (e: RunEvent) => void): Unsubscribe;
  publish(e: RunEvent): void;
  clear(): void;
  getHistory(runId?: string): RunEvent[];
  // ADR-027：等待一次匹配事件（工具交互暂停原语）
  waitFor(name: string, opts?: { requestId?: string; timeout?: number }): Promise<unknown>;
}

// ADR-030：事件名一律开放字符串字面量，无常量/枚举
interface RunEvent {
  type: string;                       // 事件名即开放字符串协议
  run_id: string;
  data: EventPayload | Record<string, unknown>;
  ts: number;
}
```

**实现**：`MemoryEventStream`（`packages/core/src/events/event-stream.ts`）。

## 3. 事件声明规范（ADR-030）

- **全部事件用开放字符串字面量**，不定义任何事件常量（`EventType` / `PermissionEvent` 已废弃）。
- **命名空间约定**：`<domain>.<action>.<event>`（如 `replay.started`、`ask.user.answered`、`tool.<name>.<event>`）。
- **拼写错误靠集成测试缓解**，不靠常量挡——断言"发布 X 后订阅者收到"。

**核心事件名（参考）**：

| 事件名 | payload | 发布方 |
|---|---|---|
| `'run.started'` | RunStartedPayload | agent-runtime |
| `'llm.request'` | LlmRequestPayload | agent-runtime |
| `'llm.response'` | LlmResponsePayload | agent-runtime |
| `'llm.stream.chunk'` | LlmStreamChunkPayload | agent-runtime |
| `'tool.call.started'` | ToolCallStartedPayload | agent-runtime |
| `'tool.call.completed'` | ToolCallCompletedPayload | agent-runtime |
| `'tool.call.failed'` | ToolCallFailedPayload | agent-runtime |
| `'guardrail.blocked'` | GuardrailBlockedPayload | agent-runtime |
| `'run.completed'` | RunCompletedPayload | agent-runtime |
| `'run.failed'` | RunFailedPayload | agent-runtime |

**特性事件名（约定）**：`tool.permission.request` / `tool.permission.response`（权限）、`ask.user.requested` / `ask.user.answered`（ask-user）。插件可自定义任意 `<domain>.*` 事件名，无需改 core。

## 4. 协作模式

| 模式 | 用法 | 场景 |
|---|---|---|
| 发布 / 订阅 | `publish(name, data)` / `subscribe(name, handler)` | 观测、审计、通知 |
| 交互暂停 | 工具 `publish` 请求事件 → `waitFor` 回复事件（`requestId` 防串台） | ask-user、permission 确认 |
| 事件驱动恢复 | `waitFor` resolve 后 handler 继续，loop 自然恢复 | 暂停型工具（`interactive: true`） |

## 5. 与其他机制的边界（防混合）

Vessel 有三种机制，职责必须分明——**不要混用**：

| 机制 | 职责 | 例子 | 混用后果 |
|---|---|---|---|
| **事件流** | 跨组件异步沟通 | runtime→观测、工具↔TUI | 把内部调用事件化 → 关键路径不可靠 |
| **直接调用** | core 内部实现 / 关键路径（可靠、有序） | `context.add`、`provider.chat`、`pluginHost.invoke` | 把协作直接调用 → 耦合 |
| **Hook / Guardrail** | 同步生命周期拦截 | BeforeLlm、ToolCall guardrail | 用事件流实现拦截 → 竞态 |

**判断标准**：
- 可丢失、多消费者、要解耦 → **事件流**
- 必须可靠、有序、单消费者、关键路径 → **直接调用**
- 同步拦截、阶段检查 → **Hook / Guardrail**

**分层事件驱动原则（ADR-031）**——内聚核心用直接调用保证及时性，外层协作必须事件驱动：

| 层 | 机制 | 例子 |
|---|---|---|
| **内聚核心**（上下文 / 工具反馈） | **直接调用 + 事件观测**（代码加入 + 消息发布双轨） | `context.add` + `context.changed`；工具结果 `context.add` + `tool.call.completed` |
| **外层协作**（工具↔TUI / 观测 / 交互暂停） | **必须事件驱动**（字符串事件名） | ask-user、permission、runtime→观测 |

判断：需要**及时性 / 可靠性** → 直接调用 + 观测；需要**解耦 / 可观测** → 事件流。

## 6. 参考

- [ADR-027](../specs/ADR.md)（事件开放）
- [ADR-030](../specs/ADR.md)（事件名一律字符串，舍弃常量）
- [CORE.md](CORE.md)（核心运行时接口）
- [plugin-dev.md](../guides/plugin-dev.md)（工具如何用事件流交互）
