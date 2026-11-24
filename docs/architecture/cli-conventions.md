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

### 3.1 归属表（谁拥有谁）〔现行，冻结语义见 gateway-lifecycle.md〕

| 组件 | 拥有（可停） | 不拥有（只 adopt / 只报告） |
|---|---|---|
| gateway（平台层） | `platform.pid` / 实例锁、平台监听与 RPC、spawn manifest（`platform-children[-<instance>].json`）、owned engine 池 | registry 里的 adopt/external node；standalone hub；adopt/external engine |
| node | 自己的 `gateway.pid` / 锁、API 监听、**tools-engine 监管子进程**、插件子进程 | 其它 node；平台层 |
| hub | `<hubDataDir>/hub.lock` | — |
| tools-engine | 无（它是被监管者） | 生命周期完全归 node 监管器（§3.3） |

- **归属判据只收紧不放松**：终止前必须三元复核（pid + started_at + node_id / hub lock）；
  拿不出归属证据的进程一律不动。adopt / external 永不杀。
- **生命周期强杀恒本机**：远程 stop（`--connect`）只发 `gateway.shutdown` + 轮询至不可达，
  绝不远程强杀；超时如实 exit 1，措辞不声称「进程已死」。
- 平台进程退出（stop/restart/崩溃）后 node/hub 继续跑，下一次 start 按判据 adopt 回来——
  平台**不拥有**它们的生命周期，只拥有「本平台 spawn」这一归属证据。

### 3.2 停止依赖序（规范序 = 反依赖序：被依赖者后停）

舰队 stop 是**薄编排**：只读清点 → 确认（§2.2）→ 共享接缝 `stopGateway` → 残留报告 → 汇总。
终止顺序、marker、优雅步骤全部在共享接缝内，**不允许第二套停止路径**。平台侧退出序列
单实现（SIGTERM/SIGINT 分支与 `gateway.shutdown` RPC 注入共用同一闭包）：

```
vessel stop（舰队）
 └─ 逐实例 stopGateway（共享接缝）
     0. 写/清 handoff marker —— 先于任何终止信号（keep 语义单一权威）
     1. 看门狗先停（不论 keep）—— 关停期间绝不许探活/重启
     2. node 子进程：优雅 drain（进程内写 resume 标记 + interrupt('shutdown')）
        │   → 预算内确认自死才算停成；否则强杀回退 + 打 node.drain.skipped
        │   └─ node 自身退出序列内：tools-engine supervisor.stop()（expected exit，
        │      不触发重生）→ 插件子进程 → run/session 状态落盘
     3. hub 子进程（无 run 面，不试优雅；与 node 是兄弟，可并行）
     4. owned engine 池 terminate（node 先停再停 engine；adopt/external 永不杀）
     5. 平台自身：停监听、清 pid/锁；manifest 空则删，未停成的条目留着供重试
```

- **handoff 变体**（`gateway stop/restart` 缺省）：第 0 步写 marker，平台退出序列消费它后
  只交出平台层——已就绪的 node/hub/owned engine 一个不动，等新平台 adopt。
  未就绪（started_at 空）的子进程没有归属证据，照样终止（防孤儿撞端口）。
- **drain 与 resume 标记**：优雅停止必须保住可恢复性——node drain 写 resume 标记，
  中断的 run 可经 `--resume-run` / `runs resume` 恢复。stop **永不**删会话/run 状态。
  强杀回退 = 这次没 drain 成，必须如实打一行（`node.drain.skipped` / `platform.drain.skipped`），
  不假成功、不静默。
- **残留报告**：停止方不 terminate 池外 engine，只逐条如实报告（id + pid / 不可读），
  让「谁还在跑」可见。

### 3.3 tools-engine 归属条款〔提案，基于现行监管器事实〕

**事实**：tools-engine 是 node 装配层经 `createEngineSupervisor` 监管的子进程
（合成 descriptor，不进 PluginLoader/catalog）。意外退出 → 监管器自动拉起
（滑动窗口预算 ≤3 次 / 10 分钟，同插件 manager 口径）；预算尽 → `disabled` + fail-closed
（**不静默回退 in-process**）。

**推论（动词条为什么只有 status/restart）**：

- 独立 `stop` 是**撒谎的动词**：外部杀掉子进程会被监管器当意外退出拉起，用户以为停了其实没停。
  真停只能走 node 的退出序列（`supervisor.stop()` 置 expected → 不重生），所以「停 tools-engine」
  这个意图的正确表达是 `vessel node stop`（或舰队 stop）。
- 独立 `start` 冗余：engine 随 node 起，没有独立启动的合法路径。
- `tools-engine status`：只读监管器视图——状态（`active` / `restarting` / `disabled` /
  随 node 停止）、重启计数、预算窗口、最后错误。经 node RPC 暴露（如
  `node.toolsEngine.status`），CLI 只做包装。node 没在跑 → 如实报告「归属 node，node 未运行」，
  exit 0（status 契约：报告产出即成功）。
