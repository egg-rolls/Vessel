# 架构决策记录（ADR）

> 记录 Vessel 的关键决策与**为什么**。设计本身见 [SPEC.md](SPEC.md)；旧项目教训见 [legacy/LESSONS.md](../../legacy/LESSONS.md)。
> ADR 一经决策不轻易推翻；如需变更，新增 ADR 标注 supersede 旧者。

---

## ADR-001：实现语言用 TypeScript

- **上下文**：旧项目用 Python，对无基础用户分发门槛高（装解释器/venv/PyInstaller 打包大且慢）。同类 CLI agent（Claude Code/Cline/Continue）多为 TS。
- **决策**：用 TypeScript；运行时 Bun；分发 `npx vessel` + `bun build --compile` 单二进制。
- **备选**：Python（分发痛点未解；遗产非代码故无迁移优势）、Go（单二进制最优但 AI/TUI 生态弱）、Rust（曲线陡、小团队不划算）。
- **后果**：团队需学 TS；但 TUI(Ink)/MCP/插件生态最佳，前后端同构。代价可接受。
- **关联**：legacy/LESSONS 教训13。

## ADR-002：三层结构（core + config + tui），非单框架/单应用

- **上下文**：纯框架无基础用户用不了；纯应用扩展性弱。用户提出"框架+控制UI"拆分。
- **决策**：三层。core=可嵌入运行时；config=声明式配置；tui=Claude-Code 式终端。无基础用 TUI，弱基础改配置，开发者写插件/嵌 core。
- **后果**：一个产品通吃三类用户；core 无 UI 依赖可独立嵌入。增加分包复杂度，但 monorepo 可控。
- **关联**：[PRD.md](PRD.md) §2；legacy/DESIGN-PRINCIPLES §1。

## ADR-003：runtime 构造函数不注入插件

- **上下文**：旧 Vessel runtime 构造函数注入 ~20 依赖（guardrails/hooks/memory/mcp/corrections/resilience...），成 god-object，违反自身 scope 纪律。
- **决策**：runtime 构造函数只接收核心必需项（provider/model/tools/context/events/limits/termination/session）；guardrail/memory/mcp/corrections/resilience 等以 Plugin 形式经 `plugins` 注入，install 时注册到 PluginHost。
- **后果**：runtime 可测、可嵌入、职责单一；插件可按需加载。代价：Plugin 接口需设计稳定。
- **关联**：legacy/LESSONS 教训2；[SPEC.md](SPEC.md) §4.9。

## ADR-004：统一声明式扩展（Plugin + PluginHost）

- **上下文**：旧 Vessel 有 4 套扩展机制（工具=装饰器、provider=register、hook=子类、workflow=add_node），心智不统一。
- **决策**：tool/provider/guardrail/hook 全部经 `Plugin.install(host)` 用同一组 register 方法注册。
- **后果**：单一心智；内置能力也走同机制（一致性）。表达力靠 Plugin 接口保证。
- **关联**：legacy/LESSONS 教训3；[SPEC.md](SPEC.md) §5。

## ADR-005：双层配置——用户身份与项目行为分离

- **上下文**：旧 Vessel 强制"不内置默认 provider/model/base_url/价格"，却给 temperature/iterations 等行为默认，教条自相矛盾。同时 `.env` 和 `vessel.yaml` 混用，API Key 散落各处，无基础用户困惑。
- **决策**：
  1. 内置安全默认（provider 预设列表 + 行为默认），用户填 Key 即跑。
  2. **Key 永远用户自备，不内置任何厂商 Key/价格。**
  3. **配置分两层**：`~/.vessel/config.yaml`（用户身份：Key + provider 偏好，跨项目复用）+ `vessel.yaml`（项目行为：工具/限额/插件，跟着仓库走）。
  4. `api_key` **只存** `~/.vessel/config.yaml`，**不进入** `vessel.yaml`（后者可安全 git commit）。
  5. 加载优先级：CLI flag > `VESSEL_*` env > `vessel.yaml` > `~/.vessel/config.yaml` > 安全默认。
  6. `.env` 不是 Vessel 的配置机制（保留 `VESSEL_*` 环境变量用于 CI/容器/自动化）。
  7. 首启向导产出 `~/.vessel/config.yaml`，此后所有项目自动可用。
