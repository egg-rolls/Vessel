---
adr: 62
title: TUI 本地化（catalog + t() + locale 解析）
status: accepted
date: 2026-10-20
related: [21, 61]
tags: [tui, i18n, locale, catalog]
---

## ADR-062：TUI 本地化（catalog + t() + locale 解析）

- **上下文**：0.8.4 之前，TUI 的用户可见文案直接写在组件与命令实现里：启动头、状态栏、确认 / 提问弹窗、错误提示与帮助文本中英文混排，既不一致，也没有任何语言入口。用户只能接受固定文案；新增文案靠复制粘贴，key 与参数无法统一。0.8.5 需要在不改变默认输出、不引入运行时依赖的前提下，把文案集中管理，并提供可预测的 locale 选择。

- **决策**：
  1. **catalog 随源码分发**。新增 `packages/tui/src/i18n/`：`messages/zh-CN.ts` 与 `messages/en.ts` 是普通 TypeScript 对象，key 为 `<域>.<项>`（如 `startup.summary.model`、`askUser.confirm`）。zh-CN 是默认语言，取值必须与 0.8.4 的可见文案逐字一致；en 与 zh-CN 的 key 集合必须相同（271 个 key）。不引入 i18n 运行时库，不做按需加载，不增加打包步骤。
  2. **查表统一走 `t()`**。`t(key, params?)` 只在当前 catalog 中查表，不做语法解析；`{name}` 风格插值，缺失参数保留原文。缺失 key 先回退 zh-CN，再回退 key 本身——不抛错、不打印告警，避免翻译滞后把 UI 弄崩。
  3. **locale 只解析一次**。`resolveLocale({ env, configLanguage? })` 优先级固定 `VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN`；每层做归一化：`zh` / `zh-*` / `zh_*`（可带 `.UTF-8`）→ `zh-CN`，`en` / `en-*` → `en`，无法识别的值跳过该层而不是报错。REPL 在 `startInkRepl` 启动时调用一次 `setLocale()`；`setLocale` / `getLocale` 维护进程级当前 locale，运行中不切换。wizard 没有 `ReplContext`，只按环境变量解析（`VESSEL_LANG` / `LANG` / `LC_ALL`）。
  4. **明确不翻译的范围**。技术词、命令名（`/help`、`/config`）、工具名、错误码（`session_corrupt` 等）、模型与 provider 名称不翻译；命令的数据输出（会话列表、trace、metrics、成本等）保持英文。`t()` 只覆盖 UI chrome（启动头、状态栏、弹窗、帮助）与交互提示。
  5. **配置入口最小化**。`packages/config` 的 `VesselConfig` 增加可选 `ui.language: string`（`UiConfig`），validator 接受 `ui` / `ui.language` 为已知键；类型层不强制枚举，非法值由 `resolveLocale` 归一化 / 跳过，保证旧配置与新增非法值都安全。

- **备选**：(a) 引入成熟 i18n 运行时（ICU MessageFormat / i18next）——增加依赖、消息语法与打包体积，而当前文案只需简单插值；(b) 只用环境变量、不提供 `config.ui.language`——配置无法随仓库 / 租户保存，用户每次都要设 env；(c) 不做本地化、只统一中文——无法满足英文用户，且文案仍散落；(d) 运行时切换语言——Ink 已归档的 `<Static>` 历史不会重绘，切换后新旧语言混杂，需要清屏或重建历史；(e) 首次请求时懒加载 catalog——在 Bun 单进程 CLI 中没有收益，反而引入异步查表。均不取。

- **后果**：默认（zh-CN）输出与 0.8.4 逐字一致，升级无可见变化；en 用户可通过 `VESSEL_LANG=en` 或 `ui.language: en` 获得英文 UI。代价是文案必须同时改两份 catalog——只加 zh-CN 会静默回退，测试只校验 key 集合一致、不保证翻译质量；命令数据输出仍是英文，中英混杂仍可能出现在 `en` 模式的数据区；locale 在进程内固定，改配置需重启；wizard 与 REPL 的 locale 来源不同（wizard 仅 env）。

- **关联**：ADR-021（工具显示接口在 TUI 层定义）、ADR-061（TUI 展示层修复）；`packages/tui/src/i18n/index.ts`、`packages/tui/src/i18n/messages/{zh-CN,en}.ts`、`packages/tui/src/repl/ink-repl.tsx`、`packages/tui/src/wizard/setup-wizard.ts`、`packages/config/src/types.ts`。
