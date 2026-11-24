# 思考强度控制插件设计（q-thinking-plugin）

- 状态：设计完成（待 main 评审；开放问题见 §8.2）
- 分支：`design/q-thinking-plugin`（纯设计，不改代码）
- 产出：本文件；实施由 main 另行派单
- 协同：q-settings（设置域基础设施，已实施）/ model-registry（provider 路由）/ provider-openai / provider-anthropic

## 0. 任务与裁决方向

用户诉求：加插件控制模型思考强度——core 开放传入额外请求头，插件通过请求头接口加入思考强度控制系统和按钮。

main 裁决方向与本设计落点：

| # | 方向 | 本设计落点 |
|---|------|-----------|
| 1 | core provider 适配器开放 extra headers/params 透传钩子（请求期可注入） | §3：`ChatRequest.extra_headers / extra_params` + 适配器合并闸 + BeforeLlm `HookResult.requestExtras` 注入链 |
| 2 | 插件贡献 thinking-intensity 设置（contributes.settings，q-settings 自动发现）+ UI 控制 | §4.2 设置 schema + §4.7 composer 工具栏菜单按钮（通用 RPC 绑定菜单契约，additive） |
| 3 | 模型能力适配：不同 provider 参数不同，插件按 provider 映射；不支持优雅降级 | §4.6 映射表（effort / budget / toggle 三形状）+ §4.5 hook 降级规则 |
| 4 | 与现有 vision/plan 请求期机制衔接 + 风险 | §5 衔接 + §8 风险表 |

设计三原则（与仓库既有判据同源）：

1. **核心只有形状，知识在插件**（宪法第十三条，vision 先例）：core 只开放「额外头/参数」的
   透传形状与合并闸，**不认识** `reasoning_effort` / `thinking` / `enable_thinking` 任何一个词；
   「哪个 provider 的哪个模型吃哪个参数」全部是插件内的纯数据映射表。
2. **additive 零回归**（P0-13 判据）：缺省（无插件 / 档位 auto / 不支持的模型）时请求体与
   今天**逐字节相同**；所有新字段可缺省，旧宿主 / 旧 gateway / 旧插件一律按「没有」降级。
3. **坏插件不拖垮请求**（HookRunner 0.8 C2 先例）：注入内容违规 → 丢弃违规项 + 告警，
   绝不抛错中断请求；hook 抛错由 HookRunner 既有故障隔离兜底。

## 1. 现状调研（事实锚点）

### 1.1 provider 适配器的请求构造点（core）

`packages/core/src/provider/providers.ts`：

- **OpenAICompatibleProvider**（:357）
  - 非流式 `chat()`（:402）：body 字面量在 :466–473（`model / messages / tools /
    temperature / max_tokens / stream:false`）；headers 在 :475–476（`Content-Type` +
    `Authorization: Bearer`）；fetch :478。
  - 流式 `streamChat()`（:550）：`streamBody` :557–565（多 `stream:true` +
    `stream_options.include_usage`）；`streamHeaders` :567–568（同非流式）；fetch :570。
  - 两条分支的 body/headers 都是**局部字面量**，没有统一构造出口——合并闸必须覆盖 4 个点
    （openai body / openai headers / openai streamBody / openai streamHeaders）。
- **AnthropicProvider**（:640）
  - `buildRequestBody()`（:831–861）：流式/非流式**共用**的 body 构造（`model / temperature /
    max_tokens / messages / system / tools [/ stream]`）——body 合并闸只有这一个点。
  - headers 两处：非流式 :752–758、流式 :878–887（`Content-Type / x-api-key /
    anthropic-version`）。
- **MemoryLLMProvider**（:245）：测试/开发用，不发 HTTP——**忽略** extra 字段即天然降级。
- 请求体已有「请求期注入」先例：`attachment_plan`（0.56 视觉）由 ExecutionUnit 请求期算好、
  随 `chat()` 进来，适配器命中才改形状（:405–419）；`applyPromptCache`（:386）请求期打缓存
  断点。extra 透传与这两者同层、正交。

### 1.2 ChatRequest 形状与请求期链路

`packages/core/src/types/provider.ts`：

- `ChatRequest`（:138–168）：`messages / model / tools / temperature / max_tokens / stream /
  session_id / signal / include_reasoning / on_chunk / attachment_plan`。
  **今天没有任何 extra headers/params 字段**——这是本设计要开的口。
- `LLMProvider`（:251–264）：`chat(req)` + 可选 `vision?: VisionBackend`。vision 的判据
  （:254–262 注释）是「能力是 `(provider, model)` 的函数，挂在**实例**上而不是模型名映射表上，
  实例由插件构造时挂上」——provider 身份事实（§3.5）沿用同一挂载方式。
- `Message.reasoning_content`（:58–64）：thinking 模式的思维链**回传**已存在（DeepSeek 等
  API 要求下一轮回传，否则拒绝）。本设计只管「生成侧强度」，不动回传链。

请求期链路（每一跳都是既有代码）：

```
tool-calling-loop.ts
  hookCtx 构造（:397–418，run_id / session_id / request_index / refs）
  → HookRunner.run(BeforeLlm)（:419；hook-runner.ts:30 聚合 HookResult）
  → ctx.window.buildRequestMessages（:459）
  → ctx.provider.chat({messages, tools, sessionId, signal, rebuildMessages})（:488–494）
execution-unit.ts
  → createLoopContext.provider.chat = chatWithOverflowRetry（:3615）
  → chatWithOverflowRetry（:3699）：resolveAttachmentPlanFor（:3719，vision/plan 请求期解析）
  → llm.request 事件 + persistData 元信息（:3822–3866）
  → ChatRequest 字面量（:3883–3915，attachment_plan 条件注入 :3894）
  → this.provider.chat(request)（:3923）
```

**关键事实**：`LoopContext.model` 已存在（tool-calling-loop.ts:68，计价用）——hook 上下文
补 `model` 零新管道；`ProviderPort.chat` 参数（:126–133）是 loop→EU 的唯一请求通道，
extra 注入沿它 additive 一个字段即可。

### 1.3 BeforeLlm hook 机制（插件注入的既有通道）

- `HookType.BeforeLlm`（types/hook.ts:10）；`HookContext`（:18–51）有 `run_id / session_id /
  request_index / refs / systemPrompt(只读) / messages(注入位)`；`HookResult`（:57–69）有
  `block / reason / updatedInput / additionalContext(deprecated)`。
- `HookRunner.run`（runtime/hook-runner.ts:30–87）：按注册顺序执行、聚合返回值、
  **单 hook 抛错隔离**（发 `hook.error` 继续下一个，:70–83）。
- 插件经 `host.registerHook`（types/plugin.ts:87）注册——**PluginHost 无需新增注册面**。
  真实先例：doc-subscription / hook-logging / basic-tools 都 registerHook；skills 的环境卡
  走 BeforeLlm 注入位到达成员会话。
- hook 每轮（每次 LLM 请求前）执行一次；`request_index` 0 起。

### 1.4 provider 装配与身份（model-registry）

`src/runtime/model-registry-wiring.ts`：

- `resolveModel(ref)`（:289）→ `{provider, model}`；`ResolvedModel` 含
  **`protocol`**（'openai' / 'anthropic' / …）、`vendorId`、`wireModel`、`baseUrl`。
- `buildInstance`（:219）：唯一构造路径 `providerHost.getProvider(resolved.protocol)` 工厂；
  未注册 protocol + baseUrl → 复用 openai 工厂（:247）；openai 插件缺失 → 裸
  OpenAICompatibleProvider（:252）。
- `delegatingProvider`（:280–287）：每请求按缓存键取/建实例（凭证轮换下一请求生效），
  `req` 原样透传；vision 读当前实例能力。**wrapper 持有 `resolved`（含 protocol）**——
  provider 身份事实在这里挂最自然（§3.5）。