- `tools-engine restart`：**drain + 受控重生**——先 drain 在途工具调用，再经监管器的
  expected-exit 路径 terminate + start。绝不外部 kill（那会消耗崩溃预算并与监管器竞态）。
  受控重启不计入崩溃预算，但受同一滑动窗口限频（防 flapping）。前置：node 在跑；
  node 没在跑 → exit 1 + 下一步提示 `vessel node start`。
- 舰队/node 停止时，tools-engine 在 node 退出序列内被 drain（§3.2 第 2 步），无需独立动词。

### 3.4 幂等与退出码稳定性

| 场景 | 结果 | 退出码 |
|---|---|---|
| 全部停成 | 成功汇总 | 0 |
| 本无运行（重复 stop） | 「nothing running」是成功 | 0 |
| 用户 N / EOF 取消 | 零进程被杀 | 0 |
| 非交互无 `--yes` | 拒绝，零进程被杀 | 1 |
| 任一组件未停成 / 超时 | 逐组件报告谁没停、为什么；manifest 条目保留供重试 | 1 |
| degraded 记录 | 先命令行复核确认是 gateway 才杀；不可读/非 gateway → 拒绝且不删记录 | 该条计失败 |
| 远程 stop 超时仍可达 | 如实报告，不强杀 | 1 |

规则：**同一事实状态永远给同一退出码**（已停 = 0，与「这次停成的」不可区分也不需区分）；
部分失败不吞——逐组件行 + 汇总 exit 1；清理失败（pid/锁/manifest）计入失败，不假装停成。

## 4. 输出契约（单一渲染实现）

### 4.1 单一实现规则

所有命令的输出走**同一个渲染模块**：现行事实源是 `src/ui-style.ts`（样式/对齐/颜色闸门）
+ `src/i18n/`（文案）；目标态收拢为 `src/cli/output.ts`（§8，吸收 ui-style，命令只交
**结构化视图模型**，渲染器决定布局/颜色/JSON）。禁止：

- 命令内手写 ANSI 转义或自造颜色判断（第二个颜色闸门 = 漂移源）；
- 命令内自造表格对齐（必须走渲染器的 `displayWidth` 对齐，CJK/全角按 2 列）；
- 同一语义两套文案（help 与用法错误已单一数据源 `cli-help-spec.ts`，输出同理）。

### 4.2 通道纪律

| 通道 | 内容 | 规则 |
|---|---|---|
| stdout | **结果**：人类报告 或 恰好一份 JSON 文档 | `--json` 时 stdout 只有 JSON：无 ANSI、无人类行、无进度噪声 |
| stderr | 警告 / 诊断 / 错误 | 配置校验警告、`*.drain.skipped`、残留提示等走 stderr；不污染机读 stdout |

- `--json` 下必须保留的警告进 JSON 的 `warnings` 数组（或 stderr），**不静默丢**。
- 退出码与通道无关：JSON 失败也走 §6 错误包 + 非零码。

### 4.3 人类输出布局

- 标题（品牌色 + 粗体）+ 分隔线（缺省 48 列）；`label  value` 对齐列（kv，label 宽统一）。
- 组件表列序固定：**组件名（稳定标识 + 实例）→ 状态 → pid → url/备注**。
  组件名用稳定标识符（`gateway` / `node` / `hub` / `tools-engine` + 实例名），不用翻译名。
- **生命周期动词必须显示状态迁移**（`running → stopped`、`starting → ready`）；
  status 显示现态 + 原因（degraded/stale/failed 必带 reason 与时刻）。
- 状态符号：`✓` ok / `!` warn / `✗` err / `·` info——符号承载语义，颜色只是增强（§7）。
- 数据值（路径、id、枚举、表格数据行）保持纯文本：不上色、不翻译。

### 4.4 状态词汇表（与状态机同一套枚举，不造第二套）

| 域 | 枚举 |
|---|---|
| 平台实例 | `running` / `degraded` / `starting` / `stale` / `unknown` / `foreign-host` / 未运行 |
| node（平台视图） | `starting` / `ready` / `failed` / `adopted` / `external` |
| tools-engine〔提案〕 | `active` / `restarting` / `disabled` / 随 node 停止 |

人类文案可翻译，**枚举字面量保持英文**（机读面与人类面指同一事实）。

### 4.5 国际化

人类散文走 `t()`（zh-CN / en 两份 catalog）；命令名、flag、路径、数据值、状态枚举是
命令行字面量/数据，不翻译。新增输出 = 新增 MessageKey，不在命令里硬编码文案。

### 4.6 JSON 契约面

