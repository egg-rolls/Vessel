---
title: Gateway 单点启动与进程生命周期（职责与边界）
kind: current
triggers: [gateway, lifecycle, 生命周期, 单点启动, adopt, 接管, 分段启动, readiness, 错误域, 隔离, node, hub, 重启, 停机, stop, detached, 孤儿, engine 池, engine_pool, drain, quiesce, 排水, 优雅停止, force, 舰队, vessel stop, vessel restart, 自重启, 看门狗, supervise]
paths: [src/gateway/**, src/cli/commands/gateway/gateway-command.ts, src/cli/commands/fleet/stop-command.ts, src/cli/commands/fleet/restart-command.ts, src/cli/commands/node-command.ts, src/node/node-drain.ts, docs/operations/GATEWAY.md]
---

# Gateway 单点启动与进程生命周期

> 现态。本文只写**职责与边界**（谁拥有谁、动作语义、drain 与监督）；运维步骤、命令输出、
> 故障处置见 [operations/GATEWAY.md](../operations/GATEWAY.md)。

## 一段话

`vessel gateway start` 只启动**平台层**（静态宿主 + `/health` + `/platform/rpc`，缺省
`127.0.0.1:8642`），并按 registry（`<dataDir>/nodes.json`）把 `auto_start: true` 的本地
Node API 与本地 Hub **拉起来**；平台**不拥有**它们的生命周期——平台进程退出（`gateway stop`、
重启、崩溃）后 node/hub 继续跑，下一次 `gateway start` 按既有判据 **adopt** 回来。
启动与等待**分段**：平台先能接请求，节点就绪在后台逐个结算，单个节点失败只标它自己。

## 生命周期表（职责边界，冻结语义）

| 动作 | gateway（平台层） | registry 里 `auto_start` 的 node | hub | 前端 |
|---|---|---|---|---|
| `vessel gateway start` | 起 | 未运行则拉起；已运行则 **adopt** | 起 / adopt | 可访问 |
| `vessel gateway restart` | 重启（**恒平台-only**） | **不动**（adopt 回来，仍跑旧代码） | 不动 | 短暂中断 |
| `vessel gateway stop` | 停 | **不动**（继续跑） | 不动 | 不可访问 |
| `vessel gateway stop --stop-nodes` | 停 | **停掉本机注册并属于本机的**（归属复核） | 停 | 停 |
| `vessel stop`（舰队级） | 停 | **停掉归属可复核的**（manifest 三元复核） | 停（manifest 内） | 不可访问 |
| `vessel restart [name]`（舰队级） | stop → start | stop → start（**stop 未全成 → 不 start**） | stop → start | 短暂中断 |
| gateway 被强杀 / 崩溃 | 死 | 存活 | 存活 | 不可访问 |

- `--no-keep-nodes` / `--keep-nodes` 是 stop 的兼容别名（前者 = `--stop-nodes`，后者 = 缺省）；`--all` 只表示**所有 gateway 实例**，不表示连 node 一起停。**`gateway restart` 的 `--stop-nodes` / `--no-keep-nodes` 已弃用**：只打 warning 指路 `vessel restart`，不再停 node（用户裁定 #6：gateway restart 恒平台-only）。
- `vessel restart [name]`：name 先按 gateway 实例名匹配（重启该实例舰队），未命中再按 registry node 名匹配（委托 `node restart` 只重启该 node）；缺省 = 本舰队全量。stop 段复用 `stopGateway` 共享接缝（缺省优雅不限时 + 进度，`--force` 传播），start 段复用既有 daemon start 接缝；确认一次覆盖 stop+start。
- `vessel stop`：缺省停 resolved data root 内所有实例的舰队，停前只读清点 + y/N 确认（`--yes` 跳过；非交互无 `--yes` 拒绝）；`--connect` 远程停需 opt-in（只认显式 flag，远程不强杀，见 [REVERSE-PROXY.md §12](../operations/REVERSE-PROXY.md)）。standalone hub / external node 只报告不动。
- 两种停止都要打印「谁还在跑 / 停了谁、哪个没停下来及原因」。

## Node 停止 / restart 与 drain-to-quiesce

- **缺省完全优雅**（用户裁定 #5）：`node stop` / `node restart` / `stopSpawnedChildren` 的 node 子进程先经 `gateway.shutdown` 请进程内跑退出序列（`node-drain.ts:createNodeDrainer`）：① fence 准入——新投递只落 durable inbox 并返 `deferred(draining)`（人类输入同样排队，不再拒绝；无 inbox 的极简入口才 `gateway_restarting`）；② **不限时**等全部活跃 run（执行面快照 ∪ scheduler queued+running，按 run_id 去重）自然终态，每 5s 进度日志；③ flush 会话状态。**不 interrupt、不写 resume 标记**——run 自然完成就没有欠账；幂等（SIGTERM 连发 / 多路径并发只跑一次）。
- **停止方等待**（`stop-drain.ts:waitForProcessExit`）：缺省不限时等进程自死，每 5s 采样 live run 渲染进度；显式 `--timeout` 只是可选上限，到点**不自动强杀**（如实报告阻塞者，提示升级阶梯）。
- **`--force` = 唯一非正常退出路径**：终止前快照在跑 run → 强杀（POSIX SIGKILL；Windows 无条件 `taskkill /T /F` 整棵子树）→ 停止方代打 `stop.forced` 审计（abnormal_exit / runs_cut）并持久化进目标实例日志（O7）。force 仍做归属复核——升级的是等待策略，不是归属判据。
- **quiesce 后有界兜底（DR15-1）**：quiesce 后 30s 进程未自死 → force + `stop.forced` 审计（`reason=quiesce_exit_timeout`，此时已无 live run，runs_cut 恒 0）。quiesce 推断要求**阳性证据**：采样成功 0 live run，或专属连接拒绝（监听已闭 ⟹ drain 毕）；401 / 超时 / 其它失败不计入强杀时钟。**候 run 段不限时是红线**：采样到 live run > 0 即重置时钟。
- 优雅受理失败（老版本无 `gateway.shutdown` / 网络）→ 回退强杀 + `node.drain.skipped` 审计持久化。停止凭据以目标 node 自身 config/dataDir 为权威（进程内 spec token 优先）。
- **托管 node 不独立 restart**（提示 `vessel restart` / `gateway restart`），避免与平台 supervisor 的 respawn 打架。
- **自重启 = 预约受理 + detached 编排者**（`vessel restart --self` / `gateway.restart` RPC）：写 continuation 标记 + handoff 文件（TTL 10min）→ spawn 编排者 → 立即返回「正在重启」；编排者等触发者 run 终态（有界，缺省 120s，超时撤销不重启）后 stop/start。RPC 契约、Windows WMI 干净父系 spawn 与启动健康确认见 [gateway-rpc](gateway-rpc.md) 的 `gateway.restart` 条。

## 职责边界

- **Gateway 拥有**：`platform.pid` / `platform-<instance>.lock`、平台监听、平台 RPC、spawn 记录（`platform-children.json`，只记**本平台 spawn** 的子进程；adopt 来的上一代活条目合并保留、死条目丢弃，供按归属复核后停止）。
- **Node 拥有**：自己的 `gateway.pid` / `gateway-default.lock`、`nodes.json` 里声明的 `data_dir`、自己的 API 监听。Node 可以完全独立于 Gateway 运行（`vessel node start --daemon`）。
- **Hub 拥有**：`<hubDataDir>/hub.lock`。手工/外部启动的 Hub 永远只 adopt，不被杀。
- **不越界**：Gateway 只终止「拿得出归属证据」的子进程（pid + started_at + node_id / hub lock 三元复核）；adopt / external 一律不动，判据**只收紧不放松**。handoff（keep）路径下**已就绪**子进程一个不终止；**未就绪**（started_at 空）的例外终止——没有归属证据、留着只会变孤儿撞端口。
- **spawn 卫生**：node/hub 子进程 detached + `windowsHide`；env 按自身 dataDir 重写继承异根（`VESSEL_DATA_DIR` + CLI 标记、`VESSEL_TOOL_OUTPUT_DIR` / `VESSEL_PLUGIN_CONFIG` 派生值），生产根不击穿 gateway → node。node bind 撞 `port_in_use` → 有界退避重 spawn（3 次 × 1.5s；证据 = 子进程已死 + **本次启动日志段**含 port_in_use，段扫描非尾 N 行）。
- **Engine 池（`gateway.engine_pool.size>0` 时）**：gateway 监督的 detached engine 进程（不是 node/hub）；routing.json 由 gateway 唯一写者，缺省 stop/restart（handoff）保池待新平台 adopt，`--stop-nodes` 才 terminate owned（adopt/external 永不杀）。平台层 graceful-first：停止方先经 `/platform/rpc gateway.shutdown` 让平台进程内跑到 `poolSupervisor.stop()`（owned-only）再退；强杀回退仍在（`platform.drain.skipped`）。**池禁用清扫**（`pool-supervisor.ts:sweepDisabledPool`）：size=0 / 移除后按上一纪元 routing.json manifest 清扫遗留 detached engine——owned → deactivate → 宽限 → 强杀兜底；external 永不杀；pid 复用只清状态文件。见 [ADR-106](../adr/ADR-106-engine-pool.md) 与 [tools.md](tools.md#engine-exec)。

## 外部存活看门狗（可选监督）

- `gateway.supervise.enabled` 缺省**关**：探活分不清「僵死」与「过载」，宁可让过载自己缓过来；外部 systemd / k8s 已做同一件事时也不必开。
- 显式开启后由**父进程**探活 node 子进程 `/health`（子进程主线程停摆时进程内定时器全停，只有父进程能推进）：2s 周期 / 2s 超时 / 连续 3 次失败判僵死 → SIGKILL → 重新 spawn；退避 1s→60s，连续 5 次探活成功退出退避；每小时重启上限 5，超限停手报错。stop/restart 期间、未就绪节点不探活（看门狗在 stop 时**先停**，不论 keep）。
- 状态落盘 `<dataDir>/platform-watchdog[-<instance>].json`；`gateway status` 显示最近探活与重启计数。

## 分段启动与错误域隔离

- 平台「能接请求」不等任何节点：spawn 判定（phase A）做完就监听、写 `platform.pid`，就绪等待（phase B）在后台并发结算。
- 每个节点一台独立状态机：`starting` / `ready` / `failed` / `adopted` / `external`；`failed` 必须带原因与时刻。「节点没起来」是**可见状态**，不是被跳过的日志。
- 一个节点慢、起不来、启动中退出、身份不符、运行期崩溃，**只影响它自己**：平台继续服务，其它节点照常就绪。就绪上界是常量（180s），超时只标该节点。
- node 监听地址解析 / 探活共用叶模块 `node-listen.ts`：「活进程自己写的地址」优先于配置推导（仅记录活着且 node_id 不冲突时采用），runtime 侧健康订阅与 CLI 共用同一份实现。

实现细节：日志行格式、`nodes.json`、端口占用与句柄继承的坑、Windows 计划任务 / systemd
跑法，见 [operations/GATEWAY.md](../operations/GATEWAY.md)。