- provider 插件工厂（plugins/provider/openai/src/index.ts:56–86）：
  `Object.assign(wrapped, { vision: createOpenAiCompatVision() })`（:82）——包装器只包
  `chat`，能力是实例事实。anthropic 插件同形（plugins/provider/anthropic/src/index.ts）。
- **EU 今天不知道 provider 名**：`ExecutionUnitOptions`（types/plugin.ts:207）只有
  `provider: LLMProvider` + `model: string`。身份要么经实例事实（vision 先例），要么改
  options/装配链——§3.5 裁决前者。

### 1.5 插件贡献面（q-settings 已建 / toolbar / RPC 桥）

- **contributes.settings 已实施**（q-settings S3/S4）：manifest spec
  `{type, title?, titleKey?, description?, descriptionKey?, default?, enum?, keywords?,
  order?, minimum?, maximum?}`（src/plugin/plugin-manifest.ts:121 `PluginSettingSchema`；
  serve types.ts:298 `PluginSettingSpec`）；`plugins.list` 透传 → Web
  `settings-registry.ts` 归一化 → 设置弹窗「扩展」组自动发现；写路径
  `plugins.config.set`（gateway/methods/config.ts:639–721，write 权限，按 spec 校验，
  child 模式 `restartRequired:true`）。契约权威：docs/dev/plans/vscode-settings-design.md §4。
  **本插件声明 settings 即自动出现在设置弹窗，零 UI 代码。**
- **composer 工具栏**（0.51 additive）：`contributes.toolbar[]`（plugin-manifest.ts:153–164：
  `slot:'composer' / id / label / titleKey / icon / order`）；**v1 点击由宿主按 id 映射回调**
  （apps/web/src/domains/chat/composer-toolbar.ts:20–62），宿主没给 handler 的条目直接丢弃
  （不渲染死按钮）；已登记宿主动作仅 `attach-file`（:43–45）。插件拿不到宿主回调，
  v1 无插件内联执行——**菜单型控制需要 additive 扩展契约**（§4.7）。
- **插件 RPC 桥**：manifest `contributes.rpc[]`（name/description/permission read|write）→
  宿主注册 `plugin.<id>.<name>`；Web 侧 PluginFrame.tsx:156
  `client.rpc('plugin.<id>.<method>', params)`（iframe postMessage 桥 `vessel.plugin.rpc`，
  方法白名单校验）；embed 组件经 @vessel-agent/plugin-ui host.ts 同一桥。
  **插件后端状态 ↔ Web UI 的通道已存在，零新 gateway 方法。**
- panels 槽位只有 `run-detail / session-detail / nav`（plugin-manifest.ts:95）——没有
  composer 面板槽，工具栏是输入框旁唯一插件面。
- i18n：`contributes.i18n`（en / zh-CN）+ pluginT 插件私有字典（E9）。

### 1.6 思考相关的既有事实（避免重复造轮子）

- `include_reasoning`（ChatRequest:153 / EU options:243）：控制思维链**增量是否进事件流**
  （显示侧）；`ui.showReasoning` 是 Web 显示开关。**生成侧强度今天没有任何控制**——
  模型默认思考多少就是多少。本设计补的是生成侧，与显示侧正交（§5.2）。
- `reasoning_content` 回传链（providers.ts:441/448/535/607）：思考强度改变后思维链更长/更短，
  回传链原样工作，无需改动。
- usage：reasoning token 已计入 completion_tokens（fromOpenAiUsage / StreamAccumulator），
  强度调高的成本在既有计价/用量面可见（§5.6）。

## 2. 总体架构

```
┌────────────────────────── Web ──────────────────────────┐
│ composer 工具栏 [思考: 高 ▾]        设置弹窗「扩展」组      │
│   │ menu 契约（§4.7，通用）          │ contributes.settings │
│   │ plugin.thinking-intensity.      │ plugins.config.set   │
│   │   get_state / set_level         │（q-settings 已有）    │
└───┼─────────────────────────────────┼───────────────────┘
    ▼                                 ▼
┌────────────────── thinking-intensity 插件（in-process）─────────────────┐
│ 状态：Map<sessionId, level> + 全局默认（settings.default_level）          │
│ 映射表：(providerName, model) → {shape: effort|budget|toggle, levels}    │
│ BeforeLlm hook：读 ctx.session_id/model/providerName → 档位 → 映射       │
│   → HookResult.requestExtras {headers?, params?}（auto/不支持 ⇒ 不注入） │
└──────────────────────────────┬──────────────────────────────────────────┘
                               ▼ HookRunner 聚合（既有）
┌──────────────────────────── core ────────────────────────────────────────┐
│ loop：hookCtx += model/providerName → beforeLlm.requestExtras             │
│   → ProviderPort.chat args += requestExtras（additive）                   │
│ EU：chatWithOverflowRetry → ChatRequest.extra_headers / extra_params      │
│   （非空才带；llm.request persistData 记键名元信息）                       │
│ 适配器合并闸（§3.2）：openai body/headers ×2 分支 + anthropic body/headers │
│   保留键/危险头丢弃 + 上限 + 一致性规则；缺省 ⇒ 逐字节不变                 │
└──────────────────────────────┬───────────────────────────────────────────┘
                               ▼
                    provider wire（reasoning_effort / thinking / enable_thinking …）
```

数据流要点：

- **UI 不直接碰请求**：按钮只改插件状态（RPC）；状态在**请求期**经 BeforeLlm hook 变成
  extra——与 vision「请求期算 plan」同一节奏，UI 与请求构造完全解耦。
- **core 不认识任何思考参数**：合并闸只按「保留键/危险头/上限」做形状校验；
  `reasoning_effort` 对 core 只是一个普通透传键。
- **档位语义统一、wire 形状各异**：用户面对 `auto / off / low / medium / high` 五档；
  插件映射表负责翻译成各家参数；翻译不出 ⇒ 不注入（优雅降级）。

## 3. core 钩子设计（最小透传面）

### 3.1 ChatRequest additive 字段

```ts
// packages/core/src/types/provider.ts — ChatRequest 追加（全部可缺省）
export interface ChatRequest {
  // …既有字段一字不动…
  /**
   * 额外请求头（additive，q-thinking-plugin）。请求期由 BeforeLlm hook 注入
   * （HookResult.requestExtras.headers），EU 原样透传；**只有适配器读它**。
   * 合并闸见 provider/request-extras.ts：危险头（Authorization 等）丢弃 + 告警。
   * 缺省 / 空 ⇒ 请求头与今天逐字节相同。
   */
  extra_headers?: Readonly<Record<string, string>>;
  /**
   * 额外请求体参数（additive）。顶层浅合并进 body；core 保留键
   * （model/messages/tools/stream/…）不可覆盖，丢弃 + 告警。
   * 值必须 JSON 可序列化（函数/symbol/循环引用丢弃）。缺省 / 空 ⇒ 请求体逐字节相同。
   */
  extra_params?: Readonly<Record<string, unknown>>;
}
```

语义边界：

- **顶层浅合并**：`extra_params: { thinking: { type:'enabled', budget_tokens: 8192 } }` 整体
  作为 `body.thinking`；不做深合并（深合并语义歧义大，且各家参数都是顶层键或整块对象）。
- **只读投影**：适配器合并时克隆，绝不改 `req.extra_*` 原对象（共享对象污染判据，
  applyPromptCache 先例）。
- **不参与持久化**：extra 不进 Message / 会话存储 / 事件正文；`llm.request` persistData 只记
  键名元信息（§3.6）。
- **重试不变量**：extra 是「轮级」事实——overflow 压缩重试 / 传输层重试 / 空响应重调
  复用同一份 extra（与 attachment_plan 每 attempt 重算不同：plan 依赖消息视图，extra 不依赖）。

### 3.2 适配器合并闸（新文件 `packages/core/src/provider/request-extras.ts`）