- **后果**：无基础用户填一次 Key 即可在所有项目使用；项目配置不含密钥可安全共享；环境变量退居自动化场景。代价：需维护 `~/.vessel/` 目录的创建/读写逻辑。
- **关联**：legacy/LESSONS 教训5；[SPEC.md](SPEC.md) §6。

## ADR-006：分发用 npx + Bun 单二进制

- **上下文**：无基础用户跑 Python 应用门槛高。
- **决策**：`npx vessel` 零安装（有 Node 者）+ `bun build --compile` 单二进制（无 Node 者）。
- **后果**：分发门槛最低。需维护两路分发。
- **关联**：legacy/LESSONS 教训13；ADR-001。

## ADR-007：流式 = 事件订阅，非独立 runtime

- **上下文**：旧 Vessel 流式是独立 StreamingAgentRuntime 类，与主 loop 分离；GAPS 自称修复的"统一事件模型"未兑现。
- **决策**：单一 runtime loop；流式输出通过订阅 EventStream 实现，TUI 订阅同一事件流渲染。
- **后果**：一套数据供 trace/replay/TUI；无重复 runtime。代价：loop 需在 LLM 流式响应时增量发事件。
- **关联**：legacy/LESSONS 教训10；[SPEC.md](SPEC.md) §3.3。

## ADR-008：事件类型枚举化 + payload schema

- **上下文**：旧 Vessel 事件类型是散落字符串字面量，手写 dict 发布，易拼写错、无校验。
- **决策**：EventType 枚举 + 每类对应 payload schema；发布走 `EventStream.publish(RunEvent)`。
- **后果**：类型安全、可校验、可文档化。新增事件需扩枚举。
- **关联**：legacy/LESSONS 教训8；[SPEC.md](SPEC.md) §4.4。

## ADR-009：全自研，不依赖 LangChain/LangGraph

- **上下文**：旧项目核心原则；保持运行时轻量、可控。
- **决策**：core 不引入 LangChain/LangGraph 等重型 agent 框架；provider/tool 协议自实现。
- **后果**：依赖精简、行为可预测；需自维护协议适配。
- **关联**：legacy/DESIGN-PRINCIPLES §5。

## ADR-010：MVP 延后 workflow/team/durable/evals

- **上下文**：旧 Vessel 在 Alpha 就全上这些，多数属 speculative generality，未真正被用。
- **决策**：MVP 只做控制面骨架 + TUI + config；workflow/team/durable/evals 延后到 Phase 3，按需再加。
- **后果**：MVP 聚焦、快速验证；高级编排能力暂缺（可后期补）。
- **关联**：legacy/LESSONS 教训14；[ROADMAP.md](ROADMAP.md)。

---

## ADR-011：Skills 作为第三扩展轴，plugin-delivered，core 不加 SkillHost

- **上下文**：用户期望"加功能 = 加 Plugin/MCP/Skill"且 core 零改动。Skills（可复用行为剧本，对标 Claude Code）对无基础用户最友好（Markdown，不写代码）。是否需要 core 新增 SkillHost 接口？
- **决策**：Skills 由 skills-loader 插件承载：用 `BeforeLlm` 钩子按需注入 skill 内容，TUI slash 命令触发；skill 内容是 Markdown。core 不新增 SkillHost 接口。用户面向四类扩展（Plugin/MCP/Skill/Config）全部经 PluginHost 投放。
- **备选**：core 加 SkillHost 与 PluginHost 对称（更紧集成、对称），但属 speculative core 增长，且与"加 skill 不动 core"诉求矛盾。
- **后果**：core 真正冻结；skill 即装即用；无基础用户可写/分享 Markdown skill。代价：skill 注入只能走现有钩子点，若将来需更紧集成再评估（届时新 ADR）。
- **关联**：legacy/LESSONS 教训14；[SPEC.md](SPEC.md) §5.1；[PLUGINS.md](PLUGINS.md) §八。

## ADR-012：Core 稳定性与演化策略

