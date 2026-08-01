# CLAUDE.md

> 本文件是 AI 编码代理在 Vessel 仓库工作的操作手册。开发前必读。
> Vessel 已从旧 Python 项目重构为面向无基础/弱基础用户的 **TypeScript Harness 应用**。
> 旧项目遗产见 [legacy/](legacy/)。本文件与代码冲突时，以代码为准并更新本文件；不靠记忆猜测。

## 1. 项目身份

- **是什么**：自组织 Agent Harness——极简核心（9 个接口、2 个插槽、1 个通用循环），Agent 自己发现缺口、自己装配能力。三层：`@vessel/core`（运行时，可独立嵌入）+ `@vessel/config`（声明式配置）+ `@vessel/tui`（终端交互）。Provder 无关、范式无关、开源。
- **语言/运行时**：TypeScript + Bun。
- **分发**：`npx vessel` + `bun build --compile` 单二进制。
- **状态**：pre-MVP。标注 `[plan]` 的为待实现。
- **大目标**：自组织、极轻便、极强扩展性、厂商中立。无基础用户填 Key 即跑；Agent 自己长大。

## 2. 文档加载策略

### 宪法级（每次编码前必读）

这三个文件是仓库的宪法。**不清楚其中内容 = 写出的代码大概率违规**。

| 必读 | 为什么 |
|------|--------|
| [docs/specs/SPEC.md](docs/specs/SPEC.md) | 接口契约——不知道接口签名写不了代码 |
| [docs/specs/ADR.md](docs/specs/ADR.md) | 架构决策——不知道历史决策会重蹈覆辙 |
| [docs/specs/DOC-STANDARD.md](docs/specs/DOC-STANDARD.md) | 文档规范——核心规则见下方摘要 |

### DOC-STANDARD 核心规则（嵌入，不必跳转）

```
docs/specs/  guides/  api/  → 永久文档，禁止出现：
  "pre-MVP" "当前" "目前" "现在" "暂不" "延后" "Phase N 实现时"
  → 只描述设计是什么，不描述做到哪了
  → 状态/进度/审查信息放 docs/dev/

docs/dev/ → 临时产物，无限制

AI 改 specs/guides/api 后自检：
  grep -rn "当前|目前|现在|暂不|延后|pre-MVP|MVP 范围" docs/specs/ docs/guides/ docs/api/
  命中即违规
```

### 按需加载

| 场景 | 文档 |
|------|------|
| 规划新功能 | [docs/specs/ROADMAP.md](docs/specs/ROADMAP.md)、[docs/specs/PRD.md](docs/specs/PRD.md) |
| 添加插件 | [docs/specs/PLUGINS.md](docs/specs/PLUGINS.md) |
| 合并审查 | [docs/specs/GIT-WORKFLOW.md](docs/specs/GIT-WORKFLOW.md)（核心规则已在 §9） |
| 查术语 | [docs/specs/GLOSSARY.md](docs/specs/GLOSSARY.md) |
| 搭环境/写测试/构建/开发插件 | [docs/guides/](docs/guides/) |
| 查 Core 接口 | [docs/specs/CORE.md](docs/specs/CORE.md)（快速参考） |
| 查 API 签名 | [docs/api/core.md](docs/api/core.md) |
| 了解协作流程 | [processes/collaboration.md](processes/collaboration.md) |
| Commit/分支/Issue 命名规范 | [processes/conventions.md](processes/conventions.md) |
| 查看当前任务 | [processes/task-assignment.md](processes/task-assignment.md) |
| 避免旧错误 | [legacy/LESSONS.md](legacy/LESSONS.md) |
| 人类贡献流程 | [CONTRIBUTING.md](CONTRIBUTING.md) |

### 入口概览

[README.md](README.md) — 项目门面，给人类看的第一眼。

## 3. 项目事实（随实现更新）

- 仓库结构：`packages/{core,config,tui}` + `plugins/` + `docs/{specs,guides,api,dev}` + `processes/` + `legacy/`。
- monorepo：bun workspaces。
- 公共入口：`@vessel/core` 的 `AgentRuntime`、`PluginHost`；`@vessel/tui` 的 REPL。
- 依赖：保持精简；core 不依赖 tui/config/plugins。
- 不引入 LangChain/LangGraph。

`[plan]` 具体 build/test/lint 命令待 `package.json` scripts 就绪后填入（预期 lint=Biome/ADR-013, test=`bun test`, build=`bun build`, 详见 §9）。

## 4. 工程规范

- TS strict；async/await 全异步，**禁止 sync-in-async**（旧项目教训6）。
- 不可变优先；构造时注入全部状态，**不外部改私有字段**（教训7）。
- 事件类型用枚举 + payload schema，**禁止散落字符串字面量**（教训8）。
- 文件/命名：包内小写 kebab；接口 PascalCase；遵循各包既有风格。
- 测试：每模块配单测；MVP 验收见 [ROADMAP.md](docs/specs/ROADMAP.md) Phase 1。
- 提交格式：`<type>(<scope>): <subject>`（feat/fix/docs/refactor/test/chore）。
- 依赖方向：tui -> config -> core；core 不反向引用。

