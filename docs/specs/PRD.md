# 产品需求文档（PRD）

> 本文档定义 Vessel **做什么、为谁做、为什么**，不涉及技术实现（见 [SPEC.md](SPEC.md)）。
> 决策理由见 [ADR.md](ADR.md)；分期见 [ROADMAP.md](ROADMAP.md)。
> 状态：pre-MVP。

## 1. 愿景

让无基础/弱基础用户也能拥有一个会自己长大的 AI Agent——填 Key 即跑，Agent 自己发现能力缺口、自己装工具/接 MCP/写 Skill。无需写代码，无需理解框架。开发者可嵌入、可扩展、不绑厂商。

## 2. 目标用户与任务（JTBD）

### 2.1 无基础用户（主要）
- **画像**：不会编程，想要一个能干活的 AI 助手。
- **任务**：下载/安装 → 填 API Key → 在 TUI 里对话、让 agent 调工具干活。
- **痛点**：现有框架要装 Python、配 YAML、懂 env var；现有产品（ChatGPT 等）不能自定义工具/流程。

### 2.2 弱基础用户
- **画像**：会改配置文件，不写代码。
- **任务**：编辑 YAML 定义 agent 人设、工具集、guardrail；在 TUI 里用。
- **痛点**：现有框架配置项太多（旧 Vessel 33 个键），劝退。

### 2.3 开发者
- **画像**：会写 TS，想嵌入运行时或写插件。
- **任务**：把 `@vessel/core` 嵌入自己的应用；写插件扩展工具/provider/guardrail/hook。
- **痛点**：现有框架扩展机制不统一（旧 Vessel 4 套），core 臃肿难嵌入。

## 3. 范围

### 3.1 MVP 范围内（IN）
- 三层结构：core 运行时 + TUI 控制层 + 声明式配置层。
- core 必备件：tool-calling loop、LLM provider 抽象、上下文管理、Run/Session、结构化事件流、工具注册、UsageLimits/TerminationPolicy、Guardrails（四阶段）、Hooks 接口。
- TUI 必备件：交互 REPL、流式渲染、slash 命令、工具执行前权限确认、首启配置向导。
- 配置层：YAML 定义 agent/工具/guardrail；零配置起步 + 渐进披露。
- 分发：`npx vessel` 零安装 + Bun 单二进制。

### 3.2 明确不做（OUT）
- workflow/DAG 编排、multi-agent/team、durable execution、evaluation harness（延后到 Phase 3，见 ROADMAP）。
- 垂直应用：RAG、代码审查、文档问答、客服、图片工作流等（永不进 core，可作插件/独立应用）。
- Web/桌面 GUI（TUI 即主界面）。
- 企业 IAM/SSO/多租户/计费。
- **默认内置任何 LLM 厂商的 API Key/价格**（Key 永远用户自备；但可有 provider 预设列表方便选择，见 ADR-005）。

## 4. 成功指标

| 指标 | MVP 目标 |
|------|----------|
| 首次跑通时间（无基础用户：安装→第一次工具调用成功） | ≤ 5 分钟 |
| 零配置起步 | 仅填 API Key 即可对话，其余全默认 |
| 弱基础定制 | 一份 ≤ 20 行 YAML 能定义一个带自定义工具的 agent |
| 开发者嵌入 | `@vessel/core` 无 UI 依赖，构造函数 ≤ 核心必需项 |
| 扩展一致性 | 新增 tool/provider/hook/guardrail 用同一种注册方式 |
| 分发 | 单二进制 < 30MB，冷启动 < 1s |

## 5. 竞品定位（摘要）

对标 Claude Code（TUI 形态）、Cline（权限交互）、OpenCode（单二进制/Auto Compact）、OpenAI Agents SDK / Pydantic AI（控制面）。详细模块通用性见 [legacy/COMP-MAP.md](../../legacy/COMP-MAP.md)。

**Vessel 差异点**：面向无基础 + 应用形态（非框架）+ 极简 core + 单一扩展心智。

## 6. 非目标（继承自遗产）

不内置垂直业务 agent；不内置重型领域工具链（OCR/PDF/向量库/浏览器自动化）；不绑定具体 Provider/Model/价格；不把插件当 core 承诺。完整非目标清单见 [legacy/DESIGN-PRINCIPLES.md](../../legacy/DESIGN-PRINCIPLES.md)。
