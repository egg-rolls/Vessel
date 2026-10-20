---
adr: 78
title: TUI 双状态栏、路径溢出与显隐持久化
status: accepted
date: 2026-10-20
related: [22, 61, 72]
tags: [tui, status-bar, layout, marquee, config, persistence]
---

## ADR-078：TUI 双状态栏、路径溢出与显隐持久化

- **上下文**：0.12 的上栏是一行固定信息，既承担模型 / context / 时长，又塞入会话计数与 cwd。问题有三：一是 `N sess` 依赖每帧 `session.list()`，会话状态变化后容易陈旧，且增加 I/O；二是长路径直接截断，CJK / emoji 会被切半个字符，branch 也会被挤掉；三是运行态（权限档位、bash / 子 agent 计数、session 入口、tenant、queue）没有稳定位置，只能散落在 hint 或历史里。终端宽度和高度差异很大，固定字段会互相挤压。

- **决策**：
  1. **上栏只放运行上下文**：模型、context 用量（含进度条 / 百分比，按宽度分级）、时长、压缩次数、路径 + branch。删除 `N sess` 与会话列表查询；session 入口移到下栏。
  2. **路径溢出分两级**：先中间省略（保留根 `D:\` / `/` / `~/` 与末两级目录，中间单格 `…`）；仍是空闲状态且路径自身溢出时，用 marquee 窗口滚动，`MARQUEE_TICK_MS = 140`、`MARQUEE_PAUSE_MS = 1200`，首尾停留后往返。branch 固定最右，自身超过 24 格才尾部截断。所有宽度按终端显示列计算（`displayWidth` / `truncateToWidth`），宽字符跨窗口边界时整字跳过。
  3. **新增运行态下栏 `BottomBar`**：与上栏同为 `PanelFrame`、同宽（`viewWidth(columns)`），单行分段 `perm` / `bash` / `sub` / `session` / `tenant` / `queue`。宽度分级：`<40` 列整栏不渲染；`40–59` 只显示 perm / bash / sub；`60–99` 增加 session；`>=100` 增加 tenant / queue。空间不足按 `tenant → queue → session → sub → auto` 从右到左丢弃，perm / bash 不丢；仍超宽时先去掉 auto 计数，最后才截断文本。
  4. **下栏吸收 hint 行**：下栏显示时底部快捷键提示并入 `PanelFrame`（`BottomBar` 的 hints），行预算为 `BOTTOM_BAR_ROWS = 3` 且 `hintRows = 0`，相对旧布局净增 2 行。独占 overlay 打开时下栏隐藏；终端 `<40` 列时按未渲染计入预算，避免白扣行。
  5. **自动显隐与持久化**：下栏默认在 `rows >= 18` 且非 minimal / hidden 模式时显示，上栏默认显示。`Ctrl+T` 切换上栏、`Ctrl+G` 切换下栏、`Ctrl+R` 打开 `/resume` picker；切换立即生效并写回用户配置 `ui.status_bars`（YAML），经注入的 `ctx.settings.setStatusBars` 原子写、`0600`、保留其它键。写回失败不回滚本次会话显示。
  6. **配置与初始覆盖**：`ui.statusBars: top|bottom|both|none`（YAML `status_bars`），非法值由 validator 拒绝，不做静默回退；`VESSEL_STATUS_BARS` 提供本次进程的初始覆盖（兼容 `top,bottom` 写法），优先级 env > config > 自动规则。手动切换只改本次进程与用户 YAML，不改环境变量。
  7. **品牌色统一**：TUI `theme.brand` 与 CLI `src/ui-style.ts` 统一为 `#c2a273`；CLI 亮色与主色同值，靠 `BOLD` 强调，避免两套暗金。

- **备选**：(a) 保留上栏会话计数并订阅会话变化——仍需额外查询，且与下栏 session 入口重复；(b) 路径始终尾部截断——看不到项目根与中间层级，branch 也容易被挤掉；(c) 用 CSS 式省略 + 鼠标 hover——终端不可用；(d) 下栏常驻所有字段、超宽自然换行——会破坏单行状态栏与行预算；(e) 只把显隐存在内存——用户每次启动都要重新切换；(f) 把显隐持久化到独立状态文件——现有用户配置已经承载 `ui.*`，再引入一份状态源会增加冲突面。

- **后果**：上栏不再产生会话列表 I/O，路径在任何宽度下都可读；运行态有固定一行，且字段丢弃顺序可预测。代价是下栏占用 3 行，`rows < 18` 时自动隐藏，用户可用 `Ctrl+G` 显式打开。状态栏显隐成为用户配置的一部分，`config set ui.statusBars` 与 TUI 热键写同一个键；`VESSEL_STATUS_BARS` 只影响启动初值，不是运行时开关。新增字段必须同时给出宽度分级与丢弃顺序，并更新 `packages/tui/__tests__/status-format.test.ts`。

- **关联**：ADR-022（spinner 状态显示）、ADR-061（TUI 展示层清洗 / resize）、ADR-072（全宽面板与 `PanelFrame` 行预算）；`packages/tui/src/repl/status-format.ts`、`packages/tui/src/components/StatusBar.tsx`、`packages/tui/src/components/BottomBar.tsx`、`packages/tui/src/repl/layout.ts`、`packages/tui/src/repl/ink-repl.tsx`、`packages/tui/src/utils/dialog.ts`、`packages/tui/src/components/InlineAutocomplete.tsx`、`src/ui-settings.ts`、`src/ui-style.ts`、`packages/config/src/validator.ts`。
