# q-scroll-fix 调查：会话定时闪现 + 滚动滑块跳离底部

日期：2026-11-24（分支 fix/q-scroll-fix）
症状（用户报）：打开的会话每隔固定时间「闪现」一下，滚动滑块跳离底部（往上移一大段，看不到最新消息）。
约束：零测试/探针/临时进程；行为验证归用户；唯一门禁 `bun run build`。本调查全部来自真实代码路径阅读。

## 1. 打开会话时仍在跑的周期源（逐一核对）

| 周期 | 位置 | 触达面 | 是否冗余 |
| --- | --- | --- | --- |
| 60s `sessions.list` | `useChatSessions.ts`（usePolledAction） | 只写 sessionStore.sessions（列表）；不碰 detail | 否——chat 订阅是**会话作用域**，别的会话的改动不推送，列表需要兜底；代码注释已声明「轮询是兜底而不是主通道」 |
| 20s roster | `useChatSessions.ts` | agentStore.roster → 会话行地址/徽标 | 否——roster 无推送通道 |
| 15s `health.get` | `NodeProvider.tsx` | nodeStore.health → 在飞徽标 + pending 超时闸 | 否——health 无推送通道 |
| 5s `agents.tree`（仅 running） | `useChatTranscript.ts` contextResource | Composer 上下文用量表 | 否——仅运行中，且只影响输入区 |
| 2s `agents.inbox`（仅条带非空） | `PendingStrip.tsx` | 条带自身 | 否 |
| 1s pending sweep | `usePendingSends.ts` | pendingSends store | 否 |
| 10/30/60s build.json | `useOutdatedBuild.ts` | 顶部「页面已过期」横幅（只提示，绝不 reload） | 否 |

结论：**store 级轮询各有无推送的兜底职责，且都不直接重建转录区**。真正的冗余刷新在
事件驱动的「终态精确刷新」路径上——它实现成了**每次快照版本变化都重扫重发**。

## 2. 根因链（三个互相放大的缺陷）

### R1 终态扫描重复触发全量刷新（冗余自动刷新，用户怀疑的那条）

`useChatTranscript.ts` 的终态刷新 effect：每次 `snapshot.version` 变化都取
`entries.slice(-40)` 重扫，只要尾窗里**还留着任何一条** `run.completed/failed/cancelled`
（或本会话 `session.saved`）就再发一次 `refreshSessions`（= `sessions.list` 全量 +
`sessions.get` 尾页强制重取）。

终态事件在尾窗里会停留到被后续 40 条事件挤出为止。多 agent 会话里事件持续到达
（成员投递 / inbox 通知 / 下一轮 run），于是**一条终态事件会触发几十次重复全量刷新**，
节奏≈事件到达节奏，用户观感即「每隔固定时间闪一下」。注释写的是「终态后做**一次**精确刷新
（150ms 合并）」，实现与注释不符。SSE/WS 已推送终态事件，一次刷新足够。

### R2 内容不变的刷新也作废认领账本（闪现的放大器）

每次强制刷新 → `sessionStore.mergeTailPage` **无条件** `prefix.concat(page.messages)`
分配新 messages 数组（即使逐字节没变）→ `buildHistoryIndex` 按引用 memo 失效 →
`ClaimLedger` 身份（`history` 按引用比较）失效 → 整表重判（`invalidated → fresh`，
不走单调并集）→ 整条 item 流重建。

账本设计（DESIGN.md §4.2「一次性判定 + 单调粘住」）的前提是「历史窗口引用变 = 窗口换了一份
历史」；R1 的冗余刷新让「引用换了但内容没换」成为常态，粘住形同虚设。重建期间任何
让位结论/身份键的微小差异（`itemKeyOf` 撞号退回绝对下标、窗口夹取、让位集合重算）都会
换 key = React 重挂 = 闪现；内容高度瞬时变化还会把 scrollTop 夹下去。

### R3 followKey 盲区（跳上去就回不来的直接原因）

`TranscriptWindow` 的 `followKey = snapshotVersion:renderedGroups.length`。
detail 刷新重建 item 流时**没有新事件、组数不变** → followKey 不变 → 贴底跟随不触发。
于是重建把内容高度瞬时改变（或 DOM 重挂让浏览器滚动锚定失效）后，scrollTop 停在
被夹下去的位置：滑块「往上移一大段」，且不会自己回到底部。
Team 页同一问题早已用「末条消息身份」做 followKey（`team-scroll.ts#teamFollowKey`），
会话页没有对齐。

## 3. 修法（最小三件，互相独立）

1. **R1**：终态扫描加 seq 水位——只有**新于水位**的终态/session.saved 才触发刷新；
   水位随 selectedId/epoch 复位（seq 空间变化），seq 回退时退回重扫（与
   `usePendingSends` 的水位同一形状）。每条终态事件恰好一次精确刷新，恢复注释语义。
2. **R2**：`mergeTailPage` 合并路径里，新尾页与缓存尾段**逐条全等**时复用缓存 messages
   引用（其余 detail 字段照常更新）。内容不变的刷新不再作废 historyIndex/认领账本/item
   memo——零重建、零闪现。比较用逐条 JSON 全等（同一 `sessions.get` 序列化，字段序稳定；
   窗口 ≤50 条 × 8KiB，刷新频率下代价可忽略）。
3. **R3**：followKey 追加 `items.length:末项key`。贴底时任何 item 流变化（含 detail
   刷新带来的重建/追加）都重新贴底；用户上滚（未 pinned）时跟随不动，阅读不打断。

不删任何 store 级轮询（§1 表：各有无推送的兜底职责）；不碰主 checkout；行为验证归用户。

## 4. 门禁

`bun run build`（exit code + 产物读数）记录于 `docs/dev/tmp/q-scroll-fix/gates.log`。