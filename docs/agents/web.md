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
- 门禁 `bun run scripts/check-i18n.ts` 校验两份 catalog 对齐与引用落地；`--orphans`
  打印「catalog 有、源码零引用」的孤儿 key 报告（默认 warn，只报告；删 key 需 1 裁决）。

## 数据与交互

- Team 写操作只经 canonical `teams.*`；成员 add / remove 走 CLI / owner 端点，Web 不直接改 roster。
- token 只存 `sessionStorage`，不落 `localStorage` / URL / 日志。0.49：平台 token（`#token=` 种子）与 node token 分槽；平台连接走 `/platform/rpc`（`whoami` → `nodes.list` → `credentials`），node 连接走 `api_url`；不再调用 `/v1/local/token`。legacy `--serve` 页面回退同源 node 连接。平台客户端固定 `gateway/platform/**`、node 客户端固定 `gateway/node/**`，互不 import。
- 权限 / `ask_user` 卡片在 **Composer 槽位**（`domains/chat/PromptSlots.tsx` 的 `PermissionCard` / `AskCard`）：pending 期间替换输入框，多条由 `pendingQueue` 排序列出；不得恢复全局遮罩，也不要挪进 `RunCard` 或做成时间线条目。数据源是 `stores/interactionStore`（`gateway/connection-handlers.ts` 直接写入 + `interactions.list` hydration 补回），**不经过**时间线分组。其他端应答 / 过期 / run 终态必须收起卡片。
- 时间线卡片只有 `StreamCard` 一张：卡头 `title` / `meta` / `summary` / chevron 一个结构，
  `children` 的有无决定能不能展开（详见 [WEB-UI.md](../WEB-UI.md) 的「时间线只有一种卡」）。
  环境信息卡（`domains/chat/EnvCard.tsx`）、「来自 agent X」卡与「待批答复」卡
  （`domains/chat/AskAnswerCard.tsx`）必须同一套样式与展开机制，不要自造卡头，也不要给某张卡单独换色 / 色条。
- async `ask_user` 的答案**是**一条 user 消息（协议要求），但人是在待批页答的：时间线上渲染成
  「待批答复」卡而不是用户气泡。身份只看结构化的 `Message.name === 'ask:answer'`
  （`domains/chat/ask-answer.ts`，与 `packages/agent` 的 `ASK_ANSWER_INPUT_NAME` 同一字面量，
  `check-transcript-items` 对账），正文解析失败就退回普通用户气泡 —— 绝不吞正文。
  这类 ask 的 run 早已结束，卡片**不随 run 终态消失**（`interactionReducer` 的 `run-finished` 例外）。
- 所有 transient 提示 / banner / 交互摘要统一经 AppBar 中心 `MessageBar`；`ToastProvider`
  只提供 API，不渲染，禁止新增 fixed toast / 浮层（见 [WEB-UI.md](../WEB-UI.md) 硬规则 7）。
- 不用 `backdrop-filter` 做层级；层级靠边框与阴影表达（ADR-072/082）。
- 消息入场动画与长消息折叠只有一份实现（`components/ui/MessageFold.tsx` +
  `useEnteringItemKeys.ts`，class 在 `styles/domains/chat.css`），会话页与 Team 页共用同一套；
  不要给某一页复制第二份阈值、也不要各记一套「新项」。**折叠只看一件事：气泡有没有底色**
  （用户气泡 / 团队页 `.team-message-bubble` 折；助手正文与 agent 卡的展开体不折）。
  细节见 [WEB-UI.md](../WEB-UI.md)。
- `plugins.catalog` 的 `declaredSurface` / `effectiveSurface` 是只读摘要（HTTP `id`/`method`/`path`，CLI `path`/`description`）。Marketplace 只展示两者差异；不据此写 config、不新增 RPC；外部插件授权提示指向 `config.yaml` 的 `expose`。

## 单公司与 node 选择

- 0.49 T4/T5：Tenants 页面、导航 / palette / BottomNav 入口、AppBar tenant chip、tenant switch / reset 已删除；`#/tenants` 回落默认路由。页面不再发送 `tenant_id`，也不再调用 `tenants.*`。
- 平台 token → `/platform/rpc` 选 node（G3 `nodes.list` / `credentials`），node 连接走 `api_url`；平台 token 与 node token 分槽，legacy `--serve` 同源回退保留。

## 指针

- [gateway-web.md](../architecture/gateway-web.md) · [WEB-UI.md](../WEB-UI.md) · [CONFIG.md](../operations/CONFIG.md)。
