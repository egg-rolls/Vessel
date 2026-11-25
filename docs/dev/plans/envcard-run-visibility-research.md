# 卡片渲染健壮性调研 —— envcard run 中可见性 + permission 审批卡刷新不显示

日期：2026-07（任务书 q-envcard-run + main 补充范围）· 分支 design/q-envcard-run · 调查人 q-envcard-run
性质：**只调研 + 设计，零代码改动**。

两个用户实测现象，同属「卡片渲染状态缺口」家族，但**根因相互独立**：

| # | 现象 | 根因层 | 一句话 |
| --- | --- | --- | --- |
| I | run 运行中看不到环境信息卡（`[inbox] N unread`、PII 通知），run 结束才显示 | **Web 可见性闸门** | notice 的 live 载体事件是 internal 档，默认配置在进 fold 前就被丢弃；q-display 补的投影分支在闸门下游，不可达 |
| II | main 调 `agent rotate` 时前端不显示 permission 审批卡，**刷新也不显示** → `approval_timeout` | **生产侧绕过事实通道 + 快照 RPC 可达性** | rotate 审批请求走裸事件流发布，**不进会话时间线**；当前 Web 的时间线订阅只收时间线记录 → live 卡永远到不了；刷新重建依赖 `interactions.list`，该 RPC 被挡/跨节点时卡片同样到不了 |

用户裁定（两现象共同的验收标准）：
- run 运行中和结束，能看到的事件卡片应该一致（I）；
- 审批请求改变了一个状态值，WebUI 刷新应读取到，不应刷新也不显示（II）。

**Part I** 为环境信息卡（原任务书范围）；**Part II** 为 permission 审批卡（补充范围，
更优先——阻塞用户审批操作）；**Part III** 为两现象对照与共同修复原则。

---

# Part I · 环境信息卡 run 中可见性状态误区

用户实测：run 运行中看不到环境信息卡（`[inbox] N unread`、PII 脱敏/失效通知）；
run 结束后才显示。用户裁定：**run 运行中和结束，能看到的事件卡片应该一致**。

## 结论（先说答案）

病灶不在渲染层（`EnvCard` / `TranscriptWindow` 对 run 状态没有任何歧视），而在
**live 事件可见性闸门**与**历史刷新时机**两层叠加：

1. **live 闸门（主因）**：环境信息消息的 live 载体事件 `message.injected` 与
   `context.changed` 都被登记为 **internal 档**（`apps/web/src/state/event-visibility.ts:156`
   / `:122`），默认配置（`showInternal=false`）下在 **进 fold 之前**就被
   `LiveItemStore` 丢弃（`apps/web/src/state/live-items.ts:437`、`:839-841`）。
   q-display 已经在 `buildLiveItems` 里补了 `message.injected → 环境信息卡` 的投影分支
   （`transcript-items.ts:1651-1669`，commit 290df5eb），**但事件根本到不了这个分支**——
   投影只在 `ui.showInternalEvents` / `verbosity: debug` 打开时才可达。
   即：q-display 修了「投影缺失」，没修「闸门拦截」，默认配置下等于没修。
2. **历史刷新时机（补渲来源）**：Web 只在 **run 终态 / `session.saved`** 时刷新
   `sessions.get`（`useChatTranscript.ts:416-453`）；而服务端 `saveSessionState`
   只在 **run 起点初始保存**与**终态**发生（`execution-unit.ts:3111` / `:3156`，
   `run-journal.ts:253-264`），**不是每轮请求**。于是 run 中途注入的 notice 消息
   要等终态落盘 + 终态刷新后才进入历史窗口，被历史侧渲成 EnvCard——这正是
   「run 结束才显示」的直接机制。

两层叠加的净效果：**运行中 notice 卡两条路都断**（live 被闸门挡、历史还没刷新），
终态后历史回填才补上。用户看到的「状态误区」是真实的结构性缺口，不是错觉。

## ① 环境信息卡的来源与注入链路

环境信息卡 = `role:'user'` + `name:'vessel:notice'`（及 `vessel:source`）的**消息**，
不是事件。生产侧分两条通道，**live 载体事件不同**——这是修复方案必须分开处理的关键：

### 通道 A：BeforeLlm hook / RunOptions 注入 → `message.injected`（带稳定 message_id）

| 生产者 | 位置 | 说明 |
| --- | --- | --- |
| inbox 计数提示 `[inbox] N unread / N pending` | `packages/agent/src/inbox.ts:1086-1166`（`createInboxNoticeHook`，消息构造 :1145-1151） | 每轮 BeforeLlm 按计数去重注入 |
| runtime.notice 总线（config/permission/tools/mcp/update/peer 热应用） | `src/runtime/runtime-notice-hook.ts:203-250` | 另落 `runtime.notice.injected` 锚点事件（:94，observe 档） |
| 成员 self-card-delta（identity/model/fields） | `packages/agent/src/self-card-delta.ts` | BeforeLlm hook |
| refs 提示 / doc-subscription（scope files） | `src/data/refs-notice-hook.ts:405`、`plugins/context/doc-subscription` | BeforeLlm hook |
| 工具面 / 模型 / system 修订增量 | `execution-unit.ts` `appendToolSurfaceNotice` / `appendModelChangeNotice` / `appendSystemRevisionNotice` | 直接调 `appendInjectedMessages` |
| `vessel:source` 来源行 | `packages/agent/src/runtime.ts:1332-1373`（`sourceMessage` 进 `RunOptions.messages`） | 每次成员 turn 注入 |
| idle 唤醒（`vessel:notice` 作为 run 输入） | `packages/agent/src/service.ts:270`（`INBOX_WAKE_NAME`） | **例外：走 run.started，见下** |

