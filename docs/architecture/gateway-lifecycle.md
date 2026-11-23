---
title: Gateway 单点启动与进程生命周期（职责与边界）
kind: current
triggers: [gateway, lifecycle, 生命周期, 单点启动, adopt, 接管, 分段启动, readiness, 错误域, 隔离, node, hub, 重启, 停机, stop, detached, 孤儿, engine 池, engine_pool]
paths: [src/gateway/**, src/gateway-command.ts, docs/operations/GATEWAY.md]
---

# Gateway 单点启动与进程生命周期

> 现态（0.55）。本文只写**职责与边界**；运维步骤、命令、故障处置见
> [operations/GATEWAY.md](../operations/GATEWAY.md)。

## 一段话

`vessel gateway start` 只启动**平台层**（静态宿主 + `/health` + `/platform/rpc`，缺省
`127.0.0.1:8642`），并按 registry（`<dataDir>/nodes.json`）把 `auto_start: true` 的本地
Node API 与本地 Hub **拉起来**；平台**不拥有**它们的生命周期——平台进程退出（`gateway stop`、
重启、崩溃）后 node/hub 继续跑，下一次 `gateway start` 按既有判据 **adopt** 回来。
启动与等待**分段**：平台先能接请求，节点就绪在后台逐个结算，单个节点失败只标它自己。
实现细节（端口、锁文件、日志行、故障处置）见 [operations/GATEWAY.md](../operations/GATEWAY.md)。

## 生命周期表（职责边界，冻结语义）

| 动作 | gateway（平台层） | registry 里 `auto_start` 的 node | hub | 前端 |
|---|---|---|---|---|
| `vessel gateway start` | 起 | 未运行则拉起；已运行则 **adopt** | 起 / adopt | 可访问 |
| `vessel gateway restart` | 重启 | **不动**（重启后 adopt 回来） | 不动 | 短暂中断 |
| `vessel gateway stop` | 停 | **不动**（继续跑） | 不动 | 不可访问 |
| `vessel gateway stop --no-keep-nodes` | 停 | **停掉本机注册并属于本机的** | 停 | 停 |
| gateway 被强杀 / 崩溃 | 死 | 存活 | 存活 | 不可访问 |

「整体关闭」= `vessel gateway stop --no-keep-nodes`（`--all` 只表示**所有 gateway 实例**，
不表示连 node 一起停）。两种停止都要打印「谁还在跑 / 停了谁、哪个没停下来及原因」。

## 职责边界

- **Gateway 拥有**：`platform.pid` / `platform-<instance>.lock`、平台监听、平台 RPC、
  spawn 记录（`platform-children.json`，只记**本平台 spawn** 的子进程，用于按归属复核后停止）。
- **Node 拥有**：自己的 `gateway.pid` / `gateway-default.lock`、`nodes.json` 里声明的
  `data_dir`、自己的 API 监听。Node 可以完全独立于 Gateway 运行（`vessel node start --daemon`）。
- **Hub 拥有**：`<hubDataDir>/hub.lock`。手工/外部启动的 Hub 永远只 adopt，不被杀。
- **不越界**：Gateway 只终止「拿得出归属证据」的子进程（pid + started_at + node_id / hub lock
  三元复核）；adopt / external 一律不动。判据**只收紧不放松**。
- **Engine 池（`gateway.engine_pool.size>0` 时）**：gateway 监督的 detached engine 进程（不是 node/hub）；routing.json 由 gateway 唯一写者，缺省 stop/restart（handoff）保池待新平台 adopt，`--stop-nodes` 才 terminate owned（adopt/external 永不杀）。见 [ADR-106](../adr/ADR-106-engine-pool.md) 与 [tools.md](tools.md#engine-exec)。

## 分段启动与错误域隔离（0.55）

- 平台「能接请求」不等任何节点：spawn 判定（phase A）做完就监听、写 `platform.pid`，
  就绪等待（phase B）在后台并发结算。
- 每个节点一台独立状态机：`starting` / `ready` / `failed` / `adopted` / `external`；
  `failed` 必须带原因与时刻。「节点没起来」是**可见状态**，不是被跳过的日志。
- 一个节点慢、起不来、启动中退出、身份不符、运行期崩溃，**只影响它自己**：平台继续服务，
  其它节点照常就绪。就绪上界是常量（180s），超时只标该节点。

实现细节：日志行格式、`nodes.json`、端口占用与句柄继承的坑、Windows 计划任务 / systemd
跑法，见 [operations/GATEWAY.md](../operations/GATEWAY.md)。
