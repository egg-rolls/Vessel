# @vessel/tui API —— emma UI/UX 替换接口文档

> **受众**：emma，仅做 UI 替换，不写功能逻辑。
> **状态**：egg-rolls 已交付完整可跑的 readline REPL。本文件描述接缝契约与可替换清单。

## 1. 入口：`startRepl(ctx)`

```ts
import { startRepl, type ReplContext } from '@vessel/tui';

const ctx: ReplContext = { /* 见 §2 */ };
await startRepl(ctx); // 阻塞至 /exit
```

emma 的版只需要实现**同一个函数签名**——用 Ink 框架替换内部实现，函数名和参数不变。壳（`src/cli.ts`）不感知替换。

## 2. ReplContext 字段

```ts
interface ReplContext {
  // ── 核心能力（壳注入，只读）───────────────
  runtime: AgentRuntime;          // 调 runtime.run(input, sessionId) 执行对话
  tools: ToolRegistry;            // /tool list 用 tools.list() 列工具
  session: SessionBackend;        // /session * 增删改查；有 listRich() 返回 SessionInfo[]
  events: EventStream;            // 订阅 LlmStreamChunk + 工具调用 + RunCompleted
  context: ContextManager;        // /session new/resume 用 context.clear() 清上下文

  // ── 可变状态 ─────────────────────────────
  currentSessionId: string;       // 当前会话 ID；/session resume/new 会改
  onSessionChange: (id) => void;  // 切换会话后回调（壳更新 currentSessionId）

  // ── 显示信息（只读）───────────────────────
  provider: { name: string; model: string; baseUrl: string };
  plugins: string[];              // 已加载插件名列表
  config: VesselConfig;           // VesselConfig（全 camelCase，ADR-019）
  permissionChecker?: ToolPermissionChecker; // 注入 promptFn 用（§3.3）

  // ── 工具函数 ─────────────────────────────
  newSessionId: () => string;     // 格式 YYYYMMDD_HHMMSS_{6hex}（照搬 Hermes）

  // ── 生命周期 ─────────────────────────────
  onExit: () => void;             // /exit 调；壳负责 runtime.dispose() + process.exit()
}
```

## 3. 替换清单（逐个模块可换）

### 3.1 REPL 循环（readline → Ink）

**readline 版（egg-rolls 交付）**：`repl/repl.ts` 中 `startRepl()` 用 `node:readline/promises` + 行队列 + `process.stdout.write` 输出。

**替换**：emma 用 Ink 框架重写 `startRepl` 函数体——React 组件式终端 UI，保持以下行为：
- `rl.on('line', ...)` 行队列 → Ink `useInput()` 或 TextInput 组件
- `process.stdout.write('vessel> ')` 提示符 → Ink status bar
- `rl.on('SIGINT', ...)` Ctrl+C → Ink 键盘事件
- 行处理逻辑（pendingResume 裸数字 → resume、`/` 开头的命令分发、普通消息 → runtime.run）不改

**不动的接口**：`startRepl(ctx)` 函数签名、`ReplContext` 类型。

### 3.2 流式渲染（console.log token → token 动画 + spinner）

**readline 版（egg-rolls 交付）**：`renderer/stream-renderer.ts` 中 `StreamRenderer` 订阅 `ctx.events`，用 `process.stdout.write(chunk.delta)` 逐 token 打印。

**替换**：emma 把 `StreamRenderer` 换成 Ink 组件——订阅同一 `EventStream`，token 做打字机动画，工具调用做 spinner 卡片。

**事件订阅示例**：

```ts
// 订阅事件流 —— emma 在 Ink 组件 useEffect 中 subscribe
const unsubscribe = ctx.events.subscribe((event: RunEvent) => {
  switch (event.type) {
    case EventType.LlmStreamChunk: {
      // event.data = { chunk: StreamChunk }
      const { delta } = event.data.chunk; // 文本增量，逐 token
      // → 追加到 Ink 组件 state，打字机动画渲染
      break;
    }
    case EventType.ToolCallStarted: {
      // event.data = { tool_name: string, arguments: unknown, tool_call_id: string }
      // → 显示工具调用卡片（名称 + 参数）+ spinner
      break;
    }
    case EventType.ToolCallCompleted: {
      // event.data = { tool_name: string, result: string, duration_ms: number }
      // → 卡片从 spinner 变为 ✓ 完成
      break;
    }
    case EventType.ToolCallFailed: {
      // event.data = { tool_name: string, error: string, duration_ms: number }
      // → 卡片标记 ✗ 失败
      break;
    }
    case EventType.RunCompleted: {
      // event.data = { output: string, duration_ms: number, iterations: number, usage }
      // → 这次 run 结束，刷新 UI
      break;
    }
    case EventType.GuardrailBlocked: {
      // event.data = { guardrail_name: string, reason: string, stage: string }
      // → 显示拦截提示
      break;
    }
  }
});
```

`StreamChunk` 类型（三态）：
```ts
type StreamChunk =
  | { type: 'text_delta'; delta: string }               // 文本增量
  | { type: 'tool_call_delta'; tool_call_index: number;  // 工具调用增量
      tool_call_id?: string; tool_call_name?: string; arguments_delta?: string }
  | { type: 'finish'; finish_reason: string; usage?: Usage } // 流结束
```

**防退化**：`StreamRenderer.didStreamLastRun()` 用于判断是否流式输出了文本。若某次 run 没有流式 chunk（非流式 provider），退回打印 `runtime.run()` 返回值。emma 版的 StreamRenderer 需保持此兜底逻辑。

