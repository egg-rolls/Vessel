---
adr: 72
title: UI 设置与终端观感（/settings、clearOnStart、全宽面板）
status: accepted
date: 2026-10-20
related: [5, 61, 62]
tags: [tui, i18n, settings, layout, terminal, web]
---

## ADR-072：UI 设置与终端观感（/settings、clearOnStart、全宽面板）

- **上下文**：0.8.5 的 TUI 本地化只在进程启动时解析一次 locale（`VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN`），用户想换语言只能退出、改配置 / 环境变量、再重启。终端外壳也有两类观感问题：0.8.4 把视图宽度上限设为 `VIEW_MAX_WIDTH = 160`，宽终端两侧留白；状态栏、启动头与会话摘要、队列预览各自画边框，行数预算（chrome / 状态栏）与真实渲染不一致，矮终端容易把输入行挤出屏幕。Web 控制台则完全没有本地化，中文用户与英文用户看到同一套中文壳层。

- **决策**：
  1. **TUI `/settings`**：新增 `/settings [language <zh-CN|en>]` 命令，不带参数时显示当前语言与用法。语言变更经装配层注入的 `ctx.settings.setLanguage(locale)` 持久化到用户配置 `ui.language`；成功后立即 `setLocale(locale)` 重渲染，无需重启。未注入 `ctx.settings` 的宿主（只读嵌入场景）显示只读提示；写入失败显示 `error.command.settings` 与格式化错误。locale 优先级本身不变，`VESSEL_LANG` 仍高于配置文件，因此设置命令不会覆盖显式环境变量。
  2. **`ui.clearOnStart?: boolean`**（默认 `true`）：TTY 进入 REPL 前写入 `\x1b[2J\x1b[H` 清可视区并把光标归位；显式 `false` 或非 TTY 时不清屏。只清可视区、不切换 alternate screen，保留终端滚动历史。
  3. **全宽面板**：删除 `VIEW_MAX_WIDTH = 160`；视图宽度统一由 `viewWidth(columns)` 计算为 `cols - VIEW_HORIZONTAL_MARGIN`（水平边距 2），宽终端不再人为留白。
  4. **统一边框与行数预算**：状态栏、启动头 + 会话摘要、队列预览改用单线 `PanelFrame`；状态栏固定 `STATUS_BAR_ROWS = 3`（上边框 + 1 行内容 + 下边框），minimal 数据行封顶 `MINIMAL_ROW_CAP = 3`，保证 14 / 15 行终端切换尺寸时容量不回落。
  5. **asm 侧写回**：`setUserLanguage(locale)` 原子写 `~/.vessel/config.yaml`（同目录临时文件 + rename，`0600`，保留其它键），新增 `vessel config set ui.language <zh-CN|en>`；本地 REPL 与 `--connect` 两处 `ReplContext` 都注入 `settings`。
  6. **Web 壳层 i18n**：`apps/web/src/i18n/` 提供 zh-CN / en 两份 catalog，覆盖导航、面包屑、Settings 六个 tab、Appearance 与通用按钮；locale 取 `localStorage['vessel.ui.language']` > `navigator.language`（`en*` → en，其余 → zh-CN）；Settings → Appearance 提供语言选择并立即重渲染；未收录 key 回退 zh-CN，再回退 key 本身。

- **备选**：(a) 只支持环境变量 / 配置文件切换——必须重启，不符合“设置”入口的预期；(b) 使用 alternate screen / 全屏 TUI——会丢失滚动历史，也让非 TUI 测试与管道输出复杂化；(c) 保留 `VIEW_MAX_WIDTH = 160`——宽终端长期浪费两侧空间，且与“面板即终端宽度”的视觉预期不符；(d) 让 `/settings` 直接写 config 文件（绕过装配层）——TUI 包不应承担用户配置文件 IO，且 `--connect` 场景要写本地文件而非远端；(e) 本轮做 Web 全量本地化——页面数量大、易与功能迭代冲突，先覆盖壳层与 Settings，未覆盖页回退中文。均不取。

- **后果**：语言可在 TUI 内切换并持久化；写配置失败有明确错误文案，不会静默。`VESSEL_LANG` 仍是最高优先级，设置命令在显式环境变量下“写入成功但当前显示不变”，文档需写清这一点。非 TTY / headless 不受 `clearOnStart` 影响。TUI 与 Web 的 locale 来源彼此独立（前者 config / env，后者 `localStorage` / `navigator.language`），不共享状态。面板全宽后退化到窄终端时只受 `cols - 2` 约束，不再有 160 列上限。Web 只有壳层本地化，功能页文案仍可能回退中文，不能宣称“Web 已全量本地化”。

- **关联**：ADR-005（分层配置）、ADR-061（TUI 展示层与 resize）、ADR-062（TUI 本地化与 locale 解析）；`packages/tui/src/commands/settings-command.ts`、`packages/tui/src/repl/clear-on-start.ts`、`packages/tui/src/components/PanelFrame.tsx`、`packages/tui/src/views/layout.ts`、`src/ui-settings.ts`、`src/config-command.ts`、`apps/web/src/i18n/`。
