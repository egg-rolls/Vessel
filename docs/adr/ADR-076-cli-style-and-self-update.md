---
adr: 76
title: CLI 暗金样式与按安装形态自更新
status: accepted
date: 2026-10-20
related: [6, 60, 69, 71, 74]
tags: [cli, ui, style, update, distribution, ansi]
---

## ADR-076：CLI 暗金样式与按安装形态自更新

- **上下文**：0.12 的一次性命令数量已经很多（gateway、config、tenant、trace、update 等），但输出格式各自拼接，标题、状态与错误没有统一视觉；在 TTY 下缺少可读的层级。另一方面，`vessel update` 长期只做 `--check`，用户仍需自己复制升级命令；但 Vessel 没有独立二进制（ADR-006），不同安装形态（npm 全局、bun 全局、源码）的可执行更新动作完全不同，盲目自替换会改坏源码工作区。

- **决策**：
  1. **新增 `src/ui-style.ts` 作为一次性命令的唯一样式入口**：提供暗金主色 / 亮色、标题、分组、状态前缀（`✓ ! ✗ ·`）、分隔线、`label value` 对齐与 CJK 显示宽度。颜色与 TUI theme 的 brand 对齐。
  2. **ANSI 只在人类可读输出中启用**：stdout 为 TTY、`NO_COLOR` 未设置（任意值含空串都算设置）、`TERM !== 'dumb'` 三者同时满足才输出 ANSI；否则所有方法返回原文。`--json` 与表格数据行保持纯文本；路径、命令名、错误码不额外上色。
  3. **覆盖范围**：全部一次性命令的人类可读输出（包括 gateway、update、config、tenant、trace、workflow、eval、plugin、doctor、demo 等），不改变命令结果语义与退出码；TUI 不经过该模块。
  4. **`vessel update` 按安装形态自更新**：检测入口路径属于 npm 全局、bun 全局、源码 / 开发模式或未知；npm 执行 `npm i -g vessel-agent@latest`，bun 执行 `bun add -g vessel-agent@latest`，源码 / 未知只提示 `git pull && bun install` 且不修改工作区。`VESSEL_INSTALL_FORM` 可显式覆盖检测结果（仅供 CI / 非常规布局）。
  5. **交互与安全**：默认先确认；`--yes` 跳过；非 TTY 且无 `--yes` 直接失败。安装命令失败返回 1，并把最后 4 KiB 输出写进 `--json` 结果；成功后提示重启当前进程。`--check`、通道选择与清单检查行为不变，`--json` 结果补充安装形态、执行命令与退出码。

- **备选**：(a) 用第三方 CLI 样式库（chalk / ora）——增加依赖，且一次性命令只需要少量转义；(b) 无条件输出 ANSI——重定向与 CI 日志会被转义污染；(c) 对所有输出（含 `--json`）统一上色——破坏机器可读性；(d) `update` 无条件执行全局安装——源码用户会被意外改写，且无法确认安装来源；(e) 下载并替换二进制——ADR-006 明确不做独立二进制。均不取。

- **后果**：一次性命令的视觉一致，且颜色是可选的装饰层：管道、`--json`、`NO_COLOR=1` 下输出与 0.11 一样是纯文本。新增命令应使用 `ui`，不得自行拼接 ANSI。自更新的安全边界是“只更新用户显式安装的全局包”；源码模式永远只提示。非 TTY 自动化必须传 `--yes`，避免脚本意外执行安装。0.12.0 仍不发布，因此自更新只在安装形态为 npm / bun 全局时才有实际意义。

- **关联**：ADR-006（无独立二进制）、ADR-060（CLI 命令注册表）、ADR-069（诊断走 stderr）、ADR-071（根包 `vessel-agent` 与发布形态）、ADR-074（gateway 命令输出）；`src/ui-style.ts`、`src/cli-update.ts`、`src/update/install-detect.ts`、`src/commands/registry.ts`。
