# 任务3：流式核心（Streaming Core）

> egg-rolls 分工。解锁 emma 的流式渲染（emma 任务3）。完全在 `@vessel/core` 内，不碰 cli.ts 的 REPL。
> 实现参照 Claude Code 与 Hermes 的流式模式（参考实现调研进行中，SSE 解析细节在实现阶段据其补全）。

## 一、现状与问题

- `OpenAICompatibleProvider` / `AnthropicProvider` 硬编码 `stream: false`（providers.ts:160, body）。
- `LLMProvider.chat()` 只返回完整 `LLMResponse`，无增量通道。
- `AgentRuntime.toolCallingLoop` 调 `provider.chat()` 后整段处理，token 不到达不渲染。
- emma 的 `StreamRenderer` 已订阅 EventStream 并 switch 各 EventType，但**没有流式文本事件可订阅**——它只能等 `LlmResponse`（整段）。

## 二、设计约束（来自宪法）

| 约束 | 来源 | 对设计的要求 |
|------|------|------------|
| 流式 = 订阅事件流，**非独立方法** | SPEC §4.1 / ADR-007 | `LLMProvider` 不新增 `chatStream()` 方法；`chat()` 仍返回完整 `LLMResponse` |
| loop 在 LLM 流式响应时增量发事件 | ADR-007 | **runtime 拥有事件发布**，provider 只回调吐 chunk |
| 事件类型枚举化 + payload schema | ADR-008 | 新增 `LlmStreamChunk` 枚举成员 + payload |
| 改 core 扩展面须先写 ADR | ADR-012(2a)(3) | 加 EventType 是扩展"插座"，允许，但需 ADR-016 |
| core 不绑厂商/重依赖 | §6 红线 | SSE 解析自实现，不引 SDK |

## 三、方案：`on_chunk` 回调 + `LlmStreamChunk` 事件

核心思想：**`chat()` 签名不变**（仍 `Promise<LLMResponse>`），`ChatRequest` 增两个可选字段。Provider 流式时边收边调 `on_chunk`，最终仍返回拼装好的 `LLMResponse`。Runtime 在闭包里把 `on_chunk` 接成 `LlmStreamChunk` 事件发布。

```
Provider(stream:true) ──on_chunk(delta)──> Runtime ──publish(LlmStreamChunk)──> EventStream ──> emma StreamRenderer
      │                                                                                         (headless 无订阅者：chunk 静默丢弃，最终 console.log(resp) 不变)
      └── 拼装 content + tool_calls + usage ──> return LLMResponse ──> Runtime 继续工具循环
```

**为什么是这个方案（而非备选）**：
- ❌ 新增 `chatStream()` 异步迭代器方法 → 违 SPEC §4.1 "非独立方法"。
- ❌ Provider 持有 EventStream 引用直接 publish → 把 core 事件系统耦合进每个 provider 插件，且违 ADR-007"loop 增量发事件"（发布权应在 loop）。
- ✅ `on_chunk` 回调：provider 只吐原始 chunk（不识 EventStream），loop 拥有回调、负责发布。provider 可测、可替换、与事件系统解耦。非流式 provider 忽略字段即退化为现状（向后兼容）。

### 3.1 类型新增（`packages/core/src/types/provider.ts`）

```ts
/** 流式 chunk（provider 吐给 loop 的增量单元） */
export interface StreamChunk {
  type: 'text_delta' | 'tool_call_delta' | 'finish';
  delta?: string;                  // text_delta：文本增量
  tool_call_index?: number;        // tool_call_delta：第几个 tool_call（按 index 累积）
  tool_call_id?: string;           // tool_call_delta：首次出现时带 id
  tool_call_name?: string;         // tool_call_delta：首次出现时带 name
  arguments_delta?: string;        // tool_call_delta：arguments 的部分 JSON 片段
  finish_reason?: FinishReason;    // finish
  usage?: Usage;                   // finish（usage 仅在流末尾可得）
}

// ChatRequest 增两个可选字段（签名不变，向后兼容）：
export interface ChatRequest {
  messages: Message[];
  model: string;
  tools?: ToolSchema[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;                 // 已存在
  session_id?: string;
  on_chunk?: (chunk: StreamChunk) => void;  // 新增
}
```

### 3.2 事件新增（`packages/core/src/types/event.ts`）

```ts
export enum EventType {
  ...,
  LlmStreamChunk = 'llm.stream.chunk',   // 新增
}

export interface LlmStreamChunkPayload extends BaseEventPayload {
  run_id: string;
  chunk: StreamChunk;            // 直接承载 provider 吐的 chunk
}
// 加入 EventPayload 联合类型
```

### 3.3 Provider 流式实现（`packages/core/src/provider/providers.ts`）

每个 provider 的 `chat()`：当 `req.stream && req.on_chunk` 时走流式分支，否则**完全保持现状**（现有测试不破）。

- **OpenAICompatibleProvider**：body 改 `stream: true`；读 `response.body`（Web Stream，`for await` 或 `getReader`）；按 SSE 解析 `data: {json}\n\n`，遇 `data: [DONE]` 结束；`choices[0].delta` 中：
  - `delta.content` → `on_chunk({type:'text_delta', delta})`
  - `delta.tool_calls[i]`（含 `index`/`id`/`function.name`/`function.arguments` 片段）→ `on_chunk({type:'tool_call_delta', tool_call_index, ...})`，本地按 `index` 累积 `arguments`
  - 末尾 `finish_reason` + `usage`（OpenAI 流式 usage 需 `stream_options:{include_usage:true}`）→ `on_chunk({type:'finish', finish_reason, usage})`
  - 返回拼装的 `LLMResponse`（content + tool_calls[] + usage）
