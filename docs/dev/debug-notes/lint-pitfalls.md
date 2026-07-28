# Lint 踩坑笔记：feat/headless-single-run 修复复盘

> 时间：2026-07-28
> 起因：`feat/headless-single-run` 分支审查发现 `bun run lint`（`biome ci`）失败。
> 实际为 **34 个 warning（0 error）**，已全部修复。本文记录**出现多次的错误模式**与正解，供后续编码避坑。
> 配套审查报告：`docs/dev/reviews/feat-headless-single-run-review.md`

---

## 速查表

| 规则 | 出现次数 | 一句话正解 |
|------|---------|-----------|
| `lint/style/noNonNullAssertion` | 19 | 别用 `!`；用 `?? 默认值` / 守卫 / `flatMap` 收窄 / 一次 `get` |
| `lint/suspicious/noEmptyBlockStatements` | 9 | `() => {}` → `() => undefined`；吞错 catch 加注释 |
| `lint/suspicious/noExplicitAny` | 4 | 定义行 interface；跨插件字段用 `host as Record<string, unknown>` |
| `suppressions/unused` | 2 | 删掉；加 `biome-ignore` 前先确认规则开启且确实触发 |

---

## 模式 1：非空断言 `!`（19 次，最大头）

### 1A 测试里 `find(...)!` / `[0]!` 后接方法调用（10 处）

```ts
// ❌ 以为前面 expect().toBeDefined() 了就安全
const hook = host.getHooks().find((h) => h.type === HookType.BeforeLlm);
expect(hook).toBeDefined();
await hook!.run(ctx);   // TS 不跨语句收窄；且若改 ?. 会静默跳过断言（测试假绿）

// ✅ 显式 throw 守卫：消掉 !、又保留"未注册即失败"语义
const hook = host.getHooks().find((h) => h.type === HookType.BeforeLlm);
if (!hook) throw new Error('BeforeLlm hook not registered');
await hook.run(ctx);
```

**要点**：`expect(x).toBeDefined()` 不能让 TS 收窄类型，`!` 仍被规则禁止；`?.` 在测试里是错的（undefined 时静默 no-op，断言不成立却过测）。守卫是唯一两全其美的写法。涉及文件：`memory-auto / memory-project / hook-logging / guardrail-pii / redact-secrets / tool-policy` 的 `__tests__`。

### 1B 生产代码 `this.config.field!`，构造函数已赋默认值（4 处）

```ts
// ❌ 构造里 this.config.x = config.x ?? 默认值; 但字段类型仍是 T | undefined
const skillsDir = this.config.skillsDir!;

// ✅ 与构造一致的 ?? 默认值
const skillsDir = this.config.skillsDir ?? './skills';
```

**要点**：构造函数赋了默认值 ≠ 类型变窄。要么用 `?? 默认值`（与构造一致），要么把存储字段类型声明为非可选。涉及：`context-manager / hook-logging / skills-loader`。

### 1C `Map.has(k)` 紧跟 `Map.get(k)!`（2 处）

```ts
// ❌ 两次查找 + 非空断言
if (msg.id !== undefined && this.pending.has(msg.id)) {
  const { resolve, reject } = this.pending.get(msg.id)!;

// ✅ 一次查找，守卫收窄
if (msg.id !== undefined) {
  const pending = this.pending.get(msg.id);
  if (pending) {
    const { resolve, reject } = pending;
```

涉及：`mcp-client`（`pending.get`）。

### 1D `.filter(c => c.x).map(c => c.x!)` 跨闭包不收窄（2 处）

```ts
// ❌ filter 检查了 c.text，但 map 是新闭包，TS 不收窄 c.text
.filter((c) => c.type === 'text' && c.text).map((c) => c.text!)

// ✅ flatMap 一步到位，条件分支内自然收窄
.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : []))
```

涉及：`mcp-client`（`callTool` / `readResource`）。

### 1E 可空来源直接 `!`（1 处）

```ts
// ❌ proc.stdout 类型是 Readable | null
const rl = createInterface({ input: proc.stdout! });

// ✅ 守卫 + 明确错误
if (!proc.stdout) { reject(new Error(`MCP server "${this.name}" has no stdout`)); return; }
const rl = createInterface({ input: proc.stdout });
```

