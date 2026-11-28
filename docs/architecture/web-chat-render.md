---
title: Chat 渲染链（单一 item 流 → 卡片）
kind: current
triggers: [chat, transcript, 渲染, 时间线, item, 认领, claiming, message_id, 投影卡, projection, 入场, sticky bottom, 吸附, 会话索引, minimap, pending, 回显, 排队条带, 图片卡, blob, 子 agent, 交接卡, rotate handoff, 日分隔, 垂直节奏]
paths: [apps/web/src/domains/chat/transcript-items.ts, apps/web/src/domains/chat/timeline-order.ts, apps/web/src/domains/chat/chat-visibility.ts, apps/web/src/domains/chat/tool-cards.ts, apps/web/src/domains/chat/history-tools.ts, apps/web/src/domains/chat/projection.ts, apps/web/src/domains/chat/projection-card.tsx, apps/web/src/domains/chat/projection-readback.tsx, apps/web/src/domains/chat/Transcript.tsx, apps/web/src/domains/chat/TranscriptWindow.tsx, apps/web/src/domains/chat/StreamItems.tsx, apps/web/src/domains/chat/StreamCard.tsx, apps/web/src/domains/chat/EventRow.tsx, apps/web/src/domains/chat/ToolCard.tsx, apps/web/src/domains/chat/ToolImageCard.tsx, apps/web/src/domains/chat/AgentMessageCard.tsx, apps/web/src/domains/chat/ReasoningBlock.tsx, apps/web/src/domains/chat/SubagentTranscript.tsx, apps/web/src/domains/chat/EnvCard.tsx, apps/web/src/domains/chat/AskAnswerCard.tsx, apps/web/src/domains/chat/ask-answered.ts, apps/web/src/domains/chat/useAnsweredAsks.ts, apps/web/src/domains/chat/useChatTranscript.ts, apps/web/src/domains/chat/useStickyBottom.ts, apps/web/src/domains/chat/sticky-bottom.ts, apps/web/src/domains/chat/conversation-index.ts, apps/web/src/domains/chat/useConversationIndex.ts, apps/web/src/domains/chat/ConversationIndex.tsx, apps/web/src/domains/chat/pending-sends.ts, apps/web/src/domains/chat/pending-placement.ts, apps/web/src/domains/chat/pending-strip.ts, apps/web/src/domains/chat/usePendingSends.ts, apps/web/src/domains/chat/PendingBubble.tsx, apps/web/src/domains/chat/PendingStrip.tsx, apps/web/src/domains/chat/image-blob-cache.ts, apps/web/src/domains/chat/image-preview.tsx, apps/web/src/domains/chat/attachment-lightbox.tsx, apps/web/src/domains/chat/rotate-handoff.ts, apps/web/src/domains/chat/RotateHandoffCard.tsx, apps/web/src/domains/chat/inbox-read.ts, apps/web/src/domains/chat/agent-sender.ts, apps/web/src/domains/chat/agent-labels.ts]
---

# Chat 渲染链（`apps/web/src/domains/chat`）

> 事件流与已落盘消息 → 单一 item 流 → 卡片。既有家只链接不复制：块协议 [blocks.md](blocks.md)；排序细则 / StreamCard 结构 / 动画 / 折叠约定 [WEB-UI.md](../WEB-UI.md)；可见性解析与网关客户端 [gateway-web.md](gateway-web.md)；环境卡解析 [env-info-append-only.md](env-info-append-only.md)；回放协议 [session-replay.md](session-replay.md)；服务端投射机制 [session-length.md](session-length.md)。

## 1. 单一 item 流（`transcript-items.ts:buildTranscriptItems`）