- **上下文**：旧 Vessel core 不断膨胀（教训2/14），因"加插件"滑成"给 core 加钩子给我的插件用"。需明确何时可改 core。
- **决策**：
  1. tool-calling loop 对功能开发冻结；功能增长一律走 Plugin/MCP/Skill（ADR-011）。
  2. core 仅在三种情况可改：(a) 新增/演化扩展面（HookType/EventType/GuardrailStage 等"插座"）；(b) 修复 loop 级缺陷；(c) 支持证明无法被工具/Hook/Guardrail/事件解决的横切需求（经 ADR-015 论证，尚无已知的此类需求）。
  3. 每次 core 改动必须先写 ADR；拿不准先做插件，验证后再议是否提升进 core。
  4. 重依赖/垂直能力永不进 core。
- **后果**：core 保持极小稳定；扩展可控；避免重蹈旧版 core 臃肿。代价：少数 loop 级能力需等 ADR + 排期。
- **关联**：legacy/LESSONS 教训2/14；[PLUGINS.md](PLUGINS.md) §九；[CLAUDE.md](../../CLAUDE.md) §6 红线。

---

## ADR-013：Linter/Formatter 用 Biome

- **上下文**：TS monorepo 需统一 lint+format 质量门禁。备选 Biome vs ESLint+Prettier。
- **决策**：用 Biome（lint+format 一体，Rust 实现，Bun 原生友好）。
- **备选**：ESLint+Prettier（生态/规则更丰富，但双工具配置繁琐、慢，需 typescript-eslint）。
- **后果**：速度快、配置极简、TS 原生；规则生态不如 ESLint，但推荐规则集足够 MVP。CI 跑 `bun run lint`（biome ci）。
- **关联**：[CLAUDE.md](../../CLAUDE.md) §9；`.github/workflows/ci.yml`。

## ADR-014：CI 用 GitHub Actions，required checks = lint+typecheck+test+build

- **上下文**：需自动化质量门禁，防回归与红线违反。
- **决策**：GitHub Actions；每个 PR/push 跑 lint(biome)+typecheck(tsc)+test(bun test)+build(bun build)；四项设为 GitHub branch protection required check。
- **备选**：仅本地 hooks（无强制）/ 其他 CI 平台。
- **后果**：质量门禁强制；需维护 workflow。release 工作流延后到 Phase 1（有可发布物时）。
- **关联**：`.github/workflows/ci.yml`；[ROADMAP.md](ROADMAP.md) Phase 0。

---

## ADR-015：循环通用性——不需要循环策略抽象

- **上下文**：旧 Vessel 在 Alpha 期就加了 workflow/team/durable 等表面"编排"能力，均属 speculative generality（教训14）。重写中我们曾怀疑"不同 Agent 范式（Harness Engineering / Loop Engineering / 树搜索 / A2A）是否需要不同的循环策略"。经逐项论证，结论是不需要。
- **决策**：
  1. Vessel 的工具调用循环是**通用的**——同一个 `while` 循环挂不同的工具/Hook/Guardrail 组合即可覆盖已知所有范式。
  2. **不引入** `LoopStrategy` 抽象（不需要"循环策略"可替换的接口）。当前硬编码的 `ToolCallingLoop` 在可预见的未来是唯一循环。
  3. 以下"看似需要新循环"的范式均证明可用现有机制实现：
     - A2A / 多 agent / 树搜索 → 工具（handler 内部 spawn 子 runtime）
     - Self-correction → Guardrail 或 Hook
     - Plan-then-execute → Agent 自身的推理 + 逐轮工具调用
     - Debate → 工具（handler 内部并行多 runtime）
     - 并行工具调用 → 工具内部 `Promise.all`；或循环中 `for each` → `Promise.all`（一行代码优化）
     - 流式工具结果 → `EventStream.publish(tool.progress)`，流的是观测层，循环仍等最终结果
     - 打断/暂停 → `signal.aborted` → `break`（一行代码）
  4. 若未来出现**真正无法用现有机制表达**的循环语义——即无法通过新增工具/Hook/Guardrail/事件类型解决——此时再写新 ADR。当前判断：不存在此类场景。
- **后果**：core 额外少一个接口（`LoopStrategy` 从 SPEC 移除）；所有范式统一用同一循环；新人不用学"选哪种策略"。代价：若未来确实需要新循环拓扑，需新 ADR。但按当前论证，那是很小概率的事件。
- **关联**：[SPEC.md §1.1](SPEC.md)；[PLUGINS.md §九](PLUGINS.md)；legacy/LESSONS 教训14。