汇合点：`tool-calling-loop.ts:449` `ctx.window.appendInjectedMessages(runId, hookCtx.messages)`
→ `execution-unit.ts:4993-5025`：逐条盖稳定 id（`${runId}:inject:hook:<n>`，:5008-5012）、
**发 `message.injected` 事件**（:5013-5022）、`addContext` 持久化（:5023）。
RunOptions 注入同形（`execution-unit.ts:3058-3070`，id `${runId}:inject:<下标>`）。

### 通道 B：`appendNotice` → `addContext` → 只有 `context.changed`（**无 message.injected**）

| 生产者 | 位置 |
| --- | --- |
| PII 句柄整批失效 / 容量耗尽 / 个别失效卡 | `execution-unit.ts:2265-2345`（`appendPiiDeadNotice`，tool-calling-loop.ts:453 每轮请求前调用）→ `appendNotice`（:1162-1185） |
| 其它无 hook 的运行时提示（身份变更等） | `appendNotice` 同入口 |

`appendNotice` 只走 `addContext`（:5344-5390）：发 **`context.changed`**（:5376-5389，
载荷含完整 message），**不发 `message.injected`**。且历史投影
`packages/core/src/session/project-messages.ts:29` 明确「context.* 不产生消息」——
**PII 卡连事件投影都不进**，历史侧完全依赖终态 `saveSessionState` 落盘的壳缓存。
无 active run 时走 `appendNoticeToSnapshot`（:2440-2463）：只写壳 + `context.changed`，
同样没有 `message.injected`。

### 渲染侧（两条历史/live 入口共用，无 run 状态歧视）

- 消息 → 卡片数据：`env-notice.ts` `runtimeEnvCard`（:163-170，notice 行解析 /
  source 地址组织），`EnvCard.tsx` 唯一渲染入口。
- 历史 item：`transcript-items.ts:1313-1329`（`noticeKindOf → runtime-notice`）。
- live item：`transcript-items.ts:1651-1669`（`injectedNoticeOfEvent` 投影，q-display 加）
  与 `:1522-1535`（run 输入本身是 `vessel:*` 时，如 idle 唤醒）。
- 渲染：`TranscriptWindow.tsx:629-638` `case 'runtime-notice'` → `EnvCard`，
  **不看 run 是否 running**。唯一的渲染期抑制是 `isStripCoveredInboxNotice`
  （`env-notice.ts:491-495`，只藏纯 `[inbox] N pending`，用户裁定 PendingStrip 已承接；
  **含 unread 的行保留**——与本 bug 无关，不是病灶）。

## ② live / history 双路径逐段对照

| 阶段 | live 路径（run 中） | history 路径（run 终态后） |
| --- | --- | --- |
| 数据源 | SSE/WS 事件 → `EventStore.push` → `LiveItemStore.ingest` | `sessions.get` → `sessionDetail.messages`（壳缓存 + 事件投影对账） |
| 可见性闸门 | `isVisibleForGrouping`（events.ts:981-987）→ `isVisibleInChat`（event-visibility.ts:332-339）：internal 档默认**丢弃** | `visibleTranscript` 过滤（useChatTranscript.ts:474-482）：按 **消息 kind** 查 `runtimeVisibility`，`notice`/`source` 属 `ENV_MESSAGE_KINDS` **默认可见**（runtime-kinds.ts:57、message-visibility.ts:38-39） |
| notice 载体 | `message.injected`（internal，:156）/ `context.changed`（internal，:122）→ **进不了 fold**（live-items.ts:437） | 消息本体就在 `messages` 里，kind 判定直接放行 |
| 装配 | `buildLiveItems` 的 `injectedNoticeOfEvent` 分支（transcript-items.ts:1651）**不可达**（默认配置） | `buildHistoryIndex` → runtime-notice item（:1313-1329）→ EnvCard |
| 刷新时机 | 事件实时到达（但被闸门挡） | **只在终态 / session.saved 触发**（useChatTranscript.ts:429-449）；服务端只在 run 起点/终态 save（execution-unit.ts:3111/:3156） |
| 去重 | live item 携 `messageId`，历史落盘后按 id 让位（transcript-items.ts:2476-2486） | 历史那条负责渲染 |

**关键不对称**：消息 kind 层（`runtime-visibility` / `ENV_MESSAGE_KINDS`）早已裁定
notice/source 默认可见，q-from-card（b2e8a922）与 q-msg-visibility 都只动了这一层；
但 **事件档位层（`EVENT_TIERS`）是另一道独立的闸门**，`message.injected` 仍是 internal。
「恒可见」的裁定没有穿透到事件层——这就是状态误区的结构根源。

### 为什么 q-display 的修复（290df5eb）默认配置下不生效

该 commit 只改了 `transcript-items.ts`（+54 行投影分支），**没有动
`event-visibility.ts` / `live-items.ts` 的闸门**。事件流顺序是：

```
ingest → visible()（internal 档在此丢弃）→ fold.apply → group.items
→ buildLiveItems → injectedNoticeOfEvent 投影分支
```

投影分支在闸门**下游**。`showInternal=false` 时 `message.injected` 在第一步就没了，
分支永远空转；只有打开「系统信息」/ debug 才可见（此时走 fold 的 default 分支
events.ts:680-700 产 `ev-<seq>` 原始行，再被投影分支截成卡）。
`docs/dev/research/q-display-owner-delta-rootcause.md` 的「修向」也只写了补投影，
漏了闸门这一层——本单把缺口补全。

旁证：`event-visibility.ts:175-178` 把 `runtime.notice.injected` 降为 observe 档，
注释理由是「消息本体已由环境信息卡表示（live 经 message.injected 投影）」——
**这个前提在默认配置下不成立**，单一表示裁决的承接链断了，raw 行藏了、卡也没出。

## ③ 关键假设的裁定

- 「live 流式渲染过滤了 notice 类」——**成立，但过滤点不在 buildLiveItems**，
  而在更上游的 `LiveItemStore.visible()`（live-items.ts:839-841，ingest :437、
  refold :860 同口径）。`buildLiveItems` 本身对 notice 无歧视。
