---
adr: 58
title: 统一工具执行管道
status: accepted
date: 2026-10-19
related: [17, 26, 29, 33, 42, 54]
tags: [runtime, tools, permissions, workflow, delegate]
---

## ADR-058：统一工具执行管道

- **上下文**：0.8.1 以前，工具执行语义分散在三条路径：`AgentRuntime` 的 loop 自己编排 ToolCall guardrail、BeforeTool hook、权限、handler 超时与 ToolResult guardrail；workflow 的 `type: tool` 直接 `PluginHost.getTool().handler`（并自行做一次 `checkPermission`），绕过 guardrail / hook / timeout；delegate 子 runtime 固定 `{ default: 'allow' }`，父级的 `ask` / `autoApprove` 不会继承。结果是同一工具在不同入口的权限与观测行为不一致，workflow 与 delegate 成为权限/检查旁路。

- **决策**：
  1. **新增 core 管道**。`packages/core/src/runtime/tool-pipeline.ts` 导出 `createToolPipeline` / `createToolPipelineFor` / `ToolPipeline` / `ToolPipelineOptions` / 结果与阶段类型（根入口与 `@vessel/core/runtime` 同步导出）。阶段顺序固定为：`getTool` → ToolCall guardrail → BeforeTool hook → **permission（最终工具与参数）** → handler（timeout + `ctx.signal`）→ ToolResult guardrail → AfterTool hook（仅成功）。
  2. **权限判定在改写之后**。ToolCall guardrail 可改写工具名 / 参数，BeforeTool hook 可提供 `updatedInput`；管道在两者之后重新解析并查找工具，再对**最终**工具与参数执行 `permission.authorize()`，避免旧工具 / 旧参数被放行。参数改写导致 JSON 非法时直接失败，不执行 handler。
  3. **阶段可关闭**。`ToolPipelineStages` 允许调用方关闭已在外层处理的阶段（`toolCallGuardrail` / `beforeToolHook` / `afterToolHook` / `toolResultGuardrail`），默认全开。`AgentRuntime`（包括 delegate 子 runtime）关闭前三者（外层 loop 已处理），只复用 permission、handler 超时与 ToolResult guardrail；workflow 使用默认全开。
  4. **事件由调用方发布**。管道自身不发布 `tool.call.*`，避免与 runtime 的事件重复；workflow 注入 pipeline 后由引擎发布 `tool.call.started` / `completed` / `failed`（`run_id` 为 workflow run id，payload 含 `workflow_run_id` / `tool_call_id` / `tool_name`）。
  5. **两处新消费方**。`WorkflowEngineOptions.toolPipeline?`：注入时 `type: tool` 走管道（含 permission / hook / guardrail / handler 超时），未注入保留旧的直接 handler 路径（deprecated，仅兼容直接构造引擎的嵌入方）。`asm` 的 `createWorkflowFromConfig` 总是注入 `createToolPipelineFor({ pluginHost, events, permission, tenantId })`。
  6. **delegate 权限继承**。`DelegateTaskOptions.permission?`；子 runtime 使用父级 resolved 权限（`default` + `autoApprove`）而不是固定 `{ default: 'allow' }`。缺省仍为 `{ default: 'allow' }`（兼容）；`permissionMode: 'allow'` 继续显式覆盖（工具被 `withAutoAllow` 包装），`deny` 继续在注册前过滤工具，`bridge` 保留工具自带 `checkPermission`。
  7. **装配层单一口径**。`resolveRuntimePermission(config, headless)` 与 `buildDelegateTaskOptions()` 为纯函数；runtime / delegate / workflow 由 `tenant-runtime-factory` 传入同一份 permission。interactive 默认 `ask`（`ask_user` 始终 auto-approve），headless 默认 `allow`。
  8. **兼容性**：`AgentRuntime` 公开 API 不变；新增的是可选注入点与导出。未注入 `toolPipeline` 的 workflow 嵌入方保持旧行为（但该路径已标记 deprecated）。`PermissionPolicy` / `GuardrailRunner` / `HookRunner` 的语义与事件不变。

- **备选**：(a) 只把 workflow 改成调用 `AgentRuntime.run()`——会产生额外 LLM 轮次，且无法表达单工具步骤；(b) 复制一份 runtime 的工具执行代码到 workflow——继续双份语义，本次要消除的正是这种漂移；(c) 在 delegate 里硬编码父权限——无法覆盖 headless / tenant 差异，也绕开了配置层；(d) 让管道自己发 `tool.call.*`——runtime 已有事件，重复发布会让观测与 trace 出现双份。均不取。

- **后果**：所有入口的工具执行顺序与权限判定统一，workflow / delegate 不再绕过 guardrail、hook、超时与父级权限。代价是：workflow 的 `ask` 从“立即 `permission_denied`”变为走 `tool.permission.request`（120s 无应答则失败）；delegate 在交互模式下默认 `ask`，无 `checkPermission` 的工具不再静默放行；新增一个 core 内部模块（不是新扩展接口）。直接构造 workflow 引擎且不注入 pipeline 的第三方嵌入方仍走旧路径，需要自行迁移。

- **关联**：ADR-017（工具 timeout）、ADR-026（工具自描述 / `checkPermission`）、ADR-029（交互暂停事件流）、ADR-033（编排外推）、ADR-042（workflow 插件）、ADR-054（run 级状态与失败隔离）；`packages/core/src/runtime/tool-pipeline.ts`、`plugins/workflow/engine/src/engine.ts`、`plugins/tools/delegate-task/src/index.ts`、`src/workflow-wiring.ts`、`src/tenant-runtime-factory.ts`。
