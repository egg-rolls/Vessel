# inbox 真相源一致性 / 前端忠实还原审计

- 作者：q-inbox-truth（红蓝调研，零代码零探针，只读）
- 分支：`design/q-inbox-truth`（基线 `redblue-dev` @ 1e29cd1e）
- 触发：用户直接报告两症状，main 转达 + 三次 live 实证补充
- 方法：源码逐链读证（store → RPC → 前端渲染），全部结论带 `file:line`。未跑任何探针/进程。

---

## 0. 结论速览（TL;DR）

**服务端真相源是统一的**，不是「真相源不统一」。单一 `AgentInboxStore` 实例同时供 inbox tool 消费与 `agents.inbox` RPC 投影（§1）。用户「刷新之后，read 掉的消息正确消失」这条 live 实证恰好证明服务端持久态与 RPC 投影一致。

两症状的真正根因都在**前端侧 / 视图口径**：

- **症状①（read 消费后前端仍显示「等待中」，刷新才消失，稳定复现）**
  根因 = **前端存在第二真相源**：客户端 `pendingSends` 内存 store。用户从浏览器发出的 human 消息在客户端有一条 pending 行；main 用 `inbox read` 消费它时，对应的 queued run 被取消、**永不产生 `user.message`/`run.started` 回显**，而 `pendingSends` 只认这两类回显才摘除 pending（`pending-sends.ts:164,435`）。于是客户端 pending 永远停在 `queued`，条带那行「等待中 human: …」常驻。
  **`useInboxRefresh` live 触发器与 2s 兜底轮询只重读「服务端条目」，碰不到客户端 pending 行**（`PendingStrip.tsx:472-495`）。刷新之所以能消除，是因为 `pendingSends` 无持久化、刷新即空（`pending-sends.ts:183-187,599-600`）。
  ⇒ 这不是「live 触发器没触发」，而是「触发了也救不了客户端那一行」。main 的「事件归属过滤」假说不是主因（§2.5 回应）。

- **症状②（部分 agent→main 消息在用户 inbox 视图看不到，human 消息却看得到）**
  根因 = **用户 inbox 视图 = 会话级 `PendingStrip`，只显示 `session_id == 当前会话` 的 held/unread 条目；全前端没有 agent 级 inbox 面板**（仅 `ChatView.tsx`/`PendingStrip.tsx` 消费 `agents.inbox`）。agent→main 消息不可见是四因叠加（§3.3）：
  (a) 被 main `inbox read` 消费后从 inbox 消失，且**不渲染成消息卡**（`AgentMessageCard` 只画 run-input，`TranscriptWindow.tsx:471-490`）→ 两处都看不到；
  (b) `wake`/`quiet` 投递**不写 `session_id`** → 条带永久隐藏（设计如此，`inbox.ts:52-60`，`env-notice.ts:478-490` 明确承认）；
  (c) agent→main 按 agent 名/id 投递时落到 **primary body**（`service.ts:5815,2630`），与用户当前视图会话可能不一致 → 等值过滤掉；
  (d) 作为 run input 被消费的消息进 **transcript**（AgentMessageCard）而非 inbox 条带 → 用户在「inbox」里找不到。
  human 消息之所以「看得到」，恰恰是因为它们卡在客户端 pending（症状①）+ 排队服务端条目里没被及时消费。

**修复方向（分级见 §4）**：P0 给客户端 pending 一个「消费/取消」收口信号（或让条带用服务端真相对账客户端 pending）；P1 提供 agent 级 inbox 真相视图 / 把 inbox-read 消费的消息渲染成可见卡 / 明确视图口径。

---

## 1. 真相源链图（store → RPC → 前端）

