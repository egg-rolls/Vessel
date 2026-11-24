# q-display · 问题2根因注记：owner 工具/上下文变化，前端为何显示 self card 而非增量消息

日期：2026-07-20 · 分支 fix/q-display · 调查人 q-display

## 结论（先说答案）

**owner 路径并不重建 self card。**「工具变化事件给 agent 看一张新 self card」这个前提
**不成立**——self card 是构造期一次性只读快照（CONTRACT-prefix-invariant 守住），工具变化
走的是与成员**同一条**增量通道。真正的病灶在 **Web 渲染侧**：模型看到的那条增量消息
（`vessel:notice`）在 live 时间线里**没有投影分支**，被当成内部原始事件行藏掉了；用户
运行中只能看到 `prompt.system_context` 投出的**整张 self card 快照卡**。

## 发射侧（owner 与成员已是同一套增量通道）

- owner self card：`src/tenant-runtime-factory.ts` `ownerSelfCard(...)` 一次性构造，经
  `overrides.selfCard` 交给 EU；EU 内 `private readonly selfCard`，**工具变化不重建**。
- owner 工具变化：`packages/core/src/runtime/execution-unit.ts` `appendToolSurfaceNotice`
  （注释明示「工具面变更卡的**唯一生产者**，owner / member / MCP 同一通道」）→ diff
  已报工具面 vs live host → `appendInjectedMessages` 注入一条 `vessel:notice`（scope
  `tools`，正文 `tools: N added; …` + `+ name — desc` / `- name` 增量行）。
- owner 上下文 / 模型变化：同文件 `appendSystemRevisionNotice`（scope context）/
  `appendModelChangeNotice`（scope model，注释「owner 与成员同一套」）。
- 成员身份/模型/上下文增量：`packages/agent/src/self-card-delta.ts`（BeforeLlm hook）→
  同样经 `appendInjectedMessages` 注入 `vessel:notice`。
- **形状一致**：都是 `role:user, name:vessel:notice`，scope 词 + 增量行；Web `env-notice.ts`
  同一套解析渲成环境信息卡。scope 词表两侧都含 `tools/model/identity/context`（已核对
  `env-info-scope.ts` 与 `env-notice.ts`）。

## 渲染侧（病灶所在）

这些增量消息统一经 `appendInjectedMessages` 落 `message.injected` 事件 + `addContext` 持久化
（`execution-unit.ts:4983`，每条盖稳定 `message_id`）。而 Web：

- `apps/web/src/state/event-visibility.ts`：`message.injected` 归 **internal 档**（默认隐藏）。
- `apps/web/src/domains/chat/transcript-items.ts` `buildLiveItems`：对 `message.injected`
  **没有投影分支** → 落进末尾「notice / 原始事件」兜底（`kind:'notice'` 原始行，internal 档
  默认不显示）。于是**运行中用户看不到这条增量卡**；只有 run 终态后 `sessions.get` 历史
  回填，才由历史侧 `noticeKindOf → envNoticeCard` 渲成环境信息卡。
- 与之对照，`prompt.system_context` 是 **content 档（live 可见）**，`buildLiveItems:1598`
  专门投成 `prompt-context` 卡——**卡体恒为整段 system prompt + self card 全量快照**，
  只有折叠摘要在 `changed` 有值时才是增量。

**净效果**：模型真实看到的那条 `vessel:notice` 增量消息，运行中被藏（internal 档原始行），
直到 run 结束历史回填才出现；而 live 可见的环境卡只有 `prompt.system_context` 的整张
self card 快照（它在快照 hash/model/toolsCount 变化时触发——上下文改写、换模型、压缩/
重启后重钉工具面导致 toolsCount 变等；注意会话内工具面被 `ensureToolPin` 钉住，纯热应用
工具增减本身不改 toolsCount，故那一刻可能连快照卡都没有，用户只看到「什么都没提示」）。
无论哪种，用户都看不到模型那条增量消息——这正是「看到 self card（或 nothing）而非模型
看到的真实增量消息」。owner 与成员同病（都走 message.injected）。

## 修向（最小侵入，守 prefix-invariant）

不动 self card、不动发射侧（已是增量）。只在 `buildLiveItems` 给 `message.injected` 里
`name` 为 `vessel:*` 的消息补一条投影分支：与历史侧同一套 `envNoticeCard` 解析、同一种
`runtime-notice` item，携 `message_id` 让位（历史落盘后按 id 合并，不出现第二张卡）。
这样增量卡在运行中即可见，与成员/历史完全一致。self card system 前缀只读，不热替换。