### 4.1 代码设计纪律（前期投入换长期回报）

#### 概念

代码被阅读的次数远多于被编写的次数。每一行提交的代码首先是一笔**负债**——未来改它、测它、理解它的成本。

AI 的默认模式是"最短路径完成当前任务"。这是局部最优，但在时间维度上是全局最劣。
每次为"快点写完"而跳过的抽象、提取、边界划分，都会在未来某次修改时连本带利索回。

"长期快乐"不是多写代码——是在正确的地方画出正确的边界，让每块逻辑可以**独立理解、独立测试、独立修改**。

#### 正面例子

以下不是规定，是方向示例——激活你自己的设计判断：

- 80 行 inline 逻辑 → 提取为模块级纯函数 → **可以单测**。3 个月后改它时，测试告诉你有没有踩断东西。
- `switch(event.type) { case A: ... case B: ... }` → 纯函数 `reduce(prev, event)` → **输入输出类型化**。加一个 case 不改调用方代码。
- 三个组件里相似的 format/parse 逻辑 → 共享工具函数 → **bug 修一次，三处受益**。不追着每个副本改。
- `as Segment` 类型断言 → 工厂函数 `makeSegment(...)` → **类型在构造时保证**。重构时编译器抓住所有断裂点，而不是运行时崩。
- 多个 useState 各自为政 → useReducer 或统一状态对象 → **状态转换可追踪**。不会出现"改了 A 忘了更新 B"的隐式 bug。

共同特征：**写完当下多花了 10 分钟，但未来每次改动省下数小时**。

#### 反面例子

反面不是"写错了"，而是"写得太快了"——缺少设计停顿：

- **"能跑就行"** → 测试只验证当前路径，不验证结构。下次改代码时，测试也改不动。
- **"这太简单了，不需要抽象"** → 简单 × 重复 N 次 = 复杂。每个重复副本都是未来 bug 的独立温床。
- **"以后再重构"** → 软件工程中回报率最低的一句话。今天不做的重构，明天的你也不会做。
- **"就加个 else if，不碍事"** → 每个分支单独看都合理，但 20 个之后就是没人敢改、测不了的巨型分发。

共同特征：**当即省了 10 分钟，但未来每次改动都要付出额外代价，直到没人愿意碰**。

#### 提交前自问（30 秒设计停顿）

这些不是 checklist——是你自己判断方向的提示：

- 3 个月后我要在这个模块里加新功能，我会感谢现在的自己吗？
- 这段逻辑能**不启动整个应用**单独测试吗？
- 新增一个 case / tool / event 需要**改几处代码**？能不能做成"只加不改"？
- 类型签名本身能**说清楚这段代码做什么**，还是必须读实现？

你有所有具体场景的信息，比任何 checklist 更了解你的代码。**10 分钟的设计停顿，换未来 10 小时的维护时间——每一笔都值得。**

## 5. 能力分层与准入决策树

新增能力前必须分类：**内置(core) / 插件 / 应用层**。

进 **core** 前必须全部满足：
1. 大多数 harness 都需要？
2. 领域无关（不涉文档/代码审查/客服/OCR/PDF/图片/向量/浏览器/IAM/计费/租户/dashboard）？
3. 可接口化（不绑具体后端/厂商 SDK/重依赖）？
4. 不绑定 Provider/Model/API Key/Base URL/价格？
5. 能被多个应用复用？

全"是" -> core；否则 -> 插件或应用层。**拿不准选插件，不选 core。**

- **内置(core)**：runtime loop、provider 抽象、context、session、events、tools、limits、termination、guardrail 接口、hook 接口、PluginHost。
- **插件**：guardrail 规则、memory、MCP、corrections、resilience、evals、OCR/PDF/图片/向量/浏览器等。**不进 runtime 构造函数**，经 Plugin 注入（ADR-003）。
- **应用层**：TUI、配置向导、业务 agent。

用户面向的四种扩展类型（Plugin/MCP/Skill/Config）全经 PluginHost 投放，core 不为它们新增接口（ADR-011）；详见 [SPEC.md §5.1](docs/specs/SPEC.md)。

### 5.1 Core 冻结（ADR-017）

**`@vessel/core` 的 9 个接口 + tool-calling loop 已冻结。** 功能增长一律走 Plugin/MCP/Skill，不动 core。

冻结范围：`packages/core/src/**` 中所有定义了接口契约、循环逻辑、事件类型的文件。

**只能因三种原因改 core**（ADR-012(2a-c)，需 ADR-017 解冻条件）：
1. 扩"插座"——EventType / HookType / GuardrailStage 枚举成员（需写新 ADR）
2. 修 loop 级 bug（竞态、泄漏、安全）
3. 横切需求——**先证明**无法用 Plugin/Hook/Guardrail/事件/工具表示（ADR-015：尚无已知的此类需求）

