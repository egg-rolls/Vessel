# q-swr-refresh ①：数据刷新 stale-while-revalidate 调研 + 设计

任务：用户裁定——usage 插件刷新时整页变「加载中」再放回（闪烁）不可接受；数据刷新统一为
**stale-while-revalidate（SWR）**：先展示旧数据（stale），后台重新验证（revalidate），新数据就绪后
无缝替换；仅首次加载（无旧数据）显示 loading。interval 可配（usage 15s）。

分支 `feat/q-swr-refresh` @ 5fc114ba（redblue-dev tip 30a439f0 的父提交，仅差一条 kanban 派单记录）。
本轮只调研 + 设计 + 本报告，未动产品代码。

---

## 1. 现状调研

### 1.1 usage 插件的刷新链路（两档共用同一份展示组件）

刷新信号源（`refreshKey` 驱动，两档各自去抖 250ms）：

| 档 | 入口 | 信号 | 频率 |
| --- | --- | --- | --- |
| iframe | `web-src/App.tsx:40-50` | `PluginRpcClient.onRefresh` ← 宿主 `PluginFrame.tsx:166-200` 在 `plugin.ready` / `plugin.changed` 事件时 postMessage `vessel.plugin.refresh` | 低频（插件启动/热重载） |
| embed | `web-src/embed.tsx:35-59` | `host.events.subscribe('llm.response' / 'run.completed')`（manifest permissions.events 白名单，fail-closed 降级） | **活跃 run 期间高频**（每次 LLM 请求完成一条） |

两档都是 `事件 → 250ms 去抖 → refreshKey++ → 视图 useEffect 重取`。**没有任何轮询**；
embed 档在 agent 活跃期间 refreshKey 持续 bump，是闪烁最严重的场景。

### 1.2 病灶（整页 loading 闪烁的直接原因）

- **`UsageView.tsx:164-181`**：useEffect deps `[client, range, refreshKey, attempt]`，每次触发
  第一行 `setState({ status: 'loading' })` → 渲染切到 `LoadingState`（:196），旧数据整体卸载；
  新数据到达再整体挂回 = 闪烁。`LoadState`（`shared.tsx:106-109`）三态 loading/error/ready
  **没有「带旧数据的刷新态」**，结构上就不支持 SWR。
- **`LogsView.tsx:264-287`**：更重——每次触发 `setLoading(true)` + `setItems([])` + `setCursor(null)`
  + `setSource(null)`，表格直接清空再重填。
- **同款反模式在其他插件**（本轮不修，规范文档列迁移指引）：
  - `plugins/context/skills/web-src/SkillsView.tsx:144`（refreshKey → `setListState({status:'loading'})`）
  - `plugins/provider/model-registry/web-src/VendorsView.tsx:79`、`CredentialsView.tsx:41`（同）

### 1.3 宿主侧已有 SWR 先例（规范的事实基础）

- **`apps/web/src/state/useResource.ts` 已经是完整 SWR 实现**：
  - `beginLoad`（:33-40）注释原文「开始加载：保留旧数据，避免刷新时闪烁/丢内容」；
  - `fail`（:51-68）失败保留旧数据 + `updatedAt`（供「更新失败，显示 <time> 的数据」）；
  - generation guard（:70-73, :131-146）旧请求不覆盖新结果；
  - `pollMs` 轮询 + `pauseWhenHidden`（默认 true）+ `visibilitychange → visible` 立即重取（:160-191）；
  - `refreshing` 标志（:196）= `loading && data !== undefined`，即「有旧数据的后台刷新」。
  - 约 30 个宿主视图在用（agents/observe/runs/settings/kanban/…）。
- **KanbanView = SWR + 条件轮询的范例**（`KanbanView.tsx`）：
  - 30s 轮询（:41 `POLL_MS`）带 `if_mtime_ms` / `if_size_bytes` 双水位（:63-109），命中 unchanged
    只 stat 不读文件、直接复用旧数据；手动刷新/归档后置无条件读必达；
  - 渲染契约（:186-199）：`loading && !data → LoadingState`；`error && !data → ErrorState`；
    **有 data 永远渲染 data**，`error && data → StaleNotice`（细微提示 + 重试，不撤数据）。
