---
title: Web 客户端 stores（zustand 域 store 与资源快照）
kind: current
triggers: [store, zustand, stores, configStore, sessionStore, runStore, interactionStore, uiStore, composerDraftStore, nodeStore, teamStore, agentStore, 草稿, draft, 资源快照, ResourceState, generation, 乐观 overlay, settingsPending, 轮询]
paths: [apps/web/src/stores/**]
---

# Web 客户端 stores（`apps/web/src/stores`）

> 客户端域 store 层：zustand 单例 + 与 `state/useResource.ts` 同一份 `ResourceState` 契约（idle / loading / success / error，刷新保留旧数据、稳定错误码；SWR 语义见 [data-refresh-swr.md](data-refresh-swr.md)）。服务端事件的实时状态（快照 / 流式 chunk / 组缓存）**不复制进 stores**，留在 `state/events.ts` / `event-store.ts`（见 [gateway-web.md](gateway-web.md) / [session-replay.md](session-replay.md)）。

## 1. 公共底座

- `store-resource.ts`：store 侧资源助手（`beginStoreLoad` / `storeSuccess` / `storeFailure`）+ **请求代际 guard**（`nextGeneration` / `isCurrentGeneration` / `invalidateGeneration`）——旧轮询响应永远不能覆盖新响应；连接 epoch / 重置时作废旧代际。
- `usePolledAction.ts`：store 资源的 effect  runner——enabled 立即跑一次再轮询；页面隐藏暂停；action 经 ref 读取（内联回调不重触发 effect）；deps 必须是 JSON 可序列化原语（与 useResource 同契约）。
- `useConfigStoreApi.ts`：configStore 的 React 绑定，与纯 store 分离（store 单测不加载模块顶层读 `window` 的 ConnectionProvider）；按需开 config / capabilities / sources 与 pollMs。

## 2. 各域 store（唯一写者与读侧）

- `configStore.ts`：`config.get` / `config.sources` / `capabilities.list` 的**单一来源**。工具卡与工具策略弹窗同读这一份，策略写成功经 `applyPermissionLists` 本地回写，不发第二次 `config.get`；chat 可见性 / hub / diagnostics / display 等所有 config 消费者共享同一快照。「已为某连接加载」按 client 身份（WeakMap）+ epoch 判定。
- `sessionStore.ts`：会话列表 + 选中 id + 当前 detail。detail 不是完整 transcript，是连续窗口 `[start, end)`（绝对下标）+ `next_before`（CONTRACT-msg-system §4.3）；`messages` 保持未过滤数组，可见性过滤在 UI 层。页大小 `TRANSCRIPT_WINDOW = 50`；`windowHasEarlier` 是「还有更早」的唯一推导；`SESSION_NOT_FOUND_MESSAGE` 哨兵区分被删会话与真失败；历史前缀被改写 → `HISTORY_CHANGED_NOTICE` 一次性提示。
- `interactionStore.ts`：pending permissions / asks + 应答中 id（`responding`）+ orphaned id 的单一来源。**ConnectionProvider 是唯一写者**（WS 事件 / `interactions.list` hydration / respond 生命周期）；纯合并规则在 `gateway/interaction-hydration.ts:interactionReducer`（桥侧事实见 [gateway-web.md](gateway-web.md)）。读侧：Composer 槽位卡片、Team 条带、全局待批栏、侧栏计数。
- `nodeStore.ts`：节点列表（当前 WS node + sessionStorage extras）、选中节点、每节点最近 `health.get`。**NodeProvider 是唯一写者**；平台模式下 `platform.nodes.list` 是唯一节点来源（`setPlatformNodes` 替换 extras / current）。
- `runStore.ts`：live / durable runs 与 diagnostics（health / events），按 node 键控；每节点独立代际 guard。
- `teamStore.ts`：每节点 team 列表 + detail / members 窗口。detail 按 `node:team:variant` 键控——详情头的 summary（`limit=1`）永不覆盖聊天窗口的 member / message limits。
- `agentStore.ts`：跨节点 roster（teams + members，经 `gateway/team-roster.ts:fetchNodeRoster`）+ 从列表打开的当前 agent（深链仍以路由为准）；roster 条目带 engine state / session id（列表的运行 / 会话摘要）。
- `uiStore.ts`：纯本地偏好——theme（`vessel.theme` 是唯一持久化键，写经 `setTheme` → `storeTheme`）+ `settingsPending` 稀疏乐观 overlay（只存写确认中的键值，**不落盘**）。服务端 config 不在此缓存：`configStore.config` 是 ui.* 的唯一来源（设置写路径见 [WEB-UI.md](../WEB-UI.md)「写路径」）。

## 3. Composer 草稿（`composerDraftStore.ts`）

- 正文 + mention chips + 待发送引用 + 会话引用 + 消息引用按 key 保存：切页面 / 切会话 / **刷新**都恢复。存储是 `sessionStorage`（不是 localStorage）：同标签页刷新可恢复，关标签即清；草稿因此多一份浏览器磁盘副本（用户明确要求的取舍）。
- key：会话 `chat:new` / `chat:<sessionId>`，团队 `team:<nodeKey>:<teamId>`。
- 有界：单条正文 ≤ 32 KiB（UTF-8 超出截断保前缀）；最多落盘 50 槽（按最后写入淘汰，内存仍全量）；引用单槽 ≤ 32 条（与 core `Message.refs` 同上限）；会话引用单槽 ≤ 8 条（按 sessionId 去重）；消息引用单槽只持一条（引用是「回复哪一句」的指向）。
- 落盘节流 debounce 300ms；`pagehide` / `beforeunload` / 转后台同步 flush；SSR / 隐私模式懒 hydrate + 全程 try/catch，失败静默降级纯内存。
- 分层：stores 不反向 import `domains/**`——chips / refs 只用结构类型（`ComposerChip` / `ComposerSessionRef` / `ComposerQuote`）；发送成功后调用方 `clear(key)`；选择器未命中回退**冻结空值**（`Object.is` 快照比较要求引用稳定）。