涉及：`mcp-client`。

---

## 模式 2：空块 `{}`（9 次）

### 2A mock 桩 / 抑制输出的 `() => {}`（8 处）

```ts
// ❌ on_chunk、subscribe、console 抑制等空箭头体
on_chunk: () => {},
console.log = () => {};

// ✅ 表达式体（无块），或加注释
on_chunk: () => undefined,
console.log = () => undefined;
```

**要点**：`() => undefined` 是箭头表达式体，没有 `{}`，不触发规则；语义即"什么都不做"。涉及：`anthropic-streaming / event-stream / provider / tui-helpers / cli` 的测试与 mock。

### 2B 吞错 catch `.catch(() => {})`（1 处）

```ts
// ❌ 静默吞错，意图不明
reader.cancel().catch(() => {});

// ✅ 注释使块非空且说明为何忽略
reader.cancel().catch(() => { /* ignore cancel errors */ });
```

**要点**：吞错是合法操作，但必须写明意图。涉及：`providers.ts`（SSE reader cancel）。

---

## 模式 3：显式 `any`（4 次）

### 3A DB 行 `stmt.get() as any` / `stmt.all() as any[]`（3 处）

```ts
// ❌ 用 any 逃避定义行类型
const row = stmt.get(sessionId) as any;
const rows = stmt.all() as any[];

// ✅ 按 CREATE TABLE 定义行 interface
interface SessionRow {
  session_id: string;
  run_id: string;
  messages: string;
  status: RunState['status'];   // 注意：status 是联合类型，要对齐
  // ...
}
const row = stmt.get(sessionId) as SessionRow | null;
```

**坑**：把 `any` 改成行 interface 后，`status: string` 会与 `RunState['status']` 联合类型冲突（typecheck 报错）。行 interface 的 `status` 字段必须显式用 `RunState['status']`。涉及：`sqlite-backend`（`load` / `list` / `listRich`）。

### 3B 跨插件私有字段 `(host as any).__field = ...`（1 处）

```ts
// ❌ meta-tools 用 as any 挂私有字段
(host as any).__assetManager = assetManager;

// ✅ 对齐代码库已有模式
(host as Record<string, unknown>).__assetManager = assetManager;
```

**根因未除**：PluginHost 缺正式的跨插件扩展面，各插件靠 cast 挂私有字段（`__mcpManager` / `__skillsManager` / `__assetManager`）。当前对齐到 `Record<string, unknown>` 消掉 `any`；若要根治，值得提 ADR 给 PluginHost 加一个带类型的扩展槽。涉及：`meta-tools`（`mcp-client` / `skills-loader` 已是正解写法）。

---

## 模式 4：死 suppression（2 次）

```ts
// ❌ biome.json 里 useNamingConvention: "off"，这条 suppression 毫无作用
// biome-ignore lint/style/useNamingConvention: LLM API protocol fields (OpenAI/Anthropic)

// ✅ 直接删掉
```

**要点**：写 `biome-ignore` 前必须确认（1）该规则在 `biome.json` 开启、（2）下一行确实触发它。否则 `suppressions/unused` 会报"无效 suppression"。涉及：`providers.ts` / `types/provider.ts`。

---

## 元教训

1. **审查统计要基于实际 `biome ci` 输出**。本次审查报告记"105 错误、34 警告"，实际是 34 warning / 0 error（疑似 biome 版本差异或口径问题）。审查数字要能复现，别用估算。
2. **`biome ci` 把 warning 也当失败**。即使 0 error、34 warning，`bun run lint` 仍非零退出，build 跟着挂。所以 warning 不能留。
3. **修 lint 后跑 formatter**。手写的多行链式调用（如 `flatMap`）可能与 biome 格式偏好不符，`bun run format` 自动修；修完再跑一次 `lint` 确认。
4. **`useNamingConvention` 当前是 off**。LLM API 的 `snake_case` 字段（`api_key` / `prompt_tokens`）目前不触发命名规则，无需 suppression。

---

## 修复后校验

```
bun run lint       ✅  0 warning, 0 error
bun run typecheck  ✅
bun test           ✅  130 pass, 0 fail
bun run build      ✅
```