两个纯函数 + 常量，全部适配器接入点共用（下表 6 行 / 7 个调用点）：

```ts
/** 危险头 denylist（小写比较）：认证 / 传输 framing / 协议版本钉死。 */
export const RESERVED_HEADERS: readonly string[] = [
  'authorization', 'x-api-key', 'cookie', 'set-cookie', 'host',
  'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'upgrade', 'expect', 'te', 'trailer', 'proxy-authorization',
  'content-type',            // 必须保持 application/json
  'anthropic-version',       // 适配器钉死 2023-06-01，不允许插件漂移协议版本
];

/** core 保留 body 键：请求形状的所有权属于 core，插件不得覆盖。 */
export const RESERVED_BODY_KEYS_OPENAI = [
  'model', 'messages', 'tools', 'stream', 'stream_options', 'temperature', 'max_tokens',
] as const;
export const RESERVED_BODY_KEYS_ANTHROPIC = [
  'model', 'messages', 'system', 'tools', 'stream', 'temperature', 'max_tokens',
] as const;

/** 上限（超限项丢弃 + 一次性告警，不抛错） */
export const EXTRA_LIMITS = {
  maxHeaders: 16, maxHeaderKeyLen: 64, maxHeaderValueLen: 1024,
  maxParamKeys: 16, maxSerializedBytes: 8192,
} as const;

export function mergeExtraHeaders(
  base: Record<string, string>,
  extra: Readonly<Record<string, string>> | undefined,
  warn: (msg: string) => void,
): Record<string, string>;

export function mergeExtraParams(
  base: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> | undefined,
  reserved: readonly string[],
  warn: (msg: string) => void,
): Record<string, unknown>;
```

合并规则（两函数同口径）：

1. `extra` 缺省 / 空对象 ⇒ **返回 base 原对象**（调用点据此保持字面量逐字节不变）。
2. 逐项校验：头名过 denylist（大小写不敏感）/ 参数键过 reserved；键长 / 值长 / 条数 /
   序列化字节上限；值类型（头必须 string；参数必须 JSON 可序列化——`JSON.stringify`
   成功且不含函数/symbol/循环引用）。
3. 违规项**丢弃 + warn 一次**（按「插件名+键」去重，进程内只告警一次，避免每轮刷屏）；
   合法项照常合并。绝不抛错——坏注入不能中断请求（HookRunner 故障隔离同判据）。
4. 头名统一小写写入（HTTP/2 口径；fetch 对大小写不敏感，统一后逐字节可预测）。
5. 参数合并顺序：`{ ...base, ...合法extra }`——extra 只增键，不改 base 既有键
   （reserved 校验已保证不覆盖）。

适配器接入点（providers.ts，共 6 处调用、2 个 provider）：

| provider | 点 | 改法 |
|----------|----|------|
| OpenAICompatibleProvider.chat | body :466 | `mergeExtraParams(body, req.extra_params, RESERVED_BODY_KEYS_OPENAI, warn)` |
| 同上 | headers :475 | `mergeExtraHeaders(headers, req.extra_headers, warn)` |
| OpenAICompatibleProvider.streamChat | streamBody :557 | 同 body（reserved 同表） |
| 同上 | streamHeaders :567 | 同 headers |
| AnthropicProvider.buildRequestBody | body :848 | `mergeExtraParams(body, req.extra_params, RESERVED_BODY_KEYS_ANTHROPIC, warn)` + §3.2.1 一致性规则 |
| AnthropicProvider.chat / streamChat | headers :752 / :878 | `mergeExtraHeaders(...)`（两处同改） |

`warn` 注入：适配器构造期可选 `on_extra_warning?: (msg: string) => void`（工厂 config 透传，
缺省走 core 既有 `writeStderrNotice` 一次性口径）；不新增 logger 依赖。

#### 3.2.1 Anthropic 一致性规则（thinking × temperature × max_tokens）

Anthropic extended thinking 有两条硬约束（官方文档）：启用 thinking 时 temperature 必须为 1
（默认值）；`budget_tokens` 必须 ≥1024 且 < `max_tokens`。core 保留键不许插件覆盖
temperature/max_tokens，因此一致性由**适配器**在合并后兜底：

- 合并后 `body.thinking?.type === 'enabled'` ⇒ **删除 body.temperature**（让 API 用默认 1；
  今天 temperature 来自 config，未配置时本来就是 undefined，行为不变）。
- `budget_tokens` clamp 到 `max_tokens - 1`；clamp 后 < 1024 ⇒ **整个 thinking 键丢弃** +
  warn（max_tokens 太小放不下思考预算 ⇒ 优雅降级为不思考，而不是发一个必 400 的请求）。
- 这是 core 唯一「认识 thinking 结构」的地方，且只做**形状一致性**不做语义映射——
  判据：约束是 Anthropic 传输协议的硬事实（与 `anthropic-version` 钉死同类），不是厂商知识。
  OpenAI 兼容侧无此类硬约束，不做任何结构特判。

### 3.3 BeforeLlm 注入位（HookResult / HookContext additive）

```ts
// packages/core/src/types/hook.ts
export interface HookContext {
  // …既有字段不动…
  /** BeforeLlm：本次请求的模型标识（additive；来自 LoopContext.model，计价同源）。 */
  model?: string;
  /**
   * BeforeLlm：provider 身份（additive；来自 LLMProvider.providerName 实例事实，§3.5）。
   * 缺省 = 装配未挂身份（裸 fallback / MemoryLLMProvider）——hook 自行按 model 启发式降级。
   */
  providerName?: string;
}

export interface HookResult {
  // …既有字段不动…
  /**
   * BeforeLlm：本次请求的额外头/参数（additive）。runtime 经 ProviderPort.chat →
   * ChatRequest.extra_headers/extra_params 透传给适配器；合并闸在适配器（§3.2）。
   * 仅 BeforeLlm 消费；其它阶段返回本字段被忽略。缺省 = 请求形状不变。
   */
  requestExtras?: {
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
  };
}
```

HookRunner 聚合语义（hook-runner.ts，additive 一段）：

- 多个 hook 返回 requestExtras：**按注册顺序顶层键浅合并，后到覆盖先到**（与 updatedInput
  的「后写生效」同口径）；同键不同值被覆盖时发一次 `hook.request_extras_conflict` 事件
  （data: hook_name / key / run_id），可观测不阻断。
- 聚合结果挂 `merged.requestExtras`；block 短路时丢弃（请求都不发了）。
- hook 抛错：既有隔离原样（该 hook 的 extras 不贡献，其余照常）。

### 3.4 接线点清单（文件级，全部 additive）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `packages/core/src/types/provider.ts` | ChatRequest += extra_headers/extra_params；LLMProvider += providerName?（§3.5） |
| 2 | `packages/core/src/types/hook.ts` | HookContext += model/providerName；HookResult += requestExtras |
| 3 | `packages/core/src/provider/request-extras.ts`（新） | 合并闸纯函数 + 常量（§3.2） |
| 4 | `packages/core/src/provider/providers.ts` | 7 个调用点接入（§3.2 表）+ Anthropic 一致性规则 |
| 5 | `packages/core/src/runtime/hook-runner.ts` | requestExtras 聚合 + conflict 事件 |
| 6 | `packages/core/src/runtime/tool-calling-loop.ts` | hookCtx += `model: ctx.model` / `providerName: ctx.providerName`；`ProviderPort.chat` args += `requestExtras?`；:488 调用点条件透传 `beforeLlm.requestExtras` |
| 7 | `packages/core/src/runtime/execution-unit.ts` | LoopContext += `providerName?`（createLoopContext 读 `this.provider.providerName`）；chatWithOverflowRetry 把 args.requestExtras 拆进 ChatRequest（**非空才带键**，:3894 attachment_plan 同形）；llm.request persistData += extras 元信息（§3.6） |
| 8 | `plugins/provider/openai/src/index.ts` | 工厂返回 `Object.assign(wrapped, { vision, providerName: p.name })` |
| 9 | `plugins/provider/anthropic/src/index.ts` | 同上（providerName: 'anthropic'） |
| 10 | `src/runtime/model-registry-wiring.ts` | delegatingProvider 挂 `providerName: resolved.protocol`（wrapper 级，不随实例缓存键变） |

