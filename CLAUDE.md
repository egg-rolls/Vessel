# CLAUDE.md

> 本文件是 AI 编码代理在 Vessel 仓库工作的操作手册。开发前必读。
> Vessel 已从旧 Python 项目重构为面向无基础/弱基础用户的 **TypeScript Harness 应用**。
> 旧项目遗产见 [legacy/](legacy/)。本文件与代码冲突时，以代码为准并更新本文件；不靠记忆猜测。

## 1. 项目身份

- **是什么**：面向无基础/弱基础用户的 AI Agent Harness **应用**（非框架）。三层：`@vessel/core`（运行时）+ `@vessel/config`（声明式配置）+ `@vessel/tui`（终端交互）。
- **语言/运行时**：TypeScript + Bun。
- **分发**：`npx vessel` + `bun build --compile` 单二进制。
- **状态**：pre-MVP。标注 `[plan]` 的为待实现。
- **大目标**：极强扩展性、可维护性、轻便；无基础用户填 Key 即跑。

## 2. 阅读顺序（动手前）

1. [README.md](README.md)
2. [docs/specs/PRD.md](docs/specs/PRD.md) - 做什么 / 为谁
3. [docs/specs/SPEC.md](docs/specs/SPEC.md) - 怎么建 / 接口契约
4. [docs/specs/ADR.md](docs/specs/ADR.md) - 为什么这么决策（勿轻易推翻）
5. [docs/specs/ROADMAP.md](docs/specs/ROADMAP.md) - 当前分期 / MVP 边界
6. [docs/specs/GLOSSARY.md](docs/specs/GLOSSARY.md) - 术语
7. [docs/specs/PLUGINS.md](docs/specs/PLUGINS.md) - 插件 backlog 目录
8. [legacy/LESSONS.md](legacy/LESSONS.md) - 旧项目教训（避免重蹈）
9. 相关 `packages/` 源码与测试
10. [CONTRIBUTING.md](CONTRIBUTING.md) - 贡献流程 / PR / commit 规范（人类贡献者入口）

## 3. 项目事实（随实现更新）

- 仓库结构：`packages/{core,config,tui}` + `plugins/` + `docs/` + `legacy/`。
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

## 8. 任务响应规则

**改代码时**：查相关包 -> 按决策树分类 -> 最小正确改动 -> 补测试 -> 更新文档/本文件 -> 跑校验。
**解释时**：引实际文件/类/函数；标 pre-MVP/`[plan]`；区分已实现 vs 规划；不虚构 API。
**不确定时**：搜代码 -> 读测试 -> 仍不清则短问。

## 9. 校验命令

`[plan]` 脚手架就绪后：

```bash
bun test          # 测试
bun build         # 构建
bun run lint      # biome lint+format 检查（ADR-013）
bun run typecheck # tsc --noEmit 类型检查
```

docs-only 改动至少跑 lint（如可行）。