```
┌─────────────────────────────── 服务端（单一真相源）──────────────────────────────┐
│                                                                                  │
│  AgentInboxStore（每 agent 一个持久文件 <dataDir>/inbox/<agentId>.json）          │
│    packages/agent/src/inbox.ts:592  class AgentInboxStore                        │
│    · 唯一实例：service.ts:1066  this.inbox = new AgentInboxStore({...})          │
│    · 挂给运行期：service.ts:1079  this.runtime.attachInbox?.(this.inbox)         │
│      → runtime.ts:1449  attachInbox(inbox){ this.inbox = inbox }                 │
│                                                                                  │
│  写入口（I1，唯一）：AgentService.trackInbox                                      │
│    service.ts:3304-3333  append{session_id = bodyId, delivery:'input'} + hold    │
│    · wake/quiet 投递不写 session_id：inbox.ts:52-60；service.ts:3297-3302        │
│    · rotate 窗口 quiet 落盘：service.ts:3076-3110                                 │
│                                                                                  │
│  消费口（I2，都走同一个 store.consume）：                                          │
│    ① 模型 inbox tool read：inbox.ts:1456-1477                                    │
│       unheld → store.read 消费(inbox.ts:755-761)；                               │
│       held → store.claim(inbox.ts:780-819) 先 beforeClaim 再 consume             │
│       beforeClaim = withdrawQueuedRuns：service.ts:1076,3949-3960                │
│         → cancelQueuedRunsFor(service.ts:4286-4301) → scheduler.cancel           │
│         → dropFromQueue(service.ts:4327-4334)                                    │
│    ② agents.claim RPC / web「我已处理」：AgentService.claim service.ts:3918-3938  │
│    ③ 成为 run input：consumeAsRunInput service.ts:3341-3347 → markConsumed        │
│                                                                                  │
│  只读投影（agents.inbox 的唯一数据源）：AgentService.inboxSnapshot                 │
│    service.ts:3713-3787                                                          │
│    · store.list(includeHeld:true) → 只回 status==='unread'（inbox.ts:707-709）    │
│      consumed 条目永不出现                                                        │
│    · 会话等值过滤：service.ts:3760  entry.session_id === sessionId                │
│      （缺 session_id 的条目永不命中）                                              │
│                                                                                  │
│  RPC：agents.inbox                                                                │
│    packages/serve/src/gateway/methods/agents.ts:686-773                          │
│    → control.inbox：src/agent/agent-control.ts:307-309 → service.inboxSnapshot    │
│    · session_id → agent 反查：agents.ts:744-754（control.resolve）                │
└──────────────────────────────────────────────────────────────────────────────────┘
                                   │  WS/SSE 事件 + RPC
                                   ▼
┌─────────────────────────────── 前端（两个数据源）────────────────────────────────┐
│                                                                                  │
│  数据源 A：服务端条目（忠实）                                                      │
│    PendingStrip.load → agents.inbox{session_id}：PendingStrip.tsx:426-446         │
│    · ownedBySession 再断一次：PendingStrip.tsx:432                                │
│    · 触发器：切会话/重连/refreshKey/reloadTick：PendingStrip.tsx:452-459          │
│    · 非空时 2s 兜底轮询（空态零流量）：PendingStrip.tsx:491-495                    │
│    · live 触发器 useInboxRefresh：useInboxRefresh.ts:46-101                       │
│      认 tool.call.completed/failed(tool_name=inbox) + agent.message.queued        │
│      按会话归属过滤(entry.sessionId ?? data.session_id)                            │
│      ChatView 接线：ChatView.tsx:277,597-612                                      │
│                                                                                  │
│  数据源 B：客户端 pending（第二真相源，内存，无持久化）★症状①根因                   │
│    pendingSends store：pending-sends.ts:188-600（单例 :599-600）                  │
│    · 创建：用户点发送 create()（pending-sends.ts:220）                            │
│    · 摘除唯一自动路径 = 回显 noteEvent：pending-sends.ts:435-467                  │
│      ECHO_EVENT_TYPES = ['user.message','run.started']：pending-sends.ts:164      │
│    · 超时 sweep 已移除：usePendingSends.ts:13-17,114-117                          │
│    · 无消费/取消信号：run.cancelled 被忽略（connection-handlers.ts:197-215        │
│      只结算 interactions；state/agents.ts:156 直接 return）                        │
│                                                                                  │
│  条带行 = 服务端条目行 + 客户端 pending 行（混排）：PendingStrip.tsx:472-488       │
│    · 客户端行顶替服务端行：claimedEntryIds / claimsEntry                          │
│      pending-placement.ts:139-169                                                │
│    · 客户端行上条带判据 inPendingStrip = queued/deferred/failed：                 │
│      pending-placement.ts:110-112                                                │
│    · 客户端行无条件加入 rows（不受服务端读数影响）：PendingStrip.tsx:486          │
│                                                                                  │
│  消息卡（transcript）：AgentMessageCard 只画 'run-input' item                      │
│    TranscriptWindow.tsx:471-490（sender 来自 run.started.input_name /             │
│    user.message.name）⇒ inbox-read 消费的消息永不进 transcript ★症状②(a)          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**关键结论**：服务端 store / inbox tool / `agents.inbox` RPC 三者**同一实例、同一真相**（`service.ts:1066-1079` 把唯一 store 同时挂给运行期工具与只读投影）。前端**服务端条目那一半是忠实的**；不忠实的是**客户端 pending 那一半**（数据源 B）与**视图口径**（会话级条带，无 agent 级面板）。

---

## 2. 症状① 根因：客户端 pending 是无消费信号的第二真相源

### 2.1 先排除「服务端真相源不统一」

- inbox tool 与 `agents.inbox` 共用同一 `AgentInboxStore`：`service.ts:1066`（构造）→ `:1079`（`attachInbox`）→ `runtime.ts:1449`（持有）→ `runtime.ts:1775-1790`（`inboxTool` 用 `this.inbox` 造工具）。只读投影 `inboxSnapshot` 读的也是 `this.inbox`（`service.ts:3748`）。**不存在第二份服务端 store。**
- `inbox read` 消费即落 `consumed`（`inbox.ts:755-761` / `:808`），`inboxSnapshot` 的 `list` 只回 `unread`（`inbox.ts:707-709`）⇒ 消费后 RPC 立即不再返回该条。
- **用户 live 实证**：「刷新之后，你 read 又正常让我的 inbox 消息消失了」⇒ 刷新重读 `agents.inbox` 得到正确（已消费）结果 ⇒ 服务端持久态与 RPC 投影一致。**「真相源不统一」被排除。**

### 2.2 残留的「等待中 human」行是客户端 pending 行，不是服务端条目

条带的行由两部分混排（`PendingStrip.tsx:472-488`）：

```
serverRows = entries.filter(未被认领 && 未 sent).map(...)   // 数据源 A
clientRows = pendings.filter(inPendingStrip).map(clientRowOf) // 数据源 B
rows = [...serverRows, ...clientRows]
```

- 客户端行**无条件加入**（`PendingStrip.tsx:486`），只要 pending 状态是 `queued/deferred/failed`（`pending-placement.ts:110-112`）。它**不依赖服务端读数**。
- 客户端行卡头：`clientRowOf` 造 `from=HUMAN_SOURCE, status='held'`（`PendingStrip.tsx:271-290`）；`labelOf` 对 `queued` 返回 `undefined` → 缺省「等待中」（`PendingStrip.tsx:906-911`）；身份 = human（`identityOf`）。⇒ 屏上正是「○ 等待中 human: … 展开」，与用户截图逐字吻合。

**为什么断定是客户端行而非服务端行**：服务端条目受 2s 兜底轮询管辖（`PendingStrip.tsx:491-495`，非空即轮询）。若残留的是服务端条目，消费后最长 2s 就会被下一次 `load` 清掉，**无需刷新**。用户报告「稳定复现、必候手动刷新」⇒ 残留行不受轮询管辖 ⇒ 只能是客户端 pending 行。刷新能消除，是因为 `pendingSends` 无持久化、整页重载即空（`pending-sends.ts:183-187` 模块头、`:599-600` 单例）。

### 2.3 消费路径不产生回显 ⇒ 客户端 pending 永不摘除

用户从浏览器发 human 消息的生命周期：

1. 点发送 → `pendingSends.create`（`pending-sends.ts:220`）→ state `sending`。
2. `runs.start` 回 `status:'queued'`（main 正忙）→ `attachRun`（`pending-sends.ts:284-297`）→ state `queued`，挂 `runId`。
3. `agent.message.queued` → `noteQueued`（`pending-sends.ts:329-348`）→ 挂 `messageId`。
4. main 调 `inbox read` 消费这条 held 消息：
   - `inbox.ts:1470-1477` → `store.claim` → `beforeClaim = withdrawQueuedRuns`（`service.ts:3949-3960`）→ `cancelQueuedRunsFor`（`service.ts:4286-4301`）→ `scheduler.cancel(runId)`（`scheduler.ts:172-188`）。
   - 该 queued run **从未开跑**就被取消 ⇒ **不会发 `user.message`，也不会发 `run.started`**（这两者只在消息真正成为 run input 时发）。
5. `pendingSends.noteEvent` 只认 `user.message`/`run.started`（`pending-sends.ts:164,435-467`）⇒ 这条 pending **没有任何事件能摘除它**。
6. 超时 sweep 已被用户裁定移除（`usePendingSends.ts:13-17,114-117`）⇒ 也不会按计时收敛成失败。
7. ⇒ pending 永远停在 `queued`，条带那行常驻，直到刷新 / 用户手动「取消/我已处理」。

**available 但被忽略的信号**：queued run 被取消时 `scheduler.cancel` 会发 `agent.queue.left`（`scheduler.ts:183,322-349`，载荷带 `run_id`/`session_id`/`agent_id`，**不带 `message_id`**）。客户端 pending 挂有 `runId`，本可按 `run_id` 匹配摘除，但 `pendingSends` 不认 `agent.queue.left`；`run.cancelled`  likewise 被忽略（`connection-handlers.ts:197-215` 只结算 interactions，`state/agents.ts:156` 直接 return）。**消费/取消这件事在事件面上有痕迹，但前端 pending 层没有接。**

### 2.4 为什么 live 触发器 / 轮询救不了

- `useInboxRefresh`（`useInboxRefresh.ts:46-101`）与 2s 轮询（`PendingStrip.tsx:491-495`）的作用都是**再读一次 `agents.inbox`**，更新的是**服务端条目**（数据源 A）。客户端 pending 行（数据源 B）由 `pendingSends` 内存独立渲染，`load`/`setPending` 完全不触碰它（`PendingStrip.tsx:426-446` 只 `setPending`）。
- 即便 `inbox read` 的 `tool.call.completed` 触发器正常触发、条带重读后服务端条目已清空，`clientRows` 仍按 `pendings.filter(inPendingStrip)` 照画（`PendingStrip.tsx:486`）。服务端读数变空只会让 `hasPending=false`、**停掉轮询**（`PendingStrip.tsx:491-495`），客户端那行反而更没人管。
- ⇒ **之前的修复（`useInboxRefresh`，commit 386c35bf 场景）是必要但不充分**：它治好了「服务端条目残留」，治不了「客户端 pending 残留」。用户这次报的恰恰是后者。

### 2.5 对 main「事件归属过滤」假说的回应

main 三次补充把方向收窄到「main 的 `tool.call.completed(inbox)` 事件没到达用户前端 / 被 `useInboxRefresh` 会话归属稳定滤掉」。逐链核对后，**这条不是主因**：

- 用户前端 chat 订阅按 `session_id = selectedId` 收敛（`subscription.ts:113-122`）。
- gateway 出站对不带 `session_id` 的工具事件**补齐归属**：`resolveEventSession`（`gateway.ts:1434-1442`）用 `run_id → session` 映射（来自 `run.started` / `runs.start` 应答，`gateway.ts:1364-1379,1466-1471`），`withSessionAttribution`（`gateway.ts:1453-1462`）把 `session_id` 补进出站副本。main 的 run 的 `run.started` 带 `session_id = main body`，故 main 的 `inbox read` 工具帧会被归到 main body 会话。
- 用户要消费的是**自己发给 main 的消息**，该消息归属 main body 会话（`trackInbox` `session_id=bodyId`），用户视图 `selectedId` 正是 main body 会话 ⇒ 归属匹配，`acceptsEvent`（`gateway.ts:873-898`）放行，客户端 `EventStore` 记 `entry.sessionId = selectedId`（`event-store.ts:717-728`），`inboxChangeOf`（`useInboxRefresh.ts:46-60`）命中 ⇒ **触发器会触发**。
- 关键：**即便触发器触发、服务端条目重读为空，客户端 pending 行仍在**（§2.4）。所以「事件归属」即便有偏差也只是次要优化项，不是「稳定复现、刷新才消失」的根因。根因是数据源 B 无消费信号。

> 注：本审计零探针，上述为源码结构推演。但「残留行不受 2s 轮询管辖 ⇒ 必为客户端行」这一步是**结构性结论**（轮询只 `setPending`，客户端行独立渲染），不依赖运行期观测。

---

## 3. 症状② 根因：用户 inbox 视图是会话级条带，agent 消息四因不可见

### 3.1 用户 inbox 视图 = 会话级 PendingStrip，无 agent 级面板

- 全前端消费 `agents.inbox` 的只有 `ChatView.tsx` 与 `PendingStrip.tsx`（grep 实证，无第三个面板）。**没有「main 的全部 inbox」这种 agent 级视图。**
- 条带取数 `agents.inbox{session_id: selectedId}`（`PendingStrip.tsx:429-431`），服务端等值过滤 `entry.session_id === sessionId`（`service.ts:3760`），前端再 `ownedBySession` 断一次（`PendingStrip.tsx:432`）。**缺 `session_id` 的条目一律不显示**（`PendingStrip.tsx:12-13` 第一条硬口径）。
- 设计意图明确：条带回答「我这一轮还压着几条输入」，不是队列编辑器，更不是收件箱历史（`PendingStrip.tsx:2-9`）。`env-notice.ts:478-490` 进一步承认：「含 unread 的行说的是『别人给你发了消息』，条带**不覆盖**这类（无 session 归属的条目会被条带隐藏）」。

### 3.2 agent→main 消息的 session_id 归属实证

- **team @ 提及 / federation 入站**：`dispatchMention` 恒为 input 投递（`team-service.ts:1479-1481`「这条路径恒为 input 投递（不传 notify）」）；federation 入站走 `teams.post` → `dispatchMention`（`packages/serve/src/federation.ts:1037-1090`）。
- **dispatch 的目标 body**：`boundSession = registry.getBySession(to)?.id === target.id ? to : undefined`（`service.ts:5815`）。按 **agent 名/id** 投递（`to='main'` 不是 session id）⇒ `boundSession=undefined` ⇒ `admit` 走 `ensureExecutionUnit` 的 `primaryBinding(record)`（`service.ts:2630`）⇒ **落 primary body**，`trackInbox` 写 `session_id = primary body 的 bindingId`（`service.ts:3314`）。
- **human 从 web 发送**：`runs.start` 带 `session_id = selectedId` ⇒ `admitInternal` 解析 `requestedBindingId = selectedId`（`service.ts:2941-2960`）⇒ 落**用户当前视图会话**那具 body。
- ⇒ **归属差异**：human 消息归属「用户视图会话」；agent 消息归属「primary body」。两者**通常**重合（用户就在 primary body 会话里聊天），但 main 一旦 rotate / 有多 body / 用户切到别的会话，就分叉 ⇒ agent 消息被等值过滤掉。

### 3.3 agent→main 消息不可见的四个原因（叠加）

**(a) 被 inbox read 消费 → 两处都看不到（最主要）**
main 处理报告时调 `inbox read` 把消息消费掉（`inbox.ts:1456-1477`）⇒ 从 inbox 消失（`consumed` 不再回）。同时 `AgentMessageCard` 只渲染 `run-input` item（`TranscriptWindow.tsx:471-490`，sender 来自 `run.started.input_name`/`user.message.name`）⇒ **inbox-read 消费的消息从未成为 run input，永不进 transcript**。正文只留在 `inbox` 工具卡的结果里（要展开工具卡才看得到）。⇒ 用户在「inbox 条带」和「消息流」两处都找不到这条 agent 消息。

**(b) wake/quiet 投递无 session_id → 条带永久隐藏**
`notify:true`（wake）、rotate 窗口（quiet）、投递失败留档（quiet）都**不写 session_id**（`inbox.ts:52-60`，`service.ts:3297-3302,3076-3110`）⇒ 条带等值过滤永不命中（`service.ts:3760`）。这类「别人给你发的消息」由 `[inbox] N unread` 环境信息卡承接（`env-notice.ts:478-490` 只隐藏纯 pending 那种、保留 unread 那种），但那只是**计数**，不是消息本体。

**(c) 归属分叉 → 等值过滤**
见 §3.2：agent 消息落 primary body，用户视图会话若不是 primary body（rotate 后 / 多 body / 切会话），`session_id` 不匹配 ⇒ 隐藏。

**(d) 作为 run input 消费 → 进 transcript 而非 inbox**
main 空闲时 agent 消息立即成为 run input（`consumeAsRunInput` `service.ts:3341-3347`）⇒ 渲染成 `AgentMessageCard` 进消息流，**不在 inbox 条带**。用户在「inbox」里找它自然找不到——它已经「送达」了。

### 3.4 human 看得到 / agent 看不到的不对称解释

- human 消息：用户刚发、main 正忙 ⇒ 排队（held + 客户端 pending）。main 还没来得及消费 ⇒ 服务端条目 + 客户端行都在条带上 ⇒ **看得到**（且消费后因症状①还残留）。
- agent 消息：main 通常**立即处理**（inbox read 或 run input）⇒ 要么被消费消失（a/d）、要么无 session_id（b）、要么归属分叉（c）⇒ **看不到**。
- ⇒ 不对称不是「human 有特权」，而是**消费时机 + 投递模式 + 归属口径**三者叠加的表象。

### 3.5 设计意图 vs 缺陷

- **会话级过滤、wake/quiet 不写 session_id**：是**设计意图**（「宁可隐藏也不串台」，`PendingStrip.tsx:12-13`、`inbox.ts:59-60`），不是 bug。
- **缺陷/缺口**：
  1. 用户期望「看到别人发给 main 的消息」，但前端**只有会话级待处理条带**，没有 agent 级收件箱视图 ⇒ **视图口径与用户期望不匹配**（症状②核心）。
  2. inbox-read 消费的消息**没有任何一等公民的用户可见表示**（既不在条带、也不进消息流，只在工具卡里）⇒ **信息承接缺口**（症状②(a)）。
  3. 客户端 pending 无消费信号 ⇒ **前端不忠实还原服务端真相**（症状①）。

---

## 4. 修复方案（分级）

> 原则：服务端真相已统一，**不动 store / 消费语义**；修复集中在「前端忠实还原」与「视图口径/承接」。零代码建议，供 main/用户裁定。

### P0 — 症状①：给客户端 pending 一个消费/取消收口（必做，稳定复现）

目标：main `inbox read` 消费排队 human 消息后，条带那行**免刷新即时消失**。三条候选，按推荐度排序：

- **P0-A（推荐，真相源对账）**：条带每次 `load` 拿到服务端 `entries` 后，对客户端 pending 做一次对账——`pending.messageId` 已不在服务端 inbox（且未收到回显）⇒ 该消息已被消费/撤回 ⇒ 摘除该 pending（或转「已被 agent 取走」终态）。
  - 落点：`PendingStrip.tsx:426-446`（`load`）+ `pending-sends.ts`（新增 `reconcile(serverIds)`）。
  - 优点：把「服务端真相」作为客户端 pending 的收敛依据，**结构性消除第二真相源漂移**，不依赖新事件；与现有「数据永远来自那次 RPC」硬口径一致。
  - 注意：只对**已挂 `messageId`** 的 pending 对账（没挂 id 的草稿态/在飞态不动），避免误删刚发还没入队的。
- **P0-B（补 live 信号）**：服务端在消费口（`store.consume` / `withdrawQueuedRuns`）发一条带 `message_id` + `session_id` 的 `agent.message.consumed`（或复用 `agent.queue.left` 补 `message_id`），`pendingSends` 认它摘除 pending。
  - 落点：`service.ts:3949-3960` / `inbox.ts:755-761,808`；`pending-sends.ts:164`（扩 ECHO/消费类型）；`event-visibility.ts` 登记新事件。
  - 优点：即时、精确；缺点：新增事件 + 跨层接线，且 `agent.queue.left` 现不带 `message_id`（`scheduler.ts:330-349`）需补。
- **P0-C（最小改，按 run_id 认取消）**：`pendingSends` 认 `run.cancelled` / `agent.queue.left`，按 pending 挂的 `runId` 匹配摘除。
  - 落点：`pending-sends.ts`（新增 noteCancelled）；`connection-handlers.ts:197-215` 或 `usePendingSends.ts` 水位。
  - 缺点：`agent.queue.left` 是 observe 档（`event-visibility.ts:219`）但能进 entries；需确认 queued-run 取消是否稳定发 `run.cancelled`（queued run 未开跑，core 不发，需 service 侧补）⇒ 不如 P0-A 稳。

**推荐 P0-A**：它把客户端 pending 钉在服务端真相当前，最符合「前端忠实还原真相」，且不需要新事件/新接线。P0-B 可作为即时性增强叠加。

### P1 — 症状②：让用户看得到 agent→main 消息（视图口径/承接）

- **P1-A（承接缺口，推荐先做）**：把 inbox-read 消费的消息渲染成一等公民可见卡。两种做法：
  - 在 transcript 里为「inbox tool 取走的正文」生成 `AgentMessageCard`（数据来自 `tool.call.completed(inbox)` 结果里的 `messages[].text/source`），让「别人发给 main 的话」在消息流可见；
  - 或保留工具卡但默认展开/摘要化，至少不让正文「藏起来」。
  - 落点：`TranscriptWindow.tsx:471-490` / `transcript-items.ts`（新增 inbox-read 消息投影）。
- **P1-B（agent 级 inbox 视图）**：提供一个「main 收件箱」面板，读 `agents.inbox{agent_id}`（不带 session 过滤，`agents.ts:733-754` 支持 agent_id），展示 main 全部 unread/held（含无 session_id 的 wake/quiet），按来源/归属分组。满足用户「看 main 全部 inbox」的期望。
  - 落点：新增面板 + `agents.inbox{agent_id}`；与现有会话级条带并存（条带仍只管「本会话压着几条」）。
- **P1-C（归属口径，谨慎）**：若用户期望「agent 消息也进当前会话条带」，需让 agent→main 投递落到用户视图会话而非恒 primary body（改 `dispatch` 的 `boundSession` 解析，`service.ts:5815`）。**风险高**（动投递寻址/恢复语义），不建议轻改；优先 P1-A/B 满足可见性。

### P2 — 口径澄清 / 文档

- 明确「用户 inbox 视图 = 会话级待处理条带，不是 agent 收件箱历史」的产品口径，并在 UI 上给「查看 main 全部收件箱」入口（接 P1-B）。
- `env-notice.ts:478-490` 已承认 unread 消息条带不覆盖——把这条口径显式告知用户（「别人发的消息在收件箱面板/消息流看，条带只管你这一轮的排队输入」）。

---

## 5. 风险面

- **P0-A 对账误删**：若 pending 还没挂 `messageId`（在飞/草稿），或入队事件延迟，对账可能把「刚发还没入队」的 pending 误判成「已消费」。缓解：只对已挂 id 且服务端明确不含该 id 的 pending 收口；保留「回显优先」。（`pending-sends.ts:329-348` noteQueued 挂 id 时机）
- **P0-B 新事件**：新增 `agent.message.consumed` 需在 `event-visibility.ts` 登记 + `docs/architecture/events.md` marker 表同步（门禁 `check:event-visibility`），漏登记会被判 FAIL。消费口多处（tool read / claim / run input）都要发，漏一处就回到漂移。
- **P1-A 投影重复**：inbox-read 消息投影成卡后，若该消息**又**成为 run input（理论上消费后不会，但 interrupt/重投路径需核），可能与 `AgentMessageCard` 重复。需按 `message_id` 去重（参考 `pending-placement.ts` 的「一条消息一个地方」）。
- **P1-B agent 级视图串台**：不带 session 过滤会展示**所有会话**的条目（含父→子消息），需按归属/来源分组并标注，避免用户误以为都是「给自己的」。`agents.inbox{agent_id}` 本就回 agent 维度全量（`service.ts:3775` unread/pending 是 agent 维度）。
- **P1-C 动投递寻址**：改 `boundSession`/primary body 选择会牵动重启恢复（`recoverPendingInputs` 按 `session_id` 重投）、rotate 窗口、多 body 隔离（`releaseHeldFor` 只放一个 body）。**高风险，不建议为可见性轻改**；可见性用 P1-A/B 解决。
- **通用**：本审计零代码零探针，结论为源码结构推演；落地任何修复前应补一个驱动/探针复现「inbox read 消费 → 条带客户端行残留」与「agent 消息不可见」，再验证修复（参考 `apps/web/scripts/queued-lifecycle-live.ts` 的既有真机读数模式）。

---

## 6. file:line 实证索引（速查）

### 服务端真相源（统一）
| 事实 | 位置 |
|---|---|
| 唯一 AgentInboxStore 构造 | `packages/agent/src/service.ts:1066` |
| 挂给运行期（工具与投影同源） | `packages/agent/src/service.ts:1079`；`packages/agent/src/runtime.ts:1449` |
| inbox tool 用同一 store | `packages/agent/src/runtime.ts:1775-1790` |
| 只读投影 inboxSnapshot | `packages/agent/src/service.ts:3713-3787` |
| list 只回 unread（consumed 排除） | `packages/agent/src/inbox.ts:707-709` |
| 会话等值过滤 | `packages/agent/src/service.ts:3760` |
| agents.inbox RPC handler | `packages/serve/src/gateway/methods/agents.ts:686-773` |
| control.inbox → inboxSnapshot | `src/agent/agent-control.ts:307-309` |
| trackInbox 写 session_id=bodyId（input only） | `packages/agent/src/service.ts:3304-3333` |
| wake/quiet 不写 session_id | `packages/agent/src/inbox.ts:52-60`；`service.ts:3297-3302` |
| rotate 窗口 quiet 落盘 | `packages/agent/src/service.ts:3076-3110` |
| tool read 消费（unheld consume / held claim） | `packages/agent/src/inbox.ts:1456-1477` |
| store.read 消费 unheld | `packages/agent/src/inbox.ts:755-761` |
| store.claim（beforeClaim + consume） | `packages/agent/src/inbox.ts:780-819` |
| beforeClaim = withdrawQueuedRuns | `packages/agent/src/service.ts:1076,3949-3960` |
| cancelQueuedRunsFor → scheduler.cancel | `packages/agent/src/service.ts:4286-4301` |
| scheduler.cancel → agent.queue.left | `packages/core/src/kernel/scheduler.ts:172-188,322-349` |
| consumeAsRunInput（run input 消费） | `packages/agent/src/service.ts:3341-3347` |
| AgentService.claim（RPC/web） | `packages/agent/src/service.ts:3918-3938` |
| emitMessageQueued（agent.message.queued） | `packages/agent/src/service.ts:7745-7761` |
| dispatch boundSession（按名/id → primary body） | `packages/agent/src/service.ts:5815,5838` |
| ensureExecutionUnit primaryBinding | `packages/agent/src/service.ts:2630` |
| admitInternal session 解析（human → 视图会话） | `packages/agent/src/service.ts:2941-2960` |
| dispatchMention 恒 input | `packages/agent/src/team-service.ts:1479-1481` |
| federation 入站 → teams.post → dispatch | `packages/serve/src/federation.ts:1037-1090` |

### 前端（两个数据源 + 视图口径）
| 事实 | 位置 |
|---|---|
| 条带 load agents.inbox{session_id} | `apps/web/src/domains/chat/PendingStrip.tsx:426-446` |
| ownedBySession 再断 | `apps/web/src/domains/chat/PendingStrip.tsx:432` |
| 缺 session_id 不显示（硬口径） | `apps/web/src/domains/chat/PendingStrip.tsx:12-13` |
| 行 = 服务端 + 客户端混排 | `apps/web/src/domains/chat/PendingStrip.tsx:472-488` |
| 客户端行无条件加入 | `apps/web/src/domains/chat/PendingStrip.tsx:486` |
| 非空 2s 轮询（空态零流量） | `apps/web/src/domains/chat/PendingStrip.tsx:491-495` |
| 客户端行卡头「等待中 human」 | `apps/web/src/domains/chat/PendingStrip.tsx:271-290,906-911` |
| live 触发器 useInboxRefresh | `apps/web/src/domains/chat/useInboxRefresh.ts:46-101` |
| ChatView 接线 | `apps/web/src/domains/chat/ChatView.tsx:277,597-612` |
| pendingSends 单例（无持久化） | `apps/web/src/domains/chat/pending-sends.ts:183-187,599-600` |
| 回显只认 user.message/run.started | `apps/web/src/domains/chat/pending-sends.ts:164,435-467` |
| noteQueued 挂 messageId | `apps/web/src/domains/chat/pending-sends.ts:329-348` |
| 超时 sweep 移除 | `apps/web/src/domains/chat/usePendingSends.ts:13-17,114-117` |
| inPendingStrip = queued/deferred/failed | `apps/web/src/domains/chat/pending-placement.ts:110-112` |
| claimsEntry / claimedEntryIds 顶替 | `apps/web/src/domains/chat/pending-placement.ts:139-169` |
| run.cancelled 被 pending 层忽略 | `apps/web/src/gateway/connection-handlers.ts:197-215`；`apps/web/src/state/agents.ts:156` |
| AgentMessageCard 只画 run-input | `apps/web/src/domains/chat/TranscriptWindow.tsx:471-490` |
| agent.message.queued = observe 档 | `apps/web/src/state/event-visibility.ts:212` |
| producesTimelineItem 只丢 chunk 噪声 | `apps/web/src/state/events.ts:879-885` |
| EventStore 按 run 记归属 | `apps/web/src/state/event-store.ts:717-728` |
| gateway acceptsEvent（session fail-closed） | `packages/serve/src/gateway.ts:873-898` |
| resolveEventSession / withSessionAttribution | `packages/serve/src/gateway.ts:1434-1462` |
| web chat 订阅 session_id | `apps/web/src/gateway/subscription.ts:113-122` |
| env-notice 承认 unread 条带不覆盖 | `apps/web/src/domains/chat/env-notice.ts:478-490` |
| 仅 ChatView/PendingStrip 消费 agents.inbox | grep 实证（无 agent 级面板） |

---

## 7. 给 main 的答复要点（对应用户两症状）

1. **真相源统一吗？** 统一。服务端单一 store，inbox tool 消费与 agents.inbox 投影同源；用户「刷新后正确消失」已证实。**不是真相源不统一。**
2. **症状①（read 后仍显示，刷新才消失，稳定复现）**：前端第二真相源（客户端 pendingSends 内存）无消费信号。main inbox read 取消 queued run → 无 user.message/run.started 回显 → 客户端 pending 永不摘除 → 条带「等待中 human」行常驻。live 触发器/2s 轮询只刷服务端条目，救不了客户端行。**修复 P0-A：条带用服务端真相对账客户端 pending。**（main 的「事件归属」假说不是主因，见 §2.5。）
3. **症状②（agent 消息看不到，human 看得到）**：用户 inbox 视图 = 会话级条带（无 agent 级面板）。agent 消息四因不可见：被 inbox read 消费且不进消息流（a）/ wake·quiet 无 session_id（b）/ 落 primary body 与视图会话分叉（c）/ 作为 run input 进 transcript 而非 inbox（d）。human 看得到是因为卡在排队 + 客户端 pending。**修复 P1-A（inbox-read 消息渲染成可见卡）+ P1-B（agent 级收件箱面板）。**
4. **设计 vs 缺陷**：会话级过滤、wake/quiet 无 session_id 是设计意图；缺陷是「客户端 pending 不忠实」+「agent 消息无用户可见承接」+「视图口径与用户期望不匹配」。