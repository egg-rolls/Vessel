---
title: Web 控制台约定
kind: advisory
triggers: [web, apps/web, i18n, locale, sessionStorage, permission card, ask_user, teams]
paths: [apps/web/**]
applies_to: [N, M]
---

# Web 控制台约定

> 改 `apps/web/**` 前读这一篇；权限硬规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## 文案与本地化

- 新增文案同时进 `apps/web/src/i18n` 的 zh-CN 与 en 两份 catalog。
- locale 解析：`localStorage['vessel.ui.language'] > navigator.language`；未收录 key 回退中文，但不得当成“已本地化”。

## 数据与交互

- Team 写操作只经 canonical `teams.*`；成员 add / remove 走 CLI / owner 端点，Web 不直接改 roster。
- token 只存 `sessionStorage`，不落 `localStorage` / URL / 日志。
- 权限 / `ask_user` 卡片内联在所属 `RunCard`，不得恢复全局遮罩；其他端应答 / 过期 / run 终态必须收起卡片。
- 不用 `backdrop-filter` 做层级；层级靠边框与阴影表达（ADR-072/082）。

## 指针

- [gateway-web.md](../architecture/gateway-web.md) · [WEB-UI.md](../WEB-UI.md) · [CONFIG.md](../operations/CONFIG.md)。
