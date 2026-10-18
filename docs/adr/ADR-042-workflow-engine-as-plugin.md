---
adr: 42
title: workflow 引擎作为插件
status: accepted
date: null
related: [10, 12, 30, 34, 37, 39, 40]
---

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
