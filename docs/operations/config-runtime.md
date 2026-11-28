---
title: 运行期配置项（空响应 / 看板 / 视觉 / engine 双开关）
kind: current
triggers: [empty_response, 空响应, seamless, nudge, kanban, board_path, 看板, vision, 视觉, 图片预算, imageTokenBudgetRatio, blobGc, tools_engine, engine_pool, 双开关, 池]
paths: [src/config/empty-response-settings.ts, src/config/hot-apply-appliers.ts, packages/config/src/types.ts, packages/config/src/validator.ts]
---

# 运行期配置项

> 空响应兜底 / 看板路径 / 视觉 / engine 双开关的运维手册。键语义的机制家：
> core `EmptyResponsePolicy`、[tools.md#engine-exec](../architecture/tools.md#engine-exec)、
> [context.md](../architecture/context.md)（图片）；热应用见 [config-reload](config-reload.md)。

## `empty_response`（缺省开）

```yaml
empty_response:
  enabled: true       # false = 空响应直接当终稿（修复前行为，零回归开关）
  seamless: true      # 无感重试：丢弃空轮、原样重调，零注入零疤痕；false = nudge 注入路径
  max_retries: 2      # 重试上限（不含首次；seamless/nudge 共用）；0–10；0 = 首个空即耗尽
  # nudge: '继续你的任务……'   # 自定义文案（user 消息注入）；缺省 core 内置
```

- 管模型偶发「空内容 + 无工具调用 + 终止原因」。seamless 重调不发 `llm.response`、不写窗口，
  只记 `llm.empty_response`（internal）；连续空耗尽后升级**一次** nudge（`escalated: true`），
  再空则 `action: 'exhausted'` 留痕后 **run 标 failed**（`empty_response_exhausted`），peer 通知链
  自动报 parent 催续（category=internal，不触发 provider 硬错误闸）。`max_retries: 0` 不升级 nudge。
- 生效面：装配进 tenant profile ⇒ **新 EU（新会话）生效**，已存活会话持启动快照。
- 可写面：`emptyResponse.{enabled,seamless,maxRetries,nudge}` 进 `config.set` 白名单
  （映射 `src/config/empty-response-settings.ts`）。

## `kanban`

```yaml
kanban:
  board_path: ~/boards/team-board.json   # 缺省 <cwd>/docs/dev/kanban/board.json
```

- `kanban.get` / `kanban.archive` 读的 board.json 路径；`~` 展开，相对路径按进程 cwd 解析。
  archive.json 恒取板同目录。校验：非空字符串，不做存在性校验（板不存在 `kanban.get` 回 `not_found`）。
- 可写面：`kanban.boardPath` 进 `config.set` 白名单（`scope: 'project'` 写工作区覆盖层）；
  agent 经 `vessel op=set_config` 帮用户切换（照旧走审批闸）。
- **热应用**：写后经 reload `config` scope 的 `applyKanban` 重解析路径原地更新 deps，
  `config.set` 返回时下一次 `kanban.get` 即用新板；未注入 applier 进 `requires_restart`。
- 平台代理：`kanban` 命名空间在 proxy 方法白名单内，`kanban.get`（read）/ `kanban.archive`
  （write，仅用户验收勾选触发）经 `/nodes/:nodeId/v1/rpc` 与代理 WS 均可达。

## `vision`（全部可选；故意没有 enable 键）

能力问 `provider.vision`（插件 `VisionBackend` 描述符），配置只管运行期。逐条内联由 `refs[].inline` 控制（file-ref-ux A1：**缺省不内联**，`true` 才入池内联；见 [gateway-rpc](../architecture/gateway-rpc.md) refs 契约）——`vision.disabled` 是全局闸，优先于逐条开关。

| 键 | 语义 |
|---|---|
| `disabled` | kill switch（等价 `VESSEL_DISABLE_VISION=1`）：不内联、`[refs]` 尾注回落老文案、记 `vision.disabled` 事件；默认 false |
| `max_images_per_request` | 显式硬上限，与 token 预算推导值、后端描述符取 min；缺省由预算推导 |
| `image_token_budget_ratio` | 图片 token 预算占 `context.maxTokens` 比例 [0,1]，缺省 0.05；仅 `maxImageTokens` 未设时生效；0 = 不内联；**重启生效**（可 `config set vision.imageTokenBudgetRatio`） |
| `max_image_tokens` | 预算绝对值（覆盖比例推导）；预算 ÷ 单图 token = 张数上限，夹在后端安全 cap（32）下 |
| `detail` / `preprocess` | 精度意图（须落在后端 `detailLevels()`）；预处理缺省 `none`，非 none 时产出新字节必须写回 `refs.sha256`（否则前缀守卫报 `prompt.prefix_changed`） |
| `orphan_grace_hours` / `image_blob_ttl_days` | 孤儿 blob 宽限窗（缺省 24h，上限 168）/ 死线（缺省 30d） |
| `blob_gc_enabled` / `blob_gc_interval_hours` / `blob_gc_dry_run` | blob GC 缺省开（间隔缺省 6h，夹 [1,168]）；启动后第一趟永远 dry-run；显式 false 关后其它 blobGc 键不生效 |

## `tools_engine.mode` + `gateway.engine_pool`（双开关缺省关）

```yaml
tools_engine: { mode: pool }    # 缺省 child = per-node stdio 子进程；pool = 共享池直连
gateway:
  engine_pool:
    size: 2                     # 0/缺省 = 不建池；1 = 装配期 fail-fast；开时 ≥2
    # max_inflight: 32          # 每 engine 在途上限；缺省 cpus × 4
    # rss_soft_limit_mb: 512    # rss 软阈值；缺省不启用
    # instance: alt             # poolDir = ~/.vessel/engine-pool[-<instance>]
```

- 两个都显式打开才走池路径；回退 = 翻配置 + 重启。池候选全不可用 ⇒ 抛
  `ENGINE_ERROR.unavailable`，**无静默回落**；busy 派发前快拒、不计熔断。
- **poolDir 不随 data_dir 移动**（在用户全局配置目录下）；隔离实例必设 `engine_pool.instance`。
- **一致性校验**（validator，形状 + 双跑判定）：`size>0` + 显式 `mode: child`（或块在而 mode
  缺省）→ M+1 双跑 **error**；`mode: pool` + `size: 0`/缺省（enginePool 块在）→ 无池可连
  **error**；分离部署（本份无对侧块）合法，单文件漏配给 warning。`size: 1` / 错拼键启动即报。
- 执行现态与路由语义见 [tools.md#engine-exec](../architecture/tools.md#engine-exec) 与
  [ADR-106](../adr/ADR-106-engine-pool.md)。