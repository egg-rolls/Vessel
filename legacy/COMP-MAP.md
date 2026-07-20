# 竞品地图与必备件清单

> 旧版 COMP 调研的提炼，作为新项目需求基线。代码推翻后本文件仍有效。

---

## 一、对标对象

| 框架 | 语言 | 定位 | 借鉴点 |
|------|------|------|--------|
| Claude Code | TS | 官方 CLI agent | TUI 形态、CLAUDE.md+memory、hooks、MCP、slash 命令、subagent |
| Cline | TS | IDE 内自主 agent | Human-in-the-loop GUI、MCP 自扩展 |
| OpenCode | Go | 终端 AI 助手 | Auto Compact、LSP、单二进制 |
| Aider | Python | 结对编程 | Repository Map（PageRank 选上下文） |
| SWE-Agent | Python | 软件工程 agent | ACI（动作空间精简、反馈即时、错误可恢复） |
| OpenAI Agents SDK | Python | 轻量 runtime | Guardrails/Sessions/Tracing/Sandbox |
| Pydantic AI | Python | 类型安全 | Output validation/Usage Limits/Evals |
| AutoGen | Python | 多 agent | Stateful agent/Termination/Teams |
| LlamaIndex Workflows | Python | 事件驱动 | Events/durable/checkpoint |

---

## 二、模块通用性（=必备件基线）

| 模块 | 通用性 | 新版取舍 |
|------|--------|----------|
| LLM Provider 抽象 | ⭐⭐⭐⭐⭐ | core，必备 |
| 上下文管理（历史/压缩/注入） | ⭐⭐⭐⭐⭐ | core，必备 |
| 工具系统（注册/schema/调用/超时） | ⭐⭐⭐⭐⭐ | core，必备 |
| 反馈闭环（工具结果→LLM） | ⭐⭐⭐⭐⭐ | core，必备 |
| Usage Limits / Termination | ⭐⭐⭐⭐ | core，必备（控制面） |
| Guardrails（四阶段） | ⭐⭐⭐⭐ | core 接口 + 插件规则 |
| Run/Session 分离 | ⭐⭐⭐⭐ | core，必备 |
| 结构化事件流 | ⭐⭐⭐⭐ | core，必备 |
| 配置系统（声明式） | ⭐⭐⭐⭐ | core，必备 |
| Hooks | ⭐⭐⭐⭐ | core 接口 + 插件 |
| Memory（跨会话） | ⭐⭐⭐⭐ | **插件**（旧版塞 core，教训 2） |
| MCP | ⭐⭐⭐ | **插件**（旧版半成品，教训 11） |
| Evaluation | ⭐⭐⭐⭐ | **延后**（教训 14） |
| Workflow/DAG | ⭐⭐⭐ | **延后**（教训 14） |
| Multi-agent/team | ⭐⭐⭐ | **延后**（教训 14） |
| Durable execution | ⭐⭐⭐ | **延后**（教训 14） |
| TUI（REPL/slash/流式渲染/权限） | — | **应用层必备**（新方向） |
| Repository Map / Auto Compact | ⭐⭐⭐ | 可选插件 |

---

## 三、Claude-Code 式 TUI 产品的必备件（新方向增量）

旧版 COMP 偏"框架"，新版增补 TUI 应用层必备件：

- **交互 REPL**：流式渲染、中断、多行输入。
- **slash 命令**：用户操作入口（类 Claude Code）。
- **权限弹窗**：工具执行前 human-in-the-loop 确认（类 Cline）。
- **项目记忆 + 自动记忆**：跨会话（继承旧 memory 设计，但做插件）。
- **Auto Compact**：上下文阈值自动摘要（类 OpenCode）。
- **配置向导**：无基础用户首启引导填 Key/选 provider。

---

## 四、新项目需求基线（一句话）

MVP = core（loop+provider+context+session+events+tools+limits+guardrail+hooks）+ TUI（REPL+slash+权限+向导）+ 配置层（YAML）；memory/MCP 做插件；workflow/team/evals/durable 延后。
