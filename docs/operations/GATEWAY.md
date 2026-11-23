---
title: Gateway 运维：单点启动、节点独立运行与停止
kind: current
triggers: [gateway, 运维, operations, 单点启动, node 独立启动, node start, daemon, systemd, launchd, schtasks, 计划任务, stop, keep-nodes, 整体关闭, 端口占用, 句柄继承, readiness, 20s, adopt, 缺席, 诊断, 日志, 时间线修复, timeline.idx, 索引重建, 中段损坏]
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
（`vessel node start --daemon --config …` ＋ 各自的计划任务/unit）。注意：`gateway stop`
缺省只停平台层，不会动本机 spawn 的 node/hub（见 §4）；要一起停用 `--stop-nodes`。

## 4. 停止：`stop` vs `stop --stop-nodes`

**缺省只停平台层，不动 node/hub** —— 它们身上可能跑着会话，杀掉不可恢复。破坏性动作必须显式。

| 命令 | 平台层 | node/hub | 输出 |
|---|---|---|---|
| `vessel gateway stop` | 停 | **不动**（继续跑，下次 start adopt 回来） | `node n-a: still running (pid 1234) — left alone; stop it with vessel gateway stop --stop-nodes` / `gateway stopped; 2 node/hub process(es) left running` + 一行可复制提示 |
| `vessel gateway stop --stop-nodes` | 停 | **一起停掉本机 spawn/接管、且归属可复核的** | `stopped node n-a (pid 1234)` / `stopped hub hub (pid 5678)`；停不下来的逐条给原因 |
| `vessel gateway restart` | 重启 | 不动（新平台 adopt 回来，**仍跑旧代码** —— 命令会打印提示） | 结尾提示：`to restart them too: vessel gateway restart --stop-nodes` |
| `vessel gateway restart --stop-nodes` | 重启 | 一起冷重启 | 重新 spawn |
| `vessel gateway stop --all` | 停**所有实例**的平台层 | 按缺省（不动） | `--all` 仍是实例选择器，不是「连 node 一起停」的同义词 |
| `vessel stop` | 停 | **一起停**（manifest 内归属可复核的 node/hub；owned 池 engine 由平台进程内 terminate） | 全根清点 + 警示 + y/N 确认；`--yes` 跳过；非交互无 `--yes` 拒绝 exit 1；取消 exit 0 |
| `vessel stop --connect <url>` | 远程平台停 | 远程舰队（registry 级清点，读不到 manifest/池文件） | 需 `gateway.remote_shutdown` opt-in + 平台 token + 已配置反代密钥；**远程不强杀**，超时如实 exit 1 |

- `--no-keep-nodes`（0.55 写法）与 `--keep-nodes`（0.52 写法）都保留为别名，分别等价于 `--stop-nodes` 与缺省。
- **`vessel stop` = 舰队级**（scope 跟名词走）：缺省停 resolved data root 内**所有实例**的舰队；
  `--instance`/`--port` 收窄单实例（`--all` 复用选择器，等价缺省）；`--timeout` 缺省 10s。
  远程只认显式 `--connect` flag（不认 `VESSEL_CONNECT` env）；未开 opt-in → 401 提示 SSH 到主机跑
  `vessel stop`。standalone hub / external node 只报告不动；池残留逐条提示（停止方不 terminate engine）。

- 判别依据仍是归属：pid + `started_at` + `node_id`（node）/ `hub.lock`（hub）三元复核；
  adopt / 外部启动的进程**永远**不在终止名单里。
- 前台 Ctrl+C / 外部 SIGTERM 没有「保留」标记 ⇒ 连本进程 spawn 的子进程一起停（调试方便）；
  `gateway stop` / `restart` 会先写保留标记 ⇒ 平台层退出时保留子进程。
- 0.55 起：还没就绪（没有 `gateway.pid` 归属证据）的子进程在停机时**会被终止**——它们
  既没接管端口也没人认识，留着就是孤儿。
- **P0-run-stops P1：停 node 先优雅、后强杀**。终止 node 前先经 Node API `gateway.shutdown`
  请它进程内 drain（写在跑 run 的 resume 标记 + interrupt('shutdown')），等它自死 ≤10s；
  超时/失败回退强杀 + 补偿清理，并打一行 `node.drain.skipped`（pid + 原因）。
  Windows 上外部 `process.kill` 是无条件终止——没有这一步，重启后在跑 run 的恢复标记
  一条都写不出来（事故复盘见个人侧 `docs/dev/issues/P0-run-stops.md`）。hub 没有 run 面，
  不走优雅关闭。
