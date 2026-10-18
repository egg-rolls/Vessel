---
adr: 49
title: 多租户隔离与单 gateway 多 tenant
status: accepted
date: 2026-10-18
related: [1, 2, 5, 36, 46, 50]
tags: [tenancy, isolation, gateway]
---

## ADR-049：多租户隔离与单 gateway 多 tenant

- **上下文**：0.5 之前所有会话、run、配置与事件都属于单一上下文。引入文件优先存储后，可以在同一进程内按 tenant 分区；但 tenant 边界必须同时覆盖存储、配置、工具、权限、quota、trace 与 RPC，否则会出现跨 tenant 读写或配置泄漏。
- **决策**：
  1. **TenantContext**：core 提供 `TenantContext<TenantConfig = unknown>`，字段 `tenant_id`、`data_dir`、`config`；asm 实例化为 `TenantContext<VesselConfig>`。core 新增 `tenant` 模块并登记到 `CORE_MODULES`。
  2. **解析优先级（冻结）**：显式 `RuntimeOptions.tenantId` → CLI `--tenant` → env `VESSEL_TENANT` → 用户配置 `tenant.default` → `default`。`tenant_id` 必须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，拒绝路径穿越。
  3. **token → principal**：`serve.token`（旧单 token）→ `{ tenant_id: 'default', role: 'admin' }`；`serve.tokens` map → 按条目 `{ tenant_id, role }`；`serve.admin_token` → `{ tenant_id: '*', role: 'admin' }`；无 token 且回环 → `{ tenant_id: 'default', role: 'admin' }`；已配置 token 但请求未带 → 401。token 解析顺序见 ADR-050。
  4. **一个 gateway N tenant**：`runtimeFor` / `sessionFor` / `contextFor` / `pluginHostFor` 为可选工厂；default tenant 使用全局注入；未提供工厂的非 default tenant 返回 `forbidden`，不得创建半成品。非 admin 在 body/query/header 指定其它 tenant → `forbidden`；admin 可显式指定。
  5. **隔离维度**：存储按 tenant 目录分区，跨 tenant 读取一律 `not_found`（避免存在性泄漏）；配置按 tenant overlay 合并；工具按 `tenants.<id>.tools.allow/deny` 过滤；guardrail / tool policy 可按 tenant 配置；quota 含 `max_sessions` / `max_runs_per_day` / `max_concurrent_runs` / `max_storage_bytes`，超限返回 `quota_exceeded` 且不落半成品；trace 按 tenant 隔离，prune 只作用于本 tenant；RPC 每个方法校验 tenant，admin 方法需要 `admin` 权限。
  6. **tenant overlay**：优先级 `CLI > env > tenant overlay > project > user > default`，tenant overlay 不得覆盖 CLI/env。允许的顶层块：`provider / agent / context / limits / termination / session / plugins / workflow / evals / feishu / tools / mcp_servers / delegate / team / host / scheduler / transport / quota`；禁止 `data_dir / trace / serve / tenant / update`；未知块 error。对象深合并、数组整体替换、map 按 key/name 合并、`null` 拒绝。tenant 的密钥字段只允许 `_env`；项目 `vessel.yaml` 出现密钥 → error。
  7. **路径**：`data_dir` 是全局配置，tenant overlay 不得修改；tenant 数据路径由 `<data_dir>/tenants/<id>` 派生。`workflow` / `evals` 默认路径迁入 tenant（`<tenant>/workflows`、`<tenant>/evals`）；显式 `workflow.path` / `evals.outDir` 优先但启动时 warn。显式 `session.storage_path` / `durable.path` 允许逃出 tenant，但启动时 warn。
  8. **tenant 生命周期**：元数据写 `<data_dir>/tenants/<id>/tenant.json`；`status: disabled` 时拒绝写路径（exit 1 / `forbidden`），只读元数据可见；删除 tenant 默认只标记 disabled，0.5 不做 `--purge`。
  9. **runs / sessions**：`runs.list` 返回内存中的活动 run；`runs.get` 内存优先、未命中回退 durable checkpoint；`runs.resume` 仅 durable；`sessions.rename` 只改 `title`，不改 `session_id`，不新增 `SessionBackend` 方法；`sessions.delete` 语义见 ADR-046。
  10. **插件 tenant 行为与内置多租户执行（A-6）**：ext 已实现每 tenant 独立插件实例、禁止模块级可变状态；asm 解析 `workflow.path` / `evals.outDir` / feishu session backend / MCP server 配置为 tenant 最终路径，插件不得再追加 `tenants/<id>`；一个飞书 `app_id` 只绑定一个 tenant；插件发起的 run 计入 tenant quota。A-6 要求 `--serve` 为每个 active tenant 构建独立执行面（config / provider / session / run store / context / PluginHost / trace / metrics / redactor / sessionControl）与独立 EventStream；gateway 为每个 active tenant 持有 writer lock，启动失败回滚、shutdown 释放，锁冲突 `tenant_locked`；disabled / 未配置 tenant → `forbidden`。A-6.3 的 web 接口增量已合入（`pluginsFor`、per-tenant manifest / `plugins.list`、`trace.readEvents(filter, tenantId)`、`sessionData.deleteSessionData(sessionId, tenantId)`）；asm 的 per-tenant 执行接线当前标 **in progress (0.5)**，落地后改为已实现。
- **备选**：(a) 单进程单 tenant，靠多进程隔离——与“一个 gateway 服务 N tenant”的目标冲突；(b) tenant 通过路径前缀隐式推导——无法覆盖配置、工具、quota 与 RPC 鉴权；(c) 允许 tenant overlay 覆盖 `data_dir` / `serve`——会产生跨 tenant 路径与安全风险。均不取。
- **后果**：tenant 边界成为全链路不变量；多租户部署优先使用 `serve.tokens` 发放 tenant token，`serve.token` 仅保留 0.4 兼容语义。非 default tenant 需要显式工厂，未配置时 fail-closed。0.5 不做跨机器远程（F5 在 0.6），也不做 tenant 物理删除。
- **关联**：ADR-001 / ADR-002（分层）、ADR-005（配置分层）、ADR-036（gateway）、ADR-046（存储）、ADR-050（配置与密钥）；DECISION-010 §2.5；Addendum A-3 §10.4–§10.7；A-4 §11.1 / §11.4 / §11.7。
