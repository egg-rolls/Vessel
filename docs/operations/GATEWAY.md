---
title: Gateway 运维：单点启动、节点独立运行与停止
kind: current
triggers: [gateway, 运维, operations, 单点启动, node 独立启动, node start, daemon, systemd, launchd, schtasks, 计划任务, stop, keep-nodes, 整体关闭, 端口占用, 句柄继承, readiness, 20s, adopt, 缺席, 诊断, 日志]
paths: [src/gateway/**, src/gateway-command.ts, docs/architecture/gateway-lifecycle.md]
---

# Gateway 运维：单点启动、节点独立运行与停止

> 适用版本：0.55+。职责与边界（谁拥有什么、生命周期表）见
> [architecture/gateway-lifecycle.md](../architecture/gateway-lifecycle.md)；本文只讲怎么做。
> 0.55 起 **node/hub 不再与 gateway 共命运**：`gateway stop` 缺省只停平台层。

## 1. 单点启动 gateway

```bash
vessel gateway start                 # 前台（Ctrl+C 停止；连子进程一起停，见 §4）
vessel gateway start --daemon        # 后台：日志进 <dataDir>/logs/gateway.log
vessel gateway start --instance 8643 # 多实例（缺省实例名 default）
```

启动顺序（0.55 分段启动）：

1. 平台自身就绪：实例锁 → 平台监听（`127.0.0.1:8642`）→ 写 `platform.pid`。
2. phase A：按 `nodes.json` 顺序**并发**判定每个 `auto_start` 节点是 adopt 还是 spawn，
   Hub 同理；这一步只做文件读 + `spawn`，**不等就绪**。
3. phase B（后台）：并行等待每个节点的 `gateway.pid` + `/health`，谁先好谁先报。

所以「平台 ready」**不含**节点就绪时间：慢节点不会拖住 WebUI/RPC。实测（临时 dataDir，
三节点：一个注入 60s 延迟、一个启动即退出、一个正常）：平台 `/health` 440 ms 内可访问，
正常节点 500–600 ms 就绪，60s 节点 61.7s 就绪，坏节点 140 ms 标 `failed`。

### 平台启动摘要与日志行

前台 TTY 打印摘要（`Platform` / `Node` / `Hub` / `ready in N ms`），每个节点行尾带当时状态
`(starting|ready|failed: 原因|adopted|external)`。非 TTY（daemon 日志）逐行输出：

```
node n-ok: ready (after 592 ms, pid 40792)
node n-slow: ready (after 61741 ms, pid 33972)
node n-bad: failed (node_start_failed: node "n-bad" exited during startup, after 145 ms, at 2026-11-16T07:03:40.264Z, pid 44376)
hub http://127.0.0.1:18647  (auto-started)
nodes: 2 ready, 1 failed (gateway keeps serving)
```

- 每行 = 一个节点的**状态 + 原因 + 耗时/时刻**；失败行进 stderr（daemon 下同样落到
  `logs/gateway.log`）。
- 实时状态另有既有通道：`vessel gateway status`、平台 RPC `platform.nodes.list`
  （按 `/health` 探测，返回 `up/down`）。0.55 没有新增 RPC 方法。

## 2. 独立启动一个 node（不经 gateway）

```bash
vessel node start --daemon --config /path/to/node.yaml   # 独立拉起一个 Node API
vessel node status [--json] [--rpc]
vessel node stop
vessel node reload --scope config
```

- node 只需要自己的配置（`serve.hostname` / `serve.port`、`host.nodeId`）和自己的
  `data_dir`；不依赖 gateway 进程。
- 注册进 gateway 的 registry（让 `gateway start` 负责拉起 / adopt）：

```bash
vessel gateway nodes add n-a --data-dir ~/.vessel/data-a --config ~/.vessel/data-a/node.yaml
vessel gateway nodes add n-b --data-dir ~/.vessel/data-b --config ~/.vessel/data-b/node.yaml --no-auto-start
vessel gateway nodes list [--json]
vessel gateway nodes remove n-a
```

- `auto_start: false` 的节点**不由 gateway 拉起**；状态显示 `external`，原因里直接给出
  启动命令（`start it with: vessel node start --daemon --config …`）。
- 同一个 `data_dir` 已有活进程：gateway 只 **adopt**（不重复 spawn、不杀）。

## 3. 常驻：Windows 计划任务 / Linux systemd / macOS launchd

```bash
vessel gateway install-service      # 按当前平台选择
vessel gateway install-service --systemd   # 显式指定（必须与当前平台一致）
vessel gateway uninstall-service
```

| 平台 | 形态 | 关键事实 |
|---|---|---|
| Linux | systemd **user** unit（不需要 root） | `~/.config/systemd/user/vessel-gateway.service`，`ExecStart=/usr/bin/env vessel gateway start`，`Restart=on-failure`，stdout/stderr 追加到 `<dataDir>/logs/gateway.log` |
| macOS | LaunchAgent | `~/Library/LaunchAgents/com.vessel.gateway.plist`，`KeepAlive=true`，`RunAtLoad=true` |
| Windows | 登录时计划任务（避免管理员服务） | 任务名 `VesselGateway`，`schtasks /SC ONLOGON`，命令 `vessel gateway start` |

服务管理器托管的是**平台层**。要连 node 一起常驻，给每个 node 单独配常驻
（`vessel node start --daemon --config …` ＋ 各自的计划任务/unit），不要指望 gateway 的
服务单元替它们收尸：`gateway stop` 按设计不动 node。

## 4. 停止：`stop` vs `stop --no-keep-nodes`

| 命令 | 平台层 | node/hub | 输出 |
|---|---|---|---|
| `vessel gateway stop` | 停 | **不动**（继续跑） | `node n-a: still running (pid 1234) — left alone; stop it with …` / `hub: still running (…)` |
| `vessel gateway stop --no-keep-nodes` | 停 | **停掉本机 spawn/接管、且归属可复核的** | `stopped node n-a (pid 1234)` / `stopped hub hub (pid 5678)`；停不下来的逐条给原因 |
| `vessel gateway restart` | 重启 | 不动 | 重启后 adopt 回来 |
| `vessel gateway stop --all` | 停**所有实例**的平台层 | 不动（`--all` 是实例选择器，不是「连 node 一起停」） | 同上 |

- 判别依据仍是归属：pid + `started_at` + `node_id`（node）/ `hub.lock`（hub）三元复核；
  adopt / 外部启动的进程**永远**不在终止名单里。
- 前台 Ctrl+C / 外部 SIGTERM 没有「保留」标记 ⇒ 连本进程 spawn 的子进程一起停（调试方便）；
  `gateway stop` / `restart` 会先写保留标记 ⇒ 平台层退出时保留子进程。
- 0.55 起：还没就绪（没有 `gateway.pid` 归属证据）的子进程在停机时**会被终止**——它们
  既没接管端口也没人认识，留着就是孤儿。

## 5. 节点缺席怎么诊断

1. `vessel gateway nodes list`：确认 registry 里有它、`auto_start` 是不是 `false`。
2. `vessel gateway status --rpc` / 平台 RPC `platform.nodes.list`：`status: down` = 该端口
   没有健康 node。
3. 看 `<dataDir>/logs/gateway.log` 的 `node <name>: failed (…)` 行：原因里带稳定错误码
   （`node_start_failed` / `node_identity_mismatch` / `node_unreachable`）与耗时。
4. 看该节点的 `<dataDir>/gateway.pid` 是否存在：不存在 = 它根本没起到监听；存在但 pid
   不活 = 上次异常退出（`vessel node start --daemon --config …` 重新起）。
5. `auto_start: false` 且没在跑 = `external`，日志里直接给启动命令。

## 6. 常见故障

| 症状 | 原因 | 处置 |
|---|---|---|
| `Platform gateway failed to start: Is port 18642 in use?` / `port in use` | 端口被占（另一个平台实例、或上一次强杀后 socket 还没释放） | `vessel gateway status` 看谁在跑；`--instance`/`--port` 换实例；确认旧进程已死后重试 |
| 平台重启后 8642 仍显示旧 pid 在 LISTEN，杀子进程也不释放 | **Windows 句柄继承**：早期版本「先监听后 spawn」，监听 socket 被 detached 子进程继承 | 0.52 起「监听必须晚于 spawn」已修；遗留现场需连持有句柄的子进程一起杀（`taskkill /PID <pid> /T /F`） |
| 节点 20s 就被判失败（≤0.54） | readiness 上界 20s 在启动关键路径上，慢机器冷启动超过就被判死 | 0.55 起上界 180s 且**不在关键路径**：平台先 ready，慢节点继续等；超时只标该节点 `failed` |
| `node_identity_mismatch` | 该 `data_dir` 的 `gateway.pid` / `/health` 报告的 `node_id` 与 registry 不一致 | 确认 registry 条目与节点配置 `host.nodeId` 一致；不要手工搬 `data_dir` |
| `node_unreachable` | `data_dir` 里有活进程但 `/health` 不通过 | 进程卡死：`vessel node stop` 后再 `gateway start`；gateway 不会替你杀它 |
| `gateway stop` 后 WebUI 打不开但 node 端口还在 | 这是**设计行为**：停了平台层，node 继续跑 | 要整体关闭用 `vessel gateway stop --no-keep-nodes` |
| `implicit_node_conflict` | 隐式单节点与平台共用 `dataDir` 的 `gateway.pid`/锁，同目录另一个实例在跑 | 停掉那个实例，或改用显式 registry（`gateway nodes add`） |

## 7. 与 standalone 相关的文件

| 路径 | 归属 | 说明 |
|---|---|---|
| `<dataDir>/platform.pid`、`platform-<instance>.lock` | 平台 | 平台实例状态；停止时按 pid+started_at 条件清理 |
| `<dataDir>/platform-children.json` | 平台 | **只**记录本平台 spawn 的子进程（pid/started_at/data_dir/kind）；`--no-keep-nodes` 与失败回滚按它复核归属 |
| `<nodeDataDir>/gateway.pid`、`gateway-default.lock` | node | node 自己的实例状态；`gateway stop` 不删 |
| `<nodeDataDir>/node.json` | node | 节点身份（`node_id`） |
| `<hubDataDir>/hub.lock` | hub | Hub 实例状态；adopt 判据 |
| `<dataDir>/nodes.json` | registry | 本地节点唯一真源（`gateway nodes *` 读写） |
| `<dataDir>/logs/gateway.log`、`logs/node-<name>.log` | 平台 / 子进程 | 平台与子进程输出（0600） |