- **缺口**：`useResource` 在 `apps/web/src/state/`，插件是独立构建（iframe sandbox / embed 动态
  import），**不能 import apps/web**；`@vessel-agent/plugin-ui` 才是双方共消费的共享叶包
  （`apps/web/vite.config.ts:147,306` 与 `usage/vite.config.ts:17,103` 都别名到
  `packages/plugin-ui/src` 源码——新增 hook 文件 + index 导出即对双方可用，无包构建步骤）。

### 1.4 构建 / 门禁事实

- usage `build:ui`（package.json:24）= `tsc -p tsconfig.web.json --noEmit && vite build && vite build --config vite.config.embed.ts`；
  产物 `web/`（iframe）与 `web/embed/`（embed）**入库**，改 web-src 必须重建并提交产物。
- 根门禁 `bun run build`（scripts/build.ts）= typecheck（root + examples + apps/web）+ biome ci，
  每步判返回码 + 输出错误证据双口径；前置要求 apps/web/node_modules。
- 工作区依赖已装好（root 482 + apps/web 86，`--frozen-lockfile`，exit 0，INSTALL_OK）；git clean。

---

## 2. SWR 设计

### 2.1 共享 hook：`packages/plugin-ui/src/useStaleWhileRevalidate.ts`（新文件 + index 导出）

放 plugin-ui 的理由：宿主与插件共消费的共享叶包（源码别名，零构建步骤）；plugin-ui 已有
非纯展示先例（host.ts 运行时桥）。**不动 apps/web 的 useResource**（30 个视图在用，零风险面）；
两者语义对齐，规范文档统一口径（useResource = 宿主侧既有实现，新 hook = 插件侧/共享实现）。

```ts
export interface SwrOptions<T> {
  /** 请求函数；经 ref 调用，闭包随渲染更新。 */
  fetch: () => Promise<T>;
  /** 查询身份（range/过滤等）。变化 = 新查询 → 清旧数据回首次 loading。 */
  queryKey?: readonly (string | number | boolean | null | undefined)[];
  /** 后台轮询间隔 ms；<=0/缺省不轮询。usage = 15_000。 */
  intervalMs?: number;
  /** 外部刷新信号（宿主事件去抖后的 refreshKey）：变化 → 后台 revalidate，保留旧数据。 */
  refreshKey?: number;
  /** 页面隐藏暂停轮询（默认 true）；回可见立即 revalidate 一次。 */
  pauseWhenHidden?: boolean;
  /** false 时不发请求（默认 true）。 */
  enabled?: boolean;
}

export interface SwrResult<T> {
  data: T | undefined;          // 旧值保持；就绪原子 swap
  error: Error | undefined;     // 最近错误；有 data 时供 stale 提示，不撤数据
  isLoading: boolean;           // 仅首次（无 data）loading
  isRefreshing: boolean;        // 有 data 的后台刷新中（细微指示用）
  updatedAt: number | undefined; // 最近成功时间（stale 提示用）
  reload: () => void;           // 手动刷新 = revalidate（有旧数据则保留）
}
```

内部状态机（五态，公开面折叠为上面的布尔标志）：

```
loading（无 data，首次）──成功──▶ ready(data, updatedAt)
   │失败                              │ revalidate 触发（interval / refreshKey / reload / visible）
   ▼                                  ▼
error（无 data）◀──失败── revalidating(data, updatedAt) ──成功──▶ ready(新 data)
                                      │失败
                                      ▼
                               stale(data, updatedAt, error) ──revalidate──▶ revalidating
```

语义条款（规范核心）：

1. **首次加载**（无 data）：`isLoading` → 视图显示 LoadingState；失败 → ErrorState + 重试。
2. **revalidate**（interval tick / refreshKey 变化 / reload() / 回可见）：data 保持旧值，
   `isRefreshing=true`；成功 → 原子 swap + updatedAt；失败 → 保留旧数据 + error（视图显示细微
   StaleNotice，可重试）。**任何 revalidate 都不整页 loading。**
3. **queryKey 变化 = 新查询**（range/过滤切换）：旧查询的数据对新查询无意义 → 清 data 回
   `isLoading`。这是「首次加载」不是「刷新」——与 revalidate 严格区分（useResource 的 deps
   保留旧数据，语义是连接世代而非查询身份；新 hook 把两者分开）。