---

## ADR-016：LlmStreamChunk 事件类型——流式增量经事件流

- **上下文**：ADR-007 确立"流式 = 订阅事件流，非独立方法"，要求 loop 在 LLM 流式响应时增量发事件。当前 `LLMProvider.chat()` 仅返回完整 `LLMResponse`，loop 阻塞等待整段响应后一次发布 `LlmResponse`——TUI 只能看到整段文本，无法 token-by-token 渲染。ADR-012(2a) 允许扩展 EventType（"插座"级别演化）。
- **决策**：
  1. 新增 `EventType.LlmStreamChunk = 'llm.stream.chunk'`，携带 `LlmStreamChunkPayload { run_id, chunk: StreamChunk }`。
  2. `StreamChunk` 类型定义三层增量：`text_delta`（文本片段）、`tool_call_delta`（按 index 累积的 tool_call arguments 片段）、`finish`（完成原因 + usage）。
  3. `ChatRequest` 增加可选字段 `stream?: boolean` + `on_chunk?: (chunk: StreamChunk) => void`。Provider 在 `chat()` 内部处理流式（单方法，不动接口签名）：当 `stream=true` 且有 `on_chunk` 时走 SSE 逐块回调，最终仍返回拼装好的 `LLMResponse`（loop 后续逻辑不变）。
  4. Runtime 在 `toolCallingLoop` 始终传 `stream: true` + `on_chunk`（发布 `LlmStreamChunk` 事件）。支持流式的 Provider 走 SSE；不支持的 Provider 忽略字段，退化为整段返回（无 chunk 事件）。headless 无订阅者时 chunk 静默丢弃。
  5. 三个 Provider 同步实现流式：`MemoryLLMProvider`（供测试）、`OpenAICompatibleProvider`（SSE `data:` 行解析，tool_calls 按 index 累积）、`AnthropicProvider`（SSE `content_block_delta` 解析，tool_use `input_json_delta` 累积）。
- **备选**：(a) 新增 `chatStream()` 异步迭代器方法——被 SPEC §4.1 "非独立方法" 否决。(b) Provider 直接持 EventStream 引用 publish——耦合 provider 插件与 core 事件系统，且违 ADR-007"loop 增量发事件"。均不取。
- **后果**：TUI 可 token-by-token 渲染（emma 的 StreamRenderer 订阅 `LlmStreamChunk`）。EventType 枚举扩 1 个成员——现有 switch 无 exhaustiveness 检查，不破坏已有代码。Provider 非流式路径完全不变。core 稳定——不改 loop 逻辑、不引厂商 SDK。
- **关联**：[SPEC.md §4.1/§4.4](SPEC.md)；ADR-007、ADR-008、ADR-012(2a)。

---

## ADR-017：Core 正式冻结

- **上下文**：ADR-012 确立了 core 稳定性策略——只改三类事（插座/bug/横切）。ADR-011 确立四种扩展类型全经 PluginHost 投放。ADR-015 论证循环通用性——不需要 LoopStrategy 抽象。经 ADR-016（流式）补完 EventType 扩展面，9 个 core 接口 + 1 个循环 + 2 个插槽（ToolRegistry、ContextManager）的 MVP 范围已完整实现且与 SPEC 对齐。对所有已知功能诉求，Plugin/MCP/Skill 提供了充分且不侵入 core 的扩展路径。
- **决策**：
  1. `@vessel/core` 的 9 个接口 + tool-calling loop + EventType 枚举 + PluginHost 接口 **正式冻结**。冻结范围：`packages/core/src/**`。
  2. **只能因三种理由修改 core**（与 ADR-012(2a-c) 一致）：(a) 扩展"插座"（新增 EventType/HookType/GuardrailStage 成员，需写新 ADR）；(b) 修复 loop 级或安全级 bug；(c) 被证明无法用 Plugin/Hook/Guardrail/事件/工具解决的横切需求（需先写新 ADR 论证）。
  3. **任何改 core 的 PR 必须带 ADR 且被两人 review 通过**。CLAUDE.md §5.1 包含 AI 自检清单——拿不准不进 core。
  4. **解冻条件**（全部满足）：(a) 出现 Plugin/Hook/Guardrail/事件/工具均无法表示的架构级需求；(b) 经至少一个插件尝试证明不可行；(c) 新 ADR 论证 + 两人 review 通过。