零改动面：PluginHost 接口（复用 registerHook）、ExecutionUnitOptions / ExecutionUnitRequest
（身份走实例事实）、Message / 会话存储 / 事件正文、gateway 方法层、withRetry/withTimeout
包装器（只包 chat，extra 随 req 透传）。

### 3.5 provider 身份：实例事实（vision 先例）

```ts
// LLMProvider additive 可选字段
export interface LLMProvider {
  chat(req: ChatRequest): Promise<LLMResponse>;
  vision?: VisionBackend;
  /**
   * provider 身份（additive，可选）：装配注册名 / model-registry protocol
   * （'openai' / 'anthropic' / 'google' / …）。与 vision 同一判据：身份是实例事实，
   * 由构造方挂上；EU 经它填 HookContext.providerName。缺省 = 身份未知（裸 fallback /
   * Memory / 旧插件），消费方按 model 名启发式降级，不炸。
   */
  providerName?: string;
}
```

- 挂载点三处（§3.4 #8–10）：provider 插件工厂（注册名）、model-registry delegating wrapper
  （resolved.protocol，**未知 protocol 复用 openai 工厂时 wrapper 仍挂原 protocol**——
  身份是路由事实不是传输事实，dashscope 走 openai 传输但 protocol 可以是 'dashscope'）。
- 为什么不走 ExecutionUnitOptions 注入：要动 options → materializeOptions → profile →
  装配链 4 层，且成员 body 自有宿主路径也要跟改；实例事实 0 管道（vision 已验证此路）。
- 为什么不让插件自己按 base_url 猜：插件拿不到 base_url（凭证/端点不进 hook 上下文，
  明文纪律）；身份必须由装配侧给。

### 3.6 可观测性（llm.request 元信息）

`chatWithOverflowRetry` 的 persistData（execution-unit.ts:3836–3864）additive：

```ts
...(extras 非空 ? {
  request_extras: {
    header_keys: Object.keys(extra_headers ?? {}),   // 只有键名，头值可能敏感，不落
    param_keys: Object.keys(extra_params ?? {}),     // 只有键名；值不进落盘副本
  },
} : {}),
```

- 发布副本（WS/trace）同形带键名；**值一律不落**（与 messages 正文不落同口径；
  reasoning_effort 值虽不敏感，但统一「只记键名」避免逐键分级）。
- 调试值可见性：`VESSEL_DEBUG` 下适配器 warn 通道可打合法注入摘要（键=值，头值除外）——
  实施切片 P1 可选，不做也不影响验收。
- 新事件：`hook.request_extras_conflict`（§3.3）；合并闸丢弃走 warn 通道（一次性），
  不新增事件类型（丢弃是插件 bug 信号，不是运行期事实）。

### 3.7 不做什么（边界）

- **不做 per-request UI 直传**：gateway 发送消息的方法不加 thinking 参数——UI 只改插件状态，
  请求期 hook 读状态。理由：直传要动 sessions/runs 方法层 + EU run 选项 + 前缀不变量审查，
  且「按钮状态」与「请求注入」会分裂成两个真相；hook 路径单一真相。
- **不做深合并 / 参数改写**：extra 只增顶层键；改 messages/tools/model 一律拒绝（保留键）。
- **不做响应侧钩子**：思考强度的效果（reasoning_content/usage）走既有响应链，无需新面。
- **不新增 PluginHost 注册方法**：registerHook 足够；新注册面 = 新冻结契约，收益为零。

## 4. 插件设计（thinking-intensity）

### 4.1 位置与 manifest

- 目录：`plugins/provider/thinking-intensity/`（provider 类插件：知识是「provider × model →
  参数」，与 provider-openai / provider-anthropic / model-registry 同组）。
- 包名 `@vessel-agent/thinking-intensity`；`vessel.id: "thinking-intensity"`；
  **`mode: in-process`**（BeforeLlm hook 必须在进程内；child 模式无 hook 通道——manifest
  不声明 child 支持，装配按 in-process 加载）。`side: "both"`（后端 hook/RPC + Web 贡献面）。
- 依赖：`@vessel-agent/core`（类型 + HookType）、`@vessel-agent/plugin-sdk`；
  Web 侧无独立 bundle（工具栏菜单由**宿主**渲染，§4.7——插件不出 UI 组件，只出声明）。

manifest 贡献面全集（声明即生效，零宿主硬编码）：

```jsonc
// package.json → vessel
{
  "id": "thinking-intensity",
  "name": "Thinking Intensity",
  "side": "both",
  // 不声明 activationEvents：hook 类插件装配即常驻（doc-subscription / hook-logging 先例）
  "contributes": {
    "settings": { /* §4.2 */ },
    "rpc": [
      { "name": "get_state",    "description": "Current level + provider capability for a session", "permission": "read" },
      { "name": "set_level",    "description": "Set thinking level (session-scoped or global runtime default)", "permission": "write" },
      { "name": "capabilities", "description": "Provider mapping table summary (read-only diagnostics)", "permission": "read" }
    ],
    "toolbar": [
      {
        "slot": "composer",
        "id": "thinking-level",
        "label": "Thinking",
        "titleKey": "thinking.toolbar.label",
        "icon": "observe",                     // 须在 PLUGIN_ICON_NAMES 白名单内（今天 14 个图标无思考专属，取 observe；可省略）
        "order": 20,
        "menu": { /* §4.7 契约 */ }
      }
    ],
    "i18n": { "en": { /* … */ }, "zh-CN": { /* … */ } }
  },
  "permissions": { "fs": [], "net": [], "process": false, "secrets": false, "events": [], "rpc": [] }
}
```

- 权限最小面：插件**不发网络请求、不读文件、不碰凭证**——它只产出「参数建议」，
  真正的 HTTP 由 core 适配器发出。net/fs 全空。
- `events: []`：不订阅事件流（hook 上下文已含所需事实）；conflict 事件由 core 发，
  插件不消费。

### 4.2 设置 schema（contributes.settings，q-settings 自动发现）

```jsonc
"settings": {
  "enabled": {
    "type": "boolean", "default": true,
    "titleKey": "thinking.settings.enabled",
    "descriptionKey": "thinking.settings.enabled.desc",
    "keywords": ["thinking", "思考", "强度", "reasoning"], "order": 10
  },
  "default_level": {
    "type": "string", "default": "auto",
    "enum": ["auto", "off", "low", "medium", "high"],
    "titleKey": "thinking.settings.defaultLevel",
    "descriptionKey": "thinking.settings.defaultLevel.desc",
    "order": 20
  },
  "budget_low":    { "type": "integer", "default": 2048,  "minimum": 1024, "maximum": 65536,
                     "titleKey": "thinking.settings.budgetLow", "order": 30 },
  "budget_medium": { "type": "integer", "default": 8192,  "minimum": 1024, "maximum": 65536,
                     "titleKey": "thinking.settings.budgetMedium", "order": 40 },
  "budget_high":   { "type": "integer", "default": 16384, "minimum": 1024, "maximum": 65536,
                     "titleKey": "thinking.settings.budgetHigh", "order": 50 },
  "experimental_providers": {
    "type": "boolean", "default": false,
    "titleKey": "thinking.settings.experimental",
    "descriptionKey": "thinking.settings.experimental.desc",
    "order": 60
  }
}
```

语义：

