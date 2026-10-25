---
title: Gateway / RPC / 远程约定
kind: advisory
triggers: [gateway, serve, rpc, remote, tls, origin, hub, tenant, attention, node_id, shutdown]
paths: [packages/serve/**, src/rpc/**]
applies_to: [N, M]
---

# Gateway / RPC / 远程约定

> 改 `packages/serve/**` / `src/rpc/**` 前读这一篇；远程与权限硬规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## RPC

- 新 RPC 方法进 `packages/serve/src/gateway/methods/<domain>.ts` 并导出 `createXxxMethods`，由 `gateway.ts` 展开；不要把方法表回灌 `gateway.ts`。
- 新增 canonical 方法必须发 addendum，并同时写 `result_schema`；方法清单与冻结项见 [gateway-rpc.md](../architecture/gateway-rpc.md#rpc-methods)（ADR-059/066）。

<a id="legacy-transport"></a>

## legacy 传输面

- `transport.kind` 只剩 `in-process`；`loopback` / `remote` / `transport.nodes[]` 是显式 validation error。
- legacy `/v1/team/*` / `RemoteTransport` / `NodeRegistry` / `LoopbackTransport` 已删除，不得恢复。

## 远程安全

- 不默认开启远程监听或 TLS；远程必须显式 opt-in 且带 token；非回环必须 TLS；`serve.allowed_origins` 只接受显式 http(s) origin，禁止 `*` / path / query。
- token 不进 WS URL / query；首帧 `auth` 5s 内未合法即关闭 4401；非 admin 指定其它 tenant → 4403。
- 完整证书 / Origin / 客户端步骤见 [REMOTE.md](../operations/REMOTE.md)；契约见 [gateway.md](../architecture/gateway.md#protocol)。

## tenant 事件与权限应答

- `respondPermission` / `respondAsk` 只能发布到该 tenant 的运行时事件流；流不存在返回 `run_ended`，不得回退共享流或两边都发。
- 权限记录持久化到 `interactions-<tenant>.json`（`0600` + `atomicWrite`），pending 不 TTL 清扫、有界清理也不淘汰 pending；重复应答幂等 / `conflict` / `orphaned`（ADR-079 Addendum）。
- `TenantEventHub` 是唯一事件面：不得重新引入 `sharedEvents`、tenant→shared 桥或单流 `GatewayOptions.events`；`hub` 不暴露 `publish`、不代理 / 不持久化消息正文、不存 pending；本地 hub 只监听 `127.0.0.1`，`hub.lock` 单实例，不自动 join / 配对（ADR-089/093）。
- 跨节点去重键含 `node` / `incarnation` / `run_id`（缺失写 `-`）；消息键含 `from`，gateway 再加 `tenant`；代际变化或 seq 回退只清该来源节点（ADR-067）。

## 关闭与 gateway 生命周期

- 关闭顺序固定：`await gateway.stop()` → 取消订阅 / 关闭 transport → `beforeClose` → `closeAll` → `shutdown`；后两步 `{ drain: false }`，不二次 drain。
- 中断 active run 用 `interrupt('shutdown'|'timeout'|'user')`，不得只 abort signal 丢原因；headless 不得提前 `process.exit` 跳过清理（ADR-070）。
- 运行态以 `<dataDir>/gateway.pid` 为唯一来源；`stop` 只删本进程持有的 PID；服务注册只在显式 `install-service` / `uninstall-service` 时执行。`gateway.reload` 只热更新 plugins 扫描缓存与 `serve.allowed_origins`，其余如实进 `requires_restart`（ADR-074/075）。

## 节点与 attention

- `node_id` 唯一来源是 `resolveNodeId()`：`config.host.nodeId` > `<dataDir>/node.json` > 首次生成并 `0600` 原子写；不得由 hostname / IP 派生；损坏抛 `node_identity_corrupt`（ADR-091）。
- 远程 attention：permission / ask 必须在运行 agent 的节点本地应答；`vessel attention` 用 gateway / team token 直连，peer token 不能用于 attention；`answered_by` 仍只 `human | policy`；roster 排序只由 `TeamService` 产生。
- `ask_user` 在 gateway / serve 入口注册（`--run` / headless / 管道不注册）。

## 指针

- [gateway.md](../architecture/gateway.md) · [gateway-rpc.md](../architecture/gateway-rpc.md) · [REMOTE.md](../operations/REMOTE.md) · [CONFIG.md](../operations/CONFIG.md)。
