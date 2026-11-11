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
- 输入框卡片是三层结构：引用区（`ComposerAttachments`，受控 `refs` + `onRemoveRef`，空数组不占高）→ **字段容器**（`ComposerField`：把 textarea 与工具栏包成一块，容器出底色 `--surface-sunken` / 圆角 / 内衬 / `:focus-within` 焦点环，textarea 与工具栏背景透明、不透第二种底色）→ 底部工具栏（`ComposerToolbar`：左侧插件扩展槽 / 宿主按钮，右侧上下文用量 + 发送键）。引用区只有**一套实现**（`domains/chat/ComposerChrome.tsx` 的 `ComposerRefsArea`）：会话页喂 `refsToAttachments(MessageRef[])`（id = path，删除回写下标，全路径进 title），团队页再把 `@` 提及 chip 并进同一行；不要再另渲染 `MessageRefs`（那只用于已发消息气泡）。会话 `domains/chat/Composer.tsx` 与团队 `domains/team/TeamComposer.tsx` 共用 `domains/chat/ComposerChrome.tsx`，不要复制第二份样式。右侧上下文用量是**比例圆环**（`ComposerContextMeter`）：弧长 = `used / max`，精确数字（`59% / 592K of 1M`）只进 `title` + `aria-label`；`max` 未知时不画圆环、只显示紧凑已用值（`592K`）。用量未知（没有 `context_used`）时不渲染，不放占位假数。圆形图标控件（发送键、回形针）的形状只有一份来源：`domains/chat/composer-controls.ts` 的 `composerIconControlClass` + 两个 tone 常量（primary / quiet），不要再手写第二套 utility；静止 = 灰或主题色、hover = `enabled:hover:` 变色、禁用 = 灰底保留只换图标色。字段容器的 hover 只有一条（`.composer-field:hover:not(:focus-within)` 把 1px 常驻透明边框转 `--line-strong`，**背景不变**；内衬每边减 1px 抵掉边框，总高不变）：textarea 与工具栏都是透明背景，所以悬停文字 / 内衬 / 缝隙命中同一条规则，不要给 `.composer-input:hover` 再补第二份。
- 时间线卡片只有 `StreamCard` 一张：卡头 `title` / `meta` / `summary` / chevron 一个结构，
  `children` 的有无决定能不能展开（详见 [WEB-UI.md](../WEB-UI.md) 的「时间线只有一种卡」）。
  环境信息卡（`domains/chat/EnvCard.tsx`）、「来自 agent X」卡与「待批答复」卡
  （`domains/chat/AskAnswerCard.tsx`）必须同一套样式与展开机制，不要自造卡头，也不要给某张卡单独换色 / 色条。
- async `ask_user` 的答案**是**一条 user 消息（协议要求），但人是在待批页答的：时间线上渲染成
  「待批答复」卡而不是用户气泡。身份只看结构化的 `Message.name === 'ask:answer'`
  （`domains/chat/ask-answer.ts`，与 `packages/agent` 的 `ASK_ANSWER_INPUT_NAME` 同一字面量，
  `check-transcript-items` 对账），正文解析失败就退回普通用户气泡 —— 绝不吞正文。
  这类 ask 的 run 早已结束，卡片**不随 run 终态消失**（`interactionReducer` 的 `run-finished` 例外）。
  待批页「一起提交」的整批答案由 gateway 合并成**一条** user 消息（前缀里逗号分隔多个
  requestId），每行是 `header（原问题摘要）: 答案`；卡片把原问题印在答案上方，卡头摘要
  仍是第一题的 header（不因加长而变高）。
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