- 渲染不分「运行态 / 终止态」两条路径：事件流（`state/events.ts:buildGroup` / `state/live-items.ts`）与 `sessions.get` 历史都只是 item 来源；同一逻辑对象两边都在时是**同一个 item**（身份靠 key）。工具运行→结束只改字段，不产生新 item、不重挂。
- 身份 key 词表（文件头是权威）：`msg:id:<message_id>`（服务端盖的稳定 id，首选）；`msg:<runId>:<role>:<ts>` 结构化身份（缺 `run_id` / 撞号退回绝对下标）；`run:<runId>:text|reasoning:<seq>`（seq = 该段**首个** delta 的 wire seq，段生命周期内恒定）；`tool:<callId>`；`notice:<runId>:<role>:<ts>`；`ask-answered:<requestId>`；`run:<runId>:input` / `run:<runId>:failure`。
- 为什么不锚绝对下标 / 段序：历史窗口被裁一次下标整体错位，React 会把 DOM 交给另一条消息；回填插入更早段会让后续段全部换号（动画重播 + 认领错位）。
- 去重 = **认领（claiming）**：同 `message_id` ⇒ 只渲染一次（历史那份胜，位置 / 操作按钮都是历史的）；身份缺失退回 `run_id` + `run_segment`，再退回内容相等；认不出就两边都渲染——宁可重复，绝不吞消息。同 id 落盘两份：历史侧丢弃后者 + 计数 + 首次 warn（`noteDuplicateIdentity`）。`run:<runId>:input` 落盘后按身份让位给历史项。
- 特殊输入的呈现：`vessel:*` 运行时上下文 → `runtime-notice` item（环境卡解析见 env-info-append-only）；`rotate:handoff[:<epoch>]` → 交接卡（`rotate-handoff.ts`，字面量与 `packages/agent` 的 `ROTATE_HANDOFF_INPUT_NAME` 一致，解析失败回退普通气泡）；`ask:answer` → 待批答复卡（身份解析 `ask-answer.ts` 归 gateway-web，卡片数据 `ask-answered.ts`）。

## 2. 排序与可见性（消费侧）