- **AnthropicProvider**：SSE 事件 `message_start`/`content_block_start`/`content_block_delta`/`content_block_stop`/`message_delta`/`message_stop`；`text_delta` → text；`input_json_delta` → 累积 tool_use 的 `input`（部分 JSON）；`message_delta` 带 `stop_reason` + `usage`。同构拼装返回。
- **MemoryLLMProvider**：`on_chunk` 在场时把 echo 文本切成 2-3 段 `text_delta` 吐出，再 `finish`，仍返回完整 `LLMResponse`（供 runtime 流式测试，无需 mock fetch）。

> SSE 解析的具体事件形态/累积策略，实现时对照 Claude Code（Anthropic SDK stream）与 Hermes（调研结果）补全。

### 3.4 Runtime 接线（`packages/core/src/runtime/agent-runtime.ts`）

`toolCallingLoop` 中构造 `ChatRequest` 处加：

```ts
const request: ChatRequest = {
  messages,
  model: this.model,
  tools: toolSchemas.length > 0 ? toolSchemas : undefined,
  session_id: sessionId,
  stream: true,
  on_chunk: (chunk) => {
    this.publishEvent({
      type: EventType.LlmStreamChunk,
      run_id: runId,
      data: { run_id: runId, chunk },
      ts: Date.now(),
    });
  },
};
```

- **始终传 `stream:true`+`on_chunk`**：支持流式的 provider 走 SSE；不支持的 provider 忽略字段、返回完整响应，退化为现状（无 chunk 事件，无副作用）。headless 无订阅者时 chunk 静默丢弃，最终 `console.log(resp)` 不变。
- 后续 `response` 处理逻辑（finish_reason 分支、tool_calls 执行）**完全不变**——provider 已拼装好完整 `LLMResponse`。

### 3.5 导出（`packages/core/src/index.ts` / `types/index.ts`）

`StreamChunk` 经 `types/provider.ts` → `types/index.ts`（`export *`）→ `index.ts`（`export * from types`）自动导出。无需额外行（确认即可）。

### 3.6 ADR-016（`docs/specs/ADR.md`）

新增 ADR 记录：扩展 EventType 增加 `LlmStreamChunk`，承载 LLM 流式增量；依据 ADR-007（流式=事件订阅，loop 增量发事件）+ ADR-012(2a)（扩展"插座"允许）；Consequences：TUI 可 token-by-token 渲染；非流式 provider 退化为无 chunk 事件。

## 四、测试（任务5 子项）

新增/补充（`packages/core/__tests__/`）：

1. `provider.test.ts`：
   - `MemoryLLMProvider` 流式：传 `stream:true`+`on_chunk`，断言收到 ≥2 个 `text_delta` + 1 个 `finish`，且返回的 `LLMResponse.content` 与非流式一致。
   - `OpenAICompatibleProvider` 流式：mock `fetch` 返回 `ReadableStream<Uint8Array>`（手搓 SSE `data:` 行，含 `delta.content` 与 `delta.tool_calls` 片段 + `[DONE]`）；断言 `on_chunk` 收到 text_delta 与 tool_call_delta（arguments 片段正确累积），返回的 `tool_calls[].function.arguments` 是完整 JSON。
   - 非流式回归：不传 `stream`/`on_chunk` 时行为与现状一致（现有用例不变）。
2. `agent-runtime.test.ts`：
   - 订阅 EventStream，`runtime.run()`，断言事件序列含 `LlmStreamChunk`（用 MemoryLLMProvider 流式）。
   - 现有"should emit events during run"用 `toContain` 断言，加新事件不破。

## 五、验证

```bash
bun test                      # 67 → 67+N 全过
bun run typecheck             # tsc --noEmit
bun run lint                  # biome
bun run build                 # bun build
```

docs 自检：`grep -rn "当前|目前|现在|暂不|延后|pre-MVP" docs/specs/ docs/guides/ docs/api/`（ADR-016 新增文本须无禁用词）。

## 六、不改的（边界守住）

- 不动 cli.ts 的 REPL（emma 的接缝任务0）。
- 不动 emma 的 `StreamRenderer`（她补 `LlmStreamChunk` case）——但我确保事件 payload 形状清晰可消费。
- 不引 LangChain / SDK。
- 不给 core 加厂商 Key/价格。
- `LLMProvider` 接口签名不变（只 `ChatRequest` 加可选字段）。

## 七、文件清单

| 文件 | 改动 |
|------|------|
| `packages/core/src/types/provider.ts` | +`StreamChunk`；`ChatRequest` +`on_chunk` |
| `packages/core/src/types/event.ts` | +`LlmStreamChunk` 枚举 + payload + 联合 |
| `packages/core/src/provider/providers.ts` | 三个 provider 加流式分支 |
| `packages/core/src/runtime/agent-runtime.ts` | `ChatRequest` 接 `stream:true`+`on_chunk` 发事件 |
| `packages/core/__tests__/provider.test.ts` | 流式 + 非流式回归 |
| `packages/core/__tests__/agent-runtime.test.ts` | `LlmStreamChunk` 事件断言 |
| `docs/specs/ADR.md` | +ADR-016 |
| `processes/task-assignment.md` | 勾选 egg-rolls 任务3 |

## 八、后续（本计划之外，待任务0 接缝后）

任务2（provider 注册制接线 cli.ts 壳）、任务1（插件加载）、任务4（权限 guardrail 注册）都改 cli.ts 壳，需先与 emma 定 `ctx` 契约（任务0）。本计划只做不依赖接缝的流式核心。
