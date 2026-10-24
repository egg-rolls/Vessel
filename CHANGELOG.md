# Changelog

> 本文件是 O(1) 当前态：**只保留当前版本的变更摘要**。
> 所有历史版本在 [`docs/versions/`](docs/versions/INDEX.md) 中按版本一文件保存，
> 索引见 [`docs/versions/INDEX.md`](docs/versions/INDEX.md)，当前版本见
> [`docs/versions/CURRENT.md`](docs/versions/CURRENT.md)。
>
> 变更记录遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。
> 管理规则见 [`docs/DOC-MANAGEMENT.md`](docs/DOC-MANAGEMENT.md)。

## [0.26.0] - 2026-10-24

> 0.26.0（基于 0.25.0，未发布）：owner 端点收敛到 canonical RPC；CI 升 Bun 1.4.4。
> 未 tag、未 publish。

### Added

- **canonical `agents.send` / `agents.dispatch` / `agents.rotate`**（54 → **57**）：
  批量契约，与输入同序、单条失败隔离；team-scoped token 逐条校验目标 team。
  `agents.create|update|close` 与它们的 handler 与传输无关，gateway 与 owner 端点共用。
- **principal additive `agent_id`**：owner transport 用合成 principal
  （`scope: admin` + owner agent id）表示发送者；gateway / team token 仍按 `human`。

### Changed

- **owner 端点只做 loopback transport**：按 canonical 方法表分发，删除自己的动作清单与
  结果映射；wire 方法名迁移为 `agents.*` / `teams.*`（pre-1.0，无别名），CLI 语法不变。
- **CI / release 的 Bun 升到 1.4.4**（B-011 mitigation）：两次 `workflow_dispatch`
  全矩阵 + 首次 main push 连续通过，含 Windows。
- CLI 的 mention 解析改用 `agents.list` + team 过滤（`team.roster` 不单独提升为方法）；
  `teams.budget` override 的 `via` 由 `cli` 改为 `api`（审计语义不变）。

### Fixed

- B-011 降为 mitigated（Bun 1.4.4；继续观察 main push 后关闭）。

### Not building

- rotate 的 Web UI；远程 agent 生命周期（spawn / close / rotate 的跨节点策略）。