- 「notice 只在终态投影才装配」——**部分成立**：历史装配确实只在终态刷新后拿到
  消息（刷新时机 + 落盘时机双重延迟）；但 live 装配分支已存在，只是不可达。
- 「notice 注入时机在 run 结束后」——**不成立**：注入发生在 run 中每轮 BeforeLlm
  （inbox.ts:1115 / runtime-notice-hook.ts:206 / tool-calling-loop.ts:449-453），
  事件当时就发了（`message.injected` / `context.changed`），是 Web 侧没接住。

## ④ 对照：来源卡（vessel:source）run 中可见吗？

**独立来源卡 run 中同样不可见**（默认配置）：`vessel:source` 走
`RunOptions.messages` → `message.injected`（execution-unit.ts:3058-3070），
与 notice 同一道 internal 闸门。q-from-card 的「恒可见」改的是消息 kind 层
（`ENV_MESSAGE_KINDS` 加 source），同样没穿透事件层。

用户若感觉「来源可见」，看到的是另外两个**content 档**的替身：

1. **agent 投递卡**：输入本身带 `input_name=agent:<alias>`，`run.started` /
   `user.message` 是 content 档（event-visibility.ts:74/:79），首帧即渲成
   agent 消息卡（buildLiveItems :1536-1549）——来源信息被这张卡吸收
   （历史侧 `sourceLocationOf`，transcript-items.ts:853/:1091）。
2. **idle 唤醒卡**：输入本身是 `vessel:notice` 时，run-input 分支直接渲成
   runtime-notice 卡（:1522-1535），载体是 content 档的 `run.started`，run 中可见。

**差异的本质**：可见与否取决于**载体事件的档位**，不取决于消息 kind。
run 输入（content）可见；run 中途注入（internal）不可见。notice 与 source 同病，
只是 source 恰好有 agent 卡这个 content 档替身，notice（inbox/PII）没有。

## 修复方案（设计，供后续修复单执行）

目标：**默认配置下，run 中即渲染 notice/source 卡，与终态历史回填完全一致**
（同一张卡、同一个位置、不双出）。

### 方案 A（推荐）：事件闸门开「vessel:* 注入」白名单 + 统一 PII 载体

**A-Web（闸门）**：让「携带 `vessel:*` 消息且带稳定 `message_id` 的
`message.injected`」按 content 档进入 fold。落点二选一：

- 改 `isVisibleInChat` / `isVisibleForGrouping`：从「只按 type 查表」扩展为
  「type + 载荷谓词」——`message.injected` 且 `data.message.name` 以 `vessel:` 开头
  且 `message_id` 非空 ⇒ 可见。注意 `isVisibleInChat` 现签名只收 type
  （event-visibility.ts:332），需要 entry 级判据（调用方 events.ts:986 /
  live-items.ts:840 都拿得到 entry）；保持「未登记按 internal」兜底不变。
- 或在 `EVENT_TIERS` 把 `message.injected` 升 content + 在 fold/投影侧把
  **非 vessel:* 注入**（skill / 附件等）继续藏掉。**不推荐**：升档会让所有注入
  的 raw 行默认进聊天，违反「内部过程信号默认隐藏」的档位语义；白名单谓词更精确。

闸门放行后，`buildLiveItems` 现成的 `injectedNoticeOfEvent` 分支
（transcript-items.ts:1651-1669）立即生效：与历史侧同一个 `runtimeEnvCard` 入口、
同一种 runtime-notice item、携 messageId 让位——**双路径一致由结构保证**，
不需要新渲染代码。非 vessel:* 注入、无 id 旧数据保持现状（internal raw 行）。

**A-Core（PII 载体统一）**：`appendNotice`（execution-unit.ts:1162-1185）在有
active run 时改走 `appendInjectedMessages`（或补发一条同 id 的 `message.injected`），
使 PII/身份提示与 hook 注入**同载体**。收益：

- live：与通道 A 共用同一道白名单，无需给 `context.changed` 另开投影分支；
- history：`message.injected` 进事件投影（project-messages.ts:397），PII 卡从此
  **刷新 / 回放窗口淘汰 / 进程重启后仍可由投影重建**，不再独家依赖壳缓存
  （今天 `context.changed` 被投影忽略，:29）；
- 身份：`appendNotice` 已盖 `noticeMessageIdOf`（:1171），与事件/落盘同 id，
  让位判据（transcript-items.ts:2476-2486）直接可用。

注意保持 `context.changed` 照发（观测面 / TUI 仍消费它），只是**追加**
`message.injected` 事实；`appendNoticeToSnapshot`（无 active run）可同步补一条
`message.injected`（run_id='notice'），或维持现状（该场景无 live 观众，
下一次 run 起点的初始保存 + 刷新即可见）。

**A-口径对账**：`runtime.notice.injected`（observe，承接:'card'）的注释前提
（event-visibility.ts:175-178）修复后重新成立，不动档位。`pii.*` 家族仍 observe
（审计面），用户可见表示只有 env 卡——单一表示不变。

### 方案 B（不推荐）：run 中周期性刷新 detail

治标：即使刷新，PII 卡也不在事件投影里（通道 B），壳又没落盘（run 中不 save），
刷新拿不到；且每次刷新重建历史窗口、作废认领账本（useChatTranscript.ts:402-406
注释记载的「定时闪现」事故正是重复刷新引起的）。代价大、收益残缺。

### 方案 C（不推荐）：默认打开 showInternal / 把 message.injected 整体升 content

会把 llm.request / hook.* / session.saved 等全部内部过程信号放进聊天时间线，
违反三档表「档位由内容性质决定」的口径与 q-msg-visibility 的用户裁决。

## 影响面（方案 A）

