# P1-B agent 级收件箱视图 — 设计审计（q-inbox-agent-view）

- 作者：q-inbox-agent-view（红蓝实施）
- 分支：`feat/q-inbox-agent-view`（基线 `redblue-dev` @ b1b3778a）
- 依据：用户裁定「我们的 inbox 都是 agent 级别的消息，不应该有会话级别的显示吧」；
  `docs/dev/plans/inbox-truth-source-audit.md` §3（症状②四因）+ §4 P1-B。
- 方法：源码逐链读证（RPC → 前端接线点），全部结论带 `file:line`。零探针零临时进程。

---

## 0. 方案裁定

**取方案①：新增 agent 级收件箱视图**（新路由域 `#/inbox?agent=<id>`，缺省 `main`），
读 `agents.inbox{agent_id}`（**不带 `session_id`**）⇒ 服务端返回该 agent 全量 unread
（held + unread，含无 `session_id` 的 wake/quiet 条目）。

**否方案②（把现有 PendingStrip 改成 agent 级口径）**，两条理由：

1. 条带的会话等值过滤是**设计内的防串台判据**，不是缺陷：agent 维度 inbox 里「父 agent
   发给子成员的消息」与「本会话的下一条输入」结构一模一样，只有 `session_id` 能区分
   （`pending-strip.ts:33-49` 头注、`PendingStrip.tsx:11-13` 第一条硬口径）。把条带改成
   agent 级 = 把别人的输入串进这条会话的 run-queue 提示，正是 0.53 换数据源时消灭的问题。
2. 红线「不破坏现有 run-queue 待处理功能」：条带回答「我这一轮还压着几条输入」
   （`PendingStrip.tsx:2-9`），它的写操作（收回编辑 / 取消 / 我已处理 / unhold）与
   客户端 pending 对账（P0-A 落点）都钉在会话口径上。

**两者关系（裁定）**：

| 表面 | 口径 | 回答的问题 | 数据 |
|---|---|---|---|
| PendingStrip（保留，不动） | 会话级 run-queue 提示 | 「我这一轮还压着几条输入」 | `agents.inbox{session_id}` |
| InboxView（新增） | **agent 级收件箱真相** | 「发给这个 agent 的全部消息」 | `agents.inbox{agent_id}` |

- 条带**不是**收件箱（它自己的头注与 `env-notice.ts:478-490` 都承认不覆盖 unread 消息）；
  收件箱真相视图**不做会话过滤**（用户裁定）。两者并存、各司其职。
- wake/quiet 无 `session_id` 条目：InboxView **可见**（标注「无归属」），条带仍不显示
  （设计如此，不改）。症状②(b)(c) 由新视图承接。
- 症状②(a)(d)（已被消费的消息两处都看不到 / 进 transcript 不进 inbox）属 **P1-A** 承接
  缺口，不在本单：本视图忠实还原「inbox 里现在有什么」，consumed 永不回
  （`inbox.ts:707-709`）是真相本身，不是视图缺陷。

## 1. 数据面（服务端零改动）

- `agents.inbox` handler（`packages/serve/src/gateway/methods/agents.ts:729-773`）：
  `agent_id` 与 `session_id` 二选一；只给 `agent_id` 时 `control.inbox(agentId, {...})`
  **不带 `sessionId`** ⇒ `inboxSnapshot` 的归属过滤短路
  （`service.ts:3760`：`sessionId === undefined || …`）⇒ 全量条目。
- `includeHeld` 缺省 true（`service.ts:3751`）：held（已排队）与 unread（留档）都回。
- `unread` / `pending` 计数本就是 **agent 维度**（过滤前，`service.ts:3775-3783`），
  直接作视图头部统计，无需前端再算。
- 正文 peek：`agents.inbox{agent_id, message_ids:[id]}` 只读（≤10 条，
  `agents.ts:697,760-766`；`findByIds` 不改状态，`service.ts:3753-3756`）。
- 写操作**复用现有 RPC**，与条带同一套来源分档（`PendingStrip.tsx:20-33`）：
  - human 源：`agents.recall`（真删 = 取消）/ `agents.claim`（我已处理，不可逆）；
  - 非 human 源且 held：`agents.recall`（unhold 留档，`canUnhold` 判据，
    `pending-strip.ts:114-116`）；
  - **不给「收回编辑」**：草稿槽在 chat 会话的 `useChatSubmit` 手里，本页没有草稿槽，
    放一颗点了没反应的键比没有更糟（`PendingStrip.tsx:375-380` 同款理由）。

## 2. 视图设计（InboxView）

- **路由**：`{ domain: 'inbox'; agentId?: string }`，hash `#/inbox?agent=<id>`；
  缺省 agent = `MAIN_AGENT_ID`（`main-session.ts:13`）。深链可分享（kanban 同款先例）。
- **agent 选择器**：`client.listAgents()`（`gateway/node/agents.ts:27-30`，useResource
  加载，epoch/手动刷新触发）；下拉选 agent，`?agent=` 优先。只列本节点 agent
  （`agents.inbox` 是本节点 control 面，`agents.ts:738-741` visibleAgents 同口径）。