- **备选**：永冻（不可逆）——过于僵化，ADR-012 保留的三种修改路径是合理安全阀。不冻（继续按 ADR-012 判断）——缺少显式里程碑，人类与 AI 对"可以改"的边界认知不统一。当前决策取了冻结 + 有限解冻条件的中间路径。
- **后果**：AI 合约明确——CLAUDE.md §5.1 让每次编码会话首条指令级阻断。人类合约明确——PR 审查引用本 ADR 即可拒绝越界改动。Core 真正"固定不动"。若未来出现需解冻的需求，按本 ADR 第 4 条执行。
- **关联**：ADR-012、ADR-011、ADR-015；[CLAUDE.md §5.1](../../CLAUDE.md)。

---

## ADR-018：BeforeLlm hook 注入消费--修复 loop 不消费 ctx.system_prompt 的 bug

- **上下文**：SPEC §4.7 规定 `Hook.run(ctx)` 返回 `HookContext | null`（`null = 拦截`）。ADR-011 确立 Skills 经 `BeforeLlm` 钩子注入 system prompt；memory-project 同机制注入 CLAUDE.md / 项目记忆。两个插件都往 `ctx.system_prompt` 写注入内容。但 `AgentRuntime.toolCallingLoop` 的 `runHooks` 忽略 hook 返回值，且 `BeforeLlm` 之后从不读 `ctx.system_prompt`--注入内容从未进入 LLM 请求。结果：AI 不会自动看到 Skills / CLAUDE.md，只能经工具（`list_skills`/`get_memory`）手动取。这是 loop 与 hook 契约不一致的 bug。
- **决策**：属 ADR-017(2b)「修复 loop 级 bug」，无需解冻。在 `toolCallingLoop` 的 `BeforeLlm` 前，用 `this.systemPrompt` 种子化 `ctx.system_prompt`（hook 链在此基础上 prepend 注入）；`BeforeLlm` 后，把 `ctx.system_prompt` 作为**本次请求**的 system 消息内容（替换已有 system 消息，或无则前置一条）。**不改动 `ContextManager` 持久化的消息**--注入只影响单次 LLM 请求，session 持久化保持干净。
- **未涉及**：(1) `runHooks` 的返回值 `null = 拦截` 语义仍未实现（无插件使用，属单独 concern，本 ADR 不处理）。(2) hook `priority` 字段仍未排序--注入顺序按注册序，非 priority（`applyGuardrails` 同样未排 priority，统一留待另议）。
- **后果**：skills-loader 与 memory-project 的自动注入生效；AI 第一轮即带 Skills / CLAUDE.md 上下文。ContextManager 不被 hook 污染（持久化干净、可 replay）。限制：注入顺序非 priority；hook 拦截未实现。二者均不影响当前功能，后续按需另立 ADR。
- **关联**：ADR-017(2b)、ADR-011；[SPEC.md §4.7](SPEC.md)。

---

## ADR-019：代码命名规范--TS 全驼峰，YAML 配置保持 snake_case，loader 做映射

