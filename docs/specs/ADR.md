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

## ADR-005：安全默认 + 可覆盖（放弃"无默认"教条）

- **上下文**：旧 Vessel 强制"不内置默认 provider/model/base_url/价格"，却给 temperature/iterations 等行为默认，教条自相矛盾；无基础用户既无默认 provider 便利，又被隐式默认困惑。
- **决策**：内置安全默认（provider 预设列表 + 行为默认），用户填 Key 即跑；所有默认可被配置覆盖。**Key 永远用户自备，不内置任何厂商 Key/价格。**
- **后果**：无基础用户零配置起步；仍保持厂商中立（不绑 Key/价格）。预设列表需维护。
- **关联**：legacy/LESSONS 教训5。

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