| 面 | 影响 |
| --- | --- |
| `apps/web/src/state/event-visibility.ts` | 白名单谓词（或 tier 调整）；`docs/architecture/events.md` marker 表 + `scripts/check-event-visibility.ts` fixture 同步（口径契约：先登记再改表） |
| `apps/web/src/state/events.ts` / `live-items.ts` | `isVisibleForGrouping` 若扩签名，两处调用点同步；fold 的 default 分支会先产 `ev-` 行再被投影分支截走，需确认 `message.injected` 进 fold 后的段边界影响（default 分支带 `flush()`，注入发生在请求之间，正文段已收口，预期无害——修复单须以 fixture 验证） |
| `apps/web/src/domains/chat/transcript-items.ts` | 投影分支已存在，零改动；让位 / 相邻折叠（:2628-2646）自动适用 |
| `packages/core/src/runtime/execution-unit.ts` | `appendNotice` 补 `message.injected`（A-Core）；`appendNoticeToSnapshot` 视裁决 |
| `packages/core/src/session/project-messages.ts` | 零改动（message.injected 已被投影）；PII 卡因此获得投影重建能力 |
| 只读成员视图 / 子 agent | `BodyTranscripts.tsx` / `SubagentTranscript.tsx` 共用 `buildLiveItems` / `runtimeEnvCard`，同收益 |
| TUI | 自有渲染链（`packages/tui`），不受 Web 闸门影响；A-Core 多发一条事件对其无副作用 |
| 去重 / 认领 | live 卡携 messageId，历史落盘后按 id 让位（:2476-2486），不双出；key 不同（`inject:ev-<seq>` vs `notice:<下标>`）但让位判据是 id 不是 key，位置由消息 ts 决定，终态前后一致 |
| 既有裁决 | `isStripCoveredInboxNotice`（纯 pending 抑制）不变；`ENV_MESSAGE_KINDS` / 五 toggle 不变；observe 档审计事件不变 |

### 风险与边界

- **旧数据**：无 `message_id` 的 `message.injected`（0.56 前）保持 internal raw 行，
  不引入重复卡（`injectedNoticeOfEvent` 已要求 id，transcript-items.ts:428）。
- **非 vessel:* 注入**（skill / 附件 / 引用文件）：白名单不放行，仍 internal。
- **回放 / 重连**：`refold` 与 `ingest` 共用 `visible()`（live-items.ts:860），
  白名单对两条路径同口径；可见性切换的整表重折叠（setVisibility）自动覆盖。
- **事件量**：`message.injected` 每条注入一次（每轮 ≤ 5 条总线通知 + inbox 计数去重），
  进 fold 的量级可忽略；`context.changed` 仍全量 internal，不进聊天。

## 验收口径（供修复单）

1. 默认配置（`ui.messageVisibility` 缺省、`showInternal=false`）下，run 运行中：
   `[inbox] N unread` 卡、PII 失效/容量卡、热应用 notice 卡、独立来源卡**即可见**；
2. run 终态历史回填后：同一批卡**不双出、位置不变**（messageId 让位生效）；
3. 纯 `[inbox] N pending` 仍被 PendingStrip 承接抑制（既有裁决不回退）；
4. 打开「系统信息」后行为不回归（raw 行 + 卡单一表示，`runtime.notice.injected`
   仍 observe）；
5. `bun run build` / `check:event-visibility` / transcript fixture 门禁通过。

## 附：关键 file:line 索引

- 闸门：`apps/web/src/state/event-visibility.ts:122`（context.changed internal）、
  `:156`（message.injected internal）、`:174-178`（runtime.notice / injected）、
  `:332-339`（isVisibleInChat）
- 丢弃点：`apps/web/src/state/live-items.ts:437`（ingest）、`:839-841`（visible）、
  `:860`（refold）；`apps/web/src/state/events.ts:981-987`（isVisibleForGrouping）、
  `:1083`（groupEvents）、`:680-700`（default 分支 raw 行）
- 投影：`apps/web/src/domains/chat/transcript-items.ts:416-430`
  （injectedNoticeOfEvent）、`:1651-1669`（live 分支）、`:1313-1329`（历史分支）、
  `:1522-1535`（run 输入 notice）、`:2476-2486`（messageId 让位）、
  `:2628-2646`（相邻折叠）
- 刷新时机：`apps/web/src/domains/chat/useChatTranscript.ts:416-453`（终态刷新）、
  `:474-482`（历史 kind 过滤）、`:163-165`（setItemVisibility）
- 渲染：`apps/web/src/domains/chat/TranscriptWindow.tsx:629-638`；
  `apps/web/src/domains/chat/env-notice.ts:163-170`（runtimeEnvCard）、
  `:491-495`（strip-covered）
- 消息 kind 层：`apps/web/src/state/runtime-kinds.ts:57`（ENV_MESSAGE_KINDS）、
  `:76-89`；`apps/web/src/state/message-visibility.ts:38-39`（默认 true）
- 发射侧：`packages/core/src/runtime/tool-calling-loop.ts:449/:453`；
  `packages/core/src/runtime/execution-unit.ts:4993-5025`（appendInjectedMessages）、
  `:3058-3070`（RunOptions 注入）、`:1162-1185`（appendNotice）、
  `:5344-5390`（addContext / context.changed）、`:2265-2345`（appendPiiDeadNotice）、
  `:2440-2463`（appendNoticeToSnapshot）、`:3111/:3156`（初始/终态保存）；
  `packages/core/src/runtime/run-journal.ts:253-264`（session.saved）
- 生产者：`packages/agent/src/inbox.ts:1086-1166`；
  `src/runtime/runtime-notice-hook.ts:203-250`；
  `packages/agent/src/runtime.ts:1332-1373`（vessel:source）
- 投影：`packages/core/src/session/project-messages.ts:29`（context.* 忽略）、
  `:397`（message.injected → 消息）
