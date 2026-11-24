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

两个纯函数 + 常量，四个适配器接入点共用：

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
| 4 | `packages/core/src/provider/providers.ts` | 6 处接入（§3.2 表）+ Anthropic 一致性规则 |
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