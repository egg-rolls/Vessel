# 架构决策记录（ADR）

> 记录 Vessel 的关键决策与**为什么**。架构事实见 [ARCHITECTURE.md](ARCHITECTURE.md)。
>
> **本文档是历史存档：只追加、不修改。** ADR-001 ~ ADR-033 写于当时的架构，其中引用的
> `SPEC.md` / `PLUGINS.md` / `ROADMAP.md` / `PRD.md` / `GLOSSARY.md` / `DOC-STANDARD.md` /
> `GIT-WORKFLOW.md` / `legacy/LESSONS.md` / `docs/api/*` / `docs/role/*` 等文件，已在
> [ADR-034](#adr-034极简化重构解冻-core三工具集skills-即消息拆治理) 的重构中删除，这些链接不再有效。
> 保留原文以存真——**其中的架构描述不代表当前实现**，以代码与 ARCHITECTURE.md 为准。
> ADR 一经决策不轻易推翻；如需变更，新增 ADR 标注 supersede 旧者。

---

## ADR-001：实现语言用 TypeScript

- **上下文**：旧项目用 Python，对无基础用户分发门槛高（装解释器/venv/PyInstaller 打包大且慢）。同类 CLI agent（Claude Code/Cline/Continue）多为 TS。
- **决策**：用 TypeScript；运行时 Bun；分发 `npx vessel`（弃单二进制，见 ADR-006）。
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

## ADR-006：分发走 npx，弃单二进制

- **上下文**：无基础用户跑 Python 应用门槛高；单二进制分发限制多——插件/工具被编译进二进制，无法运行时加载用户工具与外部扩展，违背"用户加工具运行时发现"的开放模型（对比 Claude Code / hermes 的 npx/包分发路线）。
- **决策**：分发走 `npx vessel`（有 Node/Bun 者）。**抛弃 `bun build --compile` 单二进制**——单二进制把能力锁进内核，限制插件生态与运行时工具发现（ADR-028/030 的开放模型）。
- **后果**：分发依赖 Node/Bun 环境；插件/工具可运行时加载（用户放 `~/.vessel/tools/` 即注册）；需维护 npm 发布流水线。单二进制不再作为分发形态。
- **关联**：legacy/LESSONS 教训13；ADR-001、ADR-028。

## ADR-007：流式 = 事件订阅，非独立 runtime

- **上下文**：旧 Vessel 流式是独立 StreamingAgentRuntime 类，与主 loop 分离；GAPS 自称修复的"统一事件模型"未兑现。
- **决策**：单一 runtime loop；流式输出通过订阅 EventStream 实现，TUI 订阅同一事件流渲染。
- **后果**：一套数据供 trace/replay/TUI；无重复 runtime。代价：loop 需在 LLM 流式响应时增量发事件。
- **关联**：legacy/LESSONS 教训10；[SPEC.md](SPEC.md) §3.3。

## ADR-008：事件类型枚举化 + payload schema

- **上下文**：旧 Vessel 事件类型是散落字符串字面量，手写 dict 发布，易拼写错、无校验。
- **决策**：EventType 枚举 + 每类对应 payload schema；发布走 `EventStream.publish(RunEvent)`。**已被 ADR-027/030 取代**——事件名一律开放字符串字面量，payload schema 保留。
- **后果**：类型安全、可校验、可文档化。新增事件需扩枚举。→ 开放后新增事件零 core 变更（ADR-030）。
- **关联**：legacy/LESSONS 教训8；[SPEC.md](SPEC.md) §4.4；[EVENT-SYSTEM.md](../api/EVENT-SYSTEM.md)。

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
  2. core 仅在三种情况可改：(a) 新增/演化扩展面（HookType/GuardrailStage 等"插座"；事件名已开放，无需扩 EventType，见 ADR-030）；(b) 修复 loop 级缺陷；(c) 支持证明无法被工具/Hook/Guardrail/事件解决的横切需求（经 ADR-015 论证，尚无已知的此类需求）。
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
  1. 新增 `llm.stream.chunk` 事件（携带 `LlmStreamChunkPayload { run_id, chunk: StreamChunk }`）；事件名现为开放字符串字面量（ADR-030，无 EventType 枚举）。
  2. `StreamChunk` 类型定义三层增量：`text_delta`（文本片段）、`tool_call_delta`（按 index 累积的 tool_call arguments 片段）、`finish`（完成原因 + usage）。
  3. `ChatRequest` 增加可选字段 `stream?: boolean` + `on_chunk?: (chunk: StreamChunk) => void`。Provider 在 `chat()` 内部处理流式（单方法，不动接口签名）：当 `stream=true` 且有 `on_chunk` 时走 SSE 逐块回调，最终仍返回拼装好的 `LLMResponse`（loop 后续逻辑不变）。
  4. Runtime 在 `toolCallingLoop` 始终传 `stream: true` + `on_chunk`（发布 `LlmStreamChunk` 事件）。支持流式的 Provider 走 SSE；不支持的 Provider 忽略字段，退化为整段返回（无 chunk 事件）。headless 无订阅者时 chunk 静默丢弃。
  5. 三个 Provider 同步实现流式：`MemoryLLMProvider`（供测试）、`OpenAICompatibleProvider`（SSE `data:` 行解析，tool_calls 按 index 累积）、`AnthropicProvider`（SSE `content_block_delta` 解析，tool_use `input_json_delta` 累积）。
- **备选**：(a) 新增 `chatStream()` 异步迭代器方法——被 SPEC §4.1 "非独立方法" 否决。(b) Provider 直接持 EventStream 引用 publish——耦合 provider 插件与 core 事件系统，且违 ADR-007"loop 增量发事件"。均不取。
- **后果**：TUI 可 token-by-token 渲染（emma 的 StreamRenderer 订阅 `llm.stream.chunk`）。事件名开放字符串字面量（ADR-030），新增无需扩枚举。Provider 非流式路径完全不变。core 稳定——不改 loop 逻辑、不引厂商 SDK。
- **关联**：[SPEC.md §4.1/§4.4](SPEC.md)；ADR-007、ADR-008、ADR-012(2a)。

---

## ADR-017：Core 正式冻结

- **上下文**：ADR-012 确立了 core 稳定性策略——只改三类事（插座/bug/横切）。ADR-011 确立四种扩展类型全经 PluginHost 投放。ADR-015 论证循环通用性——不需要 LoopStrategy 抽象。经 ADR-016（流式）补完 EventType 扩展面，9 个 core 接口 + 1 个循环 + 2 个插槽（ToolRegistry、ContextManager）的 MVP 范围已完整实现且与 SPEC 对齐。对所有已知功能诉求，Plugin/MCP/Skill 提供了充分且不侵入 core 的扩展路径。
- **决策**：
  1. `@vessel/core` 的 9 个接口 + tool-calling loop + HookType/GuardrailStage 枚举 + PluginHost 接口 **正式冻结**（事件名已开放，`EventType` 枚举已废弃，见 ADR-030）。冻结范围：`packages/core/src/**`。
  2. **只能因三种理由修改 core**（与 ADR-012(2a-c) 一致）：(a) 扩展"插座"（新增 HookType/GuardrailStage 成员，需写新 ADR；事件名开放，无需扩 EventType，见 ADR-030）；(b) 修复 loop 级或安全级 bug；(c) 被证明无法用 Plugin/Hook/Guardrail/事件/工具解决的横切需求（需先写新 ADR 论证）。
  3. **任何改 core 的 PR 必须带 ADR 且被两人 review 通过**。../role/DEVELOPER.md §Core 冻结 包含 AI 自检清单——拿不准不进 core。
  4. **解冻条件**（全部满足）：(a) 出现 Plugin/Hook/Guardrail/事件/工具均无法表示的架构级需求；(b) 经至少一个插件尝试证明不可行；(c) 新 ADR 论证 + 两人 review 通过。
- **备选**：永冻（不可逆）——过于僵化，ADR-012 保留的三种修改路径是合理安全阀。不冻（继续按 ADR-012 判断）——缺少显式里程碑，人类与 AI 对"可以改"的边界认知不统一。当前决策取了冻结 + 有限解冻条件的中间路径。
- **后果**：AI 合约明确——../role/DEVELOPER.md §Core 冻结 让每次编码会话首条指令级阻断。人类合约明确——PR 审查引用本 ADR 即可拒绝越界改动。Core 真正"固定不动"。若未来出现需解冻的需求，按本 ADR 第 4 条执行。
- **关联**：ADR-012、ADR-011、ADR-015；[../role/DEVELOPER.md §Core 冻结](../../role/DEVELOPER.md)。

---

## ADR-018：BeforeLlm hook 注入消费--修复 loop 不消费 ctx.system_prompt 的 bug

- **上下文**：SPEC §4.7 规定 `Hook.run(ctx)` 返回 `HookContext | null`（`null = 拦截`）。ADR-011 确立 Skills 经 `BeforeLlm` 钩子注入 system prompt；memory-project 同机制注入 CLAUDE.md / 项目记忆。两个插件都往 `ctx.system_prompt` 写注入内容。但 `AgentRuntime.toolCallingLoop` 的 `runHooks` 忽略 hook 返回值，且 `BeforeLlm` 之后从不读 `ctx.system_prompt`--注入内容从未进入 LLM 请求。结果：AI 不会自动看到 Skills / CLAUDE.md，只能经工具（`list_skills`/`get_memory`）手动取。这是 loop 与 hook 契约不一致的 bug。
- **决策**：属 ADR-017(2b)「修复 loop 级 bug」，无需解冻。在 `toolCallingLoop` 的 `BeforeLlm` 前，用 `this.systemPrompt` 种子化 `ctx.system_prompt`（hook 链在此基础上 prepend 注入）；`BeforeLlm` 后，把 `ctx.system_prompt` 作为**本次请求**的 system 消息内容（替换已有 system 消息，或无则前置一条）。**不改动 `ContextManager` 持久化的消息**--注入只影响单次 LLM 请求，session 持久化保持干净。
- **未涉及**：(1) `runHooks` 的返回值 `null = 拦截` 语义仍未实现（无插件使用，属单独 concern，本 ADR 不处理）。(2) hook `priority` 字段仍未排序--注入顺序按注册序，非 priority（`applyGuardrails` 同样未排 priority，统一留待另议）。
- **后果**：skills-loader 与 memory-project 的自动注入生效；AI 第一轮即带 Skills / CLAUDE.md 上下文。ContextManager 不被 hook 污染（持久化干净、可 replay）。限制：注入顺序非 priority；hook 拦截未实现。二者均不影响当前功能，后续按需另立 ADR。
- **关联**：ADR-017(2b)、ADR-011；[SPEC.md §4.7](SPEC.md)。
- **更新**：hook/guardrail priority 排序已在 `plugin-host.ts` 的 `registerHook`/`registerGuardrail` 中实现（按 priority 升序插入）。

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
  1. **斜杠命令（`/xxx`）——人类用户**：扁平结构、好记易用、进入 TUI 交互界面、AI 不可调用。命令清单：`/resume`、`/new`、`/history`、`/tools`、`/plugins`、`/mcp`、`/skills`、`/assets`、`/setup`、`/reload`、`/clear`、`/help`、`/exit`。
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

---

## ADR-023：AgentRuntime 构造函数异步反模式修复——改用静态工厂方法

- **上下文**：`AgentRuntime` 构造函数中启动 `installPlugins()` 但不 await，将 Promise 存为 `_readyPromise`，暴露 `ready` getter 让用户手动 await。这是异步构造反模式——构造函数同步返回但对象处于半初始化状态，忘记 `await runtime.ready` 则插件未安装就开始 `run()`，行为未定义。
- **决策**：属 ADR-017(2b)「修复 loop 级 bug」。构造改为 `private`，只做纯同步初始化；新增 `static async create(opts): Promise<AgentRuntime>` 工厂方法，在返回前 await 完插件安装；删除 `_readyPromise` 和 `ready` getter。所有调用方从 `new AgentRuntime(opts)` + `await runtime.ready` 改为 `await AgentRuntime.create(opts)`。此变更不改变 tool-calling loop 行为、不改变 Plugin/Hook/Guardrail 扩展机制、不改变 Core 接口契约——仅修复对象生命周期的一致性。
- **论证为何无法用 Plugin/Hook/Guardrail/事件表示**：构造函数是 TypeScript 语言级约束，无法通过插件扩展改变构造语义。静态工厂方法是唯一能在构造后、返回前执行异步初始化的标准模式。Plugin 在构造完成后才有机会注册，无法决定对象何时暴露给外部。
- **备选**：(a) 保持 async-in-constructor + `ready`——已证明反模式，P0 issue (#17)。(b) 让构造函数接受临时 Promise 并在外部等待——不改变现状。均不取。
- **后果**：用户拿到 runtime 时插件已就绪，无需额外 await。构造函数私有化防止直接 `new`。静态工厂方法成为标准实例化路径。Core 冻结不变——本 ADR 属 bug 修复不冲击冻结状态。
- **关联**：ADR-017(2b)、ADR-018；[issue #17](https://github.com/egg-rolls/Vessel/issues/17)。

---

## ADR-024：ToolDefinition.default 过滤——修复 loop 不按 default 字段过滤工具的 bug

- **上下文**：SPEC §4.2 定义了 `ToolDefinition.default?: boolean` 字段，语义明确——`default: true` 的工具在 system prompt 中自动列出，`default: false` 的工具通过 `search_assets` 按需发现。PLUGINS.md §一 为每个工具分配了 default 值（file-ops/grep/web-search/web-fetch 为 `true`；shell 为 `false`）。类型系统中 `default` 字段已存在，但 `AgentRuntime.toolCallingLoop` 从不读取此字段——`listTools()` 返回全部工具后直接映射为 schema 发送给 LLM。结果：渐进式工具发现机制从未生效，所有工具（包括 shell）始终暴露在 LLM 请求中。
- **决策**：属 ADR-017(2b)「修复 loop 级 bug / spec-implementation gap」，无需解冻。在 `toolCallingLoop` 的 `listTools()` 之后、`map` 之前，加一行过滤：`allTools.filter(t => t.default !== false)`。语义：`default === false` 的工具不自动发送给 LLM；`default === true` 或未设置（`undefined`）的工具保持默认可见。`pluginHost.listTools()` 仍返回全部工具——`search_assets` 可通过它发现隐藏工具；运行时仅过滤 LLM 请求中的工具列表。`LlmRequest` 事件发布过滤后的 `toolSchemas`，与 LLM 实际收到的内容一致。
- **论证为何无法用 Plugin/Hook/Guardrail/事件表示**：(1) `BeforeLlm` hook 上下文不暴露工具列表，无法过滤；(2) 若由 plugin 从 registry 中移除 `default: false` 的工具，则 `search_assets` 也无法发现它们——过滤必须发生在「选择发送给 LLM 的工具」这一时刻，而非「注册工具」时；(3) Guardrail 作用于工具调用结果或输入，不作用于工具的可见性。唯一正确的切入点就是 tool-calling loop 组装 LLM 请求处。
- **备选**：(a) 在 `pluginHost.listTools()` 层面加参数 `listTools({ defaultOnly: true })`——但 `PluginHost` 接口需新增方法签名，破坏 Core 冻结且新增接口契约。(b) 新增独立的 `listDefaultTools()` 方法——同样需改接口。(c) 不做过滤，所有工具始终可见——与 SPEC 矛盾且 shell 等危险工具无法隐藏。均不取。
- **后果**：`default: false` 的工具不再出现在 LLM 请求中，渐进式发现机制的第一步生效。`search_assets` 元工具可通过 `listTools()` 发现并文档化这些隐藏工具。向后兼容：未设置 `default` 的工具视为可见，现有行为不变。debug 日志从 `[Debug] Total tools:` 改为 `[Debug] Visible tools: N / M` 以区分可见/全部。Core 冻结不变——本 ADR 属 spec-implementation gap fix，不冲击冻结状态。
- **关联**：ADR-017(2b)、ADR-018；SPEC §4.2；PLUGINS.md §一；[issue #71](https://github.com/egg-rolls/Vessel/issues/71)。

---

## ADR-025：补全 SessionBackend 参考实现——不视为 Core 解冻

- **上下文**：SPEC §4.8 明确规划 SessionBackend "提供 in-memory、file、sqlite 三种参考实现"。in-memory 和 sqlite 已完整实现，FileSessionBackend 存在基础 stub（`session-backend.ts` 97-170 行）但缺少 meta 派生、默认路径不对齐 `.vessel/` 规范。Issue #78 要求将 file 实现补全到与 sqlite 同等的参考实现质量。
- **决策**：**补全 SPEC 规划的参考实现不构成 ADR-017 的"改 core"**。理由：(1) `SessionBackend` 是已冻结的 9 个 core 接口之一——未修改接口本身；(2) SPEC §4.8 在冻结前已规划三种实现——这是完成既定设计，不是新增能力；(3) `FileSessionBackend` 已以 stub 形式存在于 core——本 PR 仅提取到独立文件并补全实现；(4) Session 持久化明确属于 core 内置（AGENTS.md §6）；(5) `SQLiteSessionBackend` 以同样方式（独立 `sqlite-backend.ts`）进入 core，无单独 ADR。**对 ADR-017 的澄清**：冻结阻止的是接口面扩张和新架构能力进入 core。为已冻结的接口补全预规划的参考实现——不改接口、不加能力——不需解冻。
- **备选**：(a) 将 FileSessionBackend 做成插件——增加不必要的复杂度：SessionBackend 实现在 core 中是与 runtime/session 模块紧耦合的基础设施，打成插件增加加载顺序、类型引用等无谓摩擦。(b) 不补全、留 stub——SPEC 明确要求三种实现，stub 质量不可用于生产。均不取。
- **后果**：三种 SessionBackend 全部就位：in-memory（测试/开发）、file（单机轻量部署）、sqlite（生产/查询）。Core 冻结范围不变——接口、循环、事件系统均未改动。
- **关联**：ADR-017、[SPEC §4.8](SPEC.md)、[#78](https://github.com/egg-rolls/Vessel/issues/78)。

---

## ADR-026：工具自描述对象——权限/暂停/显示/条件启用下沉到工具节点

- **上下文**：Vessel 的架构哲学是「接口极简、复杂度外推」——core 只保留接口和循环，把决策和实现推到边缘。但既有的 `ToolDefinition` 只含 `name/description/inputSchema/handler/default`，权限靠外部 guardrail 挂接、暂停靠 bootstrap 合成注册（ask-user/permission）、显示靠 TUI 的 `ToolDisplayRegistry`（ADR-021）、条件启用仅一个 `default` 布尔。结果是：每个新交互工具都要改 bootstrap、每次新事件都要动 core——**复杂度被收在中心，边缘无法自由生长**。复杂度外推为什么好：(1) 核心稳定——复杂度留在中心则每次演化动冻结区，冻结失去意义；(2) 可扩展——工具自包含，加能力不改核心；(3) 认知负荷——理解 core = 理解接口，不需理解全部实现；(4) 独立演化与测试——每个工具独立改、独立测；(5) 自由度——实现可替换。
- **决策**：
  1. `ToolDefinition` 扩展为自描述对象，新增**全可选**字段（向后兼容，现有工具零改动编译）：
     - `interactive?: boolean`——需要暂停等用户输入
     - `checkPermission?(input, ctx)`——执行时权限判定
     - `render?(input)`——自定义显示（与 ADR-021 调和：默认 TUI 模板，工具可选声明渲染数据）
     - `isEnabled?(): boolean`——条件启用
     - `shouldDefer?: boolean`——延迟加载（tool_reference，预留）
  2. `ToolContext` 注入 `events: EventStream`（配合 ADR-027），工具可发事件、等事件。
  3. ask-user / permission 从 bootstrap 合成注册改为普通工具对象（ADR-029）。
- **备选**：(a) 保持现状——暂停/权限继续死代码在 bootstrap，新交互工具要改装配层；(b) 在 core 加暂停/权限接口——把复杂度推回 core，违背 ADR-017 冻结。均不取。
- **后果**：工具自描述，注册系统只做「发现」，不做业务决策；新增交互工具只加一个工具文件，bootstrap 的暂停特例消失；`default` 布尔被 `shouldDefer`/`isEnabled` 取代。本 ADR **supersede ADR-024**（default 字段过滤）、**调和 ADR-021**（工具显示，TUI 模板为主 + 工具可选定制）。
- **关联**：ADR-027、ADR-028、ADR-029、ADR-017 解冻流程；[#91](https://github.com/egg-rolls/Vessel/issues/91)。

## ADR-027：事件流拓展——事件名+payload 开放 + waitFor 原语

- **上下文**：事件流是 runtime 的核心机制——loop 的每个节点都在发事件。ADR-008 为防散落字符串拼错而枚举化，但副作用是 core 僵化：**每次新事件都要改冻结的 `EventType` 枚举、写 ADR**——这本身就是把扩展复杂度往 core 推。Claude Code 与 hermes 均验证过开放机制：事件名是字符串常量 + 任意 payload，无枚举、无注册表 schema 校验，是行业主流。复杂度外推：事件类型的扩展能力应属于插件层，而非 core。
- **决策**：
  1. `RunEvent.type` 从 `EventType` 枚举放宽为 `string`。事件名一律开放字符串字面量，不定义 `EventType` 常量（ADR-030 修正：舍弃常量，杜绝二义）。
  2. `EventStream` 新增 `waitFor(name, { requestId?, timeout }): Promise<unknown>`——等待一次匹配事件；内部维护 pending map，收到匹配事件（含 requestId）时 resolve，超时 reject。工具可发事件、等事件。
  3. `ToolContext` 注入 `events`（ADR-026）。新增事件**不需要改 core**，插件直接 `publish` 自定义字符串事件名。
- **备选**：(a) 全枚举（现状）——每次新事件动冻结区，core 僵化；(b) 注册表 `registerEventType(name, schema)`——core 加接口，且两个成熟项目均未做，非必需。均不取。
- **后果**：事件系统开放，插件自由发布/订阅事件；核心事件仍强类型（常量 + payload 文档）。本 ADR **supersede ADR-008 的枚举封闭部分**、**ADR-015 的「暂停 = `signal.aborted` 一行」条款**（交互暂停由 `waitFor` 承载，见 ADR-029）。
- **关联**：ADR-026、ADR-029；[EVENT-SYSTEM.md](../api/EVENT-SYSTEM.md)；[#91](https://github.com/egg-rolls/Vessel/issues/91)。

## ADR-028：注册系统外推——registry 接口化 + 构建时扫描

- **上下文**：core 冻结，但 core 边缘的装配机制同样应作为接口，否则自由度在装配层被卡死。既有 `src/plugin-registry.ts` 是具体类（`DEFAULT_PLUGIN_IMPORT_MAP` 路径写死）：加一个工具要手改注册表，违背开闭原则；「扫描式 / 配置声明式」的注册实现全被堵死。复杂度外推：装配机制也应接口化，实现可插拔。
- **决策**：
  1. 定义 `PluginProvider` 接口：`getAvailablePlugins()` / `loadPlugin(name)` / `getProviders()`——只承诺「发现」，不做权限/暂停/显示等业务决策（已下沉到工具对象，ADR-026）。
  2. 实现可插拔：`StaticRegistry`（既有映射表，迁移期保留）/ `BuildTimeScanner`（构建时扫描生成注册表）/ `DirScanner`（用户目录运行时扫描）/ `ConfigDeclared`（vessel.yaml 声明连接）。
  3. 内置工具**运行时扫描** `plugins/*/*/`（ADR-006 弃单二进制后，分发带插件目录，运行时动态发现；构建时扫描是单二进制时代的打包折中，不再必要）。
- **备选**：(a) 保持路径写死——加工具要改代码，违背「只加不改」；(b) 构建时扫描——单二进制时代的打包折中，ADR-006 弃单二进制后不再必要。取运行时扫描。
- **后果**：注册系统只做「发现」，实现可替换；开发者放文件夹即注册，**运行时自动发现**（无需构建生成注册表）；bootstrap 不再硬编码插件名数组。
- **关联**：ADR-026；[#92](https://github.com/egg-rolls/Vessel/issues/92)。

## ADR-029：交互暂停事件流化——ask-user/permission 用事件流实现

- **上下文**：暂停型工具（ask-user / permission）既在 bootstrap 合成注册，靠 `AskUserBridge` + 回调注入与 CLI/TUI 交互——这是「死代码」：每个交互工具都要在装配层写一遍回调桥。ADR-027 提供 `waitFor` 后，暂停可由工具自己用事件流实现，组件间交流全走事件流，无直接回调。
- **决策**：
  1. ask-user 改为普通工具：handler 里 `events.publish('ask.user.requested', { requestId, question })` → `await events.waitFor('ask.user.answered', { requestId, timeout })` → 返回回答。
  2. TUI 订阅 `ask.user.requested` → 展示选择框 → 用户作答 → `publish('ask.user.answered', { requestId, answer })`。
  3. permission 改为工具自带 `checkPermission`：同样用事件流等用户 allow/deny/ask 决定。
  4. 删除 `src/bootstrap.ts` 的 tool-permission / ask-user 合成注册；`AskUserBridge` 退役。
- **备选**：(a) 保持 bridge——回调式，工具与 TUI 耦合，新交互工具要重复装配；(b) core 暂停接口——把暂停逻辑推回 core，违背 ADR-027 的事件流外推。均不取。
- **后果**：暂停 = 工具发事件 + 等事件，loop 不改（handler 天然 await）；新交互工具只写一个 handler，不再碰 bootstrap；headless 无订阅者时靠 `waitFor` 超时/注入策略兜底。本 ADR **supersede ADR-015 的暂停条款**。
- **关联**：ADR-026、ADR-027；[EVENT-SYSTEM.md](../api/EVENT-SYSTEM.md)；[#94](https://github.com/egg-rolls/Vessel/issues/94)。

---

## ADR-030：事件声明规范——事件名即开放字符串协议，舍弃常量

- **上下文**：ADR-027 确立事件名开放。但实践中同时存在常量（`EventType` / `PermissionEvent` / `AskUserEvent`）与字符串字面量两种写法，导致后续开发者不确定用哪种、产生混乱。常量 import 还造成编译期耦合——外部工具对接事件必须依赖 core 类型，增大构建难度、违背开闭原则。
- **决策**：
  1. **全部事件用开放字符串协议**——不定义任何事件常量，生产者和消费者直接写字符串字面量（`'run.started'`、`'replay.started'`、`'ask.user.answered'`），零 import、零耦合。
  2. **舍弃事件常量**：`EventType` / `PermissionEvent` / `AskUserEvent` 不再作为事件名载体；既有常量迁移为字符串字面量（统一写法，杜绝二义）。
  3. **命名空间约定**：`<domain>.<action>.<event>`，防撞名。
  4. **拼写错误靠集成测试缓解**，不靠常量挡——测试断言"发布 X 后订阅者收到"。
- **备选**：(a) 常量 + 字符串并存（二分）——两种写法混乱，后续 AI 不知选哪个，正是本 ADR 要消除的；(b) 纯字符串无任何约定——拼错风险无缓解。均不取。
- **后果**：事件系统完全统一为字符串协议——加新事件 = 写字面量，零 import、零 core 变更；无"该用常量还是字符串"的二义，后续 AI 只有一条路。代价：无编译期拼写检查，靠命名空间约定 + 集成测试兜底。
- **关联**：ADR-027、ADR-008、ADR-029；[CORE.md §1.4](../api/CORE.md)、[EVENT-SYSTEM.md](../api/EVENT-SYSTEM.md)。

## ADR-031：上下文变化事件化——同步写入 + ContextChanged 观测

- **上下文**：`ContextManager` 是模型的输入源（关键路径），写入必须可靠、有序、及时。但上下文变化是"静默"的——模型下一轮读到，TUI/调试/回放/审计却无法观察到上下文如何演变。分层事件驱动原则（EVENT-SYSTEM §5）：内聚核心（上下文/工具反馈）用直接调用保证及时性，同时发布事件提供可观测性。
- **决策**：
  1. `ContextManager.add(msg)` **保持同步直接写**——可靠、有序、及时（模型下一轮必读，关键路径不走事件流）。
  2. 每次上下文变化发布 `context.changed` 事件（payload：新增消息 / token 数 / 消息数），TUI/调试/回放/审计订阅——**代码加入 + 消息发布**双轨。
  3. 事件名 `context.changed`（开放字符串协议，ADR-030）。
  4. 实现方式：首选由 runtime 在 `add()` 后统一发布（不改 `ContextManager` 冻结接口）；或 `ContextManager` 注入 `EventStream` 自发布（需 ADR-017 解冻）。
- **备选**：(a) 完全事件化（读写走事件流）——关键路径异步，模型可能读到不完整/乱序上下文，违背及时性；(b) 不发布事件——上下文变化静默，无法 trace/回放。均不取。
- **后果**：上下文写入仍可靠及时（关键路径），同时变化可观测/可回放/可调试；与工具反馈（`context.add` + `tool.call.completed` 事件）同构——**内聚核心 = 直接调用 + 事件观测**。
- **关联**：ADR-017（解冻说明）、ADR-027、ADR-030；[EVENT-SYSTEM.md §5](../api/EVENT-SYSTEM.md)。

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

## ADR-033：AgentRuntime 依赖倒置注入 + 编排逻辑外推（解冻 ADR-017 局部）

- **上下文**：ADR-017 冻结 core。但审计发现 `agent-runtime.ts`（757 行）存在两个 SOLID 违例，影响可测试性与可扩展性：(1) 依赖倒置违反——构造函数硬编码 `new MemoryLimitChecker()` / `new MemoryPluginHost()`，`AgentRuntimeOptions` 无 `pluginHost`/`limitChecker` 注入位，无法替换实现；(2) God-object——权限策略（~53 行）、guardrail 编排、hook 编排全部内联在 `AgentRuntime`，违反单一职责。
- **决策**：
  1. **依赖倒置注入（ADR-017(2a) 扩插座）**：`AgentRuntimeOptions` 新增**全可选**字段 `pluginHost?: PluginHost` 与 `limitChecker?: LimitChecker`，构造函数用 `?? new MemoryXxx()` 兜底。向后兼容（现有调用方零改动）。理由：构造语义无法用 Plugin/Hook/Guardrail/事件表示——Plugin 是构造后才注入的，无法决定对象构造时的依赖装配（ADR-023 同款论证）。
  2. **编排逻辑外推（内部重构，不改接口契约）**：把 `AgentRuntime` 内联的权限策略、guardrail 编排、hook 编排抽到独立模块（`runtime/permission-policy.ts`、`runtime/guardrail-runner.ts`、`runtime/hook-runner.ts`），`AgentRuntime` 降为协调者。不改变 9 接口语义、tool-calling loop 拓扑、事件名。
- **备选**：(a) 保持现状——可测试性差、`agent-runtime.ts` 持续膨胀；(b) 把权限/guardrail/hook 全做成插件——权限策略是 loop 骨架的默认行为（ADR-029），guardrail/hook 编排是 loop 的编排步骤，插件化会破坏 loop 骨架完整性。均不取。
- **后果**：`AgentRuntime` 从 778 行降至 676 行（权限/guardrail/hook 编排逻辑外推 156 行到三个 runner）；`LimitChecker`/`PluginHost` 可注入替代实现（测试/嵌入场景）；三个 runner 可独立单测。接口面仅增 2 个可选字段，向后兼容。冻结范围收紧为「9 接口语义 + loop 拓扑 + 事件名」不变。
- **关联**：ADR-017（解冻局部）、ADR-023（构造语义论证）、ADR-026/029（权限策略）。

## ADR-034：极简化重构——解冻 core、三工具集、skills 即消息、拆治理

- **上下文**：Vessel 长出了两层与产品无关的复杂度。
  **(1) 代码层**：为「让 Agent 自我管理资产」，并存了四套插件/工具发现机制（构建时生成的注册表 / 静态映射表 / 运行时目录扫描 / `vessel.yaml` 声明式）；另有 606 行的 skills-loader（SkillsManager + 文件监听 + 5 个 CRUD 工具 + 路径穿越防护）、761 行的 MCP 客户端、278 行的 file-ops（5 个工具里 3 个等价于 `ls` / `test` / `mkdir -p`）、351+338 行的两个 memory 插件。而**最必要的通用工具——执行命令的 bash 工具——根本不存在**。
  **(2) 文档层**：40 份 markdown，约 28 份在约束 AI 怎么干活（任务启动器 CLAUDE.md、5 个角色 TODO + 5 份角色文档、4 份 processes、10 份 specs 里的规范与治理）。管理流程的成本已超过写代码。
  **(3) 背离**：资产体系代码删了一半（`search_assets` / `inspect_asset` / `patch_asset` / `remove_asset` / `add_skill` / `connect_mcp` 均已不存在），但 SPEC / PLUGINS / ADR / README 与 `core/types/tool.ts` 的注释里全还写着它们；`/assets` 命令永远输出空；`skills/asset-introspection.md` 教 Agent 调用不存在的工具。
- **决策**：
  1. **工具集收敛为三个**：`bash` + `read` + `edit`。`bash` 承担 grep / cat / ls / python / mkdir / curl / git 等一切命令行操作。判据只有一条——**能被其他工具替代的工具就不该存在**。三个是原语，其余都是它们的特化。装配层另注册 `ask_user`（交互）与 `delegate_task`（子 agent 派发）。
  2. **删除 plugin 包**（共 1,862 行）：`file-ops` / `meta-tools` / `skills-loader` / `mcp-client` / `memory/project` / `memory/auto`。默认工具从 8 组降为 5 个，插件包从 12 降为 8。
  3. **skills 就是文件，不是一条加载通道**：harness 不扫描、不解析、不注入 skills。core 新增通用注入位 `RunOptions.messages`——调用方把**任何要进语言空间的文本**（skill 内容、附件、引用文件、项目约定）拼成消息传进来，core 不解释其来源与语义。REPL 侧由前端展开 `@路径`；技能就是 markdown 文件，约定放仓库 `skills/`（项目级，随仓库提交、团队共享）与 `~/.vessel/skills/`（用户级，跨项目复用）——纯约定，代码里零硬编码。memory 同理：项目约定写在 `AGENTS.md`，模型自己读；跨会话笔记是 markdown，模型自己读写。
  4. **插件发现收敛为一套**：只保留 `src/plugin-loader.ts` 的运行时扫描（`plugins/<category>/<name>/package.json` + `src/index.ts`，放文件夹即注册、无需构建步骤）。删掉 `plugin-registry.generated.ts` / `DEFAULT_PLUGIN_IMPORT_MAP` / `CompositeProvider` / `PluginProvider` 接口 / `dir-scanner.ts` / `config-declared.ts` / `scripts/discover-plugins.ts`。连带删除 `vessel.yaml` 的 `tools:` 声明段与 `ToolConfig` 类型——有了 bash 之后，「用户声明式加工具」的三条路都多余。
  5. **core 解冻 + 针对性简化**（不重写 loop）：删除全仓库零读零写的死字段 `ToolDefinition.default` / `interactive` / `render` / `isEnabled` / `shouldDefer`；删除 `ToolRegistry` 接口与 `packages/core/src/tools/`——**唯一的工具注册表是 `PluginHost` / `MemoryPluginHost`**；`AgentRuntime` 直接接 `PluginHost`（删掉构造期从 `ToolRegistry` 播种工具的双轨步骤），并暴露 `readonly pluginHost`；`Hook.run` 返回类型收窄为 `Promise<void>`；`HookContext` 加显式 `systemPrompt` 字段；抽 `buildRequestMessages()` 把持久化上下文 + `RunOptions.messages` 注入消息 + `BeforeLlm` 写入的 system 收敛到一处；删从不发布的 `GuardrailModifiedPayload`。
  6. **拆掉角色/流程治理**：删除 `docs/role/`（11 份）、`processes/`（4 份）、`legacy/`、`.github/ISSUE_TEMPLATE/` 与任务启动器 CLAUDE.md。开发流程只留 git 约定：**分支 → PR → squash merge**。
  7. **文档树收敛为 4 份**：`README.md`（是什么/怎么跑/延后项）+ `AGENTS.md`（AI 行为约定，~1 页）+ `docs/ARCHITECTURE.md`（分层/循环/两插槽/扩展模型/接口签名/事件名）+ `docs/ADR.md`（本存档，只追加）。删 `docs/specs/`（10 份）、`docs/api/`（3 份）、`docs/guides/`（4 份）、`docs/dev/`（1 份）。`CLAUDE.md` 收缩为单行 `@AGENTS.md`。
  8. **MCP 延后**：本期不做，写进 README 的延后段。若回归，形态也是「一个插件」，不给 core 加接口。
- **备选**：(a) 保持 core 冻结、把简化全做成插件——但被删的是 core 内部的死字段与双轨注册表（`ToolRegistry`），插件无法触及；且工具集本身是最贴近 core 的决策。(b) 重写 tool-calling loop——诊断为「约束错误 + 死物堆积」而非循环设计错误，重写会白扔已验证的 loop（含流式、中断、事件、限流）。(c) 保留 skills-loader 但精简——skills 的本质是「发给模型的文本」，一旦承认这点，扫描器/CRUD/文件监听/路径穿越防护全部失去存在理由。(d) 保留治理文档树——成本已超过收益，且 28 份约束文档里大部分在描述不存在的架构。均不取。
- **后果**：
  - 解冻 core。ADR-017 的冻结条款作废——core 回到按 ADR-012 的三条理由（扩插座 / 修 bug / 横切需求）逐案判断，仍需 ADR。**但冻结的精神以更弱的形式保留**：core 仍只放领域无关的运行时，「拿不准就选插件」的能力准入判据写进 AGENTS.md。
  - 仓库里每份文档都记录代码事实，每个工具都无法被其他工具替代。
  - 代价一：模型失去了「专用工具」的强约束（grep 的 glob 语义、edit 的唯一性保证由各自 handler 自守），要靠工具 description 与 `inputSchema` 把用法讲清楚。代价二：删掉的 `/assets` `/skills` `/mcp` 三条命令与资产体系没有替代品——它们是空壳。
  - `@vessel/core` 的公开面收窄：不再导出 `MemoryToolRegistry` 与 `ToolRegistry` 类型；嵌入方若只想要简单注册表，用 `MemoryPluginHost`。
- **关联**：**supersede ADR-017（Core 冻结）**、**supersede ADR-011（Skills 经 skills-loader 插件注入）**；使 **ADR-024（`ToolDefinition.default` 过滤）失效**（字段已删）、**部分取代 ADR-026**（`render` / `isEnabled` / `shouldDefer` / `interactive` 已删，`checkPermission` / `timeout` 保留）、**收窄 ADR-028**（保留其「运行时扫描」结论，删除 `PluginProvider` 接口与另外三套实现）；ADR-003（插件不进构造函数）、ADR-004（唯一扩展机制）、ADR-030（事件名开放字符串）不变；架构事实见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## ADR-035：0.1.0 core loop 级正确性修复

- **上下文**：0.1.0 审计发现 loop 与既有契约/文档不一致，均为 0 接口变更的缺陷修复：
  (1) 非法 tool arguments JSON 在 `tool.call.started` 处直接抛错，终止整个 run；
  (2) run 初始/失败保存只写单条 user 消息，覆盖既有历史；
  (3) 请求组装在上下文缺 system 时丢弃基底 systemPrompt，trim/compact 可能产生孤儿
      `role:tool` 或悬空 `assistant(tool_calls)`；
  (4) `updateRealTokens` 传入累计 token，多轮误触发 auto compact；
  (5) `GuardrailResult.replacement` 在类型与文档中存在，但 loop 只读 `allowed`。
- **决策**：按 ADR-012(2b)「修复 loop 级缺陷」逐项修复，不扩接口：
  1. tool arguments 只解析一次；失败发 `tool.call.failed` 并把 `Error: ...` 折回
     `role:tool`，不终止 run（与「工具失败不终止 run」一致）。
  2. 初始与失败状态都保存 `context.messages`；失败也不再覆盖历史。
  3. `buildRequestMessages` 在输出前归一化：补回缺失的 system；丢弃无对应调用的
     `role:tool`；不完整 tool_calls 轮次降级为普通 assistant 文本并丢弃部分结果。
     归一化只影响本次请求，不修改持久化上下文。
  4. `updateRealTokens` 改用本次请求的 `prompt_tokens + completion_tokens`。
  5. `replacement` 在 Input（改写持久化的用户消息）、Output（改写返回值与持久化
     assistant 消息）、ToolCall（改写实际执行的调用，先于 assistant 消息写入）、
     ToolResult（改写事件、上下文与返回值）四阶段生效；非法类型按未改写处理。
- **备选**：(a) 删除 `replacement` 字段——破坏接口且放弃脱敏能力；(b) 只在文档里
  标注未实现——与「文档只写已实现」冲突；(c) 在 Provider 层兜底非法消息——Provider
  无法区分孤儿工具消息与合法历史。均不取。
- **后果**：loop 输出给 Provider 的消息始终是合法序列；失败/中断会话可恢复；
  Input guardrail 可以真正脱敏；token 估算不再线性放大。代价：Input 被阻断的输入不再
  写入上下文；ToolCall guardrail 失败时 assistant 消息不落盘（更干净）。
  接口、事件名、依赖方向均不变；`ToolContext.signal` 不在本 ADR 范围（0.1.1 再议）。
- **关联**：ADR-012(2b)、ADR-018、ADR-027、ADR-033、ADR-034；`ARCHITECTURE.md`
  的 §3.2 / §4 / §5.7 需同步。

## ADR-036：Gateway 协议 v1——事件流之上的本地控制面

- **上下文**：0.1.0 需要给浏览器控制台（`apps/web`）提供后端，同时不把网络/会话/权限逻辑塞进 core。core 已有 EventStream（ADR-007/027/030）与事件化的权限、ask_user（ADR-029）；缺的是「事件流 → 网络协议」的适配层，以及运行提交/取消、会话列表、工具列表、同源静态托管。核心问题：控制面放哪、用什么协议、是否动 core。
- **决策**：
  1. 控制面放在 `@vessel/serve`，作为 **EventStream 消费者**；不改 core、不经过 PluginHost。
  2. 协议 `vessel.gateway/1`：HTTP `/v1` + WS `/v1/events`（SSE 作为只读兜底）；服务端分配 `seq`，环形缓冲默认 10000，客户端用 `?since=` 续订，截断发 `gap`。
  3. 运行异步化：`POST /v1/runs` 返回 202，结果经事件流推送；单 runtime / 单 context，串行队列（上限 100），取消用 `AbortController`。
  4. 权限与 ask_user 走事件桥（G1）：gateway 订阅请求事件、发布应答事件，不引入直接回调。
  5. 会话切换（G2）：传入 `context` 时，目标 session 不同则先 `setSessionId` 再 `clear`，由 runtime 从 `SessionBackend` 重载历史。
  6. 可选静态托管：`staticDir` 存在时同源托管 `apps/web/dist`；API 路径永不托管；路径穿越校验。
  7. 安全默认：绑定 `127.0.0.1`；Host / Origin 校验；WS 首帧鉴权（5s 超时，4401）；请求体 1 MiB；HTML CSP；无 `*` CORS。
  8. Agent team 协议延迟到 0.2：`team.*` 在 0.1.0 返回 `method_not_allowed`，类型草案留在 `protocol.ts`。
- **备选**：(a) 每个客户端自定义协议——前端/脚本/未来 peer 各写一套，重复且不一致；(b) 权限/ask 用直接回调桥——回到 ADR-029 之前的耦合；(c) 把控制面放进 core——违反「core 只放领域无关运行时」的能力准入；(d) 只用 SSE——取消与方法应答需要双向，WS 更合适（SSE 保留为只读兜底）。均不取。
- **后果**：Web / TUI / 脚本共享同一条事件流；协议可版本化；gateway 可嵌入其他应用（传 `runtime` / `context` / `staticDir`）。代价：单节点单 runtime，运行与事件历史在内存；跨节点 team 要等 0.2。`--serve` 需装配层传入 `context` / `pluginHost` / `staticDir`，G2 与静态托管才生效。
- **关联**：ADR-007、ADR-027、ADR-029、ADR-030、ADR-034；`ARCHITECTURE.md` §13；`packages/serve/src/protocol.ts`。

## ADR-038：thinking 模式 `reasoning_content` 回传

> 编号说明：ADR-035 = 0.1 core loop 修复，ADR-036 = gateway 协议，**ADR-037 = 0.2 runtime（见下）**，ADR-038 = reasoning_content（本条）。

- **上下文**：OpenAI 兼容的 thinking 模型（如 DeepSeek reasoning）在响应里返回 `reasoning_content`。当响应包含工具调用时，下一轮请求必须把该字段原样回传，否则 API 会拒绝（`reasoning_content required`）。同时，思维链属于模型内部推理，不应出现在 TUI / 事件流 / 观测里，但会话恢复后仍需保留以支持后续轮次。
- **决策**：
  1. `Message` / `LLMResponse` 增加**可选** `reasoning_content?: string`（additive，不破坏既有接口）。
  2. Provider：OpenAI 兼容非流式读取 `choice.message.reasoning_content`；流式在 `StreamAccumulator` 累积 `delta.reasoning_content`，**刻意不回调 `on_chunk`**。Anthropic 不变。
  3. 请求映射：只对 `assistant` 消息回传（普通文本与含 `tool_calls` 两种），其他角色不带。
  4. Runtime：`stop` / `tool_calls` / `length` 三处把 `reasoning_content` 写入 assistant 消息；会话持久化（JSON / SQLite）自然保留，恢复后继续回传。
  5. **事件流剔除**：`llm.request` 的 messages 与 `context.changed` 的 message 在发布前剥离 `reasoning_content`，防止思维链泄漏到 TUI / 观测 / 回放。
  6. 请求归一化：不完整 `tool_calls` 轮次降级时，若文本为空但存在 `reasoning_content`，仍保留该 assistant 消息。
- **备选**：(a) 不进 `Message`、单独旁路存储——恢复与回传需要额外关联，跨会话易丢；(b) 拼进 `content`——思维链会暴露给 TUI 并污染上下文；(c) 只在 Provider 内存缓存——跨进程 / 会话恢复不可靠。均不取。
- **后果**：thinking 模型可连续进行工具调用；接口保持向后兼容；事件流与 TUI 看不到思维链；持久化恢复可用。代价：`reasoning_content` 占用会话存储；直接读取 `context.messages` 的嵌入方仍可看到该字段（core 不强制隐藏持久化数据）。
- **关联**：ADR-007、ADR-027、ADR-030、ADR-035；`ARCHITECTURE.md` §3.2 / §5.1 / §10 / §13。

## ADR-037：Vessel as a modular agent runtime

- **上下文**：0.1.0 把 Vessel 定位为「自组织 Agent Harness」——单 agent loop + 9 接口 + 两个插槽。0.1.0 已证明 loop 可用，但多 agent 诉求被塞进两处边缘实现：`delegate_task` 在工具 handler 内每次新建子 `AgentRuntime`；`@vessel/team` 插件内自带一个 `InProcessRuntimeHost`。二者都没有成员注册表、调度、统一取消、跨进程传输，也无法被 gateway / 其它 shell 复用。继续沿这条路走，等于把平台能力固化在插件里，core 仍是单 agent，外壳各自发明多 agent 协议。
- **决策**：
  1. **定位**：Vessel 是可嵌入的**多 agent 平台 runtime**；TUI / CLI / Web / Gateway 是参考 harness 外壳，只消费 runtime 的 SDK 与事件。
  2. **分层**：`Contracts ← Kernel ← Modules ← SDK ← Shells`；`Plugins` 只依赖 Contracts / 公开 API，经 `PluginHost` 在运行期 install。依赖方向单向。
  3. **Kernel 最小集**：`RuntimeHost` / `AgentHandle` / `RunHandle` / `Scheduler` / `EventBus` / `Cancellation` / `Limits`。`AgentRuntime` 继续是**单 agent loop**；Host 负责注册、生命周期、调度与消息，不重写 loop。
  4. **Module ≠ Plugin**：Module 是编译期/构造期边界（provider / context / session / policy / transport / observability），一个 port 一个实现；Plugin 仍是唯一运行期扩展机制。**禁止 `ModuleHost` / `ModuleRegistry` / 第二套扩展机制。**
  5. **包内模块优先**：0.2 只在 `@vessel/core` 内做 ports & adapters + subpath exports，不立即拆成多个 `@vessel/*` 包；待依赖图稳定后再按需拆包。
  6. **Transport 是 port**：0.2 只做 in-process 与 loopback HTTP 实现；loopback 只绑 `127.0.0.1` 并复用 gateway v1 的 token 鉴权，禁止 `0.0.0.0`。远程、TLS、跨机器调度仍是非目标。
  7. **兼容性**：9 接口、`AgentRuntime` 公开面、`RunOptions` / `RunEvent`、事件名、插件机制全部冻结；0.2 只做加法与内部替换，不删除公开 API。`RunHandle.status()` 用方法/getter 暴露可变状态；`CancellationScope.child()` 必须随父取消自动中止。
  8. **非目标**：durable execution / workflow / evals / MCP / 多租户 / 远程监听 / TLS / 跨机器调度 / 单二进制主分发。
  9. **依赖方向必须自动检查**：层级规则不能只写在文档里；0.2 用 biome `noRestrictedImports` 或等价脚本在 CI 中阻断 `types → 实现`、模块间内部 import、core → shell 的反向依赖。
  10. **事件字段命名**：core TypeScript 内部用 camelCase（`agentId`），gateway JSON 用 snake_case（`agent_id`），映射只在 gateway 边界做一次；事件名保持开放字符串，不新增常量/枚举。
- **备选**：(a) 把 `delegate_task` 放大成 team——没有身份、生命周期、调度、inbox、取消，所有能力塞进一个工具，工具面与平台面混淆；(b) 立即拆出 `@vessel/runtime` 包——依赖图尚未稳定，拆包带来路径/版本/构建 churn，且不增加运行时能力；(c) 引入 `ModuleHost` 动态模块——与 `PluginHost` 形成第二套扩展机制，违反 ADR-004/034 的单一扩展原则；(d) 重写 `AgentRuntime`——ADR-015/034 已证明 loop 正确，问题在宿主层，不在循环。均不取。
- **后果**：
  - 多 agent 成为一等能力：成员有 id、状态、inbox、run 句柄与取消；team / delegate / gateway 共用同一 Host 与 Scheduler。
  - core 公开面增加 Kernel 类型与 subpath exports，但 `AgentRuntime` 与 9 接口不变；0.2 不删除任何公开 API。
  - 代价：Host / Scheduler / Transport 带来生命周期、并发、背压与测试复杂度；0.2 仍为 pre-1.0，本机 / loopback 之外不做承诺。
  - `delegate_task` 改为 Host 上的临时成员，工具名与语义保持不变；`@vessel/team` 的 `InProcessRuntimeHost` 降级为兼容适配层并在 0.3 移除。
- **对 ADR-015 的关系（局部 supersede）**：ADR-015 的决策 3 中有一条「A2A / 多 agent / 树搜索 → 工具（handler 内部 spawn 子 runtime）」。本 ADR **只取代这一条中「多 agent 只能/应当在工具 handler 内 spawn」作为唯一实现方式的表述**；该 bullet 作为 0.1 的过渡解释仍成立。**ADR-015 的主结论——「不需要 `LoopStrategy` 抽象，工具调用循环保持通用」——继续有效，本 ADR 不废止 ADR-015。**
- **关联**：局部 supersede ADR-015 的上述单条；保持 ADR-003（插件不进构造函数）、ADR-004（唯一扩展机制）、ADR-012/017（core 小）、ADR-030（事件名开放）、ADR-034（极简核心）、ADR-036（gateway 传输边界）、ADR-038（reasoning 不回传事件）。架构事实见 `ARCHITECTURE.md`；0.2 规划见其「0.2 目标架构（planned，未发布）」小节。

## ADR-039：MCP client 作为插件接入

- **上下文**：0.1 曾删除旧 MCP 客户端，并留下边界「MCP 若回归，形态也是一个插件，不给 core 加接口」（ADR-034 第 8 条）。0.3 需要接外部工具生态；MCP 是协议桥，不是领域无关的 runtime 能力。若把它放进 core，既违背能力准入，也会让 loop 与接口面为一种协议扩张。
- **决策**：
  1. **形态**：工厂式插件 `plugins/mcp/client/`，包名 `@vessel/mcp-client`；`createMcpPlugin(options)` 返回 `McpClientPlugin`。由 asm 装配层在 `FACTORY_PLUGINS` 中构造。
  2. **边界**：**不是 core 模块**；不新增 core 接口、不新增扩展机制；工具只经 `PluginHost.registerTool` 注册；core 的 9 个扩展接口与 loop 拓扑不变。
  3. **传输**：stdio（JSON-RPC over child process stdin/stdout）与 HTTP（MCP Streamable HTTP）。HTTP 最小范围：POST JSON-RPC；请求头 `Accept: application/json, text/event-stream`；响应支持纯 JSON 与 SSE 帧解析；不做 GET 长连接、session 恢复、OAuth。
  4. **工具名**：`toolPrefix !== false` 时为 `mcp__<server>__<tool>`，非法字符替换为 `_`；完整工具名超过 64 字符时截断到 64 并在末尾追加 `_` + 8 位 hash，避免碰撞。`toolPrefix === false` 时用原名；与既有工具冲突则**跳过并告警，不覆盖**。
  5. **权限**：`checkPermission` 一律 `'ask'`；仅 `autoApproveTools` 中的工具返回 `'allow'`。名单使用 server 返回的**原始工具名**（加前缀前），大小写敏感、精确匹配。禁止默认放行。
  6. **失败隔离**：单 server 连接失败或中途断开不得导致进程启动失败；告警并发 `mcp.server.failed` / `mcp.server.disconnected`，其余 server 继续。工具调用失败发 `mcp.tool.failed`，作为普通工具错误折回语言空间。
  7. **生命周期与控制面**：`install()` 建连；`close()` 关闭所有子进程/连接；asm 在进程退出时调用。控制面冻结为 `McpPluginControls`：`listServers()`（同步快照）、`getServer(name)`、`reconnect(name)`；`enabled:false` 的 server 也出现在列表中，status 为 `disabled`。`reconnect` 未知名字抛 `mcp_server_not_found`，禁用 server 抛 `mcp_server_disabled`。
  8. **状态类型**：`McpServerStatus { name, status: 'connected' | 'failed' | 'disabled', transport, tools, error?, protocolVersion?, serverInfo? }`。asm 负责把它适配成 TUI 的 `McpControl` 与 gateway 的状态源；tui / web 不直接 import 插件实现。
  9. **事件**（开放字符串，ADR-030）：`mcp.server.connected` / `mcp.server.failed` / `mcp.server.disconnected` / `mcp.tool.called` / `mcp.tool.failed`。
  10. **依赖**：core 依赖保持为空；插件默认自实现 JSON-RPC。若需引入 MCP SDK，需 1 单独批准；新 workspace 包首次安装由 ext 在自己 worktree 执行并提交 `bun.lock`（Addendum B §9.3 Q3），且同期 asm 不得改依赖。
  11. **安全**：`command` / `args` 以数组形式 spawn，不经 shell 拼接；`env` 只来自配置；远程 server 的 TLS 校验不得默认关闭。
- **备选**：(a) 进 core 做成 MCP 模块——违反能力准入与 ADR-034 / ADR-037；(b) 每个 MCP 工具静态生成插件——无法按配置动态增删 server；(c) 另起工具注册机制——违反单一扩展机制。均不取。
- **后果**：外部工具与内置工具走同一 `PluginHost`；core 零改动；工具总数变为动态（文档写「4 个基础 + N 个 MCP」）。代价：插件承担子进程 / 连接生命周期、超时、重连与状态维护；默认 ask 带来首次确认摩擦（刻意）。
- **关联**：ADR-034（MCP 延后条款）、ADR-037（Module ≠ Plugin）、ADR-030（开放事件名）、DECISION-008 §4.2 / §8 Addendum A / §9.1 / §9.3。

## ADR-040：Durable run——RunStore port、checkpoint 与 resume

- **上下文**：`SessionBackend` 以 session 为键保存最后一份 `RunState`；进程崩溃后无法按 run 恢复。0.2 的 Host run 状态在内存，重启即丢。需求是「本机可恢复」，不是 workflow / 跨机器调度。
- **决策**：
  1. **port 与类型位置**：`RunCheckpoint` / `RunStore` 定义在 `packages/core/src/types/run-store.ts`，`packages/core/src/session/run-store.ts` 实现并 re-export；公开导入路径与名字仍为 `@vessel/core/session` 与根入口。签名严格按 DECISION-008 §4.1。
  2. **定位**：`RunStore` 是 module port，不是第 10 个核心扩展接口；9 个扩展接口与 loop 拓扑不变。
  3. **后端**：`MemoryRunStore` 与 `FileRunStore({ dir })`。File 后端一个 run 一个 JSON 文件；同一 run 的写入串行化；临时文件 + rename 原子替换；Windows 下 rename 失败重试 3 次，仍失败则整文件直写（绝不写半截 JSON）——文档标注 **best-effort**，不做跨进程写协调。
  4. **list**：按 `updated_at` 倒序、同值按 `run_id` 升序；支持 `status` / `session_id` / `limit`；默认 `limit=50`、最大 `200`；gateway 与 CLI 同规则。
  5. **checkpoint 时机**：run 开始、每完成一轮 tool-call 后、run 结束（completed / failed / cancelled）；每次写入发 `run.checkpoint`。
  6. **写者**：**只有一个写者 `AgentRuntime`**。Host 模式把 Host 的 `runStore` 注入成员 runtime；同时给 Host 与 runtime 两个 store 时 **Host 优先，禁止双写**。单 agent 模式使用 `AgentRuntimeOptions.runStore`。
  7. **接线（additive）**：`RuntimeOptions.runStore?`、`AgentRuntimeOptions.runStore?` / `agentId?`、`InProcessRuntimeHostOptions.runStore?`；`AgentRuntime.resume(runId, opts?): Promise<string>`；`RunnableAgent.resume?(runId, opts?): Promise<RunHandle>`；`RuntimeHost.resume?(runId): Promise<RunHandle>`。
  8. **resume 语义**：恢复消息 / usage / iteration 到上下文，发 `run.resumed`，继续 loop；`RunHandle.id` 与原 `run_id` 相同。Host resume **不经 Scheduler**（保持 run_id 不变）；若该成员已有 active run → `run_already_running`。resume 不受全局并发上限约束（已知行为）。同一 run 同时只允许一个恢复，首个成功，后续（含重复 resume）→ `run_already_running`。
  9. **错误**：`RunResumeError extends Error`，字段 `code: 'run_not_found' | 'run_not_resumable' | 'run_already_running' | 'run_store_required' | 'agent_not_found'` 与 `runId`。terminal 状态一律 `run_not_resumable`；未知 id `run_not_found`；未配置 store `run_store_required`；Host 模式未知成员 `agent_not_found`。gateway 映射：`run_store_required → durable_disabled`，`agent_not_found → agent_not_found`，其余同名。
  10. **范围**：只做本机 file / memory；不做跨机器恢复、分布式锁、多进程并发写协调；File 后端假定单进程写入。无保留 / 清理策略（list 可能增长），写为已知限制。
  11. **与 SessionBackend 正交**：Session 是会话对话持久化，RunStore 是 run 执行检查点；resume 不重放事件（事件回放仍归 `FileEventStore` / `replayRun`）。
  12. **事件**：`run.checkpoint` / `run.resumed`，开放字符串，不建常量。
- **备选**：(a) 扩展 `SessionBackend` 承载 run——键语义冲突（session vs run）；(b) 从事件日志重建 run——事件不携带完整模型状态；(c) 直接做 workflow / 跨机器 durable——非目标。均不取。
- **后果**：本机崩溃后可恢复；每次 checkpoint 有 IO 成本；`MemoryRunStore` 进程退出即丢。resume 绕过 Scheduler 是刻意取舍：恢复保持原 run_id、不受全局并发上限约束，调用方需自行避免与调度器的并发争用。
- **已知限制（qa C1-09b / DECISION-008 §8 A-2）**：resume 并发守卫仅为 **per-Host / per-store-instance**；多 Host 共享同一 `FileRunStore`、或跨进程同时恢复同一 run，不在 0.3 的协调范围，属部署错误。
- **关联**：ADR-025（参考实现先例）、ADR-032（事件回放）、ADR-037、DECISION-008 §4.1 / §8 Addendum A / §9.2。

## ADR-041：远程监听与 TLS（显式 opt-in）

- **上下文**：0.1 / 0.2 gateway 只绑 `127.0.0.1`；ADR-037 把远程监听与 TLS 列为 0.2 非目标。0.3 要支持可信网络 / VM 访问，但默认行为必须与 0.2 一致。
- **决策**：
  1. **显式 opt-in**：`serve.allow_remote: true` 且 hostname 非回环才进入远程模式；默认 `127.0.0.1` + `allow_remote: false`，行为与 0.2 字节级一致。
  2. **远程必须有 token**：沿用 `config > VESSEL_GATEWAY_TOKEN > gateway 自动生成`；非回环必须 `allow_remote=true` 且 token 非空，不得匿名；token 为空或被显式关闭时启动失败并给出明确错误。
  3. **TLS 与 `allow_remote` 相互独立**：loopback + TLS 允许（`allow_remote=false` 也可启 TLS）；非回环才要求 `allow_remote=true`。`serve.tls.cert_file` 与 `serve.tls.key_file` 必须成对提供，否则启动失败。
  4. **只做 HTTP/1.1**：不做 HTTP/2 / ALPN / mTLS / 客户端证书管理 / ACME / 证书自动续期。HTTPS 与 WSS 共用同一 server、token 与 Origin 规则。
  5. **`hello.features`** 按实际启用增加 `tls`（以及既定的 `durable-resume` / `mcp-status`）；不新增 `remote` feature。
  6. **安全不变量不因远程放宽**：Host / Origin 校验、WS 首帧鉴权、1 MiB 请求体上限、无 `*` CORS、HTML CSP 全部保留。
  7. **非目标**：反向代理信任头、跨机器 team 语义变化、远程 `/v1/team/*` 扩展。
- **备选**：(a) 默认监听 `0.0.0.0`——扩大攻击面且破坏兼容；(b) 只支持反向代理 TLS——不满足内置 opt-in 需求；(c) 自动生成自签证书——信任警告与隐性风险；(d) HTTP/2——超出范围。均不取。
- **后果**：多一条显式配置路径；证书生命周期由用户负责；文档必须提示暴露 gateway 的风险；默认路径零变化，回归以默认配置对照 0.2。远程 / TLS 测试离线（本地自签证书 + 回环端口）。
- **已知行为**：监听 `0.0.0.0` 时，banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；其它机器访问需把 host 换成实际 IP。这是显示层行为，不改变监听地址、token 鉴权或 Host/Origin 校验。
- **关联**：ADR-036（gateway 协议）、ADR-037（0.2 非目标）、DECISION-008 §4.3 / §4.4 / §8 Addendum A §8.9。

## ADR-042：workflow 引擎作为插件

- **上下文**：ADR-010 / ADR-037 曾把 workflow 列为非目标。0.4 需要声明式多步骤编排，复用 `RuntimeHost` / `AgentRuntime` / `RunStore`，不重写 tool-calling loop。workflow 是领域无关但存在多种实现策略的编排能力，不是 runtime 必需 port；按能力准入（AGENTS.md）应做成插件。0.4 不注册模型可调用的 workflow 工具，入口只有 CLI / TUI / gateway。
- **决策**：
  1. **形态**：工厂式插件 `plugins/workflow/engine/`，包名 `@vessel/workflow`；加入 `src/plugin-loader.ts` 的 `FACTORY_PLUGINS`（短名 `workflow`），由 asm 构造。**不是 core 模块**；不新增 core 接口、不新增扩展机制。
  2. **执行边界**：编排只经公开的 `RuntimeHost` / `RunnableAgent` 执行；除单 agent 回退外不绕过 Scheduler。工厂签名为 `createWorkflowEngine({ host?, runtime?, pluginHost, config, events })`；单 agent 注入 `RunnableAgent` 并强制并发 1。**controls-only 模式**：CLI `workflow list` / `show` / `cancel` 允许只构造 store 侧引擎，`host` / `runtime` 均可缺省，`pluginHost` 可用空 `MemoryPluginHost`；`start` / `resume` 两者都缺省 → `workflow_disabled`（装配/配置错误，CLI exit 2）。
  3. **不注册工具**：0.4 不注册 `run_workflow`；模型不能触发任意路径的定义文件。工具化留待权限模型明确后另议。
  4. **定义格式**：YAML/JSON；`steps[]` 为 `agent | tool`；`depends_on` 构成 DAG。环依赖、未知 `depends_on`、未知模板变量、未知工具/成员 = 定义错误。模板只做字符串插值（`{{inputs.*}}`、`{{steps.<id>.output|status}}`、`{{workflow.name}}`），**不做表达式/脚本求值**。`when.step` 必须是 `depends_on` 成员；无 `when` 时只有所有依赖 `completed` 才运行，否则 `skipped`；`contains` 与 `equals` 互斥。
  5. **调度与终态**：依赖满足的步骤可并行，实际上限 `max_parallel = min(定义值, config.workflow.max_parallel)`；单 agent 回退强制 1。`retry` 只对 `failed` 生效，不对 `cancelled` 生效。只要有 step 最终为 `failed`，workflow 终态为 `failed`（即使 `on_error: continue` 跑完其余分支）；全部被跳过也算 `completed`。
  6. **权限与中断**：`type: tool` 直接调用 `PluginHost.getTool(name).handler`，**绕过 runtime 的 guardrail / hook**；权限由引擎显式检查：未声明 `checkPermission` → `allow`（与 core 库默认一致），声明且返回 `ask` / `deny` → step `failed`（错误 `permission_denied`，workflow 不弹权限框）。需要 guardrail 的步骤必须用 `type: agent`（由 runtime 完整执行）。`ToolContext` 合成：`run_id` / `session_id` = workflow run id，`messages` = 空数组，`events` = 注入的 `EventStream`，`signal` = 该 step 的取消信号。插件额外暴露 `interruptAll()`（**不进** `WorkflowControls`），由 asm 在 SIGINT/SIGTERM 调用；库本身不装全局 signal handler。
  7. **状态与持久化**：workflow run id `wf_<uuid>`；workflow 状态 `pending | running | completed | failed | cancelled | interrupted`；step 状态 `pending | running | completed | failed | skipped | cancelled`。一 run 一 JSON，临时文件 + rename 原子写（Windows 失败重试 3 次后整文件直写）；检查点：workflow 开始、每个 step 开始/结束、workflow 结束。run JSON 保存完整定义快照，resume 使用快照、不重新读磁盘定义；`definition_path` 存解析后的绝对路径，list 只扫 `wf_*.json`，损坏文件跳过并告警。
  8. **resume**：允许 `interrupted | failed | running`；`completed | cancelled` → `workflow_not_resumable`。跳过 `completed` / `skipped`；`running` / `pending` / `failed` 重置为 `pending` 并重跑；**不保证 step 幂等**。`cancel()` → `cancelled`（running step `cancelled`、pending step `skipped`），不可 resume；SIGINT/SIGTERM → `interrupted`，可 resume。0.4 的 `workflow cancel` 只支持同进程，对非本进程 run 返回 `workflow_not_found`。
  9. **路径与命名**：相对路径按 `workflow.dir` 解析；CLI 允许绝对路径；拒绝 `..` 越界与 symlink 逃逸。TUI / gateway 的 name 只允许单段安全名，由 asm 的 `resolveDefinition(name)` 解析；解析顺序 `name.yaml` → `name.yml` → `name.json`，多个命中 → `workflow_invalid`。`workflow.dir` = 定义目录，`workflow.path` = run 存储目录。
  10. **控制面**：`WorkflowControls` / `WorkflowRunSummary` / `WorkflowStepSummary` / `WorkflowRunDetail` / `WorkflowOutcome` 按 DECISION-009 §5.1.4 冻结；稳定错误码 `workflow_not_found` / `workflow_invalid` / `workflow_already_running` / `workflow_not_resumable` / `workflow_cancelled` / `workflow_disabled`；事件为开放字符串（`workflow.*`），不建常量（ADR-030）；**不新增 `workflow.step.skipped` 事件**，skipped 只体现在 run 详情与计数。CLI 退出码：0 成功；1 workflow failed；2 参数/配置错误 / `workflow_disabled`；130 用户 cancel / SIGINT / interrupted；**143 SIGTERM**。
  11. **并发与会话**：同一 run 同时只允许一个执行；不同 run 可并发 `start`；并发 `resume` 同一 run → `workflow_already_running`。agent step 使用 Host 中已存在的成员（`host.get(agent)`），**不为每个 workflow run 新建成员**；同一成员的多次 workflow run 共享其 session，Host 默认 `perAgentSerial` 会串行化。workflow 级会话隔离不在 0.4 承诺。单 agent 回退使用注入的 `RunnableAgent`，所有 agent step 串行，session 由调用方注入（asm 为每次 run 生成 `workflow:<run_id>`）。
- **备选**：(a) 放进 core——把编排语义与第二套扩展面塞进冻结区，违反 ADR-012 / ADR-034 / ADR-037；(b) 注册 `run_workflow` 工具——模型可触发任意路径定义，权限边界不清晰；(c) 新写一个调度器——与 `Scheduler` / `RuntimeHost` 重复；(d) 引入表达式引擎——扩大攻击面与依赖面。均不取。
- **后果**：core 零改动；workflow 默认关闭、显式 opt-in；不增加默认工具。resume 可能重复副作用，文档与 TUI/gateway 提示必须如实写明。单 agent 回退时并行退化为串行；workflow 定义是用户文件，不提供可视化编辑器。0.4 `workflow cancel` 只支持同进程；文件级取消标记留到 0.5。0.4 不做跨机器编排。**已知限制**：`type: tool` 直接调用 handler，绕过 runtime 的 guardrail / hook；需要 guardrail 的步骤必须用 `type: agent`。agent step 共享 Host 成员的 session，workflow 级会话隔离不在 0.4 承诺。
- **关联**：ADR-010、ADR-012、ADR-030、ADR-034、ADR-037、ADR-039、ADR-040；DECISION-009 §5.1 / §5.5 / §5.6 / §5.7 / §5.8 / §9 / §11.1 / §11.4 / §12.1 / §12.4 / §13.1。

## ADR-043：evals harness（默认离线）

- **上下文**：0.4 需要可复现、默认离线的 agent 评测基线，作为后续版本的回归门槛。评测是测试/质量工具，不是 runtime 能力；放进 core 会破坏能力准入。0.4 不允许加载自定义断言代码（安全边界）；真实 provider 必须显式联网。
- **决策**：
  1. **形态**：库 + 运行器 `plugins/evals/harness/`，包名 `@vessel/evals`；加入 `FACTORY_PLUGINS`（短名 `evals`）**仅为阻止被当作普通插件扫描**；不向 `PluginHost` 注册工具；由 asm CLI 直接调用库函数。工厂 `createEvalsPlugin()` 返回 `Plugin`（`install` no-op）+ runner（`runSuite` / `getLatest`）。
  2. **默认完全离线**：只使用脚本化 mock provider。真实 provider 需要 **`config.evals.allowNetwork === true` 且 CLI `--allow-network` 同时成立**；任一缺失 → `eval_network_required`，退出码 2；报告 `network: true`。`evals.allowNetwork: true` 单独不构成放行，CLI flag 单独也不构成放行。
  3. **Suite 格式**：YAML/JSON；`defaults.timeout_ms` / `tags` / `session: fresh|shared`；case 级 `timeout_ms` 覆盖 defaults；`mock.responses` 按序回放，耗尽返回空内容并记 `mock_exhausted` 警告（warning 不单独判失败，是否失败由断言决定）。additive 字段：`EvalCaseResult.warnings?: string[]`、`mock.responses[].tool_calls?: ToolCall[]`、`usage_under.value: { total_tokens?; prompt_tokens?; completion_tokens? }`（至少一个字段）。
  4. **断言白名单**（未知类型 = 配置错误，不执行任意代码）：`output_contains`、`output_matches`、`no_error`、`tool_called`、`tool_not_called`、`max_duration_ms`、`max_iterations`、`usage_under`。无 usage 时 `usage_under` 判 FAIL 并写明原因。
  5. **报告与写盘归属**：`EvalReport` / `EvalCaseResult` 按 DECISION-009 §5.2.3。**报告文件命名、写盘、latest 查找由 `@vessel/evals` 的 `report.ts` 负责**；asm 只传 `outDir` / `--out` 并处理 `--json` 的 stdout 输出，**不重复实现写盘**。默认文件名 `<suite>-<YYYYMMDDTHHmmssSSSZ>.json`（文件系统安全、可按名排序）；`--out` 覆盖时仍写完整 `EvalReport`。`findLatestReport` 以报告内 `finished_at` 倒序取第一条，损坏文件跳过；suite 只允许安全单段名，只读报告目录下的 `*.json`。`--filter` 未匹配的 case 记 `skipped` 并计入 `total`；skipped 只由 filter 或显式跳过产生。
  6. **退出码与错误**：0 = 全部 passed/skipped；1 = 存在 failed/error；2 = suite 解析/配置错误。`evals.enabled: false` → `eval_invalid`（消息注明 disabled），退出码 2；**不新增** `eval_disabled` 错误码。稳定错误：`eval_not_found` / `eval_invalid` / `eval_network_required`。
  7. **边界**：0.4 不做 LLM-as-judge、不做网络评测默认开启、不做任意断言插件、不做 eval 面板（gateway 只有 `GET /v1/evals/latest`）。
- **备选**：(a) 进 core——评测不是 runtime 能力；(b) 加载用户 JS 断言——安全边界不可控；(c) 只做在线评测——CI 不可复现且需要 Key；(d) LLM-as-judge——引入不确定性与额外 provider 依赖。均不取。
- **后果**：CI 可完全离线跑 eval 回归；断言面固定，扩展需要新版本。mock 回放不能覆盖真实模型行为；`--allow-network` 的结果不进入默认门禁。报告是 JSON 文件，不是 HTML 控制台。
- **关联**：ADR-030、ADR-034、ADR-037、ADR-039；DECISION-009 §5.2 / §5.7 / §9 / §11.2 / §11.4 / §12.1 / §13.2 / §13.4。

## ADR-044：飞书渠道（插件 + 官方 SDK 隔离）

- **上下文**：0.4 需要第一个真实 IM 入口，验证“人 ↔ Vessel”；WebSocket 长连接无需公网 IP。飞书官方 Node SDK 是重依赖，只能进插件包；core 的 `dependencies` 必须保持为空。个人微信无官方 API；公众号需要认证账号与公网 HTTPS，0.4 不做。
- **决策**：
  1. **形态**：工厂式插件 `plugins/im/feishu/`，包名 `@vessel/feishu`；加入 `FACTORY_PLUGINS`（短名 `feishu`）。官方 SDK 依赖只出现在该插件包。
  2. **传输抽象**：所有网络交互藏在 `FeishuTransport` 后；测试与 CI 使用 mock transport，零网络。SDK 只负责长连接与事件接收，业务语义在插件内。
  3. **配置**：`feishu.enabled / app_id / app_secret / domain / allowed_chat_ids / session_prefix / reply_timeout_ms / max_reply_chars / max_members`；**`feishu.agent_id` / `agentId` 已删除**，严格校验按未知键拒绝。环境变量 `VESSEL_FEISHU_APP_ID` / `VESSEL_FEISHU_APP_SECRET` 优先于配置。`reply_timeout_ms` 1..86400000；`max_reply_chars` 1..100000；`session_prefix` 非空且不含 `:` / 路径分隔符；`max_members` 1..64，默认 8。
  4. **专用 Host**：飞书渠道**自建专用 `InProcessRuntimeHost`**（core 公开类），`maxMembers = feishu.max_members`；不占用主 Host 的成员名额，**不改 core**。per-chat 懒 spawn 一个成员：`sessionId = feishu:<chat_id>`；agent id = `feishu_<sanitized chat_id>`（只保留 `[A-Za-z0-9_-]`，超过 64 字符时取前 55 + `_` + 8 位 hash）。同一 chat 串行；不同 chat 并行，受专用 Host 的 Scheduler 上限约束。
  5. **注入面**：asm 注入 `provider` / `model` / `pluginHost` / `session` / `events` / 可选 `contextFactory` / 可选 `runStore`；渠道把专用 Host 的事件转发到注入的 `events`（供 metrics / TUI / gateway 观测），不注入主 Host。
  6. **行为**：只处理 `im.message.receive_v1` 的 **text**；忽略机器人自己、非文本、重复 `message_id`（LRU 1000）。去重先于业务过滤；非文本消息也登记 `message_id`。单 chat 队列上限 10（只计 pending，running 不占名额），超出立即回复 `busy`；达到 `max_members` 时新 chat 立即回复 `busy`，不逐出已有成员（LRU 留 0.5）。
  7. **回复**：`im.message.reply` 到原消息；最终回复长度 ≤ `max_reply_chars`（含 `…(truncated)` 后缀）；`reply_timeout_ms` 到期取消该 run 并回复超时提示；`busy` 与超时提示文案稳定。
  8. **凭据**：任何日志 / 事件 / 错误不得输出 `app_secret` 或完整 `app_id`；只允许前 4 位 + `***`。凭据、token 不得出现在代码、测试、日志、报告或提交中。
  9. **控制面**：`FeishuStatus` / `FeishuChannel` 按 DECISION-009 §5.3.4；稳定错误 `channel_disabled` / `channel_not_connected` / `channel_auth_failed`；事件 `channel.feishu.*` 为开放字符串。
  10. **CLI 语义与运行模式**：`--feishu` 是**附加开关**。运行模式：
      - TTY + 无 `--serve`：REPL + 渠道同时运行；
      - 非 TTY + 无 `--serve`：**仅渠道前台**，不启动 REPL，阻塞到 SIGINT/SIGTERM；
      - `--serve [port]`：gateway + 渠道（无论 TTY）。
      仍与 `--run` / `--pipe` / `--resume-run` / `--tools` / `--version` / `--help` 互斥（退出码 2）。只有显式 `--feishu` 才启动渠道；`feishu.enabled: true` 单独不会启动。`--session` 允许，但只影响 REPL / serve，不影响飞书 session（始终 `feishu:<chat_id>`）。
  11. **失败语义**：配置错误 → 退出码 2；运行期连接/SDK 失败 → 退出码 1；错误必须明确，不静默降级；`start()` 失败不得被吞掉。运行中断线由 SDK 重连，状态事件如实上报。前台收到 SIGINT → 130，SIGTERM → 143。
  12. **非目标**：富媒体、卡片、@ 解析、thread 区分、多机器人、OAuth、个人微信；微信公众号/企业微信 0.5 再评估。
- **备选**：(a) 进 core——重 SDK 与渠道语义污染 core；(b) Webhook / 轮询——需要公网 HTTPS 或额外基础设施；(c) 个人微信——无官方 API；(d) 多渠道抽象层——0.4 只有一个真实渠道，抽象会变成 speculative generality。均不取。
- **后果**：core 零改动；飞书默认关闭；离线测试可用。只支持文本与单 chat 单 session；富媒体与 thread 留待后续。凭据处理成为硬门禁；`--feishu` 必须显式开启。
- **关联**：ADR-004、ADR-030、ADR-034、ADR-037、ADR-039；DECISION-009 §5.3 / §5.5 / §5.6 / §5.7 / §5.10 / §9 / §10.1 / §11.3 / §11.4 / §12.1 / §13.3 / §13.5。

## ADR-045：0.4 可观测性与稳定性

- **上下文**：0.3 的长会话、事件历史、run 存储与 gateway 慢客户端缺少统一上限与快照。0.4 需要进程内 metrics、事件历史环形缓冲、run 清理 helper 与背压加固，但不能扩 core 接口、不能新增事件、不能改变 0.3 默认行为。
- **决策**：
  1. **Metrics**：`MetricsCollector` 订阅既有事件（`run.started` / `run.completed` / `run.failed` / `run.cancelled` / `tool.call.started` / `tool.call.failed` / `llm.response`），只做进程内聚合；`MetricsSnapshot` 按 DECISION-009 §5.4.1；**不新增事件、不改 runtime**；`duration_ms.avg` 以 completed + failed 为分母，无样本为 0；进程重启即清零，不持久化、不跨 Host 合并。**`runs.cancelled` 保持 0**：取消的 run 计入 `runs.failed`（core 现有取消路径发 `run.failed`）；resume 不计 `runs.started`，按终态计 completed/failed，文档写明 `completed` 可能大于 `started`。`observability.metrics: false` 彻底关闭 collector 注入与 gateway/TUI 控制面。导出：`MetricsCollector`、`MetricsSnapshot` 可从根入口与 `@vessel/core/observability` 导入。
  2. **事件历史上限**：`MemoryEventStreamOptions.maxHistory?`（additive）；**未配置/缺省 = 1000（保持 0.3 实际默认）**；显式 `0` = 不限制；`>0` = 环形缓冲，`getHistory()` 不超过 N。`observability.event_history` 的缺省语义同上，0.4 不得把缺省改成无限。构造函数接受 `MemoryEventStreamOptions | number`，数字形式保持 0.3 语义；`MemoryEventBus` 增加可选 `MemoryEventStreamOptions` 构造参数。**不改变 `replayRun` / `FileEventStore` 语义**；`FileEventStore` 不自动轮转。导出：`MemoryEventStreamOptions` 可从根入口导入。
  3. **run 清理**：`pruneRuns(store, opts?)`（additive helper）。仅给 `status` → 删除全部匹配项；`older_than_ms` / `keep_latest` 至少一个才做年龄/保留裁剪；`keep_latest` 在 status 过滤后的集合内按 `updated_at` 倒序、`run_id` 升序；`keep_latest = 0` 删除全部匹配项；完全无条件 → 不删除。`kept` = 本次操作后仍保留的、符合 `status` 过滤的条目数；`RunStore.list` 的 200 上限不可精确统计，`keep_latest > 200` 不保证精确。**不修改 `RunStore` 接口**；不自动调度。导出：`pruneRuns`、`PruneRunsOptions`、`PruneRunsResult` 可从根入口导入。
  4. **gateway 背压**：gateway `SeqEventBuffer` 的 `maxHistory` 缺省 10000，**永不无界**，与 core `observability.event_history` 的 `0 = unlimited` 语义**独立**、不被覆盖。慢客户端：WS high 2 MiB / low 512 KiB / 硬关闭 4 MiB；SSE high 256 帧 / low 64 帧；超过阈值先丢事件并标记 `gap`，4 MiB 硬断开作为最后手段。单请求体仍限 1 MiB；远程 / 鉴权 / Host / Origin 规则不变。gateway `stop()` 不关闭 asm 注入的 collector / channel，生命周期归 asm。
  5. **加固**：`AgentRuntime` compact 后事件与消息不重复、不丢最后一条用户消息；`InProcessRuntimeHost` 关闭路径清理成员、排队 run、交互请求；大量成员 spawn/close（100 次循环）后内部 Map 无残留；`Scheduler` 队列满 / 并发取消 / 同成员串行不死锁。以测试固定，不改公开语义。
- **备选**：(a) 新增 metrics 事件或第 10 个接口——违反 ADR-012/017 的克制原则；(b) metrics 持久化 / 跨 Host 合并——0.4 只需要进程内快照；(c) 自动 prune 调度器——引入新的生命周期与并发问题；(d) gateway 无界缓冲——慢客户端会导致内存无界增长。均不取。
- **后果**：可观测性不增加扩展面；0.3 默认行为不变（事件历史缺省仍 1000）。metrics 是瞬时值；`runs.cancelled` 保持 0，取消计入 failed；`completed` 可能大于 `started`（resume 不计 started）。事件上限会丢旧事件（回放应使用 `FileEventStore`）；prune 需要显式调用；多 Host 不合并；gateway 缓冲与 core 事件历史相互独立。gateway 慢客户端会收到 `gap`，极端情况下被硬断开（4 MiB），这是刻意的背压。
- **关联**：ADR-030、ADR-036、ADR-037、ADR-040；DECISION-009 §5.4 / §5.7 / §9 / §10.2 / §10.3 / §11.4 / §12.1。