- 前序调研：`docs/dev/research/q-display-owner-delta-rootcause.md`（投影缺失那一半）；
  相关 commit：290df5eb（q-display 投影）、b2e8a922（q-from-card source 恒可见）、
  f96a13b1（单一表示去重）---

# Part II · permission 审批卡（rotate）run 中不显示、刷新也不显示

现象（用户实测）：main 调 `agent rotate`，前端不出现 permission 审批卡（无法同意/拒绝），
不停刷新仍不显示 → 工具侧 `approval_timeout`（`packages/agent/src/tool.ts:87`）。
用户裁定：审批请求改变了一个状态值，WebUI 刷新应读取到。

## 结论（先说答案）

审批请求**确实落盘了**（interactions 注册表 + 0600 原子写文件），状态值存在；
缺口在**两条到达路径各断一处**：

1. **live 路径（已验证的结构性根因）**：rotate 审批请求用**裸工具事件流**发布
   （`tool.ts:687` `ctx.events.publish`），绕过了 `publishEvent → RunJournal →
   时间线双写` 这条**唯一事实通道**，因此**永远不会成为会话时间线记录**。
   而当前 Web 聊天走**时间线 epoch 订阅**：gateway 对这类连接**一律不发** hub 环形
   缓冲的广播帧（`gateway.ts:1729`），只发时间线尾随记录（`gateway.ts:2241-2277`）。
   → live 审批卡永远到不了浏览器。**普通工具审批卡没有这个问题**——内置
   `PermissionPolicy` 的请求专门经 `publishEvent` 包装发射（`execution-unit.ts:1089-1092`
   注释原文：「权限请求经 runtime 的 publishEvent，才能保证先落盘再发布」），
   进时间线、live 可见。rotate 是**手搓 publish+waitFor**，没走这条包装。
2. **刷新路径（快照 RPC 可达性）**：刷新重建卡片的唯一来源是 `interactions.list`
   （注册表里**有**这条 pending 记录——裸流发布仍经 bridge → hub raw fan-in →
   注册表登记落盘）。hydration 链路本身完整；但 `interactions.list` **拉取失败时
   卡片同样到不了**——0.59 之前失败被一律当成「空列表」，代码注释明确点名 rotate
   权限卡是受害者（`interaction-hydration.ts:84-85`：「RPC 401 时待批页显示『没有
   待批的提问』……rotate 的权限卡就是这样永远到不了界面」）。0.59 起失败会显示
   提示条（`ComposerSlot.tsx:19-39`），但**卡片仍要等 RPC 成功才补回**。
   另一可达性缺口：**跨节点**——chat hydration 只查本节点 gateway；若浏览器连的
   节点与旋转 body 所在节点不同，本节点注册表没有这条记录（federation attention
   只覆盖待批页，不覆盖会话页 Composer 槽位）。

净效果：live 断（时间线缺口）+ 刷新断（RPC 被挡/跨节点）= 用户看到的「怎么刷都没有」，
工具侧等到 `approval_timeout`。**状态值一直在，是到达路径断了**——用户裁定的方向正确。

## ① 审批卡的数据流（生产 → 持久化 → 渲染）

### 生产侧（rotate 专用，手搓审批）

```
agent tool rotate（packages/agent/src/tool.ts:651-747）
  ├─ 闸门：options.humanApproval === true && service.canConfirm(callerSession)（:684）
  │        canConfirm = entry.mode==='bridge' && parentEvents 存在（runtime.ts:1440-1443）
  ├─ ctx.events.publish({ type:'tool.permission.request', tool:'agent.rotate',
  │        session_id: callerSession, ... })（:687-706）   ← 裸流，不经 journal
  ├─ ctx.events.waitFor('tool.permission.response', { timeout })（:708-714）
  └─ 超时 → ctx.events.publish({ type:'tool.permission.expired', ... })（:733-744）
           ← 同样裸流
```

`ctx.events` 是谁：工具管道的 `events` 端口 = ExecutionUnit 的**裸 `this.events`**
（`execution-unit.ts:1098` → `tool-pipeline.ts:203-214`），**不是** `publishEvent`
（journal 包装，`execution-unit.ts:5999-6012`）。

### bridge 转发（成员 → 父流）

```
entry.events.subscribe（packages/agent/src/runtime.ts:1984-2001）
  → bridgeRequestData 补 agent_id/team_id/session_id/parent_agent_id（:566-604）
  → parentEvents.publish(forwarded)（:1997）   parentEvents = runtimeEvents（bootstrap.ts:1576）
```

### 持久化（注册表，hub raw fan-in）

```
hub.subscribe(raw)（gateway.ts:1468-1470）→ interactions.handleEvent
  → tool.permission.request：pendingPermissions.set + rememberRecord(status:'pending')
    + persist()（interactions-registry.ts:677-723）
  → InteractionsStore.save：<interactionsDir>/interactions-<tenant>.json，0600 原子写
    （interactions-store.ts:326-342）
```

**注意**：注册表吃的是 hub **raw** fan-in（不经脱敏/摘要 map），所以裸流发布的请求
**照样登记落盘**——这就是「状态值存在」的根据。run 终态时该 run 的 pending 转
`orphaned`（interactions-registry.ts:781-803）。

### 渲染侧（Web）

- **live**：WS 事件 → `connection-handlers.ts:191` `addPermission` →
  `permissionFromEvent`（interactions.ts:42-78）→ interactionStore。
- **刷新/重连**：`hydrateInteractions`（use-interaction-hydration.ts:63-66，
  并行拉 `interactions.list` pending + orphaned）→ `buildHydrationSnapshot`
  （interaction-hydration.ts:221-286）→ reducer 合并（:382-439）。
  触发点：连接 hello 后 epoch（ConnectionProvider.tsx:461-464）、切会话
  （ChatView.tsx:175-178）、重连（connection-handlers.ts:249-252）。
