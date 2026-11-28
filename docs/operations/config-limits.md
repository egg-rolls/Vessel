---
title: 限额、价格与压缩配置
kind: current
triggers: [limits, termination, pricing, 限额, 成本, total_cost, max_iterations, max_runtime, request_limit, 压缩, compact_threshold, auto_compact, toolResultWhitelist, compositionRecord, context.composition]
paths: [src/observability/usage-pricing.ts, packages/config/src/types.ts, packages/config/src/validator.ts]
---

# 限额、价格与压缩配置

> 限额 / 价格 / 上下文压缩的配置项运维手册。执行机制见
> [runtime-loop](../architecture/runtime-loop.md#loop) 与 [session-length](../architecture/session-length.md)；
> 决策见 ADR-084 / ADR-085。

## 限额与终止（默认不限制，显式 opt-in）

```yaml
limits:
  # request_limit: 100            # 单 run LLM 请求次数上限
  # input_tokens_limit: 1000000   # 累计输入 token（含 cache_read，非上下文窗口）
  # output_tokens_limit: 50000
  # total_cost_limit: 1.5
termination:
  # max_iterations: 50
  # max_runtime_seconds: 600      # 墙钟秒数（等待用户授权不计入）
```

- 全部缺省 = 不设单 run 累计上限；长任务靠自动压缩、模型自然停止与用户中断收口。
- **判定**：每轮先终止策略（max_iterations → max_runtime），再使用量限额
  （request → input tokens → output tokens → total cost）；按 `current >= max`、首个命中生效，
  未配置的 key 跳过。
- **命中**：发布一次 `limit.blocked`（`error_code: 'limit_blocked'`、`scope`/`key`/`current`/`max`/
  `source`/`hint`/`retryable: false`），抛 `LimitExceededError`；`run.failed` 附同一结构化 `details`。
  `source` 是 camelCase 配置路径（如 `limits.inputTokensLimit`）；错误前缀
  `Usage limits exceeded: ...` / `Termination policy triggered: ...`。
- `tool_calls_limit` 已移除：旧配置该键被忽略不报错，由 max_iterations / max_runtime 兜底。

## 价格（`pricing.models`，opt-in）

```yaml
pricing:
  models:
    volcengine/deepseek-flash:   # 必须与 wire 模型名精确一致
      input_per_million: 0.27
      output_per_million: 1.10
      cache_read_per_million: 0.027    # 缺省 = input_per_million；建议显式
      cache_write_per_million: 0.3375
```

- **合并视图**（`usage-pricing.ts:createUsagePricing`）：注册模型价格唯一源 =
  `models.entries.<id>.pricing`，按 wire 名覆盖顶层 `pricing.models` 同名键；顶层块降级为
  legacy / 未注册 wire 的兜底。同 wire 多 entry 价格不同 → 确定性取条目键序首个（写前 warning）。
- 每次 provider 响应按四项费率分别计价累加到 `stats.totalCost`；没有配置 / 模型未命中时
  `total_cost` 恒 0，`total_cost_limit` 判定跳过。Vessel 不内置厂商价格、不做汇率换算。
- 只用 `input_tokens_limit` 做成本代理会在缓存命中高的长 run 上严重误判；成本请用 `total_cost_limit`。

## 上下文压缩配置（机制见 session-length）

相关键：`context.max_tokens`（默认 1,000,000）、`context.max_messages`（缺省
`max(100, floor(max_tokens / 100))`）、`context.compact_threshold`（缺省 0.85）、
`context.auto_compact`（默认 true；false 只关 token 阈值，条数超限仍强制压缩）。

- 触发：token 估算严格超过 `max_tokens × compact_threshold`，或条数超过 `max_messages`。
- 压力提示：达 `max_tokens × 0.9` 且未越阈值时每 run 一次 `context.pressure`（建议 rotate）；
  自动压缩开启且已越阈值后不再提示。
- 保留区预算 `max_tokens × 0.3`，最新 2 条非 system 消息恒保留；工具结果清空预算
  `max_tokens × 5%`（至少 1 条、最多 10 条），其余换 `[cleared ...]` 占位（请求级视图，落盘永远原文）。
- 手动 `/compact`：live EU 走 `compactContext`，idle session 走等价瞬态路径，connect 走
  `sessions.compact` RPC。摘要单块 15s 超时、per-session 连续 3 次失败熔断 10 分钟（手动/overflow 绕过）。

## 压缩白名单与组成快照

- `context.tool_result_whitelist`（TS `toolResultWhitelist`）：`{tool, action?}[]`。命中的工具结果
  在请求视图保持原文可见（**抗 trim 不抗 compaction**：段边界摘要/移除照常）。缺省 = 内置
  `[{inbox,read},{agent,read}]`（沟通读路径）；显式 `[]` 关闭；显式列表整体替换不合并。
  消费侧纯后过滤（EU 段起点冻结 + 压缩审计集合两处同一规则）；构造期注入，**重启生效**。
- `context.composition_record`（TS `compositionRecord`，默认 true）：每次真实 LLM 请求落一条
  `context.composition` 事实事件（请求视图 token 按成分分解：system/历史/占位/环境卡/图片/摘要/
  工具声明/开销），供 `sessions.composition` introspection；显式 false 关。构造期注入，重启生效。