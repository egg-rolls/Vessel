# CLAUDE.md

> 本文件是 AI 编码代理在 Vessel 仓库工作的公共操作手册。**所有角色必读。**
> 角色专属内容已移至 `docs/guides/DEVELOPER.md` / `REVIEWER.md` / `DOC-MANAGER.md`。
> Vessel 已从旧 Python 项目重构为面向无基础/弱基础用户的 **TypeScript Harness 应用**。
> 旧项目遗产见 [legacy/](legacy/)。本文件与代码冲突时，以代码为准并更新本文件；不靠记忆猜测。

> **场景调度**：每一步工作的第一步——先读对应角色入口文件，再开始干活。
>
> | 你的任务 | 第一步 |
> |---------|--------|
> | 写/改代码 | 先读 [`docs/guides/DEVELOPER.md`](docs/guides/DEVELOPER.md)（开发者须知） |
> | 审查 PR / 合并 | 先读 [`docs/guides/REVIEWER.md`](docs/guides/REVIEWER.md)（审查者须知） |
> | 修改文档 | 先读 [`docs/guides/DOC-MANAGER.md`](docs/guides/DOC-MANAGER.md)（文档管理者须知） |
>
> 每个须知文件包含该角色的必读清单（按顺序）、自检问题和自检命令。读完再干活。

## 1. 项目身份

- **是什么**：自组织 Agent Harness——极简核心（9 个接口、2 个插槽、1 个通用循环），Agent 自己发现缺口、自己装配能力。三层：`@vessel/core`（运行时，可独立嵌入）+ `@vessel/config`（声明式配置）+ `@vessel/tui`（终端交互）。Provider 无关、范式无关、开源。
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
| **角色入口（开始任何工作前）** | [`docs/guides/DEVELOPER.md`](docs/guides/DEVELOPER.md) / [`REVIEWER.md`](docs/guides/REVIEWER.md) / [`DOC-MANAGER.md`](docs/guides/DOC-MANAGER.md) |
| 规划新功能 | [docs/specs/ROADMAP.md](docs/specs/ROADMAP.md)、[docs/specs/PRD.md](docs/specs/PRD.md) |
| 添加插件 | [docs/specs/PLUGINS.md](docs/specs/PLUGINS.md) |
| 合并审查 | [docs/specs/GIT-WORKFLOW.md](docs/specs/GIT-WORKFLOW.md) |
| 修改文档 | [docs/specs/DOC-STANDARD.md](docs/specs/DOC-STANDARD.md)（§七 设计方法——修改文档前必读） |
| 查术语 | [docs/specs/GLOSSARY.md](docs/specs/GLOSSARY.md) |
| 查 Core 接口 | [docs/specs/CORE.md](docs/specs/CORE.md)（快速参考） |
| 查 API 签名 | [docs/api/core.md](docs/api/core.md) |
| 了解协作流程 | [processes/collaboration.md](processes/collaboration.md) |
| Commit/分支/Issue 命名规范 | [processes/conventions.md](processes/conventions.md) |
| 查看当前任务 | [processes/task-assignment.md](processes/task-assignment.md) |
| 避免旧错误 | [legacy/LESSONS.md](legacy/LESSONS.md) |
| 人类贡献流程 | [CONTRIBUTING.md](CONTRIBUTING.md) |

### 入口概览

[README.md](README.md) — 项目门面，给人类看的第一眼。

---

## 3. 红线（Stop and reconsider if about to）

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

---

## 4. 反幻觉纪律

- 文档只写已实现；规划项标 `[plan]`。
- 不吹 MCP/RAG/evals/workflow 等未实现能力。
- 代码与文档不一致时，改其一，不留矛盾。
- 不从记忆回答能查代码的问题；先查 `packages/`。
- **修改 `docs/specs/`、`docs/guides/`、`docs/api/` 后必须执行 §2 中的自检 grep，命中禁用词立即修正。**

---

## 5. 任务响应规则

**改代码时**：先确认自己在哪个分支（`git branch --show-current`）→ 不是自己的分支立刻切走 → 从 `main` 开新分支 → 读 `docs/guides/DEVELOPER.md` → 按决策树分类 → 最小正确改动 → 补测试 → 更新文档 → 跑校验。
**审查/合并时**：先读 `docs/guides/REVIEWER.md` → 对照门禁清单检查 → 输出审查结论。
**修改文档时**：先读 `docs/guides/DOC-MANAGER.md` → 走对应知识链路 → 再动笔。
**解释时**：引实际文件/类/函数；标 pre-MVP/`[plan]`；区分已实现 vs 规划；不虚构 API。
**不确定时**：搜代码 → 读测试 → 仍不清则短问。
