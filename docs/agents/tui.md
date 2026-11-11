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
- 帮助按位置解析：`vessel <cmd...> -h` / `vessel help <cmd...>` / `vessel <group> help` 只打印该命令的用法，无参数 `-h` 才是全局总览。用法与 flag 说明的唯一来源是 `src/cli-help-spec.ts`（渲染与 argv 解析在 `src/cli-help.ts`），**同时**喂命令页与用法错误末尾的 `Try 'vessel ... --help'`；改 flag 时改那张表，不要回到 `cli.ts` 手写 help 文案。`<group> help` 词形只对纯分组生效（位置参数里的 `help` 不被吞）。
- 人类输出用 `src/ui-style.ts` 的 `ui`；ANSI 只在 TTY、未设 `NO_COLOR`、`TERM !== 'dumb'` 时输出；`--json`、路径与数据行保持纯文本（ADR-076）。
- 启动横幅只在人类终端画 box（`wantsBoxBanner`：stdout 是 TTY 且允许 ANSI 且非 `--json`）；管道 / 重定向 / daemon 与平台 spawn 的子进程（stdout 指向 `<dataDir>/logs/*.log`）降级成一行 `Vessel Gateway <version> · <url>`，框线不进日志文件。
- 新一次性 CLI 子命令进 `src/commands/registry.ts` 的 `cliCommands`，不要在 `cli.ts` 加 `if` 链（ADR-060）；同时在 `src/completion-spec.ts`（补全）与 `src/cli-help-spec.ts`（帮助）各加一条。

## ask_user 入口

- 只在交互 REPL（TTY）注册；`--run` / headless / 管道不注册。
- `ui.askUser: false` 必须能按入口关闭；gateway / serve 的注册见 [serve.md](serve.md)。

## 指针

- [assembly.md](../architecture/assembly.md) · [gateway-web.md](../architecture/gateway-web.md) · [CONFIG.md](../operations/CONFIG.md)。