- `enabled=false` = kill switch（vision.disabled 同形）：hook 恒不注入，UI 按钮置灰。
- `default_level` = 持久化全局默认（vessel.yaml `plugins[].config`，经 plugins.config.set 写）。
  **`auto` = 不注入任何参数**（provider 自己的默认行为，零回归基线）。
- `budget_*` 只作用于 budget 形状（Anthropic / Qwen thinking_budget）；effort 形状
  （reasoning_effort）是枚举档位，无预算可调。minimum=1024 对齐 Anthropic 硬下限。
- `experimental_providers`：映射表 `status:'experimental'` 行的总开关（§4.6）——
  未经官方文档核实的厂商参数默认不生效，打开才注入（fail-safe）。
- 生效语义（q-settings §4.5）：in-process 插件 config 热应用后**下一轮请求**读到新值
  （hook 每轮读 settings 快照）；设置弹窗提示「已保存」，无需重载。
- i18n key 命名沿用 `<pluginId>.settings.<key>[.desc]` 约定（q-settings §10.3）。

### 4.3 状态模型与 RPC

状态（插件后端内存，install 时初始化）：

```ts
type Level = 'auto' | 'off' | 'low' | 'medium' | 'high';

interface ThinkingState {
  /** per-session 覆盖：UI 按钮写这里；会话关闭/进程重启即失（v1 不持久化，§8.1 R4） */
  sessionLevels: Map<string, Level>;
  /** 全局运行期默认：set_level 不带 session_id 时写这里；缺省回 settings.default_level */
  runtimeDefault: Level | undefined;
  /** 能力缓存：hook 每轮从 ctx 学到 (session → providerName/model)，供 get_state 展示 */
  observed: Map<string, { providerName?: string; model: string; supported: boolean }>;
}
```

档位解析优先级：`sessionLevels[session] ?? runtimeDefault ?? settings.default_level ?? 'auto'`。

RPC DTO（经既有 `plugin.thinking-intensity.<name>` 桥，§1.5）：

```
get_state { session_id?: string }
→ {
    level: Level,
    source: 'session' | 'runtime' | 'settings',
    enabled: boolean,                          // kill switch
    provider?: {                               // 能力缓存命中才有（首轮请求前缺省）
      name?: string, model: string,
      supported: boolean,
      available_levels?: Level[],              // 不支持的档位（如 o 系列不能 off）
      hint?: string                            // i18n key 或短文案（降级原因）
    }
  }

set_level { session_id?: string, level: Level }
→ { ok: true, level, scope: 'session' | 'global' }
错误：invalid_params（level 不在枚举 / session_id 超长）；forbidden（write 权限既有口径）

capabilities {}
→ { rows: Array<{ match: string, shape: 'effort'|'budget'|'toggle'|'none',
                  status: 'stable'|'experimental', levels: Level[] }> }
```

- `set_level` 校验 level 枚举；session_id 长度上限 128（与 gateway 会话 id 口径一致）。
- `get_state` 的 provider 能力来自**请求期观测缓存**——插件不反向查询 gateway/EU
  （插件没有那个端口，也不该有）；首轮请求前 UI 显示「auto（请求后自动识别）」，
  这是诚实降级而不是猜（§4.7 交互）。
- 状态隔离：sessionLevels 按 session_id 键控，成员会话互不串；团队/多 tenant 场景下
  插件实例 per-tenant 装配（既有插件装配口径），天然隔离。

### 4.4 install 流程

```ts
install(host, options) {
  const settings = readSettings(options?.config);        // §4.2 快照 + 热应用回调
  const state = createState();
  host.registerHook({
    name: 'thinking-intensity',
    type: HookType.BeforeLlm,
    priority: 60,                                        // 环境卡类 hook 之后；extras 合并与顺序无关（键不冲突）
    run: (ctx) => beforeLlm(ctx, state, settings),       // §4.5
  });
  return {
    rpc: async (name, params) => dispatch(name, params, state, settings),  // §4.3
    close: () => { state.sessionLevels.clear(); state.observed.clear(); },
  };
}
```

- settings 热应用：in-process 装配的 config 监听既有（q-settings §4.5）；插件每轮 hook
  读最新快照，不缓存过期值。
- 卸载/回滚：registerHook 记入 beginPluginInstall scope（既有机制），安装失败自动摘除。

### 4.5 BeforeLlm hook（请求期注入 + 降级）

```ts
function beforeLlm(ctx: HookContext, state, settings): HookResult | undefined {
  // 1. 观测记录（无论是否注入都学能力，UI 靠它）
  const entry = resolveMapping(ctx.providerName, ctx.model);   // §4.6 纯函数
  if (ctx.session_id) state.observed.set(ctx.session_id, {
    providerName: ctx.providerName, model: ctx.model ?? '', supported: entry !== undefined,
  });

  // 2. 降级闸（任一命中 ⇒ 返回 undefined，请求逐字节不变）
  if (!settings.enabled) return undefined;                     // kill switch
  const level = resolveLevel(state, settings, ctx.session_id);
  if (level === 'auto') return undefined;                      // 默认 = provider 自决
  if (!ctx.model) return undefined;                            // 无模型事实，不猜
  if (!entry) return undefined;                                // 未知 provider/model
  if (entry.status === 'experimental' && !settings.experimental_providers) return undefined;

  // 3. 档位 → wire 参数（纯函数；不支持的档位 ⇒ 不注入 + 观测记 hint）
  const params = mapLevel(entry, level, settings);             // 可能 undefined（如 o 系列 off）
  if (!params) { markUnsupported(state, ctx.session_id, level); return undefined; }

  return { requestExtras: { params } };                        // headers 本插件 v1 不用（§4.6 注）
}
```

判据：

- **hook 无 I/O、无抛错路径**：全部纯函数 + 内存 Map；任何意外（ctx 缺字段/映射表 bug）
  由 HookRunner 隔离兜底，请求照常（无 extra）。
- **每轮重新解析**：档位/设置/模型（agent.model 覆盖、凭证轮换换 vendor）都在请求期生效，
  与 vision plan 同节奏；不在 run 起点缓存。
- `request_index` 不区分：同一 run 内所有轮次同档位（强度是会话级意图，不是轮级节奏）。
- **headers 通道 v1 不用但保留**：任务书要求 core 开放 extra headers（已开，§3.1）；
  思考强度主流参数全在 body。headers 透传留给后续插件（如厂商 beta 特性头
  `anthropic-beta: ...`），本插件不注入任何头——少一个敏感面。

### 4.6 provider 映射表（插件内纯数据）

统一档位 `auto / off / low / medium / high`；三种 wire 形状：

- **effort**：枚举参数（`reasoning_effort: 'low'|'medium'|'high'`，部分模型支持 'none'）。
- **budget**：开关 + token 预算（`thinking: {type:'enabled', budget_tokens:N}` /
  `enable_thinking:true + thinking_budget:N`）；off = 显式关闭。
- **toggle**：只有开/关（`thinking: {type:'enabled'|'disabled'}`）；low/medium/high 都映射
  为 enabled（无级差，hint 说明三档等效）。
- **none**：思考不可控（恒开或恒关）⇒ supported=false，UI 提示「该模型思考强度不可调」。

映射表（按序首中；protocol = ctx.providerName，model = ctx.model）：

