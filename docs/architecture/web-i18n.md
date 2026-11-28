---
title: Web i18n（locale 解析与翻译机制）
kind: current
triggers: [i18n, locale, 语言, 本地化, 翻译, t, hasMessage, useLocale, setLocale, zh-CN, en, catalog, 文案, language]
paths: [apps/web/src/i18n/**]
---

# Web i18n（`apps/web/src/i18n`）

> 轻量 i18n：无依赖、无 RPC，两份 catalog（`messages/zh-CN.ts` / `messages/en.ts`）。本叶是 **locale 与翻译机制**的事实家；「新增文案双 catalog 同进 + 评审对账」的约定在 [agents/web.md](../agents/web.md)；插件文案（`pluginT`）归插件域（见 [plugins.md](plugins.md) / [WEB-UI.md](../WEB-UI.md)）。

## locale 解析与切换（`i18n/index.ts`）

- `Locale = 'zh-CN' | 'en'`；存储键 `LOCALE_STORAGE_KEY = 'vessel.ui.language'`（localStorage）；缺省 `DEFAULT_LOCALE = 'zh-CN'`。
- `parseLocale`：只接受受支持标签——`en` / `en-*` / `en_*` → en，`zh` / `zh-*` / `zh_*` → zh-CN，其余 null。
- `resolveLocale`（纯函数）：stored 优先，其次 `navigator.language`，非法 / 缺失回退 zh-CN。`getLocale` 首次调用才 detect（懒初始化）。
- `setLocale`：只接受两个受支持值；持久化 best-effort（隐私模式 / 配额满仍在本会话生效）；同步 `<html lang>`（用结构化最小形状访问 document，不依赖 DOM lib——根 tsconfig 的 typecheck 也编译本文件）；值变化才通知订阅者。
- `subscribeLocale` + `useLocale`（`useSyncExternalStore`）：locale 变化触发所在组件重渲染。
- `ui.language` 同时是服务端配置键（agent 侧也消费）：设置写成功后同步 `setLocale`（写路径见 [WEB-UI.md](../WEB-UI.md)「写路径」）。

## 翻译（`t` / `hasMessage`）

- `t(key, params)`：当前 locale catalog → zh-CN 回退 → key 本身；`{name}` 插值（undefined 参数保留原占位）；**永不抛错**。未收录 key 回退中文不等于「已本地化」（约定见 agents/web.md）。
- `hasMessage(key)`：键在当前 locale 或回退目录中存在与否——可选描述行的渲染判定（如设置项 desc 缺失不渲染描述行）。