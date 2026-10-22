---
adr: 90
title: 移除 workflow 插件与产品面
status: accepted
date: 2026-10-22
supersedes: [42]
related: [10, 36, 48, 58]
tags: [workflow, plugin, removal, breaking]
---

## ADR-090：移除 workflow 插件与产品面

- **上下文**：workflow 在 0.4 以插件形式实现（ADR-042），提供 YAML/JSON 定义、依赖调度、重试、持久化、resume/cancel 与 CLI/TUI/Web 控制面。0.18 起产品方向明确为 **agent / 成员能力是 workflow 的上位替代**：workflow 不再投入新功能，也不做兼容。继续保留会留下一条与 agent 能力并行、但无人维护的编排路径，并持续占用 RPC 方法表、配置 schema、测试与文档预算。

- **决策**：
  1. **删除整个 workflow 产品面**：`plugins/workflow/**`、服务端 `packages/serve` 的 workflow 引擎/方法/类型、`packages/config` 的 `workflow` 配置、`src` 的 CLI/装配、`packages/tui` 的命令/视图、`apps/web` 的页面/路由/状态/样式、示例与相关测试。
  2. **删除 5 个 canonical RPC 方法**：`workflow.list` / `workflow.get` / `workflow.start` / `workflow.resume` / `workflow.cancel`；canonical 方法数 45 → 40。删除 `workflow_*` 协议错误码。
  3. **不做兼容层**：不保留 `workflow.enabled` 开关、旧 CLI/TUI 入口、旧 Web 路由、`workflow_disabled` 返回或迁移工具。pre-1.0 允许 breaking；显式 `plugins: [workflow]` 配置将加载失败，属预期。
  4. **保留历史与 CI**：`.github/workflows/**` 是 CI，不动；ADR-010 / ADR-042 与 CHANGELOG 旧条目保留为历史，本 ADR 取代 ADR-042。
  5. **文档同步**：`AGENTS.md`、`README.md`、`docs/ARCHITECTURE.md`、`docs/operations/**`、`SECURITY.md` 的当前态描述删除 workflow；历史 ADR 不改写。
  6. **验证**：全仓 `git grep -i workflow` 只允许出现在 `.github/workflows`、历史 ADR/CHANGELOG、本 ADR 与工作计划/报告中；全量测试、typecheck、biome、Web build 与架构门禁通过。

- **备选**：
  - (a) 只冻结、不删除——死代码继续占方法表/配置/测试，且会诱使后续改动维护两套编排。
  - (b) 只删后端、保留 TUI/Web 入口——留下明确不可用的 UI，违反“不写半成品”。
  - (c) 保留兼容返回 `workflow_disabled`——pre-1.0 无外部承诺，兼容层只会延长死路径寿命。
  - (d) 把引擎改造成通用编排库保留——agent/成员能力已覆盖目标场景，保留即为第二套机制。

- **后果**：
  - 破坏性：`workflow.*` RPC、`workflow` 配置、CLI `vessel workflow`、TUI `/workflows`、Web workflow 页面全部消失；canonical 方法数变为 40。
  - 维护面收敛：插件目录、配置 schema、测试、文档与前端状态各少一条并行路径。
  - 历史可追溯：ADR-042 标记 superseded，正文保留；CHANGELOG 旧条目不改。
  - 替代方向：需要编排时使用 agent / 成员能力；若未来重新引入，必须新开 ADR，不复用旧插件。

- **关联**：ADR-010（MVP 延后 workflow）、ADR-042（workflow 引擎作为插件，被本 ADR 取代）、ADR-036（Gateway 协议）、ADR-048（统一 RPC 方法表）、ADR-058（ToolPipeline）；`plugins/workflow/**`、`packages/serve/src/workflow.ts`、`packages/serve/src/gateway/methods/workflow.ts`、`src/workflow-wiring.ts`、`src/workflow-command.ts`、`packages/tui/src/commands/workflows-command.ts`、`apps/web/src/domains/workflows/**`。
