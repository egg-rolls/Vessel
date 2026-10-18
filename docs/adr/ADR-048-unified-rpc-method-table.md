---
adr: 48
title: 统一 RPC 方法与 capability manifest
status: accepted
date: 2026-10-18
related: [20, 29, 36, 41]
tags: [rpc, api, manifest]
---

## ADR-048：统一 RPC 方法与 capability manifest

- **上下文**：0.4 的入口分散在 REST 端点、WS 方法与 CLI/TUI 直接调用内部实现之间。外部 agent 无法自描述地发现能力，新增入口容易漏掉鉴权、tenant 与错误码。0.5 要求一个统一方法表，CLI/TUI 也作为客户端走同一入口，同时保持 0.4 端点兼容。
- **决策**：
  1. **信封（冻结）**：请求 `{ v: 1, id, method, params? }`；成功 `{ v: 1, id, ok: true, result }`；失败 `{ v: 1, id, ok: false, error: { code, message, details? } }`。HTTP 入口 `POST /v1/rpc`；WS 复用 `req` / `res` 帧。请求必须含 `v:1`、`id`、`method`，响应回显 `id`。
  2. **方法表 v1.1（canonical，冻结）**：
     - health：`health.get`
     - capability：`capabilities.list`
     - config：`config.get` / `config.sources`
     - session：`sessions.list` / `sessions.get` / `sessions.delete` / `sessions.rename`
     - run：`runs.list` / `runs.get` / `runs.start` / `runs.cancel` / `runs.resume`
     - event：`events.list` / `events.subscribe`
     - tool：`tools.list`
     - plugin：`plugins.list`
     - metrics：`metrics.get`（`{ source?: 'live' | 'trace' }`，缺省 `live`）/ `metrics.reset`
     - trace：`trace.prune`
     - tenant：`tenants.list` / `tenants.get` / `tenants.create` / `tenants.update`
     - permission / ask：`permission.respond` / `ask.respond`
     - workflow：`workflow.list` / `workflow.start` / `workflow.get` / `workflow.resume` / `workflow.cancel`
     - evals：`evals.run` / `evals.latest`
     - feishu：`feishu.status`
     - mcp：`mcp.list` / `mcp.reconnect`
  3. **legacy-only（不进 manifest）**：`team.*`、`durable.*`、WS 的 `run.submit` / `run.get` / `run.cancel`。0.5 继续可用；0.6 再评估。**不新增 `metrics.rebuild`**，用 `metrics.get { source: 'trace' }`。
  4. **HTTP 语义**：信封合法时，方法成功或方法级失败都返回 HTTP 200（失败体 `ok:false`，含 `tenant_locked` / `quota_exceeded` / `conflict` 等）；JSON/信封/参数非法 400 `invalid_params`；未鉴权 401 `unauthorized`；权限不足或跨 tenant 403 `forbidden`；体过大 413；未知方法 200 `not_found`（`details.method`）；服务端异常 500 `internal`。旧 REST 适配器保留 0.4 路径、请求体、响应体、状态码与错误码（`tenant_locked`→409、`quota_exceeded`→429 等）。
  5. **事件读取/订阅**：`events.list` 支持 `run_id`、`since_seq`、`since_ts`、`types`、`type_prefix`（与 `types` 互斥）、`limit`（默认 50、最大 500），按 `(seq ?? ts)` 升序。`events.subscribe` 支持 `since`（gateway wire seq）、`since_ts`、`run_id`、`types`、`all_tenants`（仅 admin）。RPC 订阅回调统一为 `{ method: 'events.event', params: RunEvent }`，WS 旧 `{ kind: 'event', event }` 不变；事件在进入 buffer 与 trace 前完成脱敏。
  6. **capability manifest**：`capabilities.list` 返回 `{ version, config_schema_version: 1, methods: [{ name, params_schema?, result_schema?, permission: 'read'|'write'|'admin' }], tools: [{name, description?}], plugins: [{name, enabled}] }`。manifest 只含 canonical 方法；legacy-only 不出现。
  7. **客户端**：`RpcClient` 接口为 `request(method, params)` + `subscribe(handler)`；`LocalRpcClient`（进程内）与 `HttpRpcClient`（gateway）两个实现。CLI/TUI 不得绕开方法表直接调内部实现；嵌入方可直接用 core API，但对外入口必须一致。
  8. **连接方式**：`--connect <url>` / `VESSEL_CONNECT` 让 CLI/TUI 使用 `HttpRpcClient`，**不获取 tenant 写锁**；未设置时使用 `LocalRpcClient` 并获取锁。`HttpRpcClient` 只支持本机回环 gateway，不是 F5 跨机器远程。锁失败信息必须提示 `--connect <url>` 或关闭占用进程。
  9. **扩展点**：插件注册新方法只能走 `PluginHost`，不允许第二套注册机制；新增 canonical 方法必须发 DECISION addendum。
- **备选**：(a) 只保留 REST，不统一方法表——CLI/TUI 继续耦合内部实现，外部无法自描述发现；(b) 立即删除旧端点——破坏 0.4 客户端。均不取。
- **后果**：所有入口共享鉴权、tenant、错误码与 manifest；旧端点短期保留，增加一层适配与一致性测试成本。方法表成为冻结契约，新增能力需要 addendum 与文档同步。
- **关联**：ADR-020（双轨命令）、ADR-029（事件流交互）、ADR-036（gateway 协议）、ADR-041（远程/TLS 边界）；DECISION-010 §2.3；Addendum A-3 §10.1–§10.5；A-4 §11.1 / §11.5 / §11.6。
