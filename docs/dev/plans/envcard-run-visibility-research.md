# 环境信息卡 run 中可见性状态误区 · 根因调研与修复设计

日期：2026-07（任务书 q-envcard-run）· 分支 design/q-envcard-run · 调查人 q-envcard-run
性质：**只调研 + 设计，零代码改动**。

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
  f96a13b1（单一表示去重）