| # | match（protocol / model 模式） | shape | off | low / medium / high | status | 依据 |
|---|-------------------------------|-------|-----|--------------------|--------|------|
| 1 | anthropic / `claude` | budget | `thinking:{type:'disabled'}` | `thinking:{type:'enabled',budget_tokens:budget_*}` | stable | Anthropic extended thinking 文档；适配器兜底 temperature/budget 一致性（§3.2.1） |
| 2 | openai / `^(o[134]\|gpt-5)` | effort | gpt-5.1+：`reasoning_effort:'none'`；o 系列/gpt-5：**不可关**（available_levels 去掉 off） | `reasoning_effort:'low'\|'medium'\|'high'` | stable | OpenAI reasoning 文档；gpt-5.1 引入 none（已核实） |
| 3 | openai（或 dashscope）/ `^qwen` | budget | `enable_thinking:false` | `enable_thinking:true, thinking_budget:budget_*` | stable | DashScope Qwen3 混合思考（已核实 enable_thinking；thinking_budget 上限实施 P2 对官方文档复核） |
| 4 | google / `^gemini-2\.5-flash` | effort | `reasoning_effort:'none'` | `reasoning_effort:'low'\|'medium'\|'high'` | experimental | Gemini OpenAI 兼容端点 reasoning_effort→thinkingBudget；待核实 |
| 5 | google / `^gemini-2\.5-pro` | effort | **不可关** | 同上 | experimental | 2.5-pro 思考不能全关；待核实 |
| 6 | openai / `^deepseek-reasoner` | none | — | — | stable | DeepSeek reasoner 恒思考，无强度参数（已核实） |
| 7 | openai / `^deepseek-chat` | toggle | `thinking:{type:'disabled'}` | `thinking:{type:'enabled'}` | experimental | V3.2 混合思考开关；版本敏感 |
| 8 | openai / `^glm-4\.[56]` | toggle | `thinking:{type:'disabled'}` | `thinking:{type:'enabled'}` | experimental | 智谱 OpenAI 兼容 thinking 开关；待核实 |
| 9 | moonshot / `kimi` | none | — | — | stable | kimi-k2-thinking 恒思考；无公开强度参数 |
| 10 | ollama / `*` | none | — | — | stable（v1） | 本地模型思考参数随 run 配置，OpenAI 兼容面不统一；二期评估 |
| 兜底 | 未命中 | — | 不注入 | 不注入 | — | 优雅降级：supported=false，UI 提示 |

表纪律：

- **匹配键是 (providerName, model) 二元组**，providerName 缺省时只按 model 模式匹配
  （裸 fallback 降级路径）；`^qwen` 行不依赖 protocol（dashscope 常以 openai 兼容注册）。
- 每行带 `status`：stable = 官方文档已核实；experimental = 形状合理但未核实/版本敏感，
  受 `experimental_providers` 闸（默认 false）。**实施切片 P2 只带 stable 行上线**，
  experimental 行 P4 逐行核实后转正（核实 = 读官方文档，不是探针请求——宪法零探针）。
- 映射表是**纯数据 + 纯函数**（可静态断言，settings-registry 同做法）；加厂商 = 加一行，
  0 行 core 改动（vision「加视觉模型 = 加配置」同判据）。
- 档位不可用（如 o 系列 off）：`mapLevel` 返回 undefined + observed 记
  `available_levels`/`hint`——**不静默换成别的档位**（用户选了 off 却偷偷思考 = 谎报）。
- toggle 形状的级差：low/medium/high 等效（wire 只有开关）；hint 说明「该模型仅支持
  开/关，三档强度等效」——不假装有无级调节。
- 新厂商参数若不在表内（如未来 `reasoning: {effort}` 新形状）：加行即可；core 合并闸
  对任何顶层键一视同仁（§3.2），无需跟改。

### 4.7 UI 控制

#### 4.7.1 设置弹窗（零代码，q-settings 自动发现）

§4.2 声明合入即出现在设置弹窗「扩展 → Thinking Intensity」组：enabled / default_level /
budget_* / experimental_providers 可检索可编辑（plugins.config.set 写路径已有）。
default_level 是**持久默认**；composer 按钮是**会话级即时覆盖**——两层分工与
q-settings「侧栏折叠按钮 vs 设置默认值」同判据（§5.3 of vscode-settings-design）：
即时操作与持久默认写不同存储，无第二真相（按钮状态不回写 settings）。

#### 4.7.2 composer 工具栏菜单按钮（toolbar 契约 additive 扩展）

**问题**：toolbar v1 只有「宿主按 id 映射回调」一条路（attach-file 先例）。若照搬，
宿主要硬编码 `thinking-intensity` 动作 id + 档位弹层 + RPC 调用——宿主认识具体插件，
违反「核心只有形状」。

**方案**：给 `PluginToolbarContribution` additive 一个**通用 RPC 绑定菜单**声明 `menu`——
宿主渲染「声明式菜单按钮」，任何插件都能用，宿主零插件专属代码：

```jsonc
// manifest contributes.toolbar[]（本插件的声明）
{
  "slot": "composer", "id": "thinking-level",
  "label": "Thinking", "titleKey": "thinking.toolbar.label", "order": 20,
  "menu": {
    "read": "get_state",            // 须在本插件 contributes.rpc 内，permission=read
    "write": "set_level",           // 须在本插件 contributes.rpc 内，permission=write
    "valueKey": "level",            // read 结果里取当前值的键；write 时以该键传选中值
    "sessionScoped": true,          // write 时宿主注入当前 session_id（插件拿不到宿主路由）
    "items": [                      // 静态档位表（文案走插件 i18n）
      { "value": "auto",   "labelKey": "thinking.level.auto" },
      { "value": "off",    "labelKey": "thinking.level.off" },
      { "value": "low",    "labelKey": "thinking.level.low" },
      { "value": "medium", "labelKey": "thinking.level.medium" },
      { "value": "high",   "labelKey": "thinking.level.high" }
    ]
  }
}
```

宿主契约（通用，不含 thinking 一词）：

1. **校验**（loader/normalizer，既有贡献点校验同层）：menu.read/write 必须在该插件
   rpc 白名单且权限匹配（read→read，write→write）；items ≤16 项、value ≤64 字符；
   valueKey 合法键名。违规 ⇒ 丢 menu 保留普通按钮声明（单项丢弃 + 告警，既有口径）。
2. **渲染**：按钮文案 = `label: <当前档位文案>`（当前值来自 read RPC 结果的
   `[valueKey]`，按 items 匹配 labelKey → pluginT；未匹配显示原值）。点击展开菜单
   （复用宿主既有浮层/焦点圈/Esc 机制，ModalShell 同族）。
3. **read 时机**：composer 挂载 + 会话切换 + 每次 write 成功后重拉；read 结果可选字段
   （通用形状，任何插件可用）：
   - `enabled: false` ⇒ 按钮置灰 + hint tooltip；
   - `options: string[]` ⇒ 只渲染 value 在其中的 items（能力过滤：o 系列隐藏 off）；
   - `hint: string` ⇒ 菜单底部说明行（如「该模型仅支持开/关」）。
   缺省这些字段 ⇒ 全量 items 可点（旧插件/简单插件零负担）。
4. **write**：选中 item → `client.rpc('plugin.<id>.<write>', { [valueKey]: value,
   ...(sessionScoped ? { session_id: 当前会话 } : {}) })`；乐观更新按钮文案 +
   失败 toast 回滚（q-settings settingsPending 同机制）；成功重拉 read。
5. **降级**：旧 gateway 无 menu 透传 / 旧 Web 不认识 menu ⇒ normalizer 丢 menu 字段 ⇒
   条目退化为无 handler 普通按钮 ⇒ **既有规则丢弃不渲染**（无死按钮）；设置弹窗
   default_level 仍可用（功能不丢，只是没有即时按钮）。

接线点（实施 P3）：

| 文件 | 改动 |
|------|------|
| `src/plugin/plugin-manifest.ts` | PluginToolbarContribution += `menu?: PluginToolbarMenu`（类型 + 校验） |
| `packages/serve/src/plugin-host/types.ts` | PluginRenderContributions toolbar 项透传 menu（同 settings 透传先例） |
| `apps/web/src/domains/plugins/plugin-contributions.ts` | PluginToolbarItem += menu 归一化（白名单校验） |
| `apps/web/src/domains/chat/composer-toolbar.ts` | menu 条目不走 hostActions 表，走通用 MenuAction 分支（新导出 composerToolbarMenuActions） |
| `packages/plugin-ui/src/ComposerToolbar.tsx` | 渲染菜单按钮（declarative：items/current/options/hint + onSelect） |
| chat/team composer 页 | 注入 session_id + rpc client（既有 useConnection） |

