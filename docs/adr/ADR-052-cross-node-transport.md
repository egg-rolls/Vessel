---
adr: 52
title: 跨节点 transport 与 team 调度
status: accepted
date: 2026-10-19
related: [36, 37, 40, 48, 49, 51]
tags: [transport, multi-node, team, events]
---

## ADR-052：跨节点 transport 与 team 调度

- **上下文**：0.5 的 `Transport` 只有进程内与回环实现，team 的 5 个工具与消息投递都假设单机、单一 gateway。0.6 的 F5 要求父端能把 run / team 任务派发到远端节点，并在父端观测结果与事件。跨节点不能依赖共享文件系统，也没有全局时钟或全局事件序；同时 core 不能吸收 team 业务语义。本 ADR 记录已批准的 additive 扩展、跨节点协议与断线语义；实现随 0.6 合入，本文不宣称已实现。
- **决策**：
  1. **Transport port additive 扩展（core）**：`kind` 扩为 `'in-process' | 'loopback' | 'remote'`；新增可选 `readonly nodeId?: string` 与可选 `request?<T>(nodeId, { requestId?, method, params? }): Promise<T>`。`send` / `receive` / `peers` / `close` 语义不变。`request` 是通用 port 能力，**不含 team 语义**。
  2. **事件字段（core）**：`RunEvent.node_id?: string`、`EventFilter.nodeId?: string` 作为 additive 字段；seq 仍由各节点自行分配。
  3. **远端实现（asm）**：`src/remote-transport.ts` 提供 `kind: 'remote'`、`nodeId` 与 `request`；消息走 `POST /v1/team/messages`，事件走 `wss://<node>/v1/events`；鉴权用 Bearer token + 显式 CA；错误统一为 `PeerTransportError`。节点之间**不共享文件系统**，消息体必须自包含。
  4. **静态节点表**：`transport.kind: remote` 时由 `transport.nodes[]` 提供 `{ id, url, token?, token_env?, ca_file? }`；`src/node-registry.ts` 维护节点状态，以 `/health` 或 `/v1/team/agents` 心跳标记 `healthy` / `unreachable`。0.6 不做 mDNS / 服务网格 / 自动发现。
  5. **跨节点 team 协议（冻结）**：仍是 5 个 `team_*` 工具，仅增加可选 `node` 参数；`team_spawn` → `POST /v1/team/agents`，`team_inbox` → `GET /v1/team/inbox`，`team_status` → `GET /v1/team/agents[/:id]`。错误码冻结为 `transport_closed` / `peer_not_found` / `peer_unreachable` / `timeout` / `unauthorized` / `unsupported_protocol` / `invalid_request` / `agent_not_found` / `no_spawn`。
  6. **投递语义（冻结）**：task / result 为 **at-most-once**；结果回投失败只发既有 `team.transport.error`，**不自动重试**；父端通过 inbox / status 对账。`spawn` 非幂等，**不自动重试**；`status` / `inbox` 允许 asm 做一次幂等重试。`spawn` 带 `request_id` 用于去重。
  7. **事件扇出**：父端按节点订阅 `wss://.../v1/events`，按 `(node_id, wire seq)` 去重后回灌本地事件流，并填 `RunEvent.node_id`。seq 按 `(node_id, run_id)` 解释，**无全局序**；`EventFilter.nodeId` 供消费方过滤。
  8. **tenant 边界**：`AgentMessage` 不携带 tenant；远端 tenant 必须由 asm 从 token principal 派生，**不得从消息体取**，否则会跨租户。
  9. **实现顺序**：先完成 Phase A（远程控制面、token/TLS、WS 修复）并验证，再做远端 transport 与跨节点 team。
  10. **非目标**：跨机器 durable、分布式锁、共享 sqlite、多进程同 tenant 写、workflow 跨机编排与恢复、节点自动发现、反向代理信任头。需要新增 canonical RPC 方法时，必须先发 DECISION-014 addendum，不自行扩方法表。
- **备选**：(a) 在 core 里加入 team 语义与节点概念——违反 core 的领域无关约束；(b) 通过共享文件系统交换消息——远程节点不可达且无法定义一致性；(c) 对 spawn 自动重试——任务非幂等，会重复执行；(d) 维护全局事件序——跨节点无共享时钟，代价高且无消费需求。均不取。
- **后果**：节点表与心跳成为部署输入；断线语义明确但需要调用方用 inbox/status 对账；事件消费方必须按 `(node_id, seq)` 去重且不能假设全局顺序。core 只增加可选字段与方法，既有实现不受影响。
- **关联**：ADR-036（gateway）、ADR-037（模块化 runtime）、ADR-040（durable 单机边界）、ADR-048（RPC / legacy team 端点）、ADR-049（tenant 与 principal）、ADR-051（远程控制面）、ADR-053（安全基线）；DECISION-014 §1 Phase B、§3、§4.2–§4.3。