- 排序唯一实现 `timeline-order.ts:compareTimelineEntries`：ts 主序（缺 ts 排最后），同 ts 回退 wire seq，再退回插入序。run 级落位规则（live 块 / 伪 run 组 / 失败卡位置）见 WEB-UI.md「时间线渲染顺序」。seq 语义 = **到达序**（TimelineWriter 写 WAL 时分配），全部依赖点清单在 `timeline-order.ts` 头注释。
- `chat-visibility.ts`：live 与 history **共用同一判定**（`toolVisible` / `reasoningVisible` / `eventRowVisible` / `filterTimelineItems`），运行中与终态必须同时可见或同时隐藏。minimal 档只留正文 / notice / **失败**（失败永不静默）；工具卡被藏（minimal 或 tools toggle 关）且 run 在跑且最后工具项 running → `runningToolHint` 一行补偿。
- 五类消息 toggle（`ui.messageVisibility`）与 verbosity 档位的解析口在 `state/`（见 [gateway-web.md#state](gateway-web.md#state)）；本链只消费，不另写判定。

## 3. 投影卡渲染侧（`projection.ts` / `projection-card.tsx` / `projection-readback.tsx`）

- 纯逻辑在 `projection.ts`（无 React / DOM）：badge 词表（`placeholder` / `externalize` 出 badge；`archive_notice` / `passthrough` 不出）、默认视角、readback 请求与抽帧、汇总数字口径。
- 三条纪律：合并按 `tool_call_id`（`projectionIndexByCallId`），不按数组下标；模型视角文本 = wire 的 `placeholder_text` **逐字**（`modelViewTextOf`）；体量 / 行数**只读 wire**，绝不从正文 parse（尾部裁切会错数）。

## 4. 窗口、滚动与索引

- `useChatTranscript.ts` 编排：会话 detail 是连续窗口 `[start, end)` + `next_before`（`sessionStore`，页大小 `TRANSCRIPT_WINDOW = 50`）；实时组上限 `MAX_LIVE_GROUPS = 200`；`ClaimLedger` / `buildHistoryIndex` 供认领与回溯。
- `TranscriptWindow.tsx`：距顶 ≤ `EARLIER_TRIGGER_PX`（200）前插一页，连续补页上限 `AUTO_PAGE_BUDGET = 20`；入场门 `useEnteringItems`（首屏 ≤ `FIRST_SCREEN_APPEND_MAX` = 2 条算真追加，一大批 = 回填 / 回放不播；类名挂上不摘，稳定 key 复用不重播）。
- `Transcript.tsx`：日分隔（`dayKeyOf` 按 item WeakMap 缓存）；system / tool 消息不进 DOM 也不留空锚点；`.transcript-row` content-visibility 跳过视口外行；`data-index-entry-key` 只挂「人打的字」（`isIndexUserMessage`），`data-quote-anchor` = `message_id` 挂所有稳定消息；垂直节奏统一 `gap-2`（8px），角色切换更大一档由 `styles/domains/chat.css` 行级 `:has` 补（q-chat-spacing）。
- `sticky-bottom.ts`：距底 ≤ 96px 视为 pinned，只有 pinned 才跟随；跟随节流 100ms、不做 smooth；打开 / 切会话双帧等 `scrollHeight` 稳定（≤30 帧兜底）；发送被受理强制贴底（`stickToBottom('send')`）。
- `conversation-index.ts`：minimap 只给「人打的字」一个 dot，判据唯一（`isIndexUserMessage` / `isIndexUserRow`，锚点侧 import 同一组）；上限 `MAX_INDEX_ENTRIES = 50`。团队页 / 成员 body 页复用同一映射。

## 5. 卡片与子 agent

- `StreamCard` 是唯一卡壳（四槽卡头 / children 决定展开，结构与交互约定见 WEB-UI.md）；`ToolCard` / `AgentMessageCard` / `EnvCard` / `AskAnswerCard` / `RotateHandoffCard` / 失败卡都复用，不自造卡头。工具项折叠在 `tool-cards.ts:foldToolItems`，历史 tool 消息在 `history-tools.ts:buildHistoryToolItems`。
- `EventRow.tsx`：原始事件行，档位取自 `state/event-visibility.ts:tierOf`（三档表与登记义务见 [events.md#event-visibility](events.md#event-visibility)）。
- `SubagentTranscript.tsx`：`?agent=` 深链；`buildGroup` 把 child run 的 `subagent.*` 事件归一成普通 run 事件复用 `RunItems`。**登记的过渡例外**：仍从 entries 批量分组，受环形缓冲裁剪影响（早期子 agent 事件被淘汰会缺行），待 item 物化后修。
- 发言人名唯一实现 `AssistantSpeaker`（`ReasoningBlock.tsx` 导出，live 与历史共用）；发送方解析 `agent-sender.ts`，成员名展示 `agent-labels.ts`。

## 6. 待发送回显与图片卡

- `pending-sends.ts`：`PendingSend` 状态机（sending / queued / sent / failed / deferred）；`runId` 是首选合并键，`messageId` = 服务端队列条目（`agent.message.queued`）的同一身份；超时 sweep 移除，重试刷新 `createdAt`。
- `pending-placement.ts`：「这条消息此刻该画在哪」的**唯一判据**——sending = 灰态气泡、queued = 只在条带、sent = 只留服务端回显、failed = 条带 + 重试 / 编辑；`claimsEntry` 客户端 pending 认领服务端 inbox 条目（`message_id` 优先，缺失退「同会话 + human 源 + 摘要同口径」），被认领条目不再单独渲染。
- 图片卡（q-media-image-card）：`ToolImageCard.tsx` 是 media `action=view` 注入消息的结构化呈现（CardShell + RefCardRow + 投递状态 chip）；字节经 `images.blob`（客户端见 gateway-web）；`image-blob-cache.ts` = sha256 → data URL 的 LRU（64 条、只缓存成功、inflight 去重；缓存键不含 session_id——字节必是本 viewer 已过闸取到的，首取仍带 session_id 过服务端归属闸）；放大经 `image-preview.tsx` / `attachment-lightbox.tsx`。