---
adr: 89
title: 0.18.0 tenant 事件流是唯一事件面（TenantEventHub）
status: accepted
date: 2026-10-21
related: [7, 16, 29, 36, 48, 67, 79, 82]
tags: [event, gateway, tenant, multi-tenant, hub, breaking]
---

## ADR-089：0.18.0 tenant 事件流是唯一事件面（TenantEventHub）

- **上下文**：0.18 的 P0 修复（`tenantEventsFor`）解决了“应答发到共享流、工具收不到”，但 gateway 仍以**共享事件流**为中心：serve 启动时新建 `sharedEvents`，每个 tenant 通过单向桥把事件镜像进去；`GatewayOptions.events` 是单个流；序号、环形缓冲、广播与 agent registry 全绑在这一个订阅上；gateway 自己还向它 publish 诊断事件。结果是同一批事件存在两个事实源：tenant 流（runtime / 工具 / trace / metrics）与 shared（广播）。桥的注册顺序、去重与生命周期都靠调用方小心维护，任何新的发布方都可能绕过桥或造成重复。

- **决策**：
  1. **tenant 运行时事件流是唯一事件面**：删除 `sharedEvents`、tenant→shared 单向桥、`GatewayOptions.events`、`LocalRpcOptions.events` 与 `shutdownServeStack.unsubShared`。不再有“共享流”这一层。
  2. **新增 `TenantEventHub`**（`packages/serve/src/tenant-event-hub.ts`）：tenant 用 `register(tenantId, stream)` 接入，hub 负责 fan-in。接口固定为 `register` / `streamFor` / `tenantIds` / `subscribe`（原始事件）/ `subscribeSequenced`（`map` + 全局单调 `seq`）/ `since` / `gapFor` / `latestSeq` / `oldestSeq` / `close`。**hub 不暴露 `publish`**：业务代码只能写自己的 tenant 流。
  3. **`map` 必填且不得原地修改**：`createGatewayEventHub({ redactor })` 负责 `capToolEvent(redact(event))`；raw 订阅者（RunEngine）看到原始 `requestId` / `input`，sequenced 订阅者与回放看到脱敏副本。`maxHistory` 从 `GatewayOptions` 移到 hub。
  4. **RunEngine 只持 per-tenant 流**：`tenantEventsFor` 必填；应答只 publish 到 `hub.streamFor(pending.tenant_id)`，流不存在返回 `run_ended`，不再回退共享流。engine 不再接受 `events`。
  5. **gateway 只读 hub**：raw fan-in 驱动 `engine.handleEvent`；sequenced fan-in 驱动 agent registry、WS/SSE 广播与 team SSE。`gateway.stop()` 只退订，不关闭注入的 hub。
  6. **诊断事件投 default tenant**：`rpc.result_invalid` / `team.*` 发布到 `hub.streamFor(defaultTenantId)`，流缺失时丢弃；保持既有“只有 default 可见”的行为。
  7. **生命周期由 app 拥有**：`src/cli.ts` 创建 hub、注册 bootstrap 默认 bundle、传给 tenant factory 与 gateway，并在 `closeAll` 之后 `hub.close()`；工厂在构建 / dispose 时注册 / 注销。bootstrap 的本地 dispatcher 用单 tenant hub，TUI 仍直接使用 `ctx.events`。
  8. **交互去 TTL**：`interactionTtlMs` / `engine.sweep()` / gateway 30s 定时器删除；pending 只由应答、run 终态或 abort 清理。Web 的 ask 不再有过期字段，`requestedAt`（事件时间）只用于与权限请求混排。

- **冻结契约**：
  - 协议 / 帧 / `events.subscribe` / `events.list` 的请求与返回形状不变；`seq` 仍由 gateway 进程分配并保持全局单调；跨节点去重键仍为 `(node, incarnation, run_id, seq)`（ADR-067）。
  - 同一 `EventStream` 被多个 tenant 复用时只订阅一次；缺失的 `tenant_id` 用**首个注册**的 tenant 补齐（测试 / 单 runtime 多 tenant 场景）。
  - `hub.register` 按 tenant 幂等：同 stream = no-op，不同 stream = 抛错；注销后不再投递；`close()` 幂等。
  - 兼容性：0.18 允许 breaking。生产代码不保留 `events` 兼容别名；只有测试 helper 接受 `events` 并内部构造 hub。

- **备选**：(a) 保留双向桥——会形成 shared↔tenant 回路与重复投递；(b) gateway 自己创建 hub——hub 生命周期与 gateway 耦合，tenant factory 无法在构建期注册；(c) 保留 shared 只读投影——仍有两个事实源与两套过滤语义，无法通过“无 publish”守卫；(d) 让 hub 在回放时现场脱敏——缓冲里会留下未脱敏副本，违反既有约束。

- **后果**：事件面从一个“聚合流 + 桥”收敛为一个 fan-in 组件；新增 tenant 只需 `register`，不再改 cli 的桥。代价是 0.18 的嵌入方 API breaking（`GatewayOptions.events` → `hub`），测试需要构造 hub；hub 成为事件链路的单点，必须保证订阅者异常隔离与 `map` 不抛（已分别隔离 / 降级为跳过该事件）。`SharedEvents` 相关文档与测试同步删除。

- **关联**：ADR-007（流式=事件订阅）、ADR-016（流式增量事件）、ADR-029（交互暂停事件流）、ADR-036（Gateway 协议）、ADR-048（统一 RPC 方法表）、ADR-067（去重键范围）、ADR-079（权限生命周期 / 应答投递）、ADR-082（ask 内联）；`packages/serve/src/tenant-event-hub.ts`、`packages/serve/src/gateway.ts`、`packages/serve/src/run-engine.ts`、`src/cli.ts`、`src/bootstrap.ts`、`src/tenant-runtime-factory.ts`、`src/shutdown-sequence.ts`。
