# 路线图（ROADMAP）

> 分期交付与 MVP 边界。范围依据见 [PRD.md](PRD.md) §3 与 [legacy/COMP-MAP.md](../../legacy/COMP-MAP.md)；技术细节见 [SPEC.md](SPEC.md)。
> 原则：每期只做该期范围；延后项不提前实现（ADR-010）。
> 插件 backlog 与 Tier 分级见 [PLUGINS.md](PLUGINS.md)；下文分期标注对应 Tier。

## Phase 0 — 脚手架

- monorepo（bun workspaces）：`packages/{core,config,tui}`。
- `@vessel/core`：最小 tool-calling loop（构造函数仅核心项）+ provider 抽象 + in-memory context/events + PluginHost 骨架。
- `@vessel/config`：YAML 读取 + schema 校验 + 安全默认。
- `@vessel/tui`：Ink REPL 桩，能调 `core.run()` 打印结果。
- Bun 单二进制可出。
- CI：`.github/workflows/ci.yml` 跑 lint+typecheck+test+build，设为 GitHub required check（ADR-014）。
- **验收**：`bun test` 通过；单二进制能起 REPL；填 Key 后能完成一次"调一个内置工具"的对话。

## Phase 1 — MVP（见 PRD 成功指标；含 Tier 1 基础）

- **core**：provider 适配（≥1 个 OpenAI 兼容 + 1 个 Anthropic 兼容，作参考插件）、ToolRegistry、ContextManager（含 auto-compact）、Run/Session、EventStream（枚举化）、UsageLimits/TerminationPolicy、Guardrail 四阶段接口 + 1–2 个参考 guardrail、Hook 接口、SessionBackend（memory+file）、PluginHost。
- **tui**：流式渲染、slash 命令（`/help` `/tools` `/sessions` `/resume` `/new` `/history` `/config`）、工具执行前权限确认弹窗、首启配置向导（填 Key/选 provider）、Auto Compact 提示。
- **config**：`vessel.yaml` 全 schema；零配置起步；未知键报错。
- **插件示例**：1 个官方插件骨架（如 file-ops 工具集），证明 Plugin 机制。
- 发布流水线：GitHub Actions release（tag 触发，出 Bun 单二进制 + GitHub Release）；npm 发包：Phase 2。
- **验收**：无基础用户 ≤5 分钟跑通；弱基础用户 ≤20 行 YAML 定义带自定义工具的 agent；core 可独立嵌入无 UI 依赖；新增 tool/provider/hook/guardrail 走同一注册。

## Phase 2 — 增强

- 官方插件：memory（项目记忆 + 自动记忆）、MCP client（**真实现，不留 stub**）、Auto Compact 完整版、**skills-loader（Skill 第三轴，ADR-011）**。
- Tier 1 余项 + Tier 2 插件（web 搜索/抓取、RAG+embeddings、代码沙箱、浏览器、文档解析、trace/成本导出…）清单见 [PLUGINS.md](PLUGINS.md)。
- tui：会话管理、事件回放、trace 导出。
- provider 预设列表扩充。
- **验收**：跨会话记忆生效；MCP 工具可加载调用；回放可重现一次 run。

## Phase 3 — 按需能力（非承诺；Tier 3）

- workflow/DAG 编排、multi-agent/team、durable execution、evaluation harness。
- 各自独立插件包，不进 core。清单见 [PLUGINS.md](PLUGINS.md)。
- 上述均为插件 / TUI 层能力，无需改 core（见 [ADR-015](ADR.md) 与 [PLUGINS.md §九](PLUGINS.md)）。
- **前置条件**：Phase 1/2 稳定且有真实需求驱动；否则不做（避免 speculative generality）。

## 跨期红线（始终遵守）

- core 不注入插件对象（ADR-003）；统一扩展心智（ADR-004）；事件枚举化（ADR-008）；不留 stub；不绑厂商 Key/价格；core 不依赖 tui/config。完整红线见 [AGENTS.md §4 红线](../../AGENTS.md)。
