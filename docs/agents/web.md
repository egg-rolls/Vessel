---
title: Web 控制台约定
kind: advisory
triggers: [web, apps/web, i18n, locale, sessionStorage, permission card, ask, teams, 网页, 前端, 本地化, 会话存储, 权限卡, 团队, composer, 输入框, 卡片, 动画, motion]
paths: [apps/web/src/domains/chat/Composer.tsx, apps/web/src/domains/chat/ComposerChrome.tsx, apps/web/src/domains/chat/composer-controls.ts, apps/web/src/domains/chat/PromptSlots.tsx, apps/web/src/domains/chat/StreamCard.tsx, apps/web/src/domains/team/TeamComposer.tsx, apps/web/src/i18n/messages/**, apps/web/src/styles/motion.css, apps/web/src/state/event-visibility.ts, packages/plugin-ui/src/ComposerAttachments.tsx, packages/plugin-ui/src/ComposerContextMeter.tsx, packages/plugin-ui/src/ComposerToolbar.tsx]
applies_to: [N, M]
---

# Web 控制台约定

> 改 `apps/web` UI 前读这一篇；权限硬规则仍以 [AGENTS.md](../../AGENTS.md) 为准。本文只留跨域 UI 约定，事实各归其家：网关客户端 / state / 权限桥 → [gateway-web.md](../architecture/gateway-web.md)；渲染链 → [web-chat-render.md](../architecture/web-chat-render.md)；块协议 → [blocks.md](../architecture/blocks.md)；agents/team UI → [web-team-ui.md](../architecture/web-team-ui.md)；stores → [web-stores.md](../architecture/web-stores.md)；i18n 机制 → [web-i18n.md](../architecture/web-i18n.md)；组件 / 样式 / 排序 / 动画细则 → [WEB-UI.md](../WEB-UI.md) 与 [DESIGN.md](../DESIGN.md)。

## 文案与本地化

- 新增文案同时进 `apps/web/src/i18n/messages` 的 zh-CN 与 en 两份 catalog，且源码真的用到；「catalog 有、源码零引用」的孤儿 key 顺手清，删 key 需 1 裁决。一致性靠评审核对（原 `check-i18n` 脚本已按宪法删除）。locale 解析与 `t` 回退机制见 web-i18n.md。

## 数据与交互

- Team 写操作只经 canonical `teams.*`；成员 add / remove 走 CLI / owner 端点，Web 不直接改 roster。
- token 只存 `sessionStorage`，不落 `localStorage` / URL / 日志；一次性引导码、平台 / node 分槽与连接顺序见 [gateway-web.md#client](../architecture/gateway-web.md#client)。
- 权限 / `ask` 卡片在 **Composer 槽位**（`domains/chat/PromptSlots.tsx` 的 `PermissionCard` / `AskCard`）：pending 期间替换输入框，多条由 `pendingQueue` 排序列出；不得恢复全局遮罩，不挪进 `RunCard`，不做成时间线条目。数据源 `stores/interactionStore`（桥侧事实见 gateway-web.md），不经过时间线分组；其他端应答 / 过期 / run 终态必须收起卡片。
- 输入框三层结构：引用区（`ComposerAttachments`，受控 `refs` + `onRemoveRef`，空数组不占高）→ **字段容器**（`ComposerField`：textarea 与工具栏包成一块，容器出底色 `--surface-sunken` / 圆角 / 内衬 / `:focus-within` 焦点环，内层背景透明、不透第二种底色）→ 底部工具栏（`ComposerToolbar`：左插件扩展槽 / 宿主按钮，右上下文用量 + 发送键）。引用区只有**一套实现**（`ComposerChrome.tsx` 的 `ComposerRefsArea`）：会话页喂 `refsToAttachments(MessageRef[])`（id = path，删除回写下标，全路径进 title），团队页把 `@` 提及 chip 并进同一行；不另渲染 `MessageRefs`（那只用于已发消息气泡）。会话 `Composer.tsx` 与团队 `TeamComposer.tsx` 共用 `ComposerChrome.tsx`，不复制第二份样式。
- 上下文用量是**比例圆环**（`ComposerContextMeter`）：弧长 = `used / max`；精确文案（一位小数比例 + 紧凑已用值，如 `59.0% / 590K`）只进应用内 `Tooltip` + `aria-label`；`max` 未知不画圆环、只显示紧凑已用值；用量未知（无 `context_used`）不渲染、不放占位假数。**会话标题右侧不显示任何用量文本**——一处用量只有一个入口，删了就别在别处补回来。`plugin-ui` 不写原生 `title`（会与宿主 tooltip 叠两份），悬浮层由宿主包；比例取整口径只有一份（`contextFraction` → `contextPercent` 整数给色阶 / 描边，`contextPercentText` 一位小数给文案）。
- 圆形图标控件（发送键、回形针）形状只有一份来源：`domains/chat/composer-controls.ts` 的 `composerIconControlClass` + primary / quiet 两个 tone 常量，不手写第二套 utility；静止 = 灰或主题色、hover = `enabled:hover:` 变色、禁用 = 灰底保留只换图标色。工具栏按钮（发送键、回形针、插件动作、思考强度菜单 pill）的悬浮说明统一走 `components/Tooltip.tsx` 共享 `Tooltip`（hover / focus 延时、portal 定位、Esc 关闭、`aria-describedby`），不用浏览器默认 `title`（默认 tooltip = 未复用信号）；plugin-ui 不 import 宿主组件，`ComposerToolbar` 经 additive `wrapAction` 由宿主注入共享 Tooltip，注入时内置 `title` 不再渲染。字段容器 hover 只有一条（`.composer-field:hover:not(:focus-within)` 把 1px 常驻透明边框转 `--line-strong`，**背景不变**，内衬每边减 1px 抵掉边框、总高不变）；不给 `.composer-input:hover` 补第二份。
- 时间线卡片只有 `StreamCard` 一张（卡头四槽 / children 决定展开，结构事实见 WEB-UI.md 与 web-chat-render.md）：环境信息卡（`EnvCard.tsx`）、「来自 agent X」卡与「待批答复」卡（`AskAnswerCard.tsx`）必须同一套样式与展开机制，不自造卡头，不给某张卡单独换色 / 色条。
- async `ask` 的答案**是**一条 user 消息（协议要求），但时间线渲染成「待批答复」卡而不是用户气泡：身份只看结构化 `Message.name === 'ask:answer'`（`domains/chat/ask-answer.ts`，与 `packages/agent` 的 `ASK_ANSWER_INPUT_NAME` 同一字面量，对账靠评审）；正文解析失败退回普通用户气泡——绝不吞正文。这类 ask 的 run 早已结束，卡片**不随 run 终态消失**（`interactionReducer` 的 `run-finished` 例外）。逐题可勾选 / 分批补答的服务端语义见 [tools.md#ask-sync-async](../architecture/tools.md#ask-sync-async)（事实家，此处不复制）。
- 事件可见性只有一张表（`state/event-visibility.ts` 的 `EVENT_TIERS`）：新增事件名**先登记**，并在 [event-visibility.md](../architecture/event-visibility.md) 的表写一行；登记与表的一致性靠评审核对（原 `check:event-visibility` 脚本已按宪法删除）。未登记类型按 `internal` 折叠成「未知事件类型 · 已折叠」notice，绝不落裸 JSON 卡；不在 `EventRow` / `StreamItems` / `run-detail` 另写可见性判断（三档语义的事实家是 event-visibility.md）。
- 所有 transient 提示 / banner / 交互摘要统一经 AppBar 中心 `MessageBar`；`ToastProvider` 只提供 API 不渲染，禁止新增 fixed toast / 浮层（WEB-UI.md 硬规则 7）。
- 不用 `backdrop-filter` 做层级；层级靠边框与阴影表达（ADR-072/082）。
- 动画只有一份基座（`styles/motion.css` 出现 / 大小变化 / 流式三族，token 在 `styles/tokens.css` 的 `--motion-*`），新组件只挂 class，不自己写 keyframes。入场判据会话页 `TranscriptWindow.tsx:useEnteringItems`、Team 页 `components/ui/useEnteringItemKeys.ts` 共用同一套，不各记一套「新项」；**折叠只看气泡有没有底色**（用户气泡 / 团队页 `.team-message-bubble` 折，助手正文与 agent 卡展开体不折）。细则见 WEB-UI.md。
- `plugins.catalog` 的 `declaredSurface` / `effectiveSurface` 是只读摘要（HTTP `id`/`method`/`path`，CLI `path`/`description`）；Marketplace 只展示两者差异，不据此写 config、不新增 RPC；外部插件授权提示指向 `config.yaml` 的 `expose`。

## 单公司与 node 选择

- 无 Tenants 页面 / tenant 切换入口：`#/tenants` 回落默认路由；页面不发送 `tenant_id`，不调用 `tenants.*`。
- 平台 token → `/platform/rpc` 选 node，node 连接走 `api_url`；平台 / node token 分槽，legacy `--serve` 同源回退保留（连接事实见 [gateway-web.md#client](../architecture/gateway-web.md#client)）。

## 指针

- [gateway-web.md](../architecture/gateway-web.md) · [web-chat-render.md](../architecture/web-chat-render.md) · [web-team-ui.md](../architecture/web-team-ui.md) · [web-stores.md](../architecture/web-stores.md) · [web-i18n.md](../architecture/web-i18n.md) · [WEB-UI.md](../WEB-UI.md) · [CONFIG.md](../operations/CONFIG.md)