# AGENTS.md

> 本文件是 Vessel 仓库的通用概念手册。**所有 AI Agent 角色必读。**
> 角色专属规则见 `docs/role/REQUIREMENTS-ANALYST.md` / `ARCHITECT.md` / `DEVELOPER.md` / `REVIEWER.md` / `DOC-MANAGER.md`。
> 本文件与代码冲突时，以代码为准并更新本文件；不靠记忆猜测。

---

## 1. 项目身份

- **是什么**：自组织 Agent Harness——极简核心（9 个接口、2 个插槽、1 个通用循环），Agent 自己发现缺口、自己装配能力。三层：`@vessel/core`（运行时，可独立嵌入）+ `@vessel/config`（声明式配置）+ `@vessel/tui`（终端交互）。Provider 无关、范式无关、开源。
- **语言/运行时**：TypeScript + Bun。
- **分发**：`npx vessel` + `bun build --compile` 单二进制。
- **状态**：pre-MVP。标注 `[plan]` 的为待实现。
- **大目标**：自组织、极轻便、极强扩展性、厂商中立。无基础用户填 Key 即跑；Agent 自己长大。

## 2. 项目事实

- 仓库结构：`packages/{core,config,tui}` + `plugins/` + `docs/{specs,guides,role,api,dev}` + `processes/` + `legacy/`。
- monorepo：bun workspaces。
- 公共入口：`@vessel/core` 的 `AgentRuntime`、`PluginHost`；`@vessel/tui` 的 REPL。
- 依赖：保持精简；core 不依赖 tui/config/plugins。
- 不引入 LangChain/LangGraph。

## 3. 文档加载策略

### 宪法级

这三个文件是仓库的宪法。**不清楚其中内容 = 写出的代码大概率违规**。

| 必读 | 为什么 |
|------|--------|
| [docs/specs/SPEC.md](docs/specs/SPEC.md) | 接口契约——不知道接口签名写不了代码 |
| [docs/specs/ADR.md](docs/specs/ADR.md) | 架构决策——不知道历史决策会重蹈覆辙 |
| [docs/specs/DOC-STANDARD.md](docs/specs/DOC-STANDARD.md) | 文档规范——修改永久文档前必读 |

### 按需加载

| 场景 | 文档 |
|------|------|
| **角色入口（开始任何工作前）** | [`docs/role/REQUIREMENTS-ANALYST.md`](docs/role/REQUIREMENTS-ANALYST.md) / [`ARCHITECT.md`](docs/role/ARCHITECT.md) / [`DEVELOPER.md`](docs/role/DEVELOPER.md) / [`REVIEWER.md`](docs/role/REVIEWER.md) / [`DOC-MANAGER.md`](docs/role/DOC-MANAGER.md) |
| 规划新功能 | [docs/specs/ROADMAP.md](docs/specs/ROADMAP.md)、[docs/specs/PRD.md](docs/specs/PRD.md) |
| 添加插件 | [docs/specs/PLUGINS.md](docs/specs/PLUGINS.md) |
| 合并审查 | [docs/specs/GIT-WORKFLOW.md](docs/specs/GIT-WORKFLOW.md) |
| 修改文档 | [docs/specs/DOC-STANDARD.md](docs/specs/DOC-STANDARD.md)（§七 设计方法——修改文档前必读）、[docs/specs/META-GOVERNANCE.md](docs/specs/META-GOVERNANCE.md)（规范的规范——判断该不该写） |
| 新增/修改治理规则 | [docs/specs/META-GOVERNANCE.md](docs/specs/META-GOVERNANCE.md)（三条准入 + 四层梯度 + 三类分离） |
| 查术语 | [docs/specs/GLOSSARY.md](docs/specs/GLOSSARY.md) |
| 查 Core 接口 | [docs/specs/CORE.md](docs/specs/CORE.md)（快速参考） |
| 查 API 签名 | [docs/api/core.md](docs/api/core.md) |
| 了解协作流程 | [processes/collaboration.md](processes/collaboration.md) |
| Commit/分支/Issue 命名规范 | [processes/conventions.md](processes/conventions.md) |
| 查看当前任务 | [processes/task-assignment.md](processes/task-assignment.md) |
| 避免旧错误 | [legacy/LESSONS.md](legacy/LESSONS.md) |
| 人类贡献流程 | [CONTRIBUTING.md](CONTRIBUTING.md) |

