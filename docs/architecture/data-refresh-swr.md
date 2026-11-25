---
title: 数据刷新 SWR 规范（stale-while-revalidate）
kind: current
triggers: [SWR, stale-while-revalidate, 刷新, 轮询, 闪烁, 加载中, loading, refresh, revalidate, useResource, useStaleWhileRevalidate, refreshKey, intervalMs, queryKey, 旧数据, 后台刷新, 更新中, stale, 分页刷新]
paths: [packages/plugin-ui/src/useStaleWhileRevalidate.ts, apps/web/src/state/useResource.ts, apps/web/src/domains/kanban/KanbanView.tsx, plugins/observability/usage/web-src/**]
---

# 数据刷新 SWR 规范（stale-while-revalidate）

> **用户裁定（2026-11-25）**：usage 插件刷新时整页变「加载中」再放回（闪烁）不可接受。
> 数据刷新统一为 **stale-while-revalidate（SWR）**：先展示旧数据（stale），后台重新验证
> （revalidate），新数据就绪后无缝替换；**仅首次加载（无旧数据）显示 loading**。
> 本规范适用于宿主（apps/web）与插件（iframe / embed 两档）的一切数据视图。
> 调研与根因见 [q-swr-refresh 报告](../dev/reports/q-swr-refresh/investigation.md)。

## 1. 语义条款（六条，实现必须全部满足）

1. **首次加载**（无 data）：`isLoading`，视图显示 loading 态；失败 → 错误态（无 data）+ 重试。
2. **revalidate**（interval tick / 外部刷新信号 / 手动刷新 / 回可见）：data 保持旧值，
   `isRefreshing` 细微标志；成功 → **原子 swap** + `updatedAt`；失败 → **保留旧数据** + error
   （视图给细微 stale 提示，可重试）。**任何 revalidate 都不整页 loading、不清空已有内容。**
3. **queryKey 变化 = 新查询**（range / 过滤切换）：旧查询的数据对新查询无意义 → 清 data
   回首次加载语义。与 revalidate 严格区分：**换查询是「首次」，刷新是「revalidate」**。
4. **generation guard**：只有最新代次响应可落地；queryKey 变化作废旧在途请求，旧响应不得
   覆盖新结果。
5. **在途去重**：请求在途时跳过新的 revalidate 触发（事件 burst 不会造成 RPC 风暴），
   下一个 tick 自然重试。queryKey 变化不受此限（必须立即发新查询）。
6. **pauseWhenHidden**（默认 true）：页面隐藏暂停轮询；回可见立即 revalidate 一次再重启
   interval。

## 2. 渲染契约（视图层）

| 状态 | 渲染 |
| --- | --- |
| `isLoading`（无 data） | LoadingState（整页 loading **只允许出现在这里**） |
| `error && !data` | ErrorState + 重试（重试 = reload，仍走 SWR） |
| 有 data | **永远渲染 data**，不因刷新/错误卸载 |
| `error && data` | 细微 StaleNotice：「更新失败，显示 {time} 的数据」+ 重试；不撤数据 |
| `isRefreshing` | 细微「更新中」指示（toolbar 小字 / 点标，aria-live=polite），不占整页 |

禁止：revalidate 时 `setState({status:'loading'})` 重置整页、`setItems([])` 清空列表再重填
（usage 旧实现的原病灶，见报告 §1.2）。

## 3. 两个实现（同一份语义）

| | 宿主侧 | 插件侧 / 共享 |
| --- | --- | --- |
| 位置 | `apps/web/src/state/useResource.ts` | `packages/plugin-ui/src/useStaleWhileRevalidate.ts` |
| 消费方 | apps/web 视图（~30 个） | 插件 web-src（iframe / embed 共用）；宿主新视图亦可用 |
| 状态面 | `ResourceState`（idle/loading/success/error，loading/error 可带 data）+ `resourceData()` + `refreshing` | `{data, error, isLoading, isRefreshing, updatedAt, reload}` |
| 触发 | `deps`（JSON 序列化）+ `pollMs` + `reload()` | `queryKey` + `intervalMs` + `refreshKey` + `reload()` |
| 旧数据保持 | `beginLoad` / `fail` | 内部五态机（ready/revalidating/stale 恒有 data） |
| 范例 | KanbanView（30s 条件轮询 + StaleNotice） | UsageView / LogsView（15s 轮询 + 事件触发） |

语义差异只有一处，且是**有意的**：`useResource.deps` 变化保留旧数据（deps 语义是连接世代
等「同一查询的环境变化」，如 kanban 的 `epoch`）；`useStaleWhileRevalidate.queryKey` 变化清
data（queryKey 语义是**查询身份**）。选用时按语义对号：环境变化用 deps 口径，查询身份用
queryKey 口径。plugin-ui 经源码别名被双方消费（`apps/web/vite.config.ts`、各插件
`vite.config.ts`），新增导出零构建步骤；插件不得 import apps/web。

## 4. 间隔与触发建议

- **interval 可配，按视图数据变化率定**：usage / logs = **15s**（用户裁定）；kanban = 30s
  条件轮询（`if_mtime_ms` / `if_size_bytes` 双水位，命中 unchanged 只 stat 不读文件、直接
  复用旧数据——服务端条件读与客户端 SWR 的组合范例）。
- **事件驱动 + interval 并存**：宿主事件（iframe 档 `vessel.plugin.refresh` ←
  `plugin.ready` / `plugin.changed`；embed 档 `host.events` 白名单子集如 `llm.response` /
  `run.completed`）去抖（现口径 250ms）后作为 `refreshKey` 传入，给活跃期即时新鲜度；
  interval 给基线保障（无事件也刷新）。两者都走 revalidate 语义，不闪烁。
- 事件白名单 fail-closed 降级（catalog 不可用 → 无事件订阅）时，interval 仍保证刷新。
- 轮询只在视图挂载期运行；隐藏暂停（条款 6）。

## 5. 分页列表条款

已 loadMore（用户浏览深层页）时**暂停后台 revalidate**（interval 置 0 + 冻结 refreshKey），
避免后台 swap 抽走用户正在浏览的内容；手动刷新 / 换查询恢复（重置回首页）。首页数据身份
变化时，旧首页的追加页作废（loadMore 响应落地前校验首页身份）。范例：LogsView。

## 6. 迁移指引（同款反模式清单）

以下视图仍是「refreshKey → 整页 loading 重置」旧模式，按本规范迁移到
`useStaleWhileRevalidate`（本轮不强制，随各自任务迁移）：

- `plugins/context/skills/web-src/SkillsView.tsx`（list/loads/detail 三个 LoadState）
- `plugins/provider/model-registry/web-src/VendorsView.tsx`、`CredentialsView.tsx`
- `plugins/marketplace/marketplace/web-src/views/**`（同型 LoadState 自查）

迁移步骤：① 识别查询身份（range / 过滤 / 选中 id）→ queryKey；② 刷新信号（refreshKey /
事件）与 interval → revalidate 触发；③ 渲染改 §2 契约（有 data 永远渲染）；④ 分页视图加
§5 保护；⑤ 重建插件 UI 产物（`build:ui`，web/ 与 web/embed/ 入库）；⑥ `bun run build` 绿。

## 7. 验收口径

- 手动：视图已有数据后，任何刷新（事件 / 轮询 / 手动）期间**旧数据保持可见**，无整页
  「加载中」；新数据就绪无缝替换；刷新失败旧数据仍在 + 细微 stale 提示。首次打开（无数据）
  才显示 loading；换 range / 过滤显示 loading（新查询）。
- 构建期：`bun run build`（typecheck + biome ci）+ 插件 `build:ui` 产物重建。按宪法不写
  测试 / 探针；行为验证由用户手动完成。