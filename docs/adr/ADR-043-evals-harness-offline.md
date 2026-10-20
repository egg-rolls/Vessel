---
adr: 43
title: evals harness（默认离线）
status: accepted
date: null
related: [30, 34, 37, 39]
---

## ADR-043：evals harness（默认离线）

- **上下文**：0.4 需要可复现、默认离线的 agent 评测基线，作为后续版本的回归门槛。评测是测试/质量工具，不是 runtime 能力；放进 core 会破坏能力准入。0.4 不允许加载自定义断言代码（安全边界）；真实 provider 必须显式联网。
- **决策**：
  1. **形态**：库 + 运行器 `plugins/evals/harness/`，包名 `@vessel/evals`；加入 `FACTORY_PLUGINS`（短名 `evals`）**仅为阻止被当作普通插件扫描**；不向 `PluginHost` 注册工具；由 asm CLI 直接调用库函数。工厂 `createEvalsPlugin()` 返回 `Plugin`（`install` no-op）+ runner（`runSuite` / `getLatest`）。
  2. **默认完全离线**：只使用脚本化 mock provider。真实 provider 需要 **`config.evals.allowNetwork === true` 且 CLI `--allow-network` 同时成立**；任一缺失 → `eval_network_required`，退出码 2；报告 `network: true`。`evals.allowNetwork: true` 单独不构成放行，CLI flag 单独也不构成放行。
  3. **Suite 格式**：YAML/JSON；`defaults.timeout_ms` / `tags` / `session: fresh|shared`；case 级 `timeout_ms` 覆盖 defaults；`mock.responses` 按序回放，耗尽返回空内容并记 `mock_exhausted` 警告（warning 不单独判失败，是否失败由断言决定）。additive 字段：`EvalCaseResult.warnings?: string[]`、`mock.responses[].tool_calls?: ToolCall[]`、`usage_under.value: { total_tokens?; prompt_tokens?; completion_tokens? }`（至少一个字段）。
  4. **断言白名单**（未知类型 = 配置错误，不执行任意代码）：`output_contains`、`output_matches`、`no_error`、`tool_called`、`tool_not_called`、`max_duration_ms`、`max_iterations`、`usage_under`。无 usage 时 `usage_under` 判 FAIL 并写明原因。
  5. **报告与写盘归属**：`EvalReport` / `EvalCaseResult` 按 DECISION-009 §5.2.3。**报告文件命名、写盘、latest 查找由 `@vessel/evals` 的 `report.ts` 负责**；asm 只传 `outDir` / `--out` 并处理 `--json` 的 stdout 输出，**不重复实现写盘**。默认文件名 `<suite>-<YYYYMMDDTHHmmssSSSZ>.json`（文件系统安全、可按名排序）；`--out` 覆盖时仍写完整 `EvalReport`。`findLatestReport` 以报告内 `finished_at` 倒序取第一条，损坏文件跳过；suite 只允许安全单段名，只读报告目录下的 `*.json`。`--filter` 未匹配的 case 记 `skipped` 并计入 `total`；skipped 只由 filter 或显式跳过产生。
  6. **退出码与错误**：0 = 全部 passed/skipped；1 = 存在 failed/error；2 = suite 解析/配置错误。`evals.enabled: false` → `eval_invalid`（消息注明 disabled），退出码 2；**不新增** `eval_disabled` 错误码。稳定错误：`eval_not_found` / `eval_invalid` / `eval_network_required`。
  7. **边界**：0.4 不做 LLM-as-judge、不做网络评测默认开启、不做任意断言插件、不做 eval 面板（gateway 只有 `GET /v1/evals/latest`）。
- **备选**：(a) 进 core——评测不是 runtime 能力；(b) 加载用户 JS 断言——安全边界不可控；(c) 只做在线评测——CI 不可复现且需要 Key；(d) LLM-as-judge——引入不确定性与额外 provider 依赖。均不取。
- **后果**：CI 可完全离线跑 eval 回归；断言面固定，扩展需要新版本。mock 回放不能覆盖真实模型行为；`--allow-network` 的结果不进入默认门禁。报告是 JSON 文件，不是 HTML 控制台。
- **关联**：ADR-030、ADR-034、ADR-037、ADR-039；DECISION-009 §5.2 / §5.7 / §9 / §11.2 / §11.4 / §12.1 / §13.2 / §13.4。