- **渲染守卫**：`pendingForSession`（useChatTranscript.ts:371-374）→
  `pendingOwnedBySession`（attribution.ts:212-222，唯一判据 `sessionId === 当前会话`）
  → `pendingQueue` → ComposerSlot → PermissionPrompt（ComposerSlot.tsx:112-124）。
  **渲染层对 run 状态无歧视**：只要请求在 store 里且 sessionId 匹配，卡就画。
- **应答**：`permission.respond` → 注册表 `respondPermission` → 往 hub.stream() 发
  `tool.permission.response`（interactions-registry.ts:822-839）→ bridge 回灌成员流
  （runtime.ts:2004-2037）→ 工具 `waitFor` 收口。**应答链路与时间线无关**——
  只要卡能画出来，点「允许」就能送达。修复只需解决「卡可见」。

## ② 为什么刷新也不显示：三个假设的裁定

- **假设 a「审批态只在内存未持久化」——不成立**。注册表 `rememberRecord + persist`
  同步落盘（interactions-registry.ts:707-721），进程重启后 `loadAllSync` 读回
  （interactions-store.ts:251-306；无活 run 的 pending 转 orphaned 是重启语义，
  与「刷新前端」无关）。
- **假设 b「前端渲染条件 bug」——不成立（渲染层）**。ComposerSlot / pendingForSession
  不看 run 态；sessionId 匹配即渲染。**但 live 供给层有结构性 bug**（见下）。
- **假设 c「审批请求与 session 关联丢失」——不成立**。tool.ts:701 写
  `session_id: callerSession`，bridge 不覆盖已有字段（runtime.ts:580），
  注册表/列表/hydration 全程携带。

**真正的断点**：

### 断点 1（live，已验证）：裸流发布不进时间线，时间线订阅收不到

时间线 epoch 的连接**只收时间线记录**：

- `sendEventToWs`（gateway.ts:1721-1747）第一行：
  `if (ws.data.timelineEpoch === true) return;` —— hub 环形缓冲的广播帧
  （`broadcastEvent`，:1760-1777）对时间线连接**一律跳过**；
- 时间线连接的唯一实时来源是 `fanoutTimelineTailBatch`（gateway.ts:2241-2277），
  数据来自 `opts.timelineTail`（bootstrap.ts:2075 `timelineTailPort(bundle.timelineDualWrite)`）
  ——即**时间线写者 fsync 之后**发布的记录（timeline-dual-write.ts:42-48）。

而一条事件要进时间线，唯一入口是 `publishEvent → journal.appendFact →
dispatchToTimeline`（execution-unit.ts:5999-6012、run-journal.ts:90-110）。
`tool.permission.request` **是事实类型**（不在 `DERIVED_EVENT_TYPES` /
`isExcludedEventType`，timeline/types.ts:345-358）——**只要经 journal 就能进时间线**。
内置 PermissionPolicy 正是这么做的（execution-unit.ts:1090-1092 把 `publishEvent`
作为 emit 包装传进去；permission-policy.ts:74/:180-181 用它发请求）。

rotate 审批就绕过了这一层：`tool.ts:687` 直接 `ctx.events.publish`（裸流）。
裸流发布仍会到 hub（bridge 转发 → runtimeEvents → 双写闸门对「未认领」事件微任务
直通，timeline-dual-write.ts:60/:614-615）→ 注册表登记 + **旧 epoch** 广播；
但**没有 journal 派发 = 没有时间线记录 = 时间线连接永远收不到**。

对照结论：**普通工具审批卡 live 可见（经 journal），rotate 审批卡 live 不可见
（绕过 journal）**——与用户「只有 rotate 审批卡出问题」的实测一致。
`tool.permission.expired`（tool.ts:733）同样裸流，时间线客户端也收不到收卡信号
（Web 靠 `rememberExpiredRequestId` 跨刷新记住 + hydration 收敛兜底）。

### 断点 2（刷新）：interactions.list 可达性

注册表有记录 ⇒ 同节点、RPC 成功时，刷新**应当**补回卡片（链路已验证完整）。
用户环境刷新仍不显示，候选解释按证据强度排序：

1. **RPC 被挡（有代码注释直接点名）**：`interaction-hydration.ts:84-85` 记载
   0.59 前 `interactions.list` 失败（如 401）被当成空列表，「rotate 的权限卡就是
   这样永远到不了界面」。0.59 起失败可见（ComposerSlot 提示条 + 待批页提示），
   但卡片仍要等 RPC 恢复。若用户节点版本早于 0.59，或失败提示被忽略，表现就是
   「刷新也没有」。
2. **跨节点拓扑**：浏览器连的 gateway 与旋转 body 所在节点不同 ⇒ 本节点注册表
   无记录。chat hydration 只查本节点（use-interaction-hydration.ts:63-66 无节点
   路由）；federation attention-client 只服务待批页/CLI（attention-client.ts:110）。
3. **旧版本客户端**无 hydration / 无 interactions.list。

**只读查证步骤（供修复单在用户环境执行）**：
- 浏览器 DevTools 看 `interactions.list` WS 帧：成功？401/forbidden？返回里有没有
  `tool:'agent.rotate'` 的 pending 条？
- Composer 槽位有没有「拉取失败」提示条（0.59+）？
- 节点侧读 `<dataDir>/interactions/interactions-<tenant>.json`：有没有该 requestId
  的 pending 记录？（只读查证，不写生产路径）
- 确认浏览器连接的节点与 main 所在节点是否同一个。

## ③ 修复方案（设计，供后续修复单执行；permission 卡优先）

目标：**审批卡 run 中即出现（与普通工具审批卡同等待遇），刷新必能补回，
超时收卡信号同样可达**。

### P-A（推荐，生产侧，最小改动）：rotate 审批事件改走事实通道

让 rotate 的 `tool.permission.request` / `tool.permission.expired` 经
`publishEvent`（journal）发射，从而进时间线、被时间线订阅实时收到、刷新时可由
时间线回放重建（与正常工具审批卡完全同构）。落点二选一：