- **上下文**：Biome（ADR-013）的 `useNamingConvention` 规则要求 TS 对象属性用 `camelCase`。但 Vessel 的配置类型（`VesselConfig`、`ProviderConfig`、`UsageLimits` 等）全部用了 `snake_case`（如 `api_key`、`base_url`、`request_limit`），因为它们在 YAML 文件中面向用户。YAML 中 `snake_case` 更可读，不应该改动。但 TS 代码中的 `snake_case` 属性导致 CI lint 持续报警（506 条 warning + 部分 error），且与 Biome 规则对立，每次修改文件都需 biome-ignore。
- **决策**：
  1. **TS 代码层禁用 `snake_case`**：所有 TS 接口、类、变量使用 `camelCase`。`packages/config/src/types.ts` 的 `VesselConfig` 等类型字段全部改为 `camelCase`（如 `api_key` → `apiKey`，`base_url` → `baseUrl`，`max_tokens` → `maxTokens`）。
  2. **YAML 用户层保持 `snake_case`**：`vessel.yaml`、`~/.vessel/config.yaml` 中的键名不变（仍为 `api_key`、`base_url`）。用户面向的 YAML 采用 snake_case 更符合 YAML/YAML 惯例，不牺牲可读性。
  3. **config loader 做映射**：`@vessel/config` 的 `loadConfig()` 在解析 YAML 后，自动将 `snake_case` 键映射为 `camelCase` 字段（`api_key` → `apiKey`，`tool_calls_limit` → `toolCallsLimit`，以此类推）。**嵌套对象递归映射**。配置 validated 之后任意下游代码（core、tui、cli、plugins）看到的是全 camelCase 的 `VesselConfig`，不再需要处理 snake_case。
  4. **biome.json 移除 `useNamingConvention: "warn"`**：当前 `warn` 级别被 Biome 1.9 部分误报为 `error`（见 defaults.ts DEFAULT_CONFIG 的 `max_tokens`/`max_history` 等字段）。修完 snake_case 后改为**推荐规则默认级别或移除显式 warn**——因为全部 camelCase 之后自然合规，不需要手动压制。
  5. **Core 类型例外**：`@vessel/core` 中与 LLM API 协议直接对应的字段（如 `ChatRequest` 的 `max_tokens`、`ToolCall` 的 `tool_call_id`）保持 `snake_case`，因为这些字段名由 OpenAI/Anthropic API 规范定义，**不能改**。对这类字段，在文件中使用 `// biome-ignore-file lint/style/useNamingConvention: LLM API protocol fields` 压制整个文件的规则。这是 Biome 规则与外部 API 协议的合法冲突，不是 Vessel 自身的设计问题。
- **备选**：(a) 放弃 Biome 的 naming convention 规则——退回到无规则状态，代价是没有统一的 TS 命名约束。(b) 在 `biome.json` 中全局关闭 `useNamingConvention`——简单但失去 lint 保护，且其他 `snake_case` 滥用不会被检测。(c) 不改 TS 类型，对每个字段加 biome-ignore 行级注释——维护成本高、代码丑。均不取。
- **后果**：下游代码（cli、tui、core、plugins）需要使用 `config.provider.baseUrl` 而非 `config.provider.base_url`。YAML 文件语法不变，用户无感知。Core API 协议相关文件需要少量 biome-ignore 压制。`@vessel/config` 增加 `snakeToCamel` 映射函数，配置加载逻辑稍增但不影响运行时性能（只在加载时执行一次）。
- **关联**：ADR-005（双层配置）、ADR-013（Biome）；[DOC-STANDARD.md](DOC-STANDARD.md) §四；[SPEC.md §6](SPEC.md)。

---

## ADR-020：双轨命令体系——斜杠命令（人类）与控制台命令（AI）

- **上下文**：Vessel 需要两类命令接口：(1) 人类用户在 REPL 中使用的斜杠命令（`/xxx`）；(2) AI/脚本通过 CLI 调用的控制台命令（`vessel xxx`）。当前实现（commands.ts）注释明确："斜杠命令（扁平结构：`/<command> [args]`）"，所有命令均为顶层。
- **决策**：
  1. **斜杠命令（`/xxx`）——人类用户**：扁平结构、好记易用、进入 TUI 交互界面、AI 不可调用。命令清单：`/sessions`、`/tools`、`/plugins`、`/mcp`、`/skills`、`/assets`、`/setup`、`/reload`、`/clear`、`/help`、`/exit`。
  2. **控制台命令（`vessel xxx`）——AI/脚本**：复合结构（`vessel <domain> <action>`）、可脚本化、输出结构化（JSON/表格）、有完整 CLI 文档。
  3. **交互界面模式**：所有浏览器界面遵循统一模式（`┌─ [Title] ─┐` + 列表 + 快捷键提示），标准快捷键：`↑↓` 导航、`Enter` 详情、`Esc` 返回、`R` 刷新。
  4. **与元资产工具的关系**：SPEC.md §1.2 的元资产工具（`search_assets`、`add_tool` 等）是 AI 通过 tool-calling 调用的；控制台命令是人类/AI 通过 CLI 调用的接口，两者互补。