### 文档分区规则

```
docs/specs/  guides/  role/  api/  → 永久文档，禁止出现：
  "pre-MVP" "当前" "目前" "现在" "暂不" "延后" "Phase N 实现时"
  → 只描述设计是什么，不描述做到哪了
  → 状态/进度/审查信息放 docs/dev/

docs/dev/ → 临时产物，无限制
```

## 4. 红线

以下任一触发，**立即停止，重新考虑**：

- 把插件对象塞进 runtime 构造函数（guardrail/memory/mcp/corrections/resilience/evals）。→ 违 ADR-003。
- 新增第 2 套扩展机制（不走 Plugin + PluginHost）。→ 违 ADR-004。
- 用散落字符串发事件，而非 EventType 枚举。→ 违 ADR-008。
- 写 sync-in-async（阻塞调用混进异步路径）。→ 违旧项目教训6。
- 留半成品 stub（`throw new NotImplementedError()` / 空实现进 core）。→ 违旧项目教训11。
- 给 core 加默认厂商 API Key/Base URL/价格。→ 违 ADR-005（Key 永远用户自备）。
- 给 core 加 OCR/PDF/图片/向量/浏览器/IAM/计费依赖。→ 违分层。
- 在 core 里引用 tui/config/plugins。→ 违依赖方向。
- 把 workflow/team/durable/evals 提前到 MVP。→ 违 ADR-010 / ROADMAP。
- 改 core（loop 或扩展面）来实现本可做成工具/Hook/Guardrail/事件的事，且无 ADR。→ 违 ADR-012/015。
- 引入 LangChain/LangGraph。
- 让 `vessel.yaml` 默认暴露 30+ 键。→ 违旧项目教训4（零配置起步）。
- 文档吹未实现能力。→ 违反反幻觉纪律。

## 5. 反幻觉纪律

- 文档只写已实现；规划项标 `[plan]`。
- 不吹 MCP/RAG/evals/workflow 等未实现能力。
- 代码与文档不一致时，改其一，不留矛盾。
- 不从记忆回答能查代码的问题；先查 `packages/`。
- **修改 `docs/specs/`、`docs/guides/`、`docs/role/`、`docs/api/` 后必须执行自检 grep**：
  ```
  grep -rn "当前\|目前\|现在\|暂时\|暂不\|延后\|近期\|以后\|pre-MVP\|MVP 范围\|Phase.*实现时" docs/specs/ docs/guides/ docs/role/ docs/api/
  ```
  命中即违规，修改后方可提交。

## 6. 能力分层与准入决策树

新增能力前必须分类：**内置(core) / 插件 / 应用层**。

进 **core** 前必须全部满足：
1. 大多数 harness 都需要？
2. 领域无关（不涉文档/代码审查/客服/OCR/PDF/图片/向量/浏览器/IAM/计费/租户/dashboard）？
3. 可接口化（不绑具体后端/厂商 SDK/重依赖）？
4. 不绑定 Provider/Model/API Key/Base URL/价格？
5. 能被多个应用复用？

全"是" → core；否则 → 插件或应用层。**拿不准选插件，不选 core。**

- **内置(core)**：runtime loop、provider 抽象、context、session、events、tools、limits、termination、guardrail 接口、hook 接口、PluginHost。
- **插件**：guardrail 规则、memory、MCP、corrections、resilience、evals、OCR/PDF/图片/向量/浏览器等。**不进 runtime 构造函数**，经 Plugin 注入（ADR-003）。
- **应用层**：TUI、配置向导、业务 agent。

用户面向的四种扩展类型（Plugin/MCP/Skill/Config）全经 PluginHost 投放，core 不为它们新增接口（ADR-011）。

### Core 冻结（ADR-017）

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
