# Changelog

> 本文件是 O(1) 当前态：**只保留当前版本的变更摘要**。
> 所有历史版本在 [`docs/versions/`](docs/versions/INDEX.md) 中按版本一文件保存，
> 索引见 [`docs/versions/INDEX.md`](docs/versions/INDEX.md)，当前版本见
> [`docs/versions/CURRENT.md`](docs/versions/CURRENT.md)。
>
> 变更记录遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。
> 管理规则见 [`docs/DOC-MANAGEMENT.md`](docs/DOC-MANAGEMENT.md)。

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