- **Q4-C：平台层同样 graceful-first**。终止平台 entry 前先经平台自己的 `/platform/rpc`
  `gateway.shutdown`（params `{}`，回包 `{stopping:true}` 只受理）请进程跑**与 SIGTERM 完全相同**
  的退出序列（含 `poolSupervisor.stop()` 只 terminate owned engine），等自死 ≤ `--timeout`
  （缺省 10s）；超时/拒绝/老版本 `not_found` 回退强杀 + 一行 `platform.drain.skipped`（pid + 原因）。
  这关闭了 **Windows owned engine 孤儿缺口**（外部强杀跑不到进程内池 stop）。平台没有 run 面：
  不写 resume 标记；keep/保活语义仍由 handoff marker 单一权威（`gateway stop` 缺省保活不变，
  只是平台层退出也走优雅路径，最多多等一个 timeout 预算）。

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
| `gateway stop` 后 WebUI 打不开但 node 端口还在 | 这是**设计行为**：缺省只停平台层，node 继续跑 | 要整体关闭加 `--stop-nodes` |
| `implicit_node_conflict` | 隐式单节点与平台共用 `dataDir` 的 `gateway.pid`/锁，同目录另一个实例在跑 | 停掉那个实例，或改用显式 registry（`gateway nodes add`） |

## 7. 与 standalone 相关的文件

| 路径 | 归属 | 说明 |
|---|---|---|
| `<dataDir>/platform.pid`、`platform-<instance>.lock` | 平台 | 平台实例状态；停止时按 pid+started_at 条件清理 |
| `<dataDir>/platform-children.json` | 平台 | **只**记录本平台 spawn 的子进程（pid/started_at/data_dir/kind）；失败回滚与 `--stop-nodes` 按它复核归属 |
| `<nodeDataDir>/gateway.pid`、`gateway-default.lock` | node | node 自己的实例状态；`gateway stop` 不删 |
| `<nodeDataDir>/node.json` | node | 节点身份（`node_id`） |
| `<hubDataDir>/hub.lock` | hub | Hub 实例状态；adopt 判据 |
| `<dataDir>/nodes.json` | registry | 本地节点唯一真源（`gateway nodes *` 读写） |
| `<dataDir>/logs/gateway.log`、`logs/node-<name>.log` | 平台 / 子进程 | 平台与子进程输出（0600） |

## 8. 会话时间线修复：删 `timeline.idx` 再 open

0.55 起写者 `open()` 只读尾部（索引打底 + 尾窗），**历史中段的外部损坏不再每次打开重扫** ——
这是启动路径的取舍，不是故障（口径与判据见 [architecture/event-log-policy.md §7](../architecture/event-log-policy.md)）。

判据与处置：

| 症状 | 是 / 不是 |
|---|---|
| 某次重启 / adopt 后，会话**更早**的一段读不回来，`open()` 没报错、`heads` 正常 | **是**：中段损坏，尾窗是好的 |
| 尾部（最后一个块 / `wal.log` 尾行）损坏、撕裂、帧缺 | **不是**：尾窗逐条校验，照旧退全量路径并登记洞 / 污点 |
| `sessions.events` / UI 报某段 `timeline_gap_reported`（rule 3，区间固定一小段） | 先按上面的口径分清是尾窗还是中段；尾窗问题不需要人工介入 |

处置（**只对单个会话目录**，不需要停 node，但该会话不要有 active run）：

```bash
# 1) 确认是哪个会话、先备份（索引可重建，数据文件不要删）
ls <dataDir>/sessions/<session_id>/
cp -a <dataDir>/sessions/<session_id>/timeline.idx <dataDir>/sessions/<session_id>/timeline.idx.bak

# 2) 删掉索引目录（删的是**可重建的索引**，不是事件）
rm -rf <dataDir>/sessions/<session_id>/timeline.idx

# 3) 再 open：下一次 `sessions.get` / `sessions.events` / 启动 adopter 读到它即整份重读 + 重建索引 + 重新声明洞
```

- 代价：这一次 open 是**全量**（19/20 万 seq 的会话实测秒级，读数见 [event-log-policy §7](../architecture/event-log-policy.md)），之后回到 88 ms 量级。
- 判据没变：修复只是让 `open()` 走全量路径，洞 / 污点 / `wal_head` 的判定与 0.55 之前逐字段一致。
- 不要为了「让读数变好」批量删索引：删完第一次 open 就是整份读，这正是第十一条要挡的形态。
