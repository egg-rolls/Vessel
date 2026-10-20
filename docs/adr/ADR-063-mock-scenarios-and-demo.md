---
adr: 63
title: mock 场景 provider 与 vessel demo
status: accepted
date: 2026-10-20
related: [12, 60]
tags: [mock, demo, cli, testing]
---

## ADR-063：mock 场景 provider 与 `vessel demo`

- **上下文**：0.8.5 之前，`VESSEL_MOCK=1` 只把 provider 换成 core 的 `MemoryLLMProvider`，行为固定为 `Echo: <最后一条 user>`。它能验证对话、流式渲染与会话管理，但 CLI / headless 路径**永远走不到 `tool_calls`**：没有工具调用、没有权限确认、没有错误路径。README 把 mock 作为无需 Key 的第一步，实际却无法兑现「完整链路」的承诺。同时 core 的 `MemoryLLMProvider` 是公开导出并被 `--tools` 生产路径使用，不能删除或改造。

- **决策**：
  1. **场景 provider 放 app 层**。新增 `src/mock/scenarios.ts`，导出 `resolveMockScenario(raw)` 与 `createScenarioProvider(name)`；场景名为冻结契约 `echo` / `tools` / `permissions` / `error` / `multi-turn`。core 不出现「场景」概念，`MemoryLLMProvider` 与其公开导出保持不变。
  2. **默认行为冻结**。未设置 `VESSEL_MOCK_SCENARIO` 时仍用 `MemoryLLMProvider`；`echo` 场景的文本、usage 与流式分片与它逐字一致。升级 0.8.6 不改变任何既有 mock 测试与 CI 冒烟的输出。
  3. **选择方式只有环境变量**。`VESSEL_MOCK_SCENARIO` 只在 `src/cli.ts` 读取一次，经 bootstrap / tenant runtime factory 透传到 provider factory（沿用 0.8.1 单一 resolver 口径）；未知值回退 `echo` 并打印一行 stderr 警告。不新增 `--scenario` flag，不做场景 DSL。
  4. **`tools` / `permissions` 只跑无害命令**。首轮返回一次 `bash echo vessel-demo-ok` 的 tool_call，收到 tool 结果后以固定文本收尾；不写文件、不联网。两者共用实现，差别在于交互 REPL 下是否真的弹出权限确认。
  5. **`vessel demo` 是 CLI 模式，不是一次性命令**。它在 `src/cli.ts` 解析后走现有 bootstrap / REPL 路径，固定 mock + `tools`，忽略 `VESSEL_MOCK_SCENARIO`；数据目录隔离到 `<dataDir>/demo`，不读用户已有 session。非 TTY 打印提示并 exit 1；`--help` 可见。

- **备选**：(a) 删除 core 的 `MemoryLLMProvider`（D1）——它是公开导出且被 `--tools` 生产路径使用，破坏面大于收益；(b) 删除 `VESSEL_MOCK` 离线入口（D2）——会破坏 README 第一步、CI 六个冒烟步骤与 `--run hello` 门禁；(c) 把场景做成插件（G3）——需要在 provider 构造前完成 PluginHost 异步加载，`--run` / headless / `--tools` 的装配顺序都要改，复杂度不抵收益；(d) 把场景写进 core——违反 core 冻结与「core 不出现业务 / 测试场景概念」的边界；(e) 只扩文档、不改代码——CLI 路径仍然不可达 `tool_calls`。均不取。

- **后果**：默认 mock 行为与 0.8.5 逐字一致，既有测试、CI 冒烟与 `--tools` 生产路径不受影响；无 Key 用户可以真正看到工具调用、权限确认与错误路径。代价是场景逻辑留在 app 层，web / gateway 无法复用，evals 与 workflow 仍用各自固定的 mock 行为；`vessel demo` 依赖 TTY，非交互环境只能用 `VESSEL_MOCK=1 --run`；场景名一旦发布即为兼容契约，新增场景只能追加不能改名。发布形态不变：0.8.6 仍只做干跑，不 tag / publish / 合并 `main`。

- **关联**：ADR-012（core 稳定性与演化）、ADR-060（CLI 一次性命令注册表——`vessel demo` 因需进入 REPL 而不注册为一次性命令）；`src/mock/scenarios.ts`、`src/cli.ts`、`src/provider-factory.ts`、`src/tenant-runtime-factory.ts`、`src/__tests__/mock-scenarios.test.ts`。
