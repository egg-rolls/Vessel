---
adr: 79
title: 权限生命周期——默认等待、持久化与内联应答
status: accepted
date: 2026-10-20
related: [26, 29, 36, 48, 54, 55, 77]
tags: [permission, interaction, persistence, gateway, web, tui, lifecycle]
---

## ADR-079：权限生命周期——默认等待、持久化与内联应答

- **上下文**：0.11.1 / 0.12.0 把权限等待超时定为 120s 致命错误：时间一到 run 直接失败，即使用户只是离开终端或模型在等待人工确认。这不合理——权限是人工决策，不应由固定 TTL 代替用户。同时 gateway 的 pending 请求只存在内存，进程重启或 run 结束后无法区分“从未请求”“已应答”“run 已结束”，重复应答会得到 `not_found`，Web 刷新后也只能靠事件重放碰运气。Web 还使用全局权限遮罩，多个 run / session 的请求会互相覆盖，无法判断请求属于哪个 run。

- **决策**：
  1. **默认无限等待**：权限请求一直等待，直到用户应答、取消或 run abort。只有 core 显式配置正数 `RuntimePermissionConfig.timeoutMs` 才在超时后抛 `PermissionTimeoutError`（`permission_timeout`）。应用层不设置该值，因此 REPL / gateway 默认没有权限 TTL；不得重新引入 120s 自动失败。
  2. **取消与超时分离**：等待绑定 `ctx.signal`；abort 时立即结束并抛 `PermissionAbortedError`（`code: 'permission_cancelled'`，`name: 'AbortError'`），优先于超时判定，不得误报 `permission_timeout`。
  3. **请求携带关联字段**：`tool.permission.request.data` 增加 `session_id` / `tool_call_id` / `deadline_at` / `source`（additive）。只有显式正数超时才写 `deadline_at = ts + timeoutMs`；默认等待不承诺 deadline。
  4. **pending 不按 TTL sweep**：serve 的 `pendingPermissions` 只由应答、run 终态或进程退出清理；时间流逝不淘汰请求。
  5. **持久化交互记录**：`InteractionsStore` 按 tenant 写 `<dataDir>/interactions-<tenant>.json`（`atomicWrite` + `0600`），记录 `pending` / `answered` / `orphaned`。gateway 启动时加载；重启后仍是 `pending` 的记录转 `orphaned`（本进程没有对应 run）。文件损坏 / 不可读时向 stderr 报错并按空集处理，不删除原文件；tenant 名只接受 `[A-Za-z0-9._-]`，不安全名称不落盘。
  6. **终态清理与幂等**：run 进入 `completed` / `failed` / `cancelled` 时，同 run 的 pending 全部移出并持久化为 `orphaned`。重复应答返回首次结果（`duplicate: true`）；同一请求以不同决定重答返回 `conflict`；`orphaned` 请求应答返回新错误码 `run_ended`，不伪装成 `not_found`。有界记录清理只淘汰最旧的 `answered` / `orphaned`，pending 不淘汰。
  7. **Web 内联权限**：删除全局权限 Modal，`PermissionCard` 内联到所属 `RunCard`；跨 session 的待处理请求由顶部待处理条提示。其他端应答（`tool.permission.response`）或过期（`tool.permission.expired`）事件都会收起对应卡片；应答返回 `expired` / `run_ended` 时关闭卡片并 toast 对应语义。`ask_user` 本批仍是全局弹窗，保持原 120s 事件时间 TTL。

- **备选**：(a) 继续 120s 超时——把人工决策当成机器超时，用户离开终端就会失败；(b) 默认超时但放宽到 10 分钟——只是把问题推迟，仍需固定 TTL 语义；(c) pending 只存内存并用 TTL 清扫——跨重启无法区分已应答与丢失；(d) 持久化所有鉴权信息——文件会成为敏感面，记录只保留请求 / 决定 / 时间；(e) 重复应答返回 `not_found`——调用方无法区分“不存在”与“已处理”，前端会误报过期；(f) 继续全局权限遮罩——多 run 并发时无法归属，且遮挡对话上下文。

- **后果**：权限等待不再因时间自动失败，run 不会因为人不在而进入失败态；用户必须显式应答或取消。gateway 重启后旧 pending 明确变成 `orphaned`，迟到应答得到 `run_ended`；重复点击是幂等的。代价是 `<dataDir>` 多一份 0600 的交互记录文件，且 Web 刷新恢复仍依赖事件重放缓冲。core 的 `allow session` 目前只被解析为应答字段，实际只读取 `remember`（等价 `always`），session 级批准尚未生效；`interactions.pending` RPC 未提供。实现变更必须同步更新 `packages/core/__tests__/permission-lifecycle.test.ts`、`packages/serve/__tests__/interactions-store.test.ts` 与 Web 交互测试。

- **关联**：ADR-026（工具自描述权限）、ADR-029（交互暂停事件流）、ADR-036（Gateway 协议）、ADR-048（统一 RPC 方法表）、ADR-054（RunExecution 与失败隔离）、ADR-055（工具路径边界）、ADR-077（0.11.1 权限时效，本 ADR 修订其“超时致命”与 Web TTL 部分）；`packages/core/src/runtime/permission-policy.ts`、`packages/core/src/runtime/agent-runtime.ts`、`packages/serve/src/run-engine.ts`、`packages/serve/src/interactions-store.ts`、`packages/serve/src/gateway/methods/interactions.ts`、`apps/web/src/domains/chat/PermissionCard.tsx`、`apps/web/src/domains/chat/RunCard.tsx`、`apps/web/src/gateway/interactions.ts`。
