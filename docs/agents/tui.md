---
title: TUI 与 CLI 终端面约定
kind: advisory
triggers: [tui, cli, repl, terminal, i18n, sanitize, ansi, command, help, ask_user]
paths: [packages/tui/**, src/i18n/**, src/ui-style.ts, src/commands/**, src/cli.ts]
applies_to: [N, M]
---

# TUI 与 CLI 终端面约定

> 改 `packages/tui/**`、`src/i18n/**`、`src/ui-style.ts`、`src/commands/**` 前读这一篇；硬安全规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## TUI

- 渲染工具 / 命令文本前用 `sanitizeTerminalText()`；列表 key 用 `lineKey(index)`，不要用文本内容或累计偏移（ADR-061）。
- 用户可见文案一律 `t(key, params?)`，并同时加 zh-CN / en 两份 catalog；中文字面量不得直接作 UI 文案；技术词、命令名、工具名、错误码不翻译。
- 写用户配置只经注入的 `setLanguage` / `ctx.settings`（`0600` 原子写）；`VESSEL_LANG` 仍高于 `config.ui.language`（ADR-062/072）。

## CLI

- `--help` / 一次性命令错误 / 默认空状态 / demo banner 走 `src/i18n/` 双 catalog；命令的数据输出保持英文。
- 人类输出用 `src/ui-style.ts` 的 `ui`；ANSI 只在 TTY、未设 `NO_COLOR`、`TERM !== 'dumb'` 时输出；`--json`、路径与数据行保持纯文本（ADR-076）。
- 新一次性 CLI 子命令进 `src/commands/registry.ts` 的 `cliCommands`，不要在 `cli.ts` 加 `if` 链（ADR-060）。

## ask_user 入口

- 只在交互 REPL（TTY）注册；`--run` / headless / 管道不注册。
- `ui.askUser: false` 必须能按入口与 tenant 关闭；gateway / serve 的注册见 [serve.md](serve.md)。

## 指针

- [assembly.md](../architecture/assembly.md) · [gateway-web.md](../architecture/gateway-web.md) · [CONFIG.md](../operations/CONFIG.md)。
