# permission 审批卡汇集进「待批」页 —— 审计结论与实施清单

- 分支：`feat/q-permission-pending`（基线 `redblue-dev` @ 06f605fa）
- 任务来源：用户直接指示「permission 的卡片不会汇集在待批页面，加入进去」；main 调研 + 本 agent 复核。
- 状态：① 审计（本文档）→ ② 实施 → ③ build 绿证据。

## 1. 根因（复核确认，与 main 调研一致）

数据已到位，只缺 Web 消费侧：

1. **待批页只消费 ask**：`apps/web/src/domains/pending/PendingView.tsx:30` 只解构
   `useConnection().asks`；`:46` `groupPendingAsks(asks, attribution)`。文件头注释自述
   「所有待回答的 ask 提问」。`permissions`（`gateway/connection-context.ts:75`
   `permissions: readonly PermissionRequest[]`）完全未进入待批页。
2. **服务端两种 kind 都返回**：`packages/serve/src/gateway/methods/interactions.ts`
   `collectInteractions`（193-249 行）合并 `interactionRecords` / `pendingPermissions` /
   `pendingAsks`，无 kind 过滤；`interactionRecords` 分支对两种 kind 都携带
   `agent_id` / `team_id` / `session_id` / `parent_agent_id`（201-204 行）。
3. **hydration 已重建两者**：`apps/web/src/gateway/interaction-hydration.ts`
   `buildHydrationSnapshot` 同时重建 permission / ask（hydration-anon 5c42b487 修复面，
   本任务不动其闸门）。
4. **聚类只吃 ask**：`domains/pending/cluster.ts:72` `groupPendingAsks(asks, …)`；
   `PendingClusterCard` 只渲染 ask 题块（逐题勾选 + `usePendingBatch` 批量提交）。

## 2. 复用面（已核实，实施时原样复用，绝不另造卡面）

| 件 | 位置 | 要点 |
| --- | --- | --- |
| `PermissionCard` | `domains/chat/PermissionCard.tsx:48` | props `{request, busy, connected, onDecide(decision, scope)}`；tool badge + input 折叠（12 行 / 20k 上限）+ deny / allowOnce / allowSession / always 四键。卡面文案全走 `permission.*` i18n。 |
| `respondPermission` | `gateway/node/sessions.ts:172` | → `permission.respond` RPC（`request_id` + decision/scope）。 |
| 收口 / 错误处理 | `gateway/use-interaction-responses.ts` | `respondPermission` 已内置：SubmitGuard 单飞、`responding` 集合、`run_ended` / `not_found` / `expired` → settle + toast.info，其它失败 → `hydrateInteractions` + toast.error。**待批页直接调 `useConnection().respondPermission` 即获得与 composer 完全相同的语义**，无需镜像实现。 |
| composer 接线参照 | `domains/chat/ComposerSlot.tsx` | `PermissionPrompt.onDecide` 只是转发到上层 `respondPermission`；错误处理不在卡侧。 |
| composer 外复用先例 | `domains/team/TeamPendingBar.tsx` | 已包 `PermissionCard`：`busy=responding.has(id)`、断连禁用、`onDecide→respondPermission`。待批页照此接线。 |
| ask 批量机制 | `domains/pending/usePendingBatch.ts` | 逐题勾选 / 分批提交 / 已答折叠，原样保留，只服务 ask 题块。 |
| 排序口径参照 | `domains/chat/pending-permissions.ts` `pendingQueue` | `requestedAt` 升序 → 同时刻 permission 优先（rank）→ `requestId` 稳定。簇内排序沿用此口径。 |

## 3. 消费方清单（`asksForSession` / `groupPendingAsks` 全部调用点 + badge 面）

grep 全量核实（`apps/web/src`，排除测试）：

| 调用点 | 现状 | 处置 |
| --- | --- | --- |
| `domains/pending/PendingView.tsx:46` `groupPendingAsks(asks, …)` | 只聚 ask | 改混合聚类（见 §5 步骤 1/2）。 |
| `domains/pending/PendingView.tsx:55` `asksForSession(cluster.requests, …)`（focusKey） | 只查 ask | 随簇泛化为混合 items 查询；focusKey 行为不变。 |
| `domains/chat/ChatView.tsx:144` `asksForSession(asks, selectedId, attribution).length` → `:439` `pendingAskCount`（SessionRail / SessionList 当前会话「待批」入口 badge） | 只数 ask | **改**：permission 也计入（归属口径不变），badge 与待批页内容一致。 |
| `app/AppShell.tsx:115` `navCounts = { pending: asks.length }`（侧栏「待批」域 badge） | 只数 ask | **改**：`permissions.length + asks.length`。 |
| `app/AppShell.tsx:108/145` `pendingBarSummary(otherPending, otherAsks, …)` | 已合并两者 | 不动 ✓。 |
| `domains/chat/useChatSessions.ts:337` `pendingBySession`（会话行 badge） | 已数 `[...permissions, ...asks]`（按原始 sessionId） | 不动 ✓（既有口径，非本任务范围）。 |
| `domains/team/TeamPendingBar.tsx` 数据源 | `TeamDetailRoute.tsx:45-46` 从 `useConnection()` 取 permissions/asks → TeamChat → TeamChatMain → TeamPendingBar | **已含 permissions，无需补** ✓。 |
| `domains/chat/pending-permissions.ts` `pendingPermissionsOutsideView` | 对 `SessionScoped` 泛型，两种 kind 通用 | 不动 ✓。 |

