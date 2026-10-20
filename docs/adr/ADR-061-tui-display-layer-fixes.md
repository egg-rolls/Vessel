---
adr: 61
title: TUI 展示层修复（key / ANSI / Markdown / resize）
status: accepted
date: 2026-10-20
related: [21, 22]
tags: [tui, rendering, ansi, markdown, resize]
---

## ADR-061：TUI 展示层修复（key / ANSI / Markdown / resize）

- **上下文**：0.8.4 集中修复了四个可见问题。(1) 列表组件用“累计字符偏移”做 React key，连续空行或重复文本会产生相同 key，React 报 duplicate key 并错序复用节点。(2) 工具 / bash 输出里的 ANSI 颜色、OSC 标题、光标移动序列被 Ink 直接当作文本渲染，破坏行布局。(3) 流式阶段用 Markdown 渲染，完成后却把纯文本推进 `<Static>`，同一段回复在归档后回退成 Markdown 源码。(4) 宽度与高度只读 `useStdout()` 的一次性快照——它不订阅 resize——窗口变化后弹窗、面板与 live 行数不更新。

- **决策**：
  1. **key 只依赖位置**。`utils/text-layout.ts` 新增纯函数 `lineKey(index)`（`line-${index}`），`TextViewer` / `QuickHelp` / `QueuePreview` / `ToolTrail` 统一改用行下标做 key。内容可能为空或重复，任何基于文本内容或累计偏移的 key 都会碰撞。
  2. **ANSI 清洗是展示层纯函数**。新增 `packages/tui/src/utils/sanitize-terminal-text.ts` 的 `sanitizeTerminalText()`：去除 CSI（`ESC [` / C1 `0x9b`）、OSC（`ESC ]` / C1 `0x9d`，到 BEL 或 ST）、其它 ESC 序列、C0（保留 `\n` / `\t`）、DEL 与 C1；`\r\n` 与单独的 `\r` 归一为 `\n`。只在展示层调用（`TextViewer`、`ToolTrail`、`StreamOutput`、命令输出归档）；**core / 工具的原始返回值不变**，非 TUI 消费方（gateway、headless、web）仍拿到原始文本。
  3. **历史项带渲染方式**。TUI 归档从 `string[]` 改为 `HistoryItem[]`（`{ text, markdown? }`）；`appendHistory` / `appendHistoryLines` 接受 `markdown` 标志。流式完成与 Ctrl+O flush 归档时置 `markdown: true`，`<Static>` 用 `<MarkdownText>` 渲染；命令输出与用户输入仍按纯文本渲染（避免把命令输出里的 `*` / `#` 当成 Markdown）。
  4. **resize 用 `useWindowSize()` 订阅**。`ink-repl.tsx` 以 `useWindowSize()` 的 `columns` / `rows` 为准（回退 `useStdout()` 快照）；live 行数上限随终端高度增长，`MINIMAL_ROW_CAP = 5`，矮终端（`<15` 行）隐藏 live 并只提示一次；弹窗 / 面板宽度随窗口即时变化。`VIEW_MAX_WIDTH` 从 110 提到 160，宽屏保留可读性上限。
  5. **根布局不设固定 height**。固定 height 会让 Ink 判定为 fullscreen 并按帧 `clearTerminal`，在 Windows / PowerShell 下造成历史、流式输出与底栏互相覆盖；改为自然高度 + live 区 `maxHeight` 约束。
  6. **测试隔离**。新增纯函数测试（`sanitize-terminal-text.test.ts`、`text-layout.test.ts`、`repl-state.test.ts`、`layout.test.ts`）只在 `packages/tui` 内运行，不依赖 mock 模块状态。

- **备选**：(a) 在工具返回值里清洗 ANSI——会改变 gateway / headless / 插件拿到的数据，且丢失用户可能需要的原始输出；(b) 解析 ANSI 后用 Ink `<Text>` 颜色渲染——需要完整的终端状态机，且不符合“展示层只做安全文本”的定位；(c) 用文本内容做 key——重复行（连续空行、同一工具名）仍会碰撞；(d) 继续用 `useStdout()` 并手动监听 `process.stdout` 的 `resize`——重复实现 Ink 已有订阅，且拿不到行数；(e) 给根布局设固定 height 换取布局稳定——换来每帧清屏，问题更严重。均不取。

- **后果**：四个可见问题在展示层闭环，不触碰 core / 工具语义。代价是：带 ANSI 的原始输出在 TUI 中不再显示颜色；归档的 Markdown 项比纯文本更占内存与渲染成本；`sanitizeTerminalText()` 只做清洗、不做宽度重排，超长控制序列仍会短暂占用解析时间。Windows 真终端的 resize 行为仍需人工验证。

- **关联**：ADR-021（工具显示接口在 TUI 层定义）、ADR-022（spinner 状态显示）；`packages/tui/src/utils/sanitize-terminal-text.ts`、`packages/tui/src/utils/text-layout.ts`、`packages/tui/src/repl/use-repl-state.ts`、`packages/tui/src/repl/ink-repl.tsx`、`packages/tui/src/repl/layout.ts`、`packages/tui/src/views/layout.ts`、`packages/tui/src/components/{TextViewer,QuickHelp,QueuePreview,ToolTrail,StreamOutput}.tsx`。
