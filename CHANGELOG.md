# Changelog

> 本文件是 O(1) 当前态：**只保留当前版本的变更摘要**。
> 所有历史版本在 [`docs/versions/`](docs/versions/INDEX.md) 中按版本一文件保存，
> 索引见 [`docs/versions/INDEX.md`](docs/versions/INDEX.md)，当前版本见
> [`docs/versions/CURRENT.md`](docs/versions/CURRENT.md)。
>
> 变更记录遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。
> 管理规则见 [`docs/DOC-MANAGEMENT.md`](docs/DOC-MANAGEMENT.md)。

## [0.27.0] - 2026-10-28

> 0.27.0（基于 0.26.2，未发布）：架构级重写——把三套并行执行事实收敛成一套统一
> agent/body 模型，并删除全部自动化测试。完整记录见
> [`docs/versions/0.27.0.md`](docs/versions/0.27.0.md)。未 tag、未 publish。

### Removed

- **三套并行执行事实**：`RunEngine`（serve run 账本）、`RuntimeHost` /
  `InProcessRuntimeHost`（core 执行壳）、owner/member 执行二分
  （`agent-owner-injection.ts` / `owner-runtime-facade.ts` / `runtime-factory.ts`）。
  同一件事不再有三套入口、串行语义与生命周期事件。
- **`agent.turn.*` / `agent.reply.posted` 事件**：`run.*` 是唯一执行生命周期。
- **全部自动化测试**：483 个文件 / 96,662 行，连同 17 个 `package.json` 的 `bun test`
  脚本与 CI 11 处调用。门禁改为 `typecheck` + `biome ci` + `scripts/check-*.ts` 静态断言，
  运行时正确性靠一条端到端烟测。
- **Team `default_principal` / `handoff_path` 字段**：改结构化 policy 控件。

### Added

- **统一 agent/body 模型**（ADR-097）：所有 agent（含 `main`）只经
  `AgentService.admit` 准入；`body_id ≡ session_id`，一个 agent 可多 body
  （≤ 20 live / 空闲 TTL 24h），同 body 串行、跨 body 并发；每 body 独立
  runtime / context / 历史 / runStore。
- **按段数寻址**：1 段本机 agent / 2 段本机 Team / 3 段跨节点；来源行是可回信的
  `<from location="principal@node:team" />`。
- **保留 principal 词典**：`human` / `system` 不能当成员名或 id。
- **Web Tailwind L1/L2/L3 分层** + L2 `components/ui` + zustand domain stores。
- **确定性 `docs-find` + `check-docs` 结构门禁**。

## [0.26.2] - 2026-10-24

> 0.26.2（基于 0.26.1，未发布）：补齐 Web 样式缺口。未 tag、未 publish。

### Fixed

- **`<select>` 原生浮层**：`option` 使用 `--surface-raised` / `--ink` 配色，
  暗色主题下下拉列表不再回到系统默认样式。
- **无 CSS 的 className**：审计出 25 个 TSX 使用但 CSS 未定义的类；
  补齐真实缺口（`ask-answer-required`、`attention-cell`、`attention-kind`、
  `diag-errors`、`display-setting-row`），删除 3 个已由 `ModalShell size` 取代的
  弹窗宽度类，其余 17 个确认为语义钩子并保留。
- **旧 token 失效**：`team.css` / `attention.css` 仍引用已删除的
  `--surface-2` / `--surface-3` / `--text` / `--text-list` / `--radius` /
  `--shadow` / `--accent-line`，浏览器会丢弃这些声明；统一替换为现行 tokens
  （`--hover-tint` / `--surface-sunken` / `--text-sm` / `--radius-md` /
  `--elev-2` / `--line-strong` / `--ink`）。

### Not building

- 不做视觉重设计；不改组件结构。