结论：需要改的 badge 面只有两处（AppShell 域 badge、ChatView 会话入口 badge）；
TeamPendingBar / pendingBarSummary / pendingBySession 已含 permission。

## 4. team_id 实证（设计项 5：服务端已携带，Web 侧映射丢弃 → 需 additive 补齐）

**服务端已携带（无需改 gateway）**：
- `packages/serve/src/interactions-registry.ts` `handleEvent`：`tool.permission.request`
  读 `data.team_id`（687 行）并写入记录（712 行）；ask 同（761/768 行）。
- `interactions.list` 投影对两种 kind 都输出 `team_id`（methods/interactions.ts:202）。
- Web 侧 `ListedInteraction` 镜像类型已有 `team_id?: string`（interaction-hydration.ts:43）。

**Web 侧三处丢弃（本任务 additive 补齐，仅字段携带，不碰闸门判定）**：
1. `gateway/types/sessions.ts` `PermissionRequest`（444-466 行）：有 `agentId`（0.17 additive）
   但**无 `teamId`**；`AskUserRequest` 有 `teamId`。→ 类型加 `teamId?: string`。
2. `gateway/interaction-hydration.ts` `buildHydrationSnapshot` permission 分支（242-257 行）：
   **丢弃 `agent_id` 与 `team_id`**；ask 分支两者都带（271-276 行，注释明言「待批页按 agent
   聚类……不要丢掉」）。→ permission 分支照 ask 分支补两个 additive 展开。
   后果若不补：刷新 / 重连后补回的 permission 卡退化成按会话聚类，与实时卡不一致。
3. `gateway/interactions.ts` `permissionFromEvent`（42-78 行）：映射 `agent_id`（29 行）
   但**不映射 `team_id`**；`askFromEvent` 映射（125-126 行）。→ 补 `team_id` 携带。

约束核对（main 续示）：以上均为 additive 字段携带，`seen` / settled / terminal 闸门与
重建逻辑一行不动；`connection-handlers.ts` 不碰。符合「仅限 additive 字段携带（不改闸门判定）」。

## 5. 实施步骤清单（② 阶段，一次到位，不留中间态）

1. **cluster.ts 泛化**（attribution.ts 归属逻辑不动）：
   - 新增 `PendingItem = { kind: 'permission'; request: PermissionRequest } | { kind: 'ask'; request: AskUserRequest }`。
   - `groupPendingAsks` → `groupPending(permissions, asks, index)`：同键口径
     agent > session > run 不变；簇内 `requestedAt` 升序、同时刻 permission 优先
     （与 `pendingQueue` rank 口径一致，注释指明参照）；簇间 `latestAt` 降序不变。
   - `PendingCluster.requests` → `items: PendingItem[]`。
   - `asksForSession` → `itemsForSession(items, sessionId, index)`（归属口径不变，
     注释保留与 chat 侧渲染守卫 `pendingForSession` 的口径区分）。
2. **PendingView**：消费 `permissions + asks`；空态仅当两者皆空；
   `fetchFailed` / focusKey / roster 回退行为不变；头注释与 subtitle 文案更新。
3. **PendingClusterCard 混合渲染**：
   - ask 题块原样（逐题勾选 + `usePendingBatch` 批量提交 + 已答折叠）。
   - permission 项**原样复用 `PermissionCard`**（同 ask 块的 raised 容器 + run/时间 meta 行，
     参照 TeamPendingBar 先例）；`onDecide → respondPermission`；逐项
     `busy = responding.has(requestId)`；断连禁用；失败收口由 respondPermission 内置
     （toast + hydrate 一致化），run_ended / orphaned 卡随 hydrate 自然消失。
   - **permission 逐条裁决，不进批量勾选**（安全口径）；计数 badge = `items.length`。
4. **计数一致**：AppShell `navCounts.pending = permissions.length + asks.length`；
   ChatView `sessionAskCount` 改用混合 items（§3 表）。
5. **teamId additive**：§4 三处（类型 + hydration 映射 + 事件映射），仅字段携带。
6. **i18n zh/en**：`pending.*` 补 permission 相关键（subtitle / empty / count 泛化措辞）；
   卡面文案复用既有 `permission.*`，不新增重复键。
7. **红线**：composer slot 行为不变（当前会话 permission 仍在 slot 裁决，待批页是全集，
   含当前会话，与 ask 同）；不自动切会话、不加全局遮罩；permission 默认无超时
   （Addendum A），不做倒计时；不新增 RPC / store。
8. **门禁**：worktree 根 `set -o pipefail; bun run build 2>&1 | tee build.log; echo EXIT=$?`
   （WSL 退出码会谎报，必须 pipefail + 日志实证）；增量提交全部落
   `feat/q-permission-pending`，不合并不删支。

## 6. 验证分工

零测试 / 探针 / 临时进程（宪法）；行为验证归用户 / canary。canary 将以 hydration-anon
入口做耦合回归；tester 复用 cardrobust（卡面）+ skillsstyle（待批页 UI）续作。
本 agent 只写码 + build，每阶段 agent send 报 main。