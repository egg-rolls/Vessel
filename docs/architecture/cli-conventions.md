---
title: CLI 命令与输出规范
kind: target
triggers: [cli, command, verb, start, stop, restart, status, reload, fleet, 舰队, 动词, 退出码, exit code, 输出, json, NO_COLOR, 颜色, 无障碍, tools-engine, 生命周期, 依赖序, drain, resume, 错误码, 渲染, src/cli]
paths: [src/cli.ts, src/cli-args.ts, src/cli-help-spec.ts, src/cli-help.ts, src/commands/**, src/*-command.ts, src/ui-style.ts, src/tools-engine/supervisor.ts, src/gateway/node-supervisor.ts, src/gateway/pool-supervisor.ts]
---

# CLI 命令与输出规范

> **状态标记**：〔现行〕= 代码已实现、本文只做规范化表述；〔提案〕= 目标态设计，落地前以本文为准绳。
> 事实源：命令分派见 [cli-wiring.md](cli-wiring.md)，进程归属见 [gateway-lifecycle.md](gateway-lifecycle.md)。
> 本文是**规范**（conventions）：动词怎么定义、生命周期归谁、输出长什么样、退出码与错误码怎么稳定。
> 纯设计文档，不改代码；落地重组（src/cli/ 领域目录，与计划 C 合一）见 §8。

## 0. 一段话

Vessel CLI 分两层：**顶层裸动词**（`vessel start/stop/status`）做全舰队编排，**组件命名空间**
（`vessel gateway|node|hub|tools-engine <verb>`）做组件级操作，动词集在「适用处」对称
（start/stop/restart/status）。适用与否由**生命周期归属**决定，不由实现便利决定：
tools-engine 是 node 监管的子进程，独立 stop 会被监管器拉起，所以它的动词条只有
status/restart（drain + 受控重生），没有独立 start/stop。停止按依赖序优雅 drain（写 resume
标记），已停再停 = 成功（幂等），退出码稳定。所有人类输出与 `--json` 机读输出走**同一个渲染
模块**（目标落 `src/cli/`，与计划 C 重组合一）：对齐列、稳定组件名、状态迁移、非 TTY/NO_COLOR
自动去 ANSI、错误带稳定码和下一步。

## 1. 两层命令模型与命令分类表

### 1.1 分层规则

1. **顶层裸动词只保留给舰队编排**。舰队 = resolved data root 内所有 gateway 实例 + 各自
   spawn 的 node/hub + owned engine 池。新增组件操作一律进命名空间，不再新增顶层裸动词。
2. **组件命名空间动词集对称**（§2 矩阵）：同一动词在任何组件下语义一致（start 幂等、
   stop 优雅且幂等、status 只读）。「不适用」必须写明归属理由（§3），并在 help 里可见。
3. **数据面动词不碰进程生命周期**：`gateway nodes add/remove` 只写 `nodes.json`；
   `node token` / `hub join` 等只操作凭据与配对。反过来，生命周期动词不静默改注册表数据。
4. **破坏性范围扩大必须显式**：`gateway stop` 缺省只停平台层；连 node/hub 一起停要显式
   `--stop-nodes`。缺省值永远选「不杀可能跑着会话的进程」那一侧。〔现行〕
5. **命名**：命名空间用单数名词（`node`/`hub`/`gateway`/`tools-engine`），动词用原形；
   复合词 kebab-case（`install-service`/`join-code`/`node-list`）。命令名与 flag 是字面量，
   不翻译（§4.5）。

### 1.2 命令分类表

| 类别 | 命令 | 层 | 性质 | 状态 |
|---|---|---|---|---|
| A 舰队编排 | `vessel start` | 顶层 | 全舰队起（逐实例编排 gateway start + auto_start node/hub adopt） | 〔提案〕 |
| A 舰队编排 | `vessel stop [--yes] [--timeout] [--instance\|--port\|--all] [--connect …]` | 顶层 | 全舰队优雅停（清点 → 确认 → 共享接缝 → 残留报告） | 〔现行〕 |
| A 舰队编排 | `vessel status [--json]` | 顶层 | 舰队一屏只读报告（配置 + 实例 + attach） | 〔现行〕 |
| B 组件生命周期 | `vessel gateway start\|stop\|restart\|status\|reload\|list` | 命名空间 | 平台层；stop/restart 缺省 handoff 保 node/hub | 〔现行〕 |
| B 组件生命周期 | `vessel node start\|stop\|status\|reload` | 命名空间 | Node API 监听与实例锁；`restart` 见 §2 矩阵 | 〔现行〕（restart〔提案〕） |
| B 组件生命周期 | `vessel hub start` | 命名空间 | 本地 Hub；`stop`/`status` 见 §2 矩阵 | 〔现行〕（stop/status〔提案〕） |
| B 组件生命周期 | `vessel tools-engine status\|restart` | 命名空间 | node 监管子进程；**无独立 start/stop**（§3.3） | 〔提案〕 |
| B' 组件服务安装 | `vessel gateway install-service\|uninstall-service` | 命名空间 | systemd/launchd/schtasks 安装面，不是进程动词 | 〔现行〕 |
| C 组件数据面 | `vessel gateway nodes list\|add\|remove` | 命名空间 | registry 只写数据，不起停进程 | 〔现行〕 |
| C 组件数据面 | `vessel node token`、`vessel hub directory\|watch\|join-code\|join\|node-list\|node-remove` | 命名空间 | 凭据 / 联邦配对数据面 | 〔现行〕 |
| D 资源/数据命令 | `agent` `agents` `team` `model` `config` `token` `plugin` `attention` `federation` `logs` `errors` `doctor` `eval` `migrate` `trace` `prune` `dev` `completion` `update` | 平铺 | 操作资源/配置/观测数据，不操作进程生命周期 | 〔现行〕 |
| E 入口模式 | REPL（缺省）/ `--run` / `--pipe` / `--serve` / `--resume-run` / `--tools` / `--version` / `--help` / `demo` / `--feishu` | 入口 | 不是命令分派面，走 cli.ts 主路径 | 〔现行〕 |

> D 类是历史平铺命令，**不**强行塞进两层模型；它们的输出/退出码/错误契约（§4–§7）同样适用。
> 重组（§8）只改文件位置与分派接缝，不改命令字面量。

## 2. 动词契约

### 2.1 动词定义（跨组件一致）

| 动词 | 契约 | 幂等性 |
|---|---|---|
| `start` | 起组件。已在跑 → **adopt/报告**，绝不重复 spawn，exit 0。缺省前台；`--daemon` 后台（gateway/node）。端口被占 = 失败 exit 1 + 稳定码，不静默换端口（显式 `--port 0` 才由系统分配）。 | 是：重复 start = 成功 |
| `stop` | 优雅优先：先请目标进程内 drain（node 写 resume 标记），确认自死才算停成；超时/失败回退强杀并**如实打一行** `*.drain.skipped`。已停 → exit 0（「本无运行」是成功不是错误）。 | 是：重复 stop = 成功 |
| `restart` | 一次**受控** stop+start，不是两个命令的 shell 拼接。保持运行模式（读 pid record 的 daemon 标记；旧记录无标记回落前台）。gateway 缺省 handoff（只换平台层，node/hub 留活被 adopt）。 | 是：失败回滚路径不重复杀已停进程 |
| `status` | **只读**：不 bootstrap、不获取写锁、不输出任何密钥。exit 0 = 报告已产出（「没在跑」也是合法报告）；exit 1 仅当显式目标不可达 / 在跑但健康探测失败。 | 天然幂等 |
| `reload` | 热加载配置并刷新，不重启进程、不动生命周期；`--scopes` 收窄。 | 是 |
| `list` | 只读清点（实例/注册表），`--json` 机读。 | 天然幂等 |

### 2.2 确认契约（所有破坏性动词共享）〔现行，stop 先例〕

- `--yes` 跳过确认；
- 非交互（非 TTY）且无 `--yes` → **拒绝**，exit 1，零进程被杀；
- 交互 y/N：N / EOF → **用户取消**，exit 0，零进程被杀；
- 确认前必须先打印**只读清点**（谁在跑、pid、归属、谁不动），让用户对着事实决定。

### 2.3 动词对称矩阵（适用处对称，不适用写理由）

| 组件 | start | stop | restart | status | reload | 备注 |
|---|---|---|---|---|---|---|
| gateway（平台层） | ✓ | ✓ | ✓（缺省 handoff） | ✓ | ✓ | 另有 list / install-service / uninstall-service |
| node | ✓ | ✓ | ✓〔提案〕= drain stop + start（resume 标记保住可恢复性） | ✓ | ✓ | 另有 token（数据面） |
| hub | ✓ | ✓〔提案〕 | ✓〔提案〕= stop + start（无 run 面，无 drain/handoff 语义） | ✓〔提案〕 | ✗ 无热加载面 | directory/watch/join 等属数据面 |
| tools-engine | ✗ **不适用** | ✗ **不适用** | ✓〔提案〕drain + 受控重生 | ✓〔提案〕 | ✗ registry 由 node 自动 push | 归属 node 监管器，见 §3.3 |

**「不适用」规则**：只有当生命周期归属使该动词**无意义或不诚实**时才省略
（tools-engine 独立 stop 会被监管器拉起 = 撒谎的动词），绝不因「还没实现」而省略；
省略必须在本矩阵与 `vessel <ns> --help` 同时写明理由。hub 的 stop/status 属「还没实现」，
所以标〔提案〕补齐，而不是标不适用。

## 3. 生命周期归属与停止依赖序

（待扩充）

## 4. 输出契约（单一渲染实现）

（待扩充）

## 5. 退出码表

（待扩充）

## 6. 错误格式与稳定码

（待扩充）

## 7. 颜色与无障碍

（待扩充）

## 8. 落地布局：src/cli/ 领域目录（与计划 C 重组合一）

（待扩充）

## 9. 兼容与演进规则

（待扩充）