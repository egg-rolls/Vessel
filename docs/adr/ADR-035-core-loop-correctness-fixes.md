---
adr: 35
title: 0.1.0 core loop 级正确性修复
status: accepted
date: null
related: [12, 18, 27, 33, 34]
---

## ADR-035：0.1.0 core loop 级正确性修复

- **上下文**：0.1.0 审计发现 loop 与既有契约/文档不一致，均为 0 接口变更的缺陷修复：
  (1) 非法 tool arguments JSON 在 `tool.call.started` 处直接抛错，终止整个 run；
  (2) run 初始/失败保存只写单条 user 消息，覆盖既有历史；
  (3) 请求组装在上下文缺 system 时丢弃基底 systemPrompt，trim/compact 可能产生孤儿
      `role:tool` 或悬空 `assistant(tool_calls)`；
  (4) `updateRealTokens` 传入累计 token，多轮误触发 auto compact；
  (5) `GuardrailResult.replacement` 在类型与文档中存在，但 loop 只读 `allowed`。
- **决策**：按 ADR-012(2b)「修复 loop 级缺陷」逐项修复，不扩接口：
  1. tool arguments 只解析一次；失败发 `tool.call.failed` 并把 `Error: ...` 折回
     `role:tool`，不终止 run（与「工具失败不终止 run」一致）。
  2. 初始与失败状态都保存 `context.messages`；失败也不再覆盖历史。
  3. `buildRequestMessages` 在输出前归一化：补回缺失的 system；丢弃无对应调用的
     `role:tool`；不完整 tool_calls 轮次降级为普通 assistant 文本并丢弃部分结果。
     归一化只影响本次请求，不修改持久化上下文。
  4. `updateRealTokens` 改用本次请求的 `prompt_tokens + completion_tokens`。
  5. `replacement` 在 Input（改写持久化的用户消息）、Output（改写返回值与持久化
     assistant 消息）、ToolCall（改写实际执行的调用，先于 assistant 消息写入）、
     ToolResult（改写事件、上下文与返回值）四阶段生效；非法类型按未改写处理。
- **备选**：(a) 删除 `replacement` 字段——破坏接口且放弃脱敏能力；(b) 只在文档里
  标注未实现——与「文档只写已实现」冲突；(c) 在 Provider 层兜底非法消息——Provider
  无法区分孤儿工具消息与合法历史。均不取。
- **后果**：loop 输出给 Provider 的消息始终是合法序列；失败/中断会话可恢复；
  Input guardrail 可以真正脱敏；token 估算不再线性放大。代价：Input 被阻断的输入不再
  写入上下文；ToolCall guardrail 失败时 assistant 消息不落盘（更干净）。
  接口、事件名、依赖方向均不变；`ToolContext.signal` 不在本 ADR 范围（0.1.1 再议）。
- **关联**：ADR-012(2b)、ADR-018、ADR-027、ADR-033、ADR-034；`ARCHITECTURE.md`
  的 §3.2 / §4 / §5.7 需同步。
