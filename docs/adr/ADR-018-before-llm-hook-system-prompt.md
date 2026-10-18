---
adr: 18
title: BeforeLlm hook 注入消费--修复 loop 不消费 ctx.system_prompt 的 bug
status: accepted
date: null
related: [11, 17]
---

## ADR-018：BeforeLlm hook 注入消费--修复 loop 不消费 ctx.system_prompt 的 bug

- **上下文**：SPEC §4.7 规定 `Hook.run(ctx)` 返回 `HookContext | null`（`null = 拦截`）。ADR-011 确立 Skills 经 `BeforeLlm` 钩子注入 system prompt；memory-project 同机制注入 CLAUDE.md / 项目记忆。两个插件都往 `ctx.system_prompt` 写注入内容。但 `AgentRuntime.toolCallingLoop` 的 `runHooks` 忽略 hook 返回值，且 `BeforeLlm` 之后从不读 `ctx.system_prompt`--注入内容从未进入 LLM 请求。结果：AI 不会自动看到 Skills / CLAUDE.md，只能经工具（`list_skills`/`get_memory`）手动取。这是 loop 与 hook 契约不一致的 bug。
- **决策**：属 ADR-017(2b)「修复 loop 级 bug」，无需解冻。在 `toolCallingLoop` 的 `BeforeLlm` 前，用 `this.systemPrompt` 种子化 `ctx.system_prompt`（hook 链在此基础上 prepend 注入）；`BeforeLlm` 后，把 `ctx.system_prompt` 作为**本次请求**的 system 消息内容（替换已有 system 消息，或无则前置一条）。**不改动 `ContextManager` 持久化的消息**--注入只影响单次 LLM 请求，session 持久化保持干净。
- **未涉及**：(1) `runHooks` 的返回值 `null = 拦截` 语义仍未实现（无插件使用，属单独 concern，本 ADR 不处理）。(2) hook `priority` 字段仍未排序--注入顺序按注册序，非 priority（`applyGuardrails` 同样未排 priority，统一留待另议）。
- **后果**：skills-loader 与 memory-project 的自动注入生效；AI 第一轮即带 Skills / CLAUDE.md 上下文。ContextManager 不被 hook 污染（持久化干净、可 replay）。限制：注入顺序非 priority；hook 拦截未实现。二者均不影响当前功能，后续按需另立 ADR。
- **关联**：ADR-017(2b)、ADR-011；[SPEC.md §4.7](SPEC.md)。
- **更新**：hook/guardrail priority 排序已在 `plugin-host.ts` 的 `registerHook`/`registerGuardrail` 中实现（按 priority 升序插入）。
