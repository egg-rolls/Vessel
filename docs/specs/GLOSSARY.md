# 术语表（GLOSSARY）

> 跨文档共享词汇。定义以本表为准，避免歧义。

| 术语 | 定义 |
|------|------|
| **Harness** | Agent 的"运行底座"：管运行/治理/观测/扩展，不决定具体业务。 |
| **Agent** | 一个有 system prompt + 工具集 + 模型配置的执行单元。 |
| **Runtime** | 执行 tool-calling loop 的核心对象（`AgentRuntime`）。 |
| **Run** | 一次 `run()` 调用，有 run_id，发一组事件，产出最终响应。 |
| **Session** | 跨多轮的会话，持有 context 历史；Run 在 Session 内执行。 |
| **Provider** | LLM 服务的抽象适配（OpenAI 兼容/Anthropic 等），是插件。 |
| **Tool** | Agent 可调用的能力，有 name/description/inputSchema/handler。 |
| **ToolCall** | LLM 返回的工具调用请求（name + arguments）。 |
| **Context** | 当前对话的消息历史 + token 预算管理。 |
| **RunEvent** | 运行中发出的结构化事件（枚举类型 + payload）。 |
| **EventStream** | 事件的发布/订阅通道；trace/replay/TUI 流式共用。 |
| **Guardrail** | 四阶段（Input/Output/ToolCall/ToolResult）的可插拔检查。 |
| **UsageLimits** | 请求/工具调用/token/成本硬上限。 |
| **TerminationPolicy** | 最大迭代/运行时长/无工具调用即停等终止条件。 |
| **Hook** | 生命周期钩子（BeforeLlm/AfterLlm/BeforeTool/AfterTool/OnError）。 |
| **Plugin** | 统一扩展单元，install 时向 PluginHost 注册 tool/provider/guardrail/hook。 |
| **PluginHost** | 插件注册宿主，runtime 持有。 |
| **Skill** | 行为 know-how 的可复用剧本（Markdown + 可选脚本）；由 skills-loader 插件承载，经 BeforeLlm 钩子注入、slash 命令触发。 |
| **元认知 Skill** | Agent 用于了解自身资产的 Skill（如何查询工具、节俭上下文、何时委派子 agent）。随 Vessel 分发，启动时自动加载。详见 PLUGINS §八。 |
| **TUI** | 终端交互界面（Terminal UI），Vessel 的主入口。 |
| **ACI** | Agent-Computer Interface 设计原则：动作空间精简、反馈即时、错误可恢复。 |
| **MCP** | Model Context Protocol，标准化工具/资源扩展协议；Vessel 中作插件。 |
| **Auto Compact** | 上下文达阈值时自动摘要历史，无缝续接。 |
| **core / config / tui** | 三层包：`@vessel/core`（运行时）/`@vessel/config`（声明式配置）/`@vessel/tui`（终端）。 |
| **内置 / 插件 / 应用层** | 能力分层：内置=core 必备；插件=可选扩展；应用层=TUI/向导/业务。 |