#### 4.7.3 交互细节

- 按钮位置：composer 工具栏，attach-file 之后（order 20）；会话页与团队页共用
  （toolbar 既有口径）。
- 档位文案：auto=「自动」/ off=「关闭」/ low=「低」/ medium=「中」/ high=「高」；
  按钮常态显示「思考: 中」，compact 模式只显示图标 + 档位字。
- 不支持的模型：按钮置灰 + tooltip「当前模型不支持思考强度调节」（read 的
  supported=false / options 空）；**不隐藏按钮**（用户需要知道为什么没得调）。
- 首轮请求前：能力未知 ⇒ 按钮可点、全档位可选，菜单底部提示「发送首条请求后自动识别
  模型能力」；选了不支持的档位 ⇒ hook 不注入 + 下轮 read 带 hint（诚实降级）。
- 不做滑块：档位是离散语义（各家 wire 都是枚举/预算档），滑块暗示无级调节是谎报；
  budget 数值精调在设置弹窗（budget_* 数字输入）。

## 5. 与现有机制的衔接

### 5.1 vision / plan 请求期机制（同节奏、正交）

- 同一判据链：vision 是「能力问实例（provider.vision）+ 请求期算 plan（resolveAttachmentPlanFor）
  + 适配器命中才改形状」；thinking 是「身份问实例（provider.providerName）+ 请求期 hook 算
  extras + 适配器合并闸」。两者都在 `chatWithOverflowRetry` 内、`provider.chat` 前完成，
  互不读写对方字段。
- 差异点（明示）：attachment_plan 每 attempt 重算（依赖压缩后的消息视图）；extra 轮级一次
  （不依赖消息视图）。overflow 重试后 extra 不变是**正确**的——强度意图不随压缩改变。
- 图 + 思考同时启用：请求体既有图块又有 thinking 参数，各家 API 均支持（多模态 reasoning
  模型）；无组合特判。

### 5.2 include_reasoning / ui.showReasoning（显示侧，正交）

- `include_reasoning`（EU 选项）决定 reasoning_delta 是否进事件流；`ui.showReasoning` 决定
  Web 是否渲染。本插件决定**生成多少思考**——三者三层，互不覆盖。
- 组合语义：off 档 + showReasoning=true ⇒ 没有思维链可显示（模型不思考），UI 自然为空；
  high 档 + showReasoning=false ⇒ 思考照常生成、回传、计费，只是不显示。**不做联动**
  （联动会制造「关显示=省 token」的错觉）。

### 5.3 前缀不变量 / prompt cache

- extra 只加 body 顶层键，`messages / system / tools` 一个字节不动 ⇒ prefixGuard 与
  CONTRACT-prefix-invariant 不受影响；prompt cache 断点（applyPromptCache /
  addMessageCacheBreakpoint）照常。
- 注意：部分厂商的隐式缓存键可能含采样参数——reasoning_effort 变化可能导致缓存未命中
  （成本事实，不是正确性问题）；切档后首轮 prompt_tokens 可能升高，usage 面可见（§5.6）。
  文档提示即可，不做缓存补偿。

### 5.4 model-registry / 凭证轮换 / agent.model 覆盖

- providerName 挂 delegating wrapper（resolved.protocol），不随实例缓存键（凭证 updatedAt）
  变化——轮换凭证不换身份，映射稳定。
- `agent.model` 覆盖 ⇒ req.model 变 ⇒ hook 每轮按新 model 重新匹配映射表（§4.5），
  自动适配；vision 的「能力是 (provider, model) 函数」判据原样复用。
- 未知 protocol 复用 openai 工厂：wrapper 挂原 protocol（路由事实），传输是 openai 兼容
  ——映射表按 protocol+model 匹配不受影响。

### 5.5 q-settings / 插件装配

- 设置域声明即发现（S3/S4 已实施）；写路径 plugins.config.set 校验 enum/minimum/maximum
  由 spec 驱动，本插件零写侧代码。
- in-process 限定：hook 与 RPC 状态都在进程内；manifest 不声明 child 支持。若未来装配
  把它放 child ⇒ hook 不存在 ⇒ 恒不注入（additive 降级，不炸），设置弹窗会显示
  restartRequired——文档明示本插件必须 in-process。
- 装配顺序无关：registerHook 按 priority 排序执行；extras 键（reasoning_effort/thinking/
  enable_thinking）与其它插件的 extras 键天然不冲突；真冲突 ⇒ conflict 事件 + 后到覆盖
  （§3.3），可观测。

### 5.6 重试 / 空响应兜底 / 用量计价

- withRetry / withTimeout / overflow / empty-response 重调都复用同一 ChatRequest（或重建
  消息视图但 extra 不变）——强度参数在重试间稳定，不会「重试一次换个强度」。
- reasoning token 已计入 completion_tokens（既有 fromOpenAiUsage / StreamAccumulator），
  high 档的成本在 usage 插件 / context_usage / 计价面**自动可见**，零新计量。
- `llm.request` persistData 的 request_extras 键名元信息（§3.6）让「这轮为什么贵/为什么
  没思考」可从落盘日志回答。

### 5.7 成员 body / 团队场景

- 成员 EU 的 pluginHost 来自 profile 工厂或成员自有宿主（ExecutionUnitRequest.pluginHost）；
  tenant 插件的 hook 经装配进入 EU HookRunner（skills 环境卡 / doc-subscription 已验证此路）。
  本插件作为 tenant 插件装配 ⇒ 成员会话同样受控。
- 会话级状态按 session_id 键控 ⇒ 同一 tenant 下多个成员会话各自独立档位；
  全局默认（settings）是 tenant 级意图。
- 跨节点（federation）：插件状态在**本节点**进程内；远端成员的请求由远端节点装配的插件
  实例控制——v1 不做跨节点档位同步（开放问题 Q2）。

## 6. 安全与护栏

| 面 | 护栏 | 落点 |
|----|------|------|
| 认证头劫持 | Authorization / x-api-key / cookie / proxy-authorization 等 denylist，丢弃+告警 | §3.2 RESERVED_HEADERS |
| 请求形状篡改 | model/messages/tools/system/stream/temperature/max_tokens 保留键，插件不可覆盖 | §3.2 RESERVED_BODY_KEYS_* |
| 协议漂移 | anthropic-version / content-type 钉死 | §3.2 |
| 体积放大 | 头 ≤16 条 / 值 ≤1024B；参数 ≤16 键 / 序列化 ≤8KiB；超限丢弃 | §3.2 EXTRA_LIMITS |
| 非 JSON 值 | 函数/symbol/循环引用丢弃（JSON.stringify 校验） | §3.2 |
| 坏插件 | 合并闸逐项 fail-open；hook 抛错 HookRunner 隔离 | §3.2 / §1.3 |
| 越权写 | set_level 走 contributes.rpc permission=write（gateway 既有鉴权）；menu.write 校验权限匹配 | §4.3 / §4.7 |
| 会话串扰 | session_id 键控 + 长度上限；tenant 装配隔离 | §4.3 |
| 敏感值落盘 | extra 值不进事件/落盘（只记键名）；头值连 debug 摘要都不打 | §3.6 |
| 凭证接触 | 插件 permissions net/fs/secrets 全空；hook 上下文不含 base_url/api_key | §4.1 |
| 谎报 | 不支持档位不静默替换；toggle 无级差明示；能力未知不猜 | §4.6 / §4.7 |

信任模型：in-process 插件与既有插件同信任级（装配即信任，安装经 marketplace/TOFU 既有门）；
本设计不新增信任面——合并闸防的是**bug 与越界**，不是恶意进程内代码（后者已有插件信任门管）。