- **既有 `--json` 形状是冻结契约**（如 `gateway status --json` 不加 adopted 字段的先例）：
  只 additive 加字段，不改名、不删字段、不改语义。
- 新命令统一信封：成功 `{ "ok": true, "command": "<ns verb>", "data": { … }, "warnings": [...]? }`；
  失败走 §6 错误包。序列化统一 `JSON.stringify(payload, null, 2)`，一份文档，无 ANSI。
- 机读面缺省不输出密钥值：打印值仅回环 + 交互式终端，非交互需显式 opt-in
  （`token show` 的 `allowNonInteractive` 先例）；`--json` 不是绕过该闸门的后门。

## 5. 退出码表

| 码 | 语义 | 例 |
|---|---|---|
| 0 | 成功 / 幂等空操作 / 用户主动取消 | 停成；本无运行再 stop；确认 N/EOF |
| 1 | 运行时失败 | 组件没停成、超时、非交互无 `--yes` 拒绝、显式目标不可达、配置校验错误 |
| 2 | 用法错误 | 未知命令/flag、缺参、互斥冲突、未知子命令（feishu 配置类错误同归 2 的先例） |
| 3 | headless ask 挂起（保留码，现行 `HEADLESS_ASK_SUSPENDED_EXIT_CODE`） | `--run` 遇 ask 无法交互 |
| 130 / 143 | SIGINT / SIGTERM（128+信号号） | 前台进程被中断 |

规则：

1. **退出码是契约**：同一事实状态永远同一码；新码必须先登记进本表，禁止命令私造。
2. 幂等成功 = 0，不是「错误：已在运行」（start 已跑 / stop 已停都属此类）。
3. 一次性命令经 `commands/registry.ts` 返回码，cli.ts 统一落 `process.exitCode`；
   headless 只记录退出码，走完清理再落码，不提前 `process.exit`。〔现行〕
4. 部分失败 = 1 + 逐组件报告；不吞失败，也不把「用户取消」当失败。

## 6. 错误格式与稳定码

### 6.1 人类格式

```
✗ <stable_code>: <message>
  next: <一条可执行的下一步>
```

- 用法错误末尾统一附 `Try 'vessel <cmd...> --help'`（文案与 help 单一数据源 cli-help-spec）。
- `next` 对运行时错误**必填**：给一条能直接跑的命令或能直接查的文件
  （如 `vessel node start`、`检查 <dataDir>/platform.pid`），不给「请联系管理员」式空话。
- 警告不是错误：不打稳定码、不影响退出码、走 stderr（§4.2）。

### 6.2 JSON 错误包

```json
{
  "ok": false,
  "error": {
    "code": "stop_timeout",
    "message": "…",
    "next": "vessel stop --timeout 30000",
    "details": { }
  }
}
```

`details` 可选、additive；`code` / `message` 必有；错误包与成功信封互斥（`ok` 判别）。

### 6.3 稳定码注册规则

- 命名 `snake_case`，域前缀：`usage_*` / `stop_*` / `gateway_*` / `node_*` / `engine_*` /
  `config_*` / `token_*` …；与 RPC 稳定码（`unauthorized` / `not_found` /
  `ENGINE_ERROR.unavailable` 等既有先例）同口径，能复用不新造。
- **码是契约**：永不改名、永不复用给别的语义；废弃走「保留旧码 + 文档标 deprecated」，
  不静默换码。message 可翻译可润色，code 恒英文恒定。
- 每个新码登记：码 → 语义 → 退出码 → next 模板。登记表随 §8 落地放
  `src/cli/errors.ts`（单一事实源），本文是规范。

## 7. 颜色与无障碍

1. **语义不依赖颜色**：符号（✓/!/✗/·）+ 文字承载状态，去色后信息无损。
2. **颜色闸门单一谓词**（现行 `shouldUseColor`）：stdout 是 TTY **且** `NO_COLOR` 未设置
   （no-color.org：任意值含空串都算设置）**且** `TERM !== 'dumb'`。非 TTY 管道自动纯文本；
   `--json` 恒无 ANSI。
3. **警告不用黄色**：中性粗体（现行 DECISION-023 §2.5 决策，避免与品牌色/低对比终端冲突）。
4. **降级路径**：truecolor 品牌色（海洋绿 `#1EFFC7`）假设深色终端；16 色终端由基础 ANSI
   （绿/红/青/粗体）承担语义，品牌色降级不丢状态。
5. **对齐按显示宽度**：CJK/全角按 2 列（`displayWidth`），混排表格不锯齿。
6. 数据行/路径/JSON 永不上色；无闪烁类动画。

## 8. 落地布局：src/cli/ 领域目录（与计划 C 重组合一）

（待扩充）

## 9. 兼容与演进规则

（待扩充）