### 3.3 权限确认弹窗（readline confirm → 图形弹窗）

**readline 版（egg-rolls 交付）**：`renderer/tool-confirm.ts` 中 `ToolPermissionChecker.confirm()` 创建 readline 询问 `y/n/always`。

REPL 已通过 `ToolPermissionChecker.promptFn` 注入自定义提示函数，复用 REPL 的 readline 并阻止 `y/n` 泄漏进对话。

**替换**：emma 在 `startRepl` 中重设 `promptFn` 为 Ink 弹窗组件（如图形确认对话框），不再用 readline：

```ts
if (ctx.permissionChecker) {
  ctx.permissionChecker.promptFn = async (question: string) => {
    // → 渲染 Ink 确认弹窗，返回 'y' | 'n' | 'always'
    return await showConfirmDialog(question);
  };
}
```

`pausedForConfirm` 标志（`repl.ts` 中）在确认期间静默丢弃输入——emma 版本应改为缓存输入、确认结束后恢复的机制。

### 3.4 响应输出（console.log → Markdown + 颜色主题）

**readline 版（egg-rolls 交付）**：命令输出、错误提示、会话表格均用 `console.log` + ANSI 颜色码。

**替换**：emma 用 Ink 组件渲染富文本：错误提示用颜色标签、`/session list` 用表格组件、对话输出支持 Markdown。

**不动的逻辑**：`repl.ts` 中 `classifyError()` 的分类逻辑、`commands.ts` 中各命令的数据获取逻辑（调 `ctx.session.listRich()` 等）。

### 3.5 Slash 命令 `/` 弹菜单 + autocomplete + 模糊过滤

**readline 版（egg-rolls 交付）**：`commands/commands.ts` 中 `CommandRegistry.execute()` 做精确 `/domain action` 匹配，无弹窗。

**替换**：emma 在 Ink 中实现 `/` 触发弹菜单——读取 `CommandRegistry.list()` 获取所有域和子命令，做 autocomplete + 模糊过滤。**CommandRegistry 的 `execute()` 逻辑不动**——emma 只做触发层的 UI。

## 4. 不动的边界

以下模块 emma **不要改**：

| 层 | 文件 | 说明 |
|----|------|------|
| **core** | `packages/core/src/**` | ADR-017 冻结 |
| **config** | `packages/config/src/**` | 配置加载/校验/映射 |
| **壳** | `src/cli.ts` | argv 解析、config 加载、provider 构造、runtime 构造、插件加载、ReplContext 构造、headless 路径 |
| **命令逻辑** | `packages/tui/src/commands/commands.ts` | CommandRegistry、所有 `/session` `/tool` `/help` 等命令的业务逻辑 |
| **权限确认** | `packages/tui/src/renderer/tool-confirm.ts` | `ToolPermissionChecker` 判断逻辑、`createPermissionGuardrail` |
| **向导** | `packages/tui/src/wizard/setup-wizard.ts` | `runSetupWizard()` 流程——emma 只打磨 `/setup` 命令中调用后的 UI 提示 |
| **Rich 渲染** | `packages/tui/src/rich-renderer.ts` | `buildBanner/buildSessionTable/infoPanel/divider` —— emma 可替换其实现但保持签名 |
| **会话逻辑** | `packages/tui/src/repl/repl.ts` 中的 session/id 管理 | `currentSessionId`、`pendingResume`、会话切换逻辑不变 |

## 5. 调用示例（壳视角——emma 参考但不改）

```ts
// src/cli.ts — 壳构造 ctx，调 startRepl（egg-rolls 已实现）
const ctx: ReplContext = {
  runtime, tools, session, events, context,
  currentSessionId,
  onSessionChange: (id) => { currentSessionId = id; },
  provider: { name: 'openai', model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' },
  plugins: ['meta-tools', 'skills-loader', 'file-ops', 'memory-project', ...],
  config,
  permissionChecker, // ToolPermissionChecker 实例，REPL 可设其 promptFn
  newSessionId: () => generateSessionId(),
  onExit: () => { runtime.dispose(); process.exit(0); },
};
await startRepl(ctx);
```

## 6. 关键接口速查

| 接口 | 来源 | 关键方法 |
|------|------|----------|
| `AgentRuntime` | `@vessel/core` | `run(input, sessionId?, opts?) → Promise<string>`, `ready`, `dispose()` |
| `EventStream` | `@vessel/core` | `subscribe(handler) → unsubscribe`, `clear()` |
| `EventType` | `@vessel/core` | 枚举：`RunStarted`, `LlmStreamChunk`, `ToolCallStarted/Completed/Failed`, `RunCompleted/Failed`, `GuardrailBlocked` |
| `SessionBackend` | `@vessel/core` | `load(sessionId)`, `save(RunState)`, `delete(id)`, `listRich() → SessionInfo[]` |
| `ToolRegistry` | `@vessel/core` | `list() → ToolDefinition[]` |
| `ContextManager` | `@vessel/core` | `clear()`, `messages`, `add(msg)` |
| `ToolPermissionChecker` | `@vessel/tui` | `promptFn?: (q: string) → Promise<string>`, `confirm(toolName, args) → Promise<PermissionResult>` |
| `CommandRegistry` | `@vessel/tui` | `list() → CommandEntry[]`, `execute(input, ctx, state) → Promise<CommandResult>` |
| `StreamRenderer` | `@vessel/tui` | `start(eventStream)`, `stop()`, `didStreamLastRun() → boolean` |
| `classifyError` | `@vessel/tui` | `classifyError(error) → ClassifiedError {category, message, hint}` |
