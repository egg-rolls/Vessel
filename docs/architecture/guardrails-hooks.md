---
title: Guardrail 与 Hook
kind: current
triggers: [guardrail, hook, replacement, input, output, tool_call, tool_result, before_llm]
paths: [packages/core/src/types/guardrail.ts, packages/core/src/types/hook.ts, packages/core/src/**/*runner*]
---

# Guardrail 与 Hook

<a id="guardrails"></a>

### `Guardrail`（`types/guardrail.ts`）

```ts
interface Guardrail {
  name: string;
  stage: GuardrailStage;
  check(value: unknown, ctx: GuardrailContext): Promise<GuardrailResult>;
  priority?: number;
}

enum GuardrailStage {
  Input = 'input',
  Output = 'output',
  ToolCall = 'tool_call',
  ToolResult = 'tool_result',
}

interface GuardrailResult {
  allowed: boolean;
  replacement?: unknown;
  reason?: string;
}
```

四个阶段任一 `allowed: false` 即短路（发 `guardrail.blocked`），随后沿用各阶段的 blocked 语义：Input / Output 终止 run，ToolCall 标记该调用被阻断，ToolResult 折回 tool 错误。`replacement` **真实生效**（ADR-035）：Input 改写持久化的用户消息；Output 改写返回值与持久化 assistant 消息；ToolCall 改写实际执行的调用（先于 assistant 消息写入）；ToolResult 改写事件、上下文与返回值。类型不符的 replacement 按未改写处理（Input/Output/ToolResult 只接受字符串，ToolCall 只接受合法 `ToolCall`）。

（ADR-054）`check()` 自身抛错按 **fail-closed** 处理——发 `guardrail.error`，返回 `{ allowed: false, reason: 'guardrail_error' }`，再走上述 blocked 语义；原始异常不再冒泡成 run 失败。

<a id="hooks"></a>

### `Hook`（`types/hook.ts`）

```ts
interface HookContext {
  run_id: string;
  session_id?: string;
  /** 只读：会话基底 system；写入被忽略并发 hook.system_prompt_ignored */
  readonly systemPrompt?: string;
  /** BeforeLlm 唯一的注入位：尾部追加消息（持久化，不写 system） */
  messages?: Message[];
  [key: string]: unknown;
}

interface Hook {
  name: string;
  priority?: number;
  type: HookType;
  run(ctx: HookContext): Promise<void | HookResult>;
}

interface HookResult {
  /** BeforeTool：阻断并折回 tool 错误 */
  block?: boolean;
  reason?: string;
  /** BeforeTool：改写工具输入 */
  updatedInput?: unknown;
  /** @deprecated 不再进 system；runtime 自动转成 vessel:hook 尾部消息 */
  additionalContext?: string;
}

enum HookType {
  BeforeLlm = 'before_llm',
  AfterLlm = 'after_llm',
  BeforeTool = 'before_tool',
  AfterTool = 'after_tool',
  OnError = 'on_error',
}
```

`HookResult` 只承载当次 hook 的决定；跨 hook 注入统一写 `HookContext.messages`。
BeforeLlm 的 system 冻结，动态上下文只能尾部追加（见 [context](context.md#prefix)）。

（ADR-054）`HookRunner` 对每个 hook 独立 try/catch。某个 hook 抛错时发 `hook.failed`（兼容既有订阅方）与 `hook.error`（统一信号），继续执行后续 hook，不终止 run，也不丢弃已聚合的结果。

