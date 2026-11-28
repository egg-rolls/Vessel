---
title: Agents / Team UI（roster 视图与群聊交互）
kind: current
triggers: [agents, team, roster, 成员, 群聊, mention, @, 提及, member detail, body history, 角色转换, promote, demote, peer, contractor, 乐观发送, teams.get, 轮询, 成员窗口, 团队页, 成员详情]
paths: [apps/web/src/domains/agents/**, apps/web/src/domains/team/**]
---

# Agents / Team UI（`apps/web/src/domains/agents|team`）

> 本叶只管 **UI 侧面**（视图组合 / 交互 / 乐观发送 / 窗口分页）。成员 / 临时的定义、数据模型、创建路径与转换设计是 [agent-structure.md](agent-structure.md) 的事实（共享锚点各管一面）；canonical `agents.*` / `teams.*` 服务端契约见 [gateway-rpc.md](gateway-rpc.md)；选择状态持久化（sessionStorage 键表与口径）见 [WEB-UI.md](../WEB-UI.md)「UI 选择状态持久化」；客户端 store 形状见 [web-stores.md](web-stores.md)。

## 1. Agents 域（跨节点 roster）

- `AgentsView.tsx`：列表数据 = 每节点 `teams.list` + `teams.get`（经 `gateway/team-roster.ts:fetchNodeRoster`，store 在 `agentStore`）；CRUD 走 canonical `agents.create|update|close`（单条批量形状，`{results:[{ok:false}]}` 失败严格上报，不静默）。
- 深链 `#/agents/<nodeKey>/<agentId>[/edit]` 由本域直接识别（`agent-url.ts`，不进 `app/router.ts` 的 Route）；`?body=<sessionId>` = 该成员只读会话正文深链；查询串保留列表过滤。名称优先、缺失回退短 id；原始 `agent_id` 只在 Advanced details 出现。
- `agent-form.ts`（纯函数）：创建判别 `kind: peer|contractor`（服务端映射 member / temporary）；**peer 必须绑 Team**（`peer_requires_team` 内联校验），contractor 可 unbound；创建始终发 `kind`、空字段省略；编辑只发真正变化的字段，零变化返回 `no_change` 由 UI 提示，不发空请求。
- `AgentDetailView.tsx`：Team 成员复用 `MemberDetail` 嵌入模式（**唯一一份成员面板**）；无 Team 归属退回键值信息；数据复用列表已加载 roster。Close 走警告确认。
- `agent-search.ts` / `agent-errors.ts` / `useAgentBreadcrumb.ts`：过滤、错误文案与面包屑辅助。

## 2. 成员详情与角色

- `MemberDetail.tsx`：当前 Body + 已退役 Body + 旧 Body 只读 transcript；**不渲染标题栏**（身份 / 作用域 / 状态由调用方 `EntityHeader` 负责）。Body 历史优先服务端 `member.body_history`，字段缺失才用 `agent.retired` 的本次页面观察值并明确标注。提供需确认的新建 session（`sessions.create` 无来源）；不提供配置 / close。
- `role.ts`：role v3 展示助手。旧 gateway 的 `single` 在 `roleOf` **唯一一处**降级为 member；缺 `role` 按 owner 推断（无 owner = member，有 = temporary）。roster 排序 members 先、temporaries 后（`groupMembersByRole`）。
- `RoleConversionSection.tsx`：转换动作 = `conversionActions`（member ↔ temporary，省略 no-op）；temporary → member 需 Team（`member_requires_team` 内联校验镜像服务端）；写经 `agents.update`。
- `member-status.ts`：三层状态彼此独立——`membership`（present / left）、`presence`（live / gone）、engine `state`；展示优先级固定 **left > gone > state**（不把离线成员显示成「正在工作」）。
- `BodyTranscripts.tsx` / `BodyHistory.tsx`：旧 Body 只读转录，复用 `useRuntimeVisibility` 与 chat 的 `conversation-index` / `EnvCard`（同一套可见性与索引判据）。

## 3. Team 群聊（`TeamChat` / `useTeamChat`）

- **权威消息源只有轮询** `teams.get`（`TEAM_POLL_MS = 4000`）；`run.*` / `agent.*` 事件只让 roster 与日志失效（定向 reload，roster cooldown 2s），**不构造消息正文**。事件合并纯函数在 `state/teams.ts`（`applyTeamEvent` / `mergeMessages` / `sortMessages`）。
- 发送**串行**（`teams.post` 无幂等键）：发送期间停轮询，成功后 reload 对账；失败不自动重试，reload 找不到同内容消息才标 failed；「再次发送」只把内容填回 Composer，由用户再次确认后作为新日志。
- `team-send.ts`：乐观行只在服务端还没有同 `message_id` 时渲染；回执到达后同一行换成真实 `message_id`（React key 换 = 重挂，入场动画据此不播第二次）；无幂等键 ⇒ 失败后只能按 content + mentions + ts 对账。
- `team-window.ts`：消息分页走 `teams.get.before` 游标（尾页 `DEFAULT_LIMIT = 100`，`messages_has_more` 驱动）；成员窗口是服务端排好序的 `members_limit`：缺省 20、每次 +80、封顶 100（DECISION-038），到顶仍更多 → `capped` 提示「仅显示前 100」。
- `team-scroll.ts`：吸附滚动 resetKey 只看「打开 / 切换 + hydrate」，followKey 只看最后一条消息身份——前插更早历史不触发跟随。
- 组合：`TeamChatMain` / `TeamChatMembersAside` / `TeamMemberSidebar` / `TeamTranscript` / `TeamMessageRow` / `TeamPendingBar`（待批条带，interactionStore 读侧见 [gateway-web.md](gateway-web.md)）。

## 4. @ 提及与输入框

- `mention.ts`（纯函数）：候选只从 `membership === 'present'` 的 roster 生成；触发 = 光标前最后一个 `@` 后无空白（位置不限，中文正文后直接接 `@` 也算），email / 路径形态排除（`detectMention`）；提交的是结构化 `agent_id`，正文里没有 chip 的 `@name` 只是普通文本，**不提供从正文反解 mention**。正文 UTF-8 上限 64 KiB（`MAX_MESSAGE_BYTES`）。
- `MentionPopover.tsx`：候选列表渲染；键盘与 ARIA 在 `TeamComposer.tsx` 处理，焦点始终留在 textarea。
- `TeamComposer.tsx`：受控 value + mention chips；Enter 发送 / Shift+Enter 换行 / IME composition 内不响应；外观与会话页共用 `ComposerField` / `.composer-input`（引用区 / 字段容器 / 工具栏三层结构约定见 [agents/web.md](../agents/web.md)）；空白点击进输入框（`focusComposerInputOnBlankClick` 与会话页同一份）。草稿 / chips / refs 持久化在 `composerDraftStore`（见 [web-stores.md](web-stores.md)）。