- **ToolContext 增一个事实发射端口**（如 `emitFact`），装配侧接
  `ExecutionUnit.publishEvent`（tool-pipeline.ts 构造 ctx 处 + execution-unit.ts
  传入）；tool.ts rotate 的两处 publish 改用它。`waitFor` 仍用 `ctx.events`
  （同一条流，应答照旧到达）。**影响面最小**：只有 rotate 审批改道，其余工具的
  裸流发布语义不变。
- 或把工具管道的 `events` 端口整体换成 publishEvent 包装。**不推荐**：所有工具的
  裸流发布都会进 journal（非事实类型虽被 `isNonFactEventType` 挡掉，但发布时序从
  同步变异步 fsync 后，影响面大，需逐一核对 waitFor / 观察面语义）。

配套：`tool.permission.expired` 同样改道（收卡信号与请求卡同通道）。

### P-B（注册表侧）：expired 收口记录

注册表 `handleEvent` 目前**不处理** `tool.permission.expired`
（interactions-registry.ts:676-804 只有 request/response/终态）：超时后记录仍
`pending`，直到 run 终态才 orphaned。本端浏览器靠 `rememberExpiredRequestId`
不复活死卡，但**换设备/换浏览器刷新**会在「expired 之后、run 终态之前」的窗口里
补回一张点了也没用的卡。建议：expired 事件把记录收口为终态（`orphaned` + reason），
让 `interactions.list` 在任何端都收敛。

### P-C（Web 侧，可达性兜底）：hydration 失败可见 + 跨节点路由

- 0.59 的失败可见（PendingFetchNotice）**保留**，它是「刷新也没有」的最后一道
  自证；修复单验收时确认用户环境版本含此行为。
- 跨节点：chat hydration 增加「按请求归属节点路由 interactions.list」或把
  federation attention 的 pending 并入 chat 的 interactionStore（待批页已有
  attention-client 先例）。此项工作量较大，可作为后续单；P-A 落地后同节点场景
  已闭环。

### 不推荐的方向

- **run 中轮询 sessions.get 找审批态**：sessions.get 不携带权限请求明细
  （requestId/input），拿不到也画不出卡；且重复刷新会作废认领账本（Part I 已述）。
- **把审批卡改成读 member status（waiting_permission）**：状态值只说明「在等」，
  不含请求内容；interactions.list 才是正确的快照源（用户裁定的「状态值」就是它）。

## ④ 影响面（P-A + P-B）

| 面 | 影响 |
| --- | --- |
| `packages/agent/src/tool.ts` | rotate 两处 publish 改事实端口；waitFor 不变 |
| `packages/core/src/runtime/tool-pipeline.ts` / `execution-unit.ts` | ToolContext 增事实发射端口（additive，旧工具不受影响） |
| 时间线 | `tool.permission.request` / `.expired` 本就是事实类型，进时间线无需改类型表；回放/刷新重建自动获得 |
| `packages/serve/src/interactions-registry.ts` | P-B：expired 收口（注意与 run 终态 orphaned 的幂等） |
| Web | 零改动即收益：live 事件经时间线尾随到达 → connection-handlers:191 照常 addPermission；刷新时时间线回放与 interactions.list 双保险 |
| TUI / CLI | 应答链路（hub.stream → bridge → waitFor）不变；TUI 读 raw 流照旧 |
| 既有裁决 | 权限等待不按时间过期（Addendum A）不变；rotate 的 approval_timeout 兜底不变；渲染守卫（sessionId 等值）不变 |

### 风险与边界

- **发布时序**：事实端口经 journal，fsync 后才到订阅者（微任务/IO 级延迟）；
  rotate 的 `waitFor` 在同一条流上等应答，请求晚到几毫秒不影响正确性。
- **双写闸门**：经 journal 的事件会被双写认领（claim），fsync 后放行；写者失败
  fail-open 直通（timeline-dual-write.ts:60），UI 一条不丢——与既有事实事件同口径。
- **旧会话**：legacy（events.ndjson only）会话不支持时间线订阅，走旧 epoch 广播；
  P-A 前后都可见（旧 epoch 收 hub 广播），无回归。
- **重复卡**：live 事件与 hydration 按 requestId 去重（enqueuePermission /
  reducer hasId），时间线回放重建的卡与 interactions.list 补回的卡同 id 不双出。

## ⑤ 验收口径（供修复单）

1. 默认配置、时间线订阅下，main 调 `agent rotate`：审批卡**run 中即出现**在
   会话页 Composer 槽位，可同意/拒绝，应答后工具正常收口；
2. 审批等待中**刷新页面**：卡片必补回（时间线回放或 interactions.list 任一成功即可）；
3. `interactions.list` 被挡时：Composer 槽位出现「拉取失败」提示条（0.59 行为），
   不再冒充「没有待批」；
4. 超时（approval_timeout）后：本端与**换端刷新**都不再出现死卡（P-B）；
5. 普通工具审批卡、ask 卡、待批页行为零回归；`bun run build` + 相关门禁通过。

---

# Part III · 两现象对照与共同修复原则

## ③（任务书）对照：是否同根因？

**不是同一个根因，但是同一个家族**——「用户应见的卡片，其到达路径存在状态/通道缺口」：

| 维度 | I · envcard | II · permission 审批卡 |
| --- | --- | --- |
| 断点层 | **Web 可见性闸门**（事件档位层） | **生产侧事实通道**（core 发布路径）+ 快照 RPC 可达性 |
| 载体事件 | `message.injected` / `context.changed`（internal 档，默认被 LiveItemStore 丢弃） | `tool.permission.request`（observe 档、承接:'card'，档位没问题——**但压根没进时间线**） |
| live 断因 | 事件到了浏览器，被闸门挡在 fold 外 | 事件**到不了**时间线订阅的浏览器（裸流发布绕过 journal） |
| 刷新断因 | 历史窗口只在终态刷新（notice 消息终态才进 sessions.get） | interactions.list 被挡/跨节点（记录本身已落盘） |
| 渲染层 | 无 run 状态歧视（TranscriptWindow:629-638） | 无 run 状态歧视（ComposerSlot:112-124） |
| 修复落点 | Web 闸门白名单 + PII 载体统一（Part I 方案 A） | rotate 发布改事实端口 + expired 收口（Part II P-A/P-B） |

