---
title: Gateway 运维：单点启动、节点独立运行与停止
kind: current
triggers: [gateway, 运维, operations, 单点启动, node 独立启动, node start, daemon, systemd, launchd, schtasks, 计划任务, stop, restart, force, drain, keep-nodes, 整体关闭, 端口占用, 句柄继承, readiness, adopt, 缺席, 诊断, 日志, 时间线修复, timeline.idx, 索引重建, 中段损坏]
paths: [src/gateway/**, src/cli/commands/gateway/gateway-command.ts, src/cli/commands/gateway/gateway-nodes-command.ts, src/cli/commands/fleet/stop-command.ts, src/cli/commands/fleet/restart-command.ts]
---

# Gateway 运维：单点启动、节点独立运行与停止

> 职责与边界（谁拥有什么、生命周期表）见 [architecture/gateway-lifecycle.md](../architecture/gateway-lifecycle.md)；本文只讲怎么做。**node/hub 不与 gateway 共命运**：`gateway stop` 缺省只停平台层。

## 1. 单点启动 gateway

```bash
vessel gateway start                 # 缺省 detach：spawn 平台、确认就绪、打印 pid/port/node 名即退
vessel gateway start --foreground    # 前台（Ctrl+C 停止；连子进程一起停，见 §4）
vessel gateway start --instance 8643 # 多实例（缺省实例名 default）
```

启动分段：① 平台自身就绪（实例锁 → 监听 `127.0.0.1:8642` → 写 `platform.pid`）；② phase A 按 `nodes.json` 顺序**并发**判定每个 `auto_start` 节点 adopt 还是 spawn（Hub 同理），只做文件读 + spawn，**不等就绪**；③ phase B（后台）并行等各节点 `gateway.pid` + `/health`，谁先好谁先报。「平台 ready」不含节点就绪时间：慢节点不拖住 WebUI/RPC；readiness 上界 180s 且不在关键路径，超时只标该节点 `failed`。

前台 TTY 打印摘要（`Platform` / `Node` / `Hub` / `ready in N ms`），节点行尾带当时状态 `(starting|ready|failed: 原因|adopted|external)`。非 TTY（daemon 日志）逐行输出：

```
node n-bad: failed (node_start_failed: node "n-bad" exited during startup, after 145 ms, at 2026-11-16T07:03:40.264Z, pid 44376)
```

失败行进 stderr（daemon 下同样落 `logs/gateway.log`）。实时状态另有 `vessel gateway status` / `vessel ps`、平台 RPC `platform.nodes.list`（按 `/health` 探测，返回 `up/down`）。

## 2. 独立启动一个 node（不经 gateway）

```bash
vessel node start --daemon --config /path/to/node.yaml   # 独立拉起一个 Node API（缺省前台）
vessel node status [--json] [--rpc]
vessel node stop [--force]
vessel node reload --scope config
```

- node 只需要自己的配置（`serve.hostname` / `serve.port`、`host.nodeId`）和自己的 `data_dir`，不依赖 gateway 进程。
- 注册进 gateway 的 registry（让 `gateway start` 负责拉起 / adopt）：

```bash
vessel gateway nodes add n-a --data-dir ~/.vessel/data-a --config ~/.vessel/data-a/node.yaml
vessel gateway nodes add n-b --data-dir ~/.vessel/data-b --config ~/.vessel/data-b/node.yaml --no-auto-start
vessel gateway nodes list [--json]
```

- `auto_start: false` 的节点不由 gateway 拉起；状态显示 `external`，原因里直接给启动命令。
- 同一个 `data_dir` 已有活进程：gateway 只 **adopt**（不重复 spawn、不杀）。

## 3. 常驻：Windows 计划任务 / Linux systemd / macOS launchd

`vessel gateway install-service`（按当前平台选择；`--systemd` 等显式指定必须与当前平台一致）；卸载 `vessel gateway uninstall-service`。

| 平台 | 形态 | 关键事实 |
|---|---|---|
| Linux | systemd **user** unit（不需要 root） | `~/.config/systemd/user/vessel-gateway.service`，`ExecStart=/usr/bin/env vessel gateway start`，`Restart=on-failure`，stdout/stderr 追加到 `<dataDir>/logs/gateway.log` |
| macOS | LaunchAgent | `~/Library/LaunchAgents/com.vessel.gateway.plist`，`KeepAlive=true`，`RunAtLoad=true` |
| Windows | 登录时计划任务（避免管理员服务） | 任务名 `VesselGateway`，`schtasks /SC ONLOGON`，命令 `vessel gateway start` |

服务管理器托管的是**平台层**。要连 node 一起常驻，给每个 node 单独配常驻（`vessel node start --daemon --config …` ＋ 各自的计划任务/unit）。`gateway stop` 缺省只停平台层，不动本机 spawn 的 node/hub（见 §4）。

## 4. 停止与重启

**缺省只停平台层，不动 node/hub**——它们身上可能跑着会话，杀掉不可恢复。破坏性动作必须显式。

| 命令 | 平台层 | node/hub | 说明 |
|---|---|---|---|
| `vessel gateway stop` | 停 | **不动**（下次 start adopt 回来） | 缺省**不限时 drain**；`--timeout` 才是可选上限；输出 still-running 清点 + 可复制提示 |
| `vessel gateway stop --stop-nodes` | 停 | 一起停（本机 spawn/接管、归属可复核的） | `--keep-nodes`/`--no-keep-nodes` 保留为兼容别名（前者等价缺省，后者等价 `--stop-nodes`） |
| `vessel gateway stop --force` | 强杀 | 按上面选择 | 显式非正常退出：快照 + 强杀 + 审计行 `stop.forced`（abnormal_exit / runs_cut / sessions / runs / signal） |
| `vessel gateway restart` | 重启 | **恒不动**（新平台 adopt 回来，仍跑旧代码） | `--stop-nodes`/`--no-keep-nodes` 已弃用：解析保留但不再停 node，打 warning 指路 `vessel restart` |
| `vessel gateway stop --all` | 停所有实例的平台层 | 按缺省（不动） | `--all` 是实例选择器，不是「连 node 一起停」 |
| `vessel stop` | 停 | 一起停（manifest 归属可复核的；owned 池 engine 进程内 terminate） | 舰队级：缺省 resolved data root 全实例，`--instance/--port` 收窄；本地缺省不限时 drain；全根清点 + y/N 确认，`--yes` 跳过，非交互无 `--yes` 拒绝 exit 1 |
| `vessel stop --connect <url>` | 远程平台停 | 远程舰队（registry 级清点） | 需 `gateway.remote_shutdown` opt-in + 平台 token + 反代密钥；远程缺省 10s 预算、**不强杀**，超时如实 exit 1；只认显式 `--connect`（不认 env） |
| `vessel restart [name]` | stop→start | docker 式编排 | name 先匹配 gateway 实例名、再匹配 registry node 名（委托 node restart）；缺省本舰队全量；**stop 未全成 → 不 start**；`--force` 传播；确认一次覆盖 stop+start |

- **restart 缺省保持运行模式**：读目标实例 pid record 的 `daemon` 标记，不带 `--daemon` 按原模式重启；显式 `--daemon` 强制后台；旧记录无标记 / 无运行实例 → 前台。`restart --all` 仍要求显式 `--daemon`。
- 判别依据是归属：pid + `started_at` + `node_id`（node）/ `hub.lock`（hub）三元复核；adopt / 外部启动的进程**永远**不在终止名单里。
- **真停 drain 期间 start 会等待**：`--stop-nodes` / 舰队级 stop/restart 的 drain 窗口内 node/hub 仍活但已被判死；停止方写 `platform-stop-nodes[-<instance>].json` 意图 marker，并发的 `gateway start` / `restart` 候 drain 毕再 adopt/spawn（打一行等待提示），不会接管即将被杀的 node/hub。停止方进程死亡 = marker 失效（残留自动清）。语义见 [gateway-lifecycle](../architecture/gateway-lifecycle.md)。
- 前台 Ctrl+C / 外部 SIGTERM 没有保留标记 ⇒ 连本进程 spawn 的子进程一起停；`gateway stop` / `restart` 先写保留标记 ⇒ 平台层退出时保留子进程。还没就绪（无 `gateway.pid` 归属证据）的子进程停机时会被终止（留着就是孤儿）。
- **graceful-first**：停 node 前先经 Node API `gateway.shutdown` 请它进程内 drain（写 resume 标记 + interrupt('shutdown')），缺省不限时等它自死；显式 `--timeout` 到点 / 受理失败回退强杀 + 补偿清理，打一行 `node.drain.skipped`（pid + 原因，持久化到目标实例日志）。平台层同款：经 `/platform/rpc` `gateway.shutdown`（回包 `{stopping:true}` 只受理）跑与 SIGTERM 相同的退出序列（含池 stop 只 terminate owned engine），回退强杀打 `platform.drain.skipped`。drain 完成但退出链挂死 → quiesce 兜底强杀 + `stop.forced`（reason=quiesce_exit_timeout）。退出链步骤级进度见 `node.shutdown.step` 事件（[LOGS](LOGS.md)）。hub 没有 run 面，不走优雅关闭。

## 5. 节点缺席怎么诊断

1. `vessel gateway nodes list`：registry 里有没有它、`auto_start` 是不是 `false`（`external` 时日志直接给启动命令）。
2. `vessel gateway status --rpc` / `platform.nodes.list`：`status: down` = 该端口没有健康 node。
3. `<dataDir>/logs/gateway.log` 的 `node <name>: failed (…)` 行：稳定错误码（`node_start_failed` / `node_identity_mismatch` / `node_unreachable`）+ 耗时。
4. 该节点 `<dataDir>/gateway.pid`：不存在 = 没起到监听；存在但 pid 不活 = 上次异常退出（`vessel node start --daemon --config …` 重新起）。

## 6. 常见故障

| 症状 | 原因 | 处置 |
|---|---|---|
| `Is port 18642 in use?` / `port in use` | 端口被占（另一实例、或强杀后 socket 未释放） | `vessel gateway status` 看谁在跑；`--instance`/`--port` 换实例 |
| 平台重启后 8642 仍旧 pid LISTEN，杀子进程也不释放 | Windows 句柄继承（监听 socket 被 detached 子进程继承） | 不变量「监听必须晚于 spawn」已修；遗留现场连持有句柄的子进程一起杀（`taskkill /PID <pid> /T /F`） |
| `node_identity_mismatch` | `gateway.pid` / `/health` 的 `node_id` 与 registry 不一致 | registry 条目与 `host.nodeId` 对齐；不要手工搬 `data_dir` |
| `node_unreachable` | `data_dir` 有活进程但 `/health` 不通过 | `vessel node stop` 后再 `gateway start`；gateway 不会替你杀它 |
| `implicit_node_conflict` | 隐式单节点与平台共用 `dataDir` 的 pid/锁，同目录另一实例在跑 | 停掉那个实例，或改用显式 registry |

## 7. 关键文件

- 平台：`<dataDir>/platform.pid`、`platform-<instance>.lock`（实例状态）；`platform-children.json`（**只**记录本平台 spawn 的子进程，失败回滚与 `--stop-nodes` 按它复核归属）；`platform-handoff[-<instance>].json`（保活交接标记，TTL 120s 消费即删）；`platform-stop-nodes[-<instance>].json`（真停 drain 意图标记，停止方活着才有效，drain 毕清除）；`nodes.json`（本地节点唯一真源）。
- node：`<nodeDataDir>/gateway.pid`、`gateway-default.lock`（`gateway stop` 不删）；`node.json`（节点身份）。hub：`<hubDataDir>/hub.lock`（adopt 判据）。
- 日志：`<dataDir>/logs/gateway.log`、`logs/node-<name>.log`（0600）。

## 8. 会话时间线修复：删 `timeline.idx` 再 open

写者 `open()` 只读尾部（索引打底 + 尾窗），历史中段的外部损坏不再每次打开重扫——这是启动路径取舍，不是故障（口径见 [event-log-policy §7](../architecture/event-log-policy.md)）。重启/adopt 后**更早**一段读不回来、`open()` 没报错、`heads` 正常 = 中段损坏；尾部损坏不是此类（尾窗逐条校验，照旧退全量路径）。

处置（只对单个会话目录，不需要停 node，但该会话不要有 active run）：先备份 `timeline.idx`，再 `rm -rf <dataDir>/sessions/<session_id>/timeline.idx`（删的是可重建索引，不是事件）；下一次 `sessions.get` / `sessions.events` / 启动 adopter 读到它即整份重读 + 重建索引 + 重新声明洞。代价是这一次 open 全量（大会话实测秒级），之后回到常态。不要为「让读数变好」批量删索引。