## 7. 实施切片（文件级；实施由 main 派单）

| 切片 | 内容 | 主要文件 | 门禁 |
|------|------|----------|------|
| **P1** core 透传钩子 | ChatRequest extra 字段 + 合并闸 + 7 接入点 + Anthropic 一致性规则 + HookResult.requestExtras/HookContext.model/providerName + HookRunner 聚合 + loop/EU 接线 + providerName 实例事实（3 挂载点）+ llm.request 元信息 | §3.4 表 10 项 | bun run build exit 0；缺省逐字节不变（静态对照请求体字面量） |
| **P2** 插件后端 | manifest（settings/rpc/i18n）+ 状态 + BeforeLlm hook + stable 映射行（1/2/3/6/9/10）+ RPC dispatch + 装配登记 | 新 `plugins/provider/thinking-intensity/{package.json,src/index.ts,src/mapping.ts,src/state.ts}`；装配插件清单 | 同上 |
| **P3** 工具栏菜单契约 + UI | menu 声明类型/校验/透传/归一化 + ComposerToolbar 菜单渲染 + composer 页接线 + 插件 toolbar 声明 | §4.7.2 表 6 项 + 插件 manifest | 同上 |
| **P4** 映射扩面 + 文档 | experimental 行逐行官方文档核实转正（4/5/7/8）+ capabilities 诊断面 + docs 同步（WEB-UI.md / specs / 本文件定稿） | mapping.ts + docs | 同上 + doc-sync 复核 |

- 依赖：P1 是 P2 的前置；P3 依赖 P2 的 RPC；P4 独立可后置。每切片独立 commit + 独立可回退。
- P1 合入即有通用透传能力（任何插件可注入 extra）；P2 合入即可经 vessel.yaml
  `plugins[].config.default_level` 控制强度（无 UI 也能用）；P3 合入满足「按钮」诉求。
- 宪法约束：零测试/探针/临时进程；每切片仅 `bun run build` 门禁；不碰主 checkout；
  只提交实施分支。映射核实读官方文档，不发验证请求。

## 8. 风险与开放问题

### 8.1 风险表

| # | 风险 | 缓解 |
|---|------|------|
| R1 | Anthropic thinking 要求 temperature=1 / budget<max_tokens，config 的 temperature/max_tokens 与之冲突 | 适配器一致性规则（§3.2.1）：enabled ⇒ 删 temperature；budget clamp；放不下 ⇒ 丢 thinking 降级，不发必 400 的请求 |
| R2 | 厂商参数漂移（新模型改参数名/枚举值）⇒ 400 | 映射表 status 闸 + experimental 默认关；400 走既有 ProviderHttpError 面（错误可见）；不做自动降档重试（会掩盖配置错误，且重试语义属 core 重试策略，插件不碰）；修表 = 加行/改行，热应用下一轮生效 |
| R3 | 多 hook extras 键冲突 | 后到覆盖 + conflict 事件（§3.3）；本插件键名空间（reasoning_effort/thinking/enable_thinking/thinking_budget）与既有插件无交集 |
| R4 | 会话级档位进程重启即失 | v1 明示「会话级覆盖是即时意图，持久默认走设置」；重启后回 settings.default_level（不是回 auto，用户持久意图不丢）；持久化会话覆盖列二期（Q3） |
| R5 | toolbar menu 契约扩展面过大 | menu 是单一 additive 可选字段，校验/降级沿用既有贡献点口径；旧链路丢 menu 不渲染死按钮；宿主零插件专属代码（通用性判据） |
| R6 | 能力观测滞后（首轮请求前 UI 不知道模型） | 诚实降级：全档可选 + 提示「请求后识别」；hook 不支持 ⇒ 不注入 + hint；不反向查询 gateway（插件无端口） |
| R7 | 切档导致隐式缓存未命中、成本上升 | §5.3 文档提示；usage 面既有可见性；不做缓存补偿 |
| R8 | budget 档与模型上限不符（如 thinking_budget 超 Qwen 上限） | P2 实施对官方文档复核上限；适配器 clamp 只兜 Anthropic 硬约束；其它厂商超限 ⇒ 400 可见 + 修表（R2 同路） |
| R9 | 用户误以为 off = 省钱（off 档模型不支持时） | available_levels 过滤 + hint 明示「不可关」；不静默替换档位 |
| R10 | child 模式误装配 ⇒ 功能静默缺失 | manifest 限定 in-process；文档明示；装配降级不炸（§5.5） |

### 8.2 开放问题（main 裁决）

- **Q1** 档位集：v1 五档（auto/off/low/medium/high）。是否加 `minimal`（gpt-5 系）/`max`
  （budget 上限档）？倾向不加：minimal 与 low 语义重叠，max 用 budget_high 设置覆盖。
- **Q2** 作用域：v1 会话级 + tenant 全局默认。是否需要 per-agent（成员 pin 强度，
  随 self card）/ 跨节点同步？倾向二期：成员 pin 要动装配链，跨节点要动 federation 协议。
- **Q3** 会话覆盖持久化：重启后恢复 per-session 档位需要插件写数据目录（fs 权限 + 落盘
  形状）。v1 不做（R4）；若 main 认为需要，P2 加 `state.json`（permissions.fs 限定插件数据目录）。
- **Q4** headers 注入的首个用户：本插件 v1 只用 params。是否同期给 anthropic 插件加
  `anthropic-beta` 头配置（验证 headers 通道）？倾向不搭车：headers 闸已随 P1 落地，
  首个用户另单。
- **Q5** UI 形态：菜单按钮（本设计）vs 循环按钮（点一下换一档）vs 设置弹窗内滑块。
  倾向菜单：档位可见、能力过滤可表达、误触少；循环按钮在「不支持档位」上会静默跳过，
  交互谎报风险。

## 9. 验收判据（实施门禁）

1. **零回归**：不装插件 / enabled=false / default_level=auto / 未知模型 ⇒ 四家请求体与
   今天逐字节相同（静态对照 providers.ts 字面量；无 extra 键出现）。
2. **wire 形状**：anthropic+claude high ⇒ body.thinking={type:'enabled',budget_tokens:16384}
   且无 temperature；openai+gpt-5.1 low ⇒ reasoning_effort:'low'；qwen off ⇒
   enable_thinking:false；deepseek-reasoner 任意档 ⇒ 无注入。
3. **护栏**：extra 注入 Authorization/model/messages ⇒ 丢弃 + 一次性告警，请求照常；
   超 16 键 ⇒ 截断丢弃；Anthropic budget≥max_tokens ⇒ clamp/降级。
4. **UI 流**：设置弹窗出现 Thinking Intensity 域（6 键可编辑）；composer 出现
   「思考: <档>」菜单按钮；选档 ⇒ set_level ⇒ 下一轮请求带对应参数；不支持模型 ⇒
   按钮置灰 + hint；旧 gateway ⇒ 按钮不渲染、设置域仍可用。
5. **可观测**：llm.request persistData 带 request_extras 键名；conflict 事件可触发；
   usage 面 reasoning token 随档位变化。
6. **故障隔离**：hook 抛错 ⇒ hook.error 事件 + 请求无 extra 照常；合并闸违规不抛错。

## 10. 协同与文档互指

- q-settings（vscode-settings-design.md §4）：设置域契约权威，本文件 §4.2 只声明不复制。
- model-registry（CONTRACT-model-registry-internal）：providerName 实例事实挂 wrapper，
  不改 registry 契约；protocol 语义沿用。
- vision（0.56 design）：请求期注入判据同源，本文件 §5.1 明示差异。
- 实施时 specs 同步：plugin-manifest 契约（toolbar.menu）/ ChatRequest 字段 / HookResult
  字段进对应 spec 文档（P4 doc-sync）。