**共同结构教训**：两张卡的渲染组件都「随时可以画」，缺口全在**供给链**——
卡片可见性 = 载体事件到达正确的渲染路径 × 该路径的可见性判据放行 × 快照重建可达。
三者任一断裂，用户看到的就是「状态误区」。

## 共同修复原则（供后续同类卡片参照）

1. **事实通道唯一**：凡用户应见的卡片，其载体事件必须经 `publishEvent → journal →
   时间线`（或消息本体进 sessions.get 投影），不得用裸流发布绕过事实通道。
   裸流只适合「过程信号」（observe/internal），不适合「用户应见事实」。
2. **双路径一致**：live 投影与 history/快照重建必须用同一个卡片入口
   （envcard：runtimeEnvCard；permission：permissionFromEvent / hydration 映射），
   去重按稳定 id（messageId / requestId），终态让位不双出。
3. **快照必可达**：每类卡片都要有一个「刷新就能读到」的权威快照源
   （envcard：sessions.get 消息；permission：interactions.list），且快照拉取失败
   **必须可见**，不得冒充「没有」（0.59 裁决）。
4. **可见性裁定要穿透所有层**：消息 kind 层（ENV_MESSAGE_KINDS）的「恒可见」裁定
   必须同步到事件档位层（EVENT_TIERS）与通道层（时间线事实类型），否则裁定在
   某一层被静默拦截（I 的闸门、II 的 journal 绕过都是这类「裁定未穿透」）。

## envcard 补充发现（Part I 方案 A 的加强证据）

调研 Part II 时顺带验证了 Part I 通道 B（PII notice）的载体在时间线架构下的处境，
**比 Part I 原结论更严峻**，进一步强化「A-Core 统一载体」的必要性：

1. `context.changed` 是**非事实类型**（`DERIVED_EVENT_TYPES`，timeline/types.ts:351-358）
   ——journal 明确不派发给时间线写者（run-journal.ts:107-108）。即 PII notice 的
   live 载体**永远不进时间线**，时间线订阅的浏览器即使闸门放行也收不到它。
2. `context.changed` 的**广播副本被摘要化剥掉 `data.message`**
   （summarize-event.ts:94-111 `summarizeContextChanged`，hub map 必经，
   tenant-event-hub.ts:192）——旧 epoch 连接收到的副本也没有消息本体可供投影。
3. 对照：`message.injected` 经 `publishEvent` 发射（execution-unit.ts:5013-5022），
   是事实类型，**进时间线**——Part I 方案 A 的白名单放行后，通道 A（inbox/总线/
   source）在时间线架构下立即可用；通道 B（PII）必须先做 A-Core（appendNotice 改走
   appendInjectedMessages）才能获得同等载体。**A-Core 不是可选项，是 PII 卡可见的
   必要条件。**

## 附：Part II 关键 file:line 索引

- 生产：`packages/agent/src/tool.ts:651-747`（rotate 审批）、`:687-706`（裸流 publish）、
  `:733-744`（expired 裸流）、`:87`（approval_timeout）；
  `packages/agent/src/runtime.ts:1440-1443`（canConfirm）、`:1984-2001`（bridge 转发）、
  `:566-604`（bridgeRequestData）、`:2004-2037`（应答回灌）、`:1131/:1175-1180`（成员自有流）
- 工具管道：`packages/core/src/runtime/tool-pipeline.ts:203-214`（ctx.events = 裸流）；
  `packages/core/src/runtime/execution-unit.ts:1096-1108`（管道装配）、
  `:1089-1092`（PermissionPolicy 的 publishEvent 包装 + 注释）、`:5999-6012`（publishEvent）
- 事实通道：`packages/core/src/runtime/run-journal.ts:90-110`（appendFact 派发）、
  `packages/core/src/timeline/types.ts:345-358`（非事实类型表）、
  `src/session/timeline-dual-write.ts:42-48/:60/:614-615`（fsync 后发布 / 未认领直通）
- 时间线订阅：`packages/serve/src/gateway.ts:1729`（时间线连接拒收 hub 帧）、
  `:2241-2277`（时间线尾随扇出）、`:2560-2688`（events.subscribe 时间线段）、
  `src/runtime/bootstrap.ts:2075`（timelineTail 装配）、`:1576`（parentEvents）
- 持久化：`packages/serve/src/interactions-registry.ts:677-723`（登记）、
  `:781-803`（终态 orphaned）、`:806-862`（respondPermission）、
  `packages/serve/src/interactions-store.ts:326-342`（0600 原子写）
- 快照 RPC：`packages/serve/src/gateway/methods/interactions.ts:549-654`（interactions.list）
- Web：`apps/web/src/gateway/connection-handlers.ts:123-129/:191-195`（live 入队）、
  `apps/web/src/gateway/use-interaction-hydration.ts:63-99`（刷新重建）、
  `apps/web/src/gateway/interaction-hydration.ts:84-85`（0.59 失败可见注释，点名 rotate）、
  `apps/web/src/domains/chat/ComposerSlot.tsx:19-39/:112-124`（失败提示 + 渲染）、
  `apps/web/src/domains/pending/attribution.ts:212-222`（渲染守卫）、
  `apps/web/src/domains/chat/useChatTranscript.ts:367-384`（pending 派生）
- 摘要化：`packages/core/src/events/summarize-event.ts:94-111/:117-123`、
  `packages/serve/src/tenant-event-hub.ts:186-194`