4. **generation guard**：只有最新代次响应可落地；queryKey 变化作废旧在途请求。
5. **在途去重**：请求在途时跳过新的 revalidate 触发（interval tick / 事件 bump），防止事件 burst
   期间 RPC 风暴；下一个 tick 自然重试。queryKey 变化不受此限（必须立即发新查询）。
6. **pauseWhenHidden**：隐藏暂停轮询，回可见立即 revalidate 一次再重启 interval（同 useResource）。

### 2.2 usage 接入（步骤②）

**UsageView**：

```tsx
const swr = useStaleWhileRevalidate<UsageData>({
  fetch: () => Promise.all([
    client.call<SummaryResult>('summary', rangeParams(range)),
    client.call<LeaderboardResult>('leaderboard', rangeParams(range)),
  ]).then(([summary, models]) => ({ summary, models })),
  queryKey: [range],
  intervalMs: 15_000,
  refreshKey,
});
```

渲染契约：`isLoading → LoadingState`；`error && !data → ErrorState(retry=reload)`；
**有 data 永远渲染** CoverageNotice + UsageBody；`error && data → 细微 StaleNotice`（shared.tsx
新增小组件：「更新失败，显示 {time} 的数据」+ 重试）；`isRefreshing → toolbar 右侧细微
「更新中…」指示`（text-2xs text-faint，aria-live=polite，不占整页）。
新增 i18n key：`common.updating`、`common.stale`（en/zh-CN 双语）。

**LogsView**（分页列表特例）：首页走同一 hook（`queryKey=[序列化 applied]`，intervalMs 15s）；
loadMore 保持 append + generation guard。**已翻页（loadMore 过）时暂停后台 revalidate**
（intervalMs 置 0 + 冻结 refreshKey），避免后台 swap 抽走用户正在浏览的深层页；手动刷新 /
换过滤恢复（重置回首页）。此条款写入规范（分页列表通用）。

**App.tsx / embed.tsx**：保留现有 250ms 去抖事件 → refreshKey（现在 SWR-safe，不再闪烁）；
15s 轮询由 hook 提供。事件驱动（活跃期即时新鲜）+ interval（基线保障）双触发并存。
**宿主刷新协议零改动**（PluginFrame / host.ts / embed 事件白名单都不动）。

### 2.3 文档化（步骤③）

`docs/architecture/data-refresh-swr.md`（+ INDEX.md 条目）：SWR 语义条款（§2.1 六条）、渲染契约、
queryKey vs revalidate 区分、interval 建议（usage 15s；kanban 30s + if_mtime 条件轮询 = 服务端
unchanged 复用 + 客户端 SWR 的组合范例）、分页列表条款、两个实现的语义对齐表
（useResource ↔ useStaleWhileRevalidate）、其他视图（skills / model-registry / marketplace）
迁移指引（同款反模式清单，本轮不强制迁移）。

### 2.4 并发避让与改动面

- 不碰 `src/plugin/plugin-loader.ts`（q-plugin-lifecycle-impl）、不碰 Composer（q-drag-reference）。
- 我的改动面：`packages/plugin-ui/src/useStaleWhileRevalidate.ts`（新）+ `index.ts`（一行导出）、
  `plugins/observability/usage/web-src/*`（UsageView/LogsView/shared/i18n）、usage `web/` 重建产物、
  `docs/`。**不改 plugin-ui/host.ts、不改 apps/web 任何文件。**

### 2.5 门禁与提交计划

- ①（本轮）：本报告提交。
- ②：hook + usage 接入 + `bun run --cwd plugins/observability/usage build:ui` 重建产物，
  `bun run build` 绿后分提交（hook / usage+产物）。
- ③：规范文档 + INDEX，build 绿后提交。
- ④：最终 `bun run build` + usage `build:ui` 全量门禁，exit code + 日志实证报告。

---

## 3. 本轮结论

1. 闪烁根因确定：视图层 `LoadState` 无「带旧数据的刷新态」，每次 refreshKey 重置 loading
   （UsageView）甚至清空表格（LogsView）；embed 档 llm.response 事件高频触发放大症状。
2. SWR 不是新发明：宿主 useResource + kanban 已是事实规范；缺的是插件侧共享实现。
3. 方案：plugin-ui 新增 useStaleWhileRevalidate（六条语义条款），usage 两视图接入（15s 轮询 +
   事件触发并存，分页特例），规范文档固化。零协议改动、零 apps/web 改动、并发面不重叠。