- **列表**：复用条带纯函数 `orderPendingEntries`（held 在前、ts 升序，
  `pending-strip.ts:232-241`）——同一套「谁在等」的稳定排序，不假装能拖拽换序。
  每行：
  - 身份：复用 `pendingIdentityOf`（human/ask/bash/system 固定标签、`agent:<name>`、
    短 id 兜底，`pending-strip.ts:168-194`），i18n 文案与条带同一组 key；
  - 状态徽章：`held` = 排队中 / `unread` = 未读留档；
  - 摘要 + 时间（`formatTimestamp`）；
  - **归属标注（防串台，审计 §5 P1-B 风险项）**：有 `session_id` ⇒ 短会话 id +
    「去会话」链接（navigate chat）；缺省 ⇒ 「无归属（wake/quiet）」标签。
    agent 级视图天然含所有会话的条目，逐条标注归属，不误导「都是给我的」。
- **展开全文**：行可展开 → peek 正文（只读 RPC），本地按 message_id 缓存
  （正文不可变）；peek 失败如实报错，不本地假装。
- **空态 / 错误态 / 陈旧提示**：`States` 组件（kanban 同款：EmptyState / ErrorState /
  StaleNotice / NotEnabledState）。
- **写操作交互**：与条带同款「乐观本地减法 + 失败重读对齐 + toast 如实」
  （`PendingStrip.tsx:525-562,725-768` 的模式），文案复用既有 `chat.pending.*` /
  `chat.toast.*` key，不新造同义词。

## 3. SWR（事件触发重读 + 兜底轮询，红线）

- **live 触发器**（新纯函数 `agentInboxChangeOf` + seq 水位 hook，
  `useInboxRefresh.ts:68-101` 同款结构，但**agent 级匹配**）：
  - `agent.message.queued` 且 `data.agent_id === agentId`：一条事件覆盖三种投递
    （input/wake/quiet，`service.ts:7735-7761` emitMessageQueued 头注），
    `data.agent_id` 由 `emitForSession` 恒带（`service.ts:7781`）；
  - `tool.call.completed/failed` 且 `tool_name === 'inbox'`，且（`data.agent_id`
    命中 或 事件会话归属 ∈ 该 agent 的 body sessions）：工具帧不带 agent_id，
    归属靠 EventStore 按 run 记的 `sessionId`（`events.ts:14-20`）+ roster 的
    `bodies`（`AgentSummary.bodies`，`gateway/types/agents.ts:79-80`）。
  - 水位单调 seq、纪元回退重扫（与 useInboxRefreshTick 逐字同款）；触发器只 +1，
    **不携带条目数据**。
- **兜底轮询**：非空 2s（条带同款）；**空态 10s**（与条带「空态零流量」不同：
  这是用户主动打开的专页，旧 gateway 事件面可能缺，空态也要能看见新消息进来；
  10s 是廉价兜底，不是主通道）。`pauseWhenHidden`（useResource 内建）。
- **数据永远来自那次 RPC**，事件只当触发器（条带三条硬口径逐字继承）。
- **订阅面**：inbox 域落 `scopeForRoute` default ⇒ `{kind:'none'}` ⇒
  `allow_global: true`（`subscription.ts:131-140`）⇒ 收得到 `agent.message.queued`
  与工具终态帧。无需新订阅范围。

## 4. 入口

- 桌面侧栏 chat 组：`chat / pending / inbox / teams / kanban`（`nav.ts:43`）；
  命令面板自动（`palette-items.ts:29-35` 遍历 DOMAINS）；移动端 More sheet 加一项。
- **会话页头入口**：SessionHeader 标题行加「收件箱」按钮 →
  `#/inbox?agent=<本会话归属 agent>`（ChatView 的 `catalogAgentId` 同源派生，
  `ChatView.tsx:63-74,418-422`，不新增 RPC）。用户正在和 main 聊天时一键看 main 全量
  inbox —— 症状②的现场入口。

## 5. 变更面

新增：
- `apps/web/src/domains/inbox/InboxView.tsx`（视图主体 + agent 选择器 + SWR）
- `apps/web/src/domains/inbox/InboxRow.tsx`（行卡：身份/状态/归属/展开/动作）
- `apps/web/src/domains/inbox/agent-inbox-refresh.ts`（agent 级触发判据 + 水位 hook）

修改（全部是接线，不改既有行为）：
- `app/router.ts`（Route / parseRoute / formatRoute）
- `app/nav.ts`（DOMAINS / NAV_GROUPS / primaryRoute / routeBreadcrumb）
- `app/ShellRouteView.tsx`（渲染分支）
- `app/BottomNav.tsx`（More 项 + moreActive）
- `components/DomainIcon.tsx`（inbox 图标：信封；pending 的开口盒不动）
- `i18n/messages/{en,zh-CN}.ts`（nav.domain.inbox / breadcrumb.inbox / inbox.*）
- `domains/chat/{ChatView,ChatHeader,SessionHeader}.tsx`（页头入口回调穿透）

不动：服务端全部（AgentInboxStore / inboxSnapshot / RPC）、PendingStrip、
pending-sends、useInboxRefresh（会话级触发器原样）、订阅控制器。

## 6. 风险与边界

- **串台**：agent 级全量天然含跨会话条目 ⇒ 逐行归属标注 + agent 选择器显式切换
  （审计 §5 P1-B 风险项的对策）。
- **误写**：写操作沿用服务端来源分档（human 真删 / 其余 unhold），前端照抄
  `HUMAN_SOURCE` / `canUnhold` 同一判据，不新造分档。
- **消费后消失**：inbox read 消费后条目不再回 —— 忠实还原，不是缺陷；
  「已消费消息的可见承接」归 P1-A，不在本单扩面。
- **零新事件 / 零新 RPC / 零服务端改动** ⇒ 无 event-visibility 登记面。
- 新视觉留用户验收（宪法）；行为验证归用户/canary。