- **备选**：(a) 单轨体系——斜杠命令和控制台命令共用同一套——但人类需要图形化交互，AI 需要结构化输出，需求冲突。(b) 斜杠命令直接执行操作——但失去交互界面的选择、确认能力。
- **后果**：职责清晰（人类用斜杠命令，AI 用控制台命令）、体验优化（人类获图形化界面，AI 获结构化输出）、扩展性好。代价：需维护两套命令体系、需编写控制台命令文档。
- **关联**：ADR-011、SPEC.md §5.1；[tui.md](../api/tui.md) §7。

---

## ADR-021：工具显示接口——TUI 层定义，不改 Core

- **上下文**：当前工具调用显示（`🔧 tool_name args ✓ duration_ms`）过于简单，需要支持更丰富的显示：工具活动描述、进度状态、结果渲染、错误显示等。Claude Code 的工具显示接口设计值得参考。
- **决策**：
  1. **不改 Core**：`@vessel/core` 的 `ToolDefinition` 保持不变（`name`, `description`, `inputSchema`, `handler`）。显示接口在 TUI 层单独定义。
  2. **TUI 层定义 `ToolDisplayDefinition`**：
     ```typescript
     interface ToolDisplayDefinition {
       userFacingName(input: unknown): string
       userFacingColor?(input: unknown): string
       renderToolUseMessage(input: unknown, options: DisplayOptions): React.ReactNode
       getActivityDescription?(input: unknown): string | null
       renderToolResultMessage?(result: string, options: DisplayOptions): React.ReactNode
       renderToolUseErrorMessage?(error: string, options: DisplayOptions): React.ReactNode
     }
     ```
  3. **注册机制**：TUI 层维护 `ToolDisplayRegistry`，工具可以注册自定义显示定义，未注册的工具使用默认渲染器。
  4. **简化设计**：移除 `isSearchOrReadCommand`（折叠显示）和 `isResultTruncated`（点击展开）等辅助功能，用默认行为替代。
- **备选**：(a) 扩展 Core 的 `ToolDefinition` 加 `display` 字段——违反 ADR-017 Core 冻结。(b) 不定义接口，每个工具硬编码渲染逻辑——难以维护。
- **后果**：Core 不改动，显示逻辑集中在 TUI 层，可独立演化。内置工具可以注册自定义显示，第三方工具使用默认渲染器。
- **关联**：ADR-017（Core 冻结）、ADR-020（命令设计）；Claude Code `Tool.ts` 参考。

---

## ADR-022：Spinner 状态显示——追踪思考/工具执行状态

- **上下文**：当前 REPL 没有"思考中"状态显示，用户不知道 AI 是否在思考、思考了多久、是否在等待响应。Claude Code 的 Spinner 组件设计值得参考。
- **决策**：
  1. **Spinner 组件**：实现 `<SpinnerWithVerb>` 组件，支持三种模式：
     - `thinking`：思考中，显示 `🤔 Thinking...`
     - `tool`：工具执行中，显示活动描述（如 `📖 Reading src/foo.ts`）
     - `idle`：空闲，显示 `✻ Idle`
  2. **状态追踪**：TUI 层实现 `StateTracker`，订阅事件流计算状态：
     - `LlmRequest` → `thinking` 开始
     - `LlmStreamChunk` → `thinking` 结束，计算时长
     - `ToolCallStarted` → `tool` 开始
     - `ToolCallCompleted` → `tool` 结束
  3. **最小显示时间**：思考状态最少显示 2 秒，避免 UI 闪烁。
  4. **附加信息**：Spinner 可显示：
     - 活动描述（`getActivityDescription()`）
     - Token 计数
     - 努力程度（effort suffix）
     - 下一个任务（如果有）
     - Token 预算（如果配置）
  5. **替代当前实现**：Spinner 组件替代 `StreamRenderer` 的 `renderToolCallStarted/Completed/Failed` 方法，提供更丰富的显示。
- **备选**：(a) 保持当前简单文本输出——用户体验差。(b) 在 Core 层追踪状态——违反 ADR-017。
- **后果**：用户获得更好的状态反馈，知道 AI 是否在思考、思考了多久、执行了什么工具。需要修改 TUI 层的 StreamRenderer 和 REPL 组件。
- **关联**：ADR-017（Core 冻结）、ADR-021（工具显示）；Claude Code `Spinner.tsx` 参考。