**你以为需要改 core？走这个 checklist：**
```
[ ] 我能用 Plugin + PluginHost.registerTool/registerHook 实现吗？
[ ] 我能用 MCP server + bridge plugin 实现吗？
[ ] 我能用 Skill（Markdown + BeforeLlm Hook）实现吗？
[ ] 我能用 Guardrail（四阶段）实现吗？
[ ] 我能用事件（新增或现有 EventType）实现吗？
→ 任一为"是" → 不进 core。全"否" → 写 ADR，两人 Review。
```

**AI 编码前自查**：如果你要改 `packages/core/src/` 下的文件，先读本段。拿不准 = 不在 core 做。

## 6. 红线（Stop and reconsider if about to）

- 把插件对象塞进 runtime 构造函数（guardrail/memory/mcp/corrections/resilience/evals）。-> 违 ADR-003。
- 新增第 2 套扩展机制（不走 Plugin + PluginHost）。-> 违 ADR-004。
- 用散落字符串发事件，而非 EventType 枚举。-> 违 ADR-008。
- 写 sync-in-async（阻塞调用混进异步路径）。-> 违教训6。
- 留半成品 stub（`throw new NotImplementedError()` / 空实现进 core）。-> 违教训11。
- 给 core 加默认厂商 API Key/Base URL/价格。-> 违 ADR-005（Key 永远用户自备；可有 provider 预设但不绑 Key）。
- 给 core 加 OCR/PDF/图片/向量/浏览器/IAM/计费依赖。-> 违分层。
- 在 core 里引用 tui/config/plugins。-> 违依赖方向。
- 把 workflow/team/durable/evals 提前到 MVP。-> 违 ADR-010 / ROADMAP。
- 改 core（loop 或扩展面）来实现本可做成工具/Hook/Guardrail/事件的事，且无 ADR。-> 违 ADR-012/015（循环通用；A2A、树搜索、多 agent、流式全可用工具/Hook/事件表示；core 是所有方法都试过后的最后选项）。
- 引入 LangChain/LangGraph。
- 让 `vessel.yaml` 默认暴露 30+ 键。-> 违教训4（零配置起步）。
- 文档吹未实现能力。-> 违反幻觉纪律。

## 7. 反幻觉纪律

- 文档只写已实现；规划项标 `[plan]`。
- 不吹 MCP/RAG/evals/workflow 等未实现能力。
- 代码与文档不一致时，改其一，不留矛盾。
- 不从记忆回答能查代码的问题；先查 `packages/`。
- **修改 `docs/specs/`、`docs/guides/`、`docs/api/` 后必须执行 §2 中的自检 grep，命中禁用词立即修正。**

## 8. 任务响应规则

**改代码时**：查相关包 → 按决策树分类 → 最小正确改动 → 补测试 → 更新文档/本文件 → 跑校验。
**解释时**：引实际文件/类/函数；标 pre-MVP/`[plan]`；区分已实现 vs 规划；不虚构 API。
**不确定时**：搜代码 → 读测试 → 仍不清则短问。

## 9. 合并审查规则（Git 门禁）

合并任何分支到 `main` 前，必须执行以下检查并输出结论。**核心原则：合并前验证，不合并后修复。** 详见 [docs/specs/GIT-WORKFLOW.md](docs/specs/GIT-WORKFLOW.md)。

### 9.1 架构规范检查（对照全部 specs 文档）

每次合并前逐条检查：

```
[ ] 依赖方向：core 未引用 tui/config/plugins
[ ] 能力分层：新代码按 §5 决策树正确分类
[ ] 红线：未触碰 §6 的任一条
[ ] 扩展机制：未新增第二套扩展路径
[ ] 事件类型：未用散落字符串替代 EventType 枚举
[ ] sync-in-async：异步路径中无同步阻塞调用
[ ] 半成品：无 NotImplementedError / 空实现进 core
[ ] 无硬编码密钥/Token/密码
[ ] 文档诚实：未声称未实现功能
[ ] 新能力：改 core 则必有 ADR
[ ] 设计质量：新增复杂逻辑是否有清晰的模块边界？是否能独立测试？（对照 §4.1 自问）
```

### 9.2 CI 硬性门禁

```
bun run lint       → 必须通过
bun run typecheck  → 必须通过
bun test           → 必须通过
bun run build      → 必须通过
```

### 9.3 阻断规则

以下情况必须阻断合并：
- CI 任一项不通过
- 架构检查任一项不通过
- 发现硬编码密钥
- 分支有未解决的合并冲突
- "稍后修复"承诺——要求先修复再合

### 9.4 合并后

- 删除远程 feature 分支
- 确认 main push 成功
- 更新本地 main

## 10. 校验命令

`[plan]` 脚手架就绪后：

```bash
bun test          # 测试
bun build         # 构建
bun run lint      # biome lint+format 检查（ADR-013）
bun run typecheck # tsc --noEmit 类型检查
```

docs-only 改动至少跑 lint（如可行）。
