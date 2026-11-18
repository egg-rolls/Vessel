# Changelog

> 本文件是 O(1) 当前态：**只保留当前版本的变更摘要**。
> 所有历史版本在 [`docs/versions/`](docs/versions/INDEX.md) 中按版本一文件保存，
> 索引见 [`docs/versions/INDEX.md`](docs/versions/INDEX.md)，当前版本见
> [`docs/versions/CURRENT.md`](docs/versions/CURRENT.md)。
>
> 变更记录遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。
> 管理规则见 [`docs/DOC-MANAGEMENT.md`](docs/DOC-MANAGEMENT.md)。

## [0.55.0] - 未发布

> 本节只写**已在 main 上落地**的条目；真机读数与未核实项逐条标注，不按「计划」写。

### 性能 / 语义变更

- **usage 插件迁到时间线**（`merge b006338d`）：数据源从 `sessions/<id>/events.ndjson`（0.54 起停写）改为
  `wal.log` 的**事实行**（只对进合计的行做逐行 CRC32）。不读 `wal.blocks`（只有 chunk 帧、无用量字段）、
  不读 `timeline.ndjson`（是 `wal.log` 前缀副本，两份会重复计数）。有界：单会话 ≤64 MiB（超了读尾部记
  `partial_files`）、单次 ≤512 MiB / 4096 会话、保留 ≤192 MiB 按会话 LRU；峰值内存 = 索引行 + 至多一个会话的投影事件。
  增量索引升 v2（按会话存 size+mtime，未变零字节）。实测 330 会话 / 425 MiB / 282k 行整目录 **5.7 s**。
  真数据对账（同一拷贝、同一聚合、只换源）：2026-11-15 当天**逐项完全一致**（501 请求 / prompt 102,615,306 /
  completion 293,052 / cache_read 101,152,640）；全期差异 2.0x **逐项可解释**——旧源停在 0.54 切版时刻。
- **写者 `open()` 只读尾部**（`perf(core/timeline)`，commit `daa0b00a`）：`timeline.initialize()` 拆成两条路径 ——
  增量（缺省）：`timeline.idx` 打底 + `wal.log` / 归档 / `timeline.manifest` 尾窗（`readNdjsonTail`，首窗 256 KiB、
  上限 4 MiB）+ 只解**最后一个块** + `holes.ndjson` 全读；全量：老路径一条判定不改，任何自洽检查不成立就退回。
  19/20 万 seq 的会话（`d813eaea` 只读拷贝，before/after 各 3 次交错跑）：**中位 4484.0 ms → 87.6 ms（51×，约 −98%）**，
  冷缓存首次 8531.2 ms → 87.6 ms；`heads` 逐字段一致（`wal_head` / `timeline_head` / `published_head` / `holes` / `tainted`）。
  为什么必须改：那是**启动路径**（进程启动 / 会话打开 / idle 压缩 / adopt 每一次都付一遍），第十一条禁止启动路径出现
  O(会话大小)。为什么能在尾部结束：判据没放松 —— 索引算术（`first_seq = 1` 且 `count = last_seq`）+ 尾窗实测
  `tailMax >= last_seq` 且 `(last_seq, tailMax]` 逐号齐全 ⇒ 记录集恰好是 `[1..tailMax]`；`knownMax` 仍含
  `manifest.archivedTo`，所以「manifest 说已归档、盘上却读不回来」照样声明成洞、照样顶 `wal_head`。
- **语义变更（运维要知道的一条）**：**历史中段**（早已封好的老块、更早的 `wal.log` 行）的**外部**损坏不再每次打开重扫 ——
  这是启动路径的取舍，不是故障。**显式修复路径 = 删 `<sessionDir>/timeline.idx/` 整个目录再 open**（整份重读 + 重建索引 +
  重新声明洞；索引本就可重建，ADR-105 §5 的不变式「删掉索引 ⇒ 所有读 RPC 返回逐字节相同的结果，只有耗时变长」）。
  **尾部损坏的判定一个字节都没省**：坏行 / 坏帧 / manifest 说写完但帧缺 / 撕裂尾帧按原口径处理（尾窗里见到就整份退回）。
  口径见 [event-log-policy §7](docs/architecture/event-log-policy.md)，步骤见 [operations/GATEWAY §7](docs/operations/GATEWAY.md)。

### 工具 / 运行时

- **工具名统一 snake_case**（`^[a-z][a-z0-9_]*$`，≤64）：判据收在
  `packages/core/src/runtime/tool-name.ts`（唯一真源）。之前只有 provider 那条下限
  `[A-Za-z0-9_-]{1,64}`，所以 `piiReveal` 这种驼峰能跑但生态上不一致（模型先验、MCP 落地面、
  大小写不敏感环境撞名、grep 搜不全）。本次改名：`piiReveal` / `pii.reveal` → **`pii_reveal`**；
  `ask_user` → `ask`（早前遗留）。**旧名保留一版**：别名表 `TOOL_NAME_ALIASES`（一处），
  `MemoryPluginHost.getTool` 统一解析，`tool-pipeline` 命中别名时把一行弃用提示追加进回给模型的
  结果（错误路径也带），`--tools` 末尾单列 `Deprecated tool-name aliases`；`src/legacy-tool-names.ts`
  改成从同一张表派生（配置层 `auto_approve` / `never_auto_approve` 的旧名换算与注册表不再各存一份）。
  **机制级校验两道**：注册期 `registerTool` 不合规直接抛（文案带正则与建议名，`badName → bad_name`）；
  装配期 `assertToolNameLegality` 全量扫描，挂在 `installPluginsIntoHost` 收尾、`bootstrap` 收尾、
  `--tools` —— 内置工具违规**列出全部违规项后失败**，不再等模型调用时才炸。**外部来源（MCP）原样透传**：
  走 `registerTool(def, { external: true, source: 'mcp:<server>' })`，同样过校验但只记 warning
  （装配日志 + `--tools` 的 warnings 可见），名字我们改不了，但不能不可见。规则见
  [docs/architecture/tools.md § 命名规则](docs/architecture/tools.md#tool-name-rule)。

### 日志中枢（gateway 降噪 / 着色 / config / WebUI）

- **进程级日志中枢**（`feat/gateway-log` P1–P6，commits `d64fa589` / `4d371234` / `f2e3d4d7` /
  `bbb97652` / `ff90d071`）：core 新增 `log-hub.ts`（级别阈值 / 按模块级别 / 格式 / 时间 / 颜色，
  运行时可改）与 `log-format.ts`（排版唯一来源，自 `serve/log-event.ts` 搬入 `EVENT_FIELDS`）。
  core Logger、serve `logEvent`、插件注入 Logger 三路汇流 `emitLogLine`：过滤 → 脱敏 → 排版 →
  `writeStderrNotice`（EPIPE 自激防护不变量保留，无裸 `process.stderr.write`）；`logEvent` 首次纳入
  redactor。`createStderrLogger` 改薄封装、阈值实时读取（模块级单例自动跟随配置）。
- **降噪**（降 debug 不删除，`modules` 可单独打开）：`timeline.gap_reported` warn→debug +
  同 session 60s 窗口折叠（`suppressed=N`，诊断面板不折叠）；`gateway.ws.closed` 正常关闭
  （客户端 1000/1001）debug、异常（1006/1011 / 服务端发起）warn、其余 info（审计账不折叠，
  node 与平台代理共用 `wsClosedLevel`）；`agent.bash_job.delivering/delivered/delivery_ready`、
  `basic_tools.bash_job.started`、`run.timing` / `run.llm.gap` 降 debug（`VESSEL_RUN_TIMING=1`
  仍可强制开，`0/false/off` 强制关）；`agent.snapshot.duplicate_name` 每 name 进程内首次 warn；
  provider retry 第 1 次 debug、≥2 次 warn；`update.check.failed` 网络失败 1h 窗口折叠。
  basic-tools 起步行 / plugin-host 默认 logger / proxy 记账出口收口事件行，消灭第三种格式。
- **着色**：`shouldColor`（`NO_COLOR`/`TERM=dumb`/`color:never` 优先关；`always`/`FORCE_COLOR≠0`
  强制开；auto=`stderr.isTTY`）；`COLORTERM` truecolor/16 色两档。配色：INF 海洋绿 `#1EFFC7`、
  WRN 品红+BOLD（不用黄）、ERR RED+BOLD、时间/DBG/事件域/key= DIM、ERR 行 error/reason 值 RED。
  daemon 落盘天然无 ANSI、时间 iso。配色表进宪法第十四条 §2.1。
- **config 热应用**：`observability.log.{level,modules,color,format,time}`（schema / 校验 /
  默认值 / `modules` 键 snake→camel 豁免）；启动应用 + config-watch 热应用（log applier，差异行
  `log: level info→debug` 进 `runtime.notice`，不新增 RPC scope）；优先级 `VESSEL_DEBUG` >
  `VESSEL_LOG_LEVEL` > `VESSEL_RUN_TIMING` 强制 > config > 默认；`config show` / `config.get`
  （新增可选 `logEnvOverrides`）/ WebUI 标注环境覆盖。
- **WebUI**：Settings 新增「日志（gateway）」分组（4 个枚举键走既有 `config.set` write 权限，
  `ui-settings` 支持三层键嵌套写）；`modules` 一期只读展示；被环境变量覆盖的键只读 + 提示。
  口径见 [operations/LOGS §1.1](docs/operations/LOGS.md)、[architecture/config](docs/architecture/config.md)。

### 客户端（WebUI）

- **修：刷新/重连把整段聊天记录「从前往后」拉一遍直至 node 被看门狗重启**（2026-11-17 事故）。根因是
  **两套 seq 混进同一个游标**：连接级 hello 的回放帧是进程级 `hub seq`，客户端却把它写进时间线游标；
  下一次 subscribe 带着这个越界的值，服务端按 `reset` 从 `seq 1` 堂堂正正重放，客户端的续拉循环便
  `2000 → 4000 → …` 一路追到会话末尾（实测 30,061 帧 / 12.5 MB / 51 次订阅；`timeline.gap_reported`
  13,854 条，node 探活连续 3 次超时后被 supervisor 重启）。同一路径在 `sessions.get` 读游标超时时也成立
  —— 旧 fail-open 会发 `after_timeline_seq: 0`，而这是**合法请求**，服务端没有理由拒绝。修法五条：
  ① 连接级 hello 用客户端内部标记 `connectionLevel` 判形，chat + timeline 下 hub 帧只隔离、不碰游标；
  ② 游标读失败**本轮退到有界 hub 尾窗**（老订阅参数），绝不再发 0；③ 服务端声明 `reset` 时丢弃缓冲、
  锚到尾部窗口（`seqFloor` 挡住 reset 段的 `1..2000`）；④ 重连 `since` 不再复用时间线游标，且连接级回放
  改为不请求（路由订阅自己会收敛）；⑤ 环里只有 hub 帧（左缘 0）时，在时间线落位前先清空。顺带修掉
  `subscribeOnce` 的「没有 `session_id` 也先试 `after_timeline_seq`」分支：服务端按 `invalid_params` 拒，
  非 chat 范围（team / runs）会因此拿不到订阅；现在由调用方显式决定走老参数。
- **删掉「400ms 没新帧 = 这趟发完了」的空闲猜测**（`EPOCH_IDLE_MS` 已删除）：结趟改吃两条**显式事实** ——
  ① 服务端整趟发完后补的 `timeline-epoch-end {end_seq, count, has_more}`（能力位 `timeline.epoch-end`）；
  ② 订阅 `res` 已回（老服务端 0.54 / 服务端撞背压提前停时的兜底，按连续前缀收口续拉）。为什么要删：网络慢一点或
  一次 GC 停顿就误判成「停」并按前缀收口续拉（用户看到的是那条假缺口报告），反过来真没发完时也分不清两件事。
  帧口径见 [gateway-rpc](docs/architecture/gateway-rpc.md)。
- **首屏回填失败时不再从 seq 1 回放**：chat 订阅的 `after_timeline_seq` 夹到**当前尾部窗口**左端
  （`tailWindowStart(target) - 1`，与首屏回填同一预算 `TIMELINE_TAIL_WINDOW_EVENTS = 2000`）。真机（`d813eaea` 只读拷贝、
  同一 0.55 网关、避开 8644）：订阅起点 `0 → 207835`（`wal_head = 209835`），首屏帧数两边都是 2000，但尾部窗口落在
  209835 且 `has_more: false`；旧行为停在 2000（= 会话开头）且 `has_more: true`，会一路续下去。
- **修：时间线 hello 的时间线段是平铺的，客户端却按嵌套对象读** —— `readTimelineHelloSegment(source, info.timeline)`
  拿到的永远是 `undefined`，于是**四条校验与 epoch 记账在真机上从未生效**（一律退化成老 epoch 行为，靠 `truncateAfter`
  硬对齐游标）。现在 wire → 内部形状的映射收敛在 `apps/web/src/gateway/node/protocol.ts#readHelloTimelineSegment`
  一处（`timeline_source === 'timeline'` 且六个键齐全才给），判定与 `packages/serve/src/gateway/frames.ts#helloFrame`
  的平铺形状一致。真机（`eecc5a48`，订阅 `after_timeline_seq: 7000`）：epoch 记账生效、`timeline-epoch-end` 收尾得到声明
  `[7001..7955] count=955 has_more=false`，四条校验通过、零缺口（此前同一路径不会有任何 epoch 结算）。

### 破坏性（删除清单，逐项可直接回滚）

- **日志行格式变更（日志中枢，`feat/gateway-log`）**：
  - **去掉 `[vessel]` 前缀**（pretty 与 json 都去）。pretty 改 `时间 LVL 事件名 k=v` 单行
    （TTY clock / 落盘 iso）。grep `[vessel]` 的运维脚本请改 grep 事件名；`vessel logs tail`
    只读行、不依赖前缀，不受影响。
  - **json 逃生阀形状统一**为单行 `{time, level, event, ...fields}`：原 core Logger 的
    `{time,level,message,fields:{...}}` 与 logEvent 的 `[vessel] {"event":...}` 两种形状合并
    （Logger 的 message 进 `event` 位）。`VESSEL_LOG_JSON=1` 或 `observability.log.format: json` 开启。
  - **info 级事件行从 stdout 改到 stderr**（诊断只走 stderr 红线）：只抓 stdout 的管道会少这部分行。
  - **`createStderrLogger` 不再接受 options**（`LoggerOptions` 的 level/redact 移除，仓内无调用方受损）：
    阈值与脱敏由进程级中枢统一控制；嵌入方要自定义 sink 仍注入自己的 Logger 端口（ADR-069 不变）。
  - 回滚方式：revert 对应 commit 即恢复旧格式（前缀 / 双 JSON 形状 / console.info 通道）。

- **`serve:` 段移除（0.55）**：`serve` 从此**不是配置块**，写它就**启动失败**（`exit 2`），整块一个键都不生效
  —— 不是「警告 + 照旧生效」。文案逐键给出可照做的改名提示（`serve.token -> node.token`、
  `serve.token_env -> node.token_env`、`serve.allowed_origins -> node.allowed_origins` …），
  用户复制改名即可，字段名与语义一个都没变。为什么现在动：`serve:` 是 0.3 时代的名，`vessel serve`
  命令 0.49 就没了；留着两个名字读同一份字段，`doctor` 和启动迟早会漂开。同步落地：loader 拦住并**丢弃**
  该块（绝不静默生效）、验证错误路径一律写 `node.*`、脱敏路径 `serve.tokens.*` → `node.tokens.*`
  （token 永不打印这条不变）、`vessel doctor` 的 `config` 一行直接显示这条错误（状态 `fail`）。
  口径见 [operations/CONFIG §2.0](docs/operations/CONFIG.md)、[operations/REMOTE §3.1](docs/operations/REMOTE.md)。

- **`events.ndjson` 的读写代码全删（0.55）：0.54 之前的会话格式不再支持**
  - 删了什么：`packages/core/src/session/session-event-log.ts`（整文件，旧日志实现）、
    `tenant-paths.ts#sessionEventsFilePath`、`timeline/freeze.ts`（只读冻结整块）、
    `TimelineWriter` 的 `adoptLegacyShapedSession`、`src/session-migrate.ts` +
    `src/session-migrate-command.ts` 与 CLI 的 `vessel session migrate`（含 help / completion /
    i18n 条目）、双写旁路里的 `frozenSessions` / `counters.frozen_sessions` 与两层时间推断
    （构造时快照 + 旧日志首条 `ts`）。
  - 现在会怎么坏：**旧格式会话（只有 `events.ndjson`、无任何 timeline 标记）读不了**。
    `sessions.get` / `sessions.events` / `events.subscribe{after_timeline_seq}` 会拿到
    `legacy_session_unsupported`（取代 `session_frozen_readonly`，serve / rpc / core 三张错误码表同步），
    文案写明「不读、不写、不迁移；用 0.54 导出后再用 0.55 打开」。**不静默降级成空会话**
    —— 那会让人以为历史丢了却不给原因。写侧同样拒绝（避免造出半新半旧的目录）。
    判据仍只有一处：`packages/core/src/timeline/legacy-format.ts#assertSessionFormatSupported`，
    读口 / 写者 `open()` / 索引写回三处调用。
  - 用户该怎么办：旧备份或老数据目录先用 **0.54** 跑一次 `vessel session migrate <id>|--all`
    （或直接用 0.54 打开把会话导出来），再把产物交给 0.55；0.55 自己不读、不写、不迁移。
    0.55 起**没有** `vessel session migrate` 这个命令了。
  - 口径见 [event-log-policy §1](docs/architecture/event-log-policy.md)。
  - **已知遗留（不在本单范围）**：`plugins/observability/usage` 仍依赖
    `sessions/<id>/events.ndjson`（`src/store.ts` 的 `SESSION_LOG`）。它在 0.54 停写之后就已经
    在读一个不再增长的文件；0.55 删掉这份文件之后其**数据面不再可用**（用量 / 请求日志页会是空的），
    将单独迁移到时间线。

- **`timeline_source` 四件一起删：帧字段 / 读源标记 / 老格式退回路径 / `gap` 帧（0.55）**
  - 删了什么：① `hello.timeline_source` 帧字段（服务端 `frames.ts` / `protocol.ts` /
    `events.subscribe` 的 result 都停发）；② `TimelineReadFrom` 类型与 `read_from` 残留口径
    （`serve/gateway/timeline-protocol.ts`）；③ 老格式会话的退回路径（本单上一组删 `events.ndjson`
    之后它已经没有活分支，客户端那侧剩下的是「没有 `timeline` 段 ⇒ 老 epoch」这一条，保留）；
    ④ `gap` 帧整条链：`ServerFrame` 的 `kind:'gap'`、`frames.ts#gapFrame`、WS 背压补发 /
    心跳补发 / 回放缺口 / SSE 的三处发送点，以及客户端的 `onGap` 订阅与 `offGap` 分支
    （`GapFrame` 类型、`TimelineGapSource` 的 `'server'` 成员一起删）。
  - 判据换成**形状**：客户端 `readHelloTimelineSegment` 只看 `hello` 上那六个键在不在
    （`apps/web/src/gateway/node/protocol.ts` 的 wire → 内部形状映射仍只有一处）；服务端
    `helloFrame` 只在有时间线段时才带那几个键。
  - 现在会怎么坏（**用户视角，必须写在 CHANGELOG 里**）：**升级后请刷新页面**。48 小时内
    没刷新的老前端还靠 `timeline_source` 判读：服务端停发该键之后它会把这趟当成老 epoch，
    于是 ① 不做四条 count 校验、② 忽略 `timeline-epoch-end`、③ 看到假缺口（表现为时间线上
    一条「这一段读不回」的污点条）。刷新页面即恢复（新前端判形状，不依赖该键）。
  - 老服务端（0.54）不受影响：`timeline_source` 只是被当成未知键忽略，而新前端读的是同一批
    形状键，四条校验照旧生效。
  - 口径见 [gateway-rpc §订阅 epoch](docs/architecture/gateway-rpc.md)、
    [events](docs/architecture/events.md)、[session-replay](docs/architecture/session-replay.md)。

## [0.54.0] - 2026-11-16

> 本节按 0.54 迁移判据 B-4
> 「破坏性变更必须登记」写。**全部条目均在 main（`c31dba42` 起）上落地并真机验证过**，无「未核实」遗留。

### 破坏性

- **`events.list` 的 `seq` 语义从 per-run 改为 `timeline_seq`**：同一 RPC 名、语义换源 —— 原本返回
  `data/events/<run_id>.jsonl` 的 per-run 序号（`packages/core/src/observability/read-trace.ts:120`），目标是查
  timeline 的 run 索引并返回会话内 `timeline_seq`（ADR-105 D5；计划书 §2 第 5 项）。消费方（Run 详情 / 观测页 /
  `vessel errors`）**不得再把 `seq` 当 run 内序号**。
  **未核实**：本分支 `events.list` 仍走 `trace.readEvents`（`packages/serve/src/gateway/methods/observability.ts:36-90`），换源未落地。

### 新增

- **`timeline.hello` 时间线段六字段**：`start_seq` / `end_seq` / `count` / `timeline_head` / `wal_head` / `holes`
  （`packages/serve/src/protocol.ts:145-181`），pub-i2 再加 `published_head`（`(published_head, wal_head]` 允许永不被推送）；
  能力位 `timeline.cursor`（`packages/serve/src/gateway.ts:1027`）。
- **事件**：`timeline.gap_reported`（客户端自报缺口，服务端只记录；`packages/serve/src/gateway.ts:2609-2658`）与
  `timeline.divergence`（双写采样比对不一致，不阻断、不进 timeline 自身；`src/timeline-dual-write.ts:1605-1626`），
  两者可见性均为 `observe`（`apps/web/src/state/event-visibility.ts:145`、`:156`）。
- **客户端**：单游标 + 单区间回填 + 四条硬校验（`apps/web/src/gateway/timeline-protocol.ts:298`），缺口表现为污点条
  `TimelineGapBar`（`apps/web/src/domains/chat/TimelineGapBar.tsx`）。

### 移除

- **`gap` 帧**：时间线 epoch **永不发**（`packages/serve/src/protocol.ts:196-218` 自述「过渡期字段」），完整性改由
  `count` + `holes` 表达。
- **前端两个磁盘源** `disk-replay.ts` / `replay-source.ts`（整文件删除，净减 957 行，commit `61395751`），连带两阶段回填、
  `beginBackfill` / `endBackfill`、`MAX_BACKFILL_PAGES`、时间截断（计划书判据 B-1 的符号零引用清单）。
- **门禁** `scripts/check-replay-merge.ts` 及其链项（commit `44cdac45`）—— 它验的出货代码已不存在。
- **`events.ndjson` 写路径**：新格式会话只写 timeline（`wal.log` / `wal.blocks/` / 归档段），`events.ndjson` 停止增长；
  旧格式只读冻结（`packages/core/src/timeline/freeze.ts#isLegacyFrozenSessionDir`），**是迁移窗口里的过渡件，
  计划随「旧会话一次性迁移」删除**（迁移入口 `vessel session migrate` **未实现**：`src/cli-help-spec.ts` 无该命令组）。

### 内部

- **满投影不再把占位正文写进 `SessionState`**：`projectMessages(events, { applyClearedReplacements: false })`
  （`packages/core/src/runtime/execution-unit.ts:4049`），占位只活在请求视图与 UI 派生层。
- **`tainted` 可复位**：`timeline.manifest` 追加 `tainted_cleared` 行（`packages/core/src/timeline/writer.ts#clearTaint`，`:1151`；
  读法 `lastTaintedState`，`:227`），值按**物理写入顺序** last-wins，不按 `at` 排序。
- **洞可退役**：`holes.ndjson` 追加 `kind:'hole_retired'` 并要求「区间重读逐条通过」自证（`packages/core/src/timeline/holes.ts:365`），
  退役后不再压制 `tainted`。
- **chunk 瘦身**：`tool_call_delta` / `finish` 是瞬时 chunk，不占 `timeline_seq`、不进块（`packages/core/src/timeline/blocks.ts:68`、
  `writer.ts:659-666`），实测**帧 −82% / 字节 −83%**；刷新后工具卡由 `tool.call.started` / `tool.call.completed` 复原（commit `149f5c32`）。

## [0.53.0] - 2026-11-13

> 0.53 收口线（基于 `main @ c698471a`；manifest 根 `package.json` = `0.53.0`）。未 tag、
> 未 publish（tag 等 1.0.0）。完整记录见 [docs/versions/0.53.0.md](docs/versions/0.53.0.md)，
> 未尽事项与 0.54 边界记在个人侧 handoff（不入共享仓）。
> 0.52 开发线（prune / PII 金库 / 启动恢复 / 优雅退出与 handoff 重启 / ask 交互 / 事件可见性
> 加固等）随本版一并收口，条目仍记在 [docs/versions/CURRENT.md](docs/versions/CURRENT.md)。

### 上下文（投射四模式 / trim 卡 / 幂等守卫 / C1g·C1h 判据）

- **会话级投射声明与四模式（ADR-104）**：词表 `passthrough` / `placeholder` / `externalize` /
  `archive_notice`；**0.53 默认 `placeholder`**（用户 2026-11-15 裁定，覆盖 ADR 默认表里的
  passthrough）。声明落 `SessionState.context_projection`（`declaration_id` / `source` / `params` /
  `declared_at`），**不可变**（同值幂等、异值抛 `projection_mode_immutable`）、子不能放松父；
  读侧唯一入口 `resolveProjection`（declaration / default / legacy 三态 + 四枚冻结错误码）。
  门禁 `check:projection-declaration`（103 项）。
- **运行期接线（U2）**：模式与「清哪些旧工具结果」都在 **run（段）起点冻结一次**
  （`freezeSegmentProjection` → `windowProjectionMode` + `segmentClearPlans`），请求期只读、
  段内绝不重算（反事实：改成每请求重算把 +9.85 打成 −72.37）。`passthrough` 与「完全没有
  投射机制」逐字节相同（不跑 plan、不替换、不发 trim 卡）；未实现档运行期 fail-open 到
  `passthrough` 并写审计（**两层降级不许混**：声明期降级落 `placeholder`、运行期单 run 降级落
  `passthrough`）。审计 `context_projection_audit` 只在**决策变更**的段起点写一条，不刷日志。
- **归档模式（U3）**：`archive_notice` 按同一套保留预算规划，但**只登记、不替换** —— 追加一张
  归档卡（`tool_call_ids` / `tool_names` / `bytes` / 原文日志 + 读回法），集合只进 `plan_hash` /
  卡 / 事件，**不进**冻结集合（否则等于伪造「这批被换成占位了」）；`sessions.events` 加可选
  `tool_call_id` 读回原文。门禁 `check:archive-notice`（45 项，含「模式之间不串味」）。
- **trim 卡分层 + 同载荷去重**：折叠态标题只说**本轮新增**（`added` / `tool_call_ids`），展开
  明细才给**会话内累计**（`cleared` / 保留条数）；签名 `(cleared, added, fresh ids)` 全等即
  不再 append、不重复发事件。门禁 `check:tool-result-clear`（76 项，T7 幂等 / T8 分层）。
- **占位幂等守卫**：`withClearedToolResults` 遇到正文已是占位就原样透传 ——
  `formatClearedToolResult` 的行数取自原始结果，把占位喂回去会退化成 `-> 1 lines`，每多投影
  一次多一层漂移（写入侧落成占位后这条路径每轮都命中，所以是必需条件、不是防御性冗余）。
- **C1g 按模式分档**：`passthrough` = 请求视图改写必须 0（并用「同场景按 placeholder 会改 N 条」
  的反事实证明不是真空绿）；`placeholder` = 改写集合**恰好等于**「审计集合 ∩ 落盘工具结果」，
  且每条 `role=tool` + id 在审计集合内 + 正文 `isClearedToolResult`；声明 / 读侧解析 / 请求期
  生效三者必须同一个模式（防实现把模式静默保底）。
- **C1h 正式裁定（本版收口）**：请求期改写从「一律违规 / 灰度 PENDING」改成**按豁免事实判定** ——
  ① 声明存在（mode ∈ `placeholder|externalize`）② 审计行存在且链尾模式与声明一致
  ③ 审计集合 ∩ 落盘工具结果**逐条等于**实际改写集合 ④ 每条改写确实是占位。四真同时成立才
  `EXEMPT` 并打印原因；任一不满足即 **FAIL**（错误行带 `mode=` / `audit=` / `request=`）。
  `pending()` 灰度机制随之清空并删除，`--phase=1` 与默认模式必须给出同一结论；判据自带
  `C0b` 自检（10 例反证：缺声明 / 错模式 / 缺审计 / 链尾不一致 / 缺集合 / 越界 / 漏改 / 非占位
  逐条立项），探针也会真跑一遍（真 EU 改了 8 条 = 审计 8 条）。

### 可观测与回放（磁盘回填两阶段 / 内容 id / 竞态用例 / 阶段一触顶）

- **磁盘回填两阶段**：`sessions.events` + `sessions.get.event_cursor` + 环 1 万 → 5 万后，前端
  **第一次真读磁盘** —— 刷新/重连时阶段一拉本会话日志（`sessions.events`），阶段二按 `run_id`
  逐 run 拉 trace-only 类型（`events.list`，最多 `REPLAY_MAX_TRACE_RUNS = 3` 个）。只做阶段一会
  漏 `context.changed` / `hook.*` / `run.checkpoint` / `runtime.notice`（本机实测 767/847 =
  90.6% 补不回），所以两条回填缺一不可。
- **观测面 `EventStore#diskBackfill`**：累计位 attempts / merged / duplicates / alreadyMerged /
  outOfRange / deferred / evicted / truncated，最近一次快照 stage1Pages / stage1HitCap /
  stage2RunsRequested / stage2RunsFetched / stage1CapWarned / lastError。**押后（deferred）归
  实时流、不算丢**，这条语义有断言钉住。
- **内容 id 带 payload 摘要**：跨源去重键 `stableEventId` 从 `run_id|type|ts` 补 payload 摘要，
  不再吞「同毫秒不同内容」的事件；段内身份 `(run_id, seq)` 保证跨次回填幂等（`alreadyMerged`）。
- **阶段一触顶可见**：页数硬上限（`REPLAY_MAX_SESSION_PAGES = 20`）先到时置 `stage1HitCap` +
  一条 warn + 一次 toast —— 否则「早于最近 3 个 run 的事件这次根本没被请求」会被读成「本来
  就没问题」。
- **四组用例**：竞态 / 覆盖 / 押后 / 触顶进 `check-replay-apply`（76 项）、
  `check-replay-merge`（12 项：覆盖 `[1..366]` 零洞 / 确实调 `sessions.events` / 重叠去重 /
  fail-open / 阶段一 vs 阶段一+二）；静态链路门 `check-replay-wiring`（F 逐方法接线、F1 禁
  `apps/web` 碰本地文件系统、F2 禁裸 transport，带 16 例 selftest，已转 PASS）。

### 通知与可见性（peer-stop / rotate 重解析 / inbox 卡头 / env-scope 门禁）

- **成员停下真能通知到父会话**：peer 成员兜底走创建者进程内映射，注入落
  `runtime.notice.injected`（0.53 peer-stop notice）；门禁 `check:peer-notice`（68 条断言）。
- **投递前重解析父 session**：通知在合并窗口内遇到父 rotate 也能投到**新 body**，不再落到旧
  epoch（装配层接上重解析口）。
- **inbox 卡头**：待处理/收件卡补 `env` 卡头（scope 词 + 卡头标签中英两侧），
  **可见性对等**由新门禁 `check:env-scope-parity`（50 项：生产者的 scope 必须在 Web 词表里，
  且每个词都解析得出卡头标签）机械判定。

### 工具与配置（piiReveal / 注册期校验 / 旧名换算）

- **工具名合法性**：`pii.reveal` → `piiReveal`（点号不是合法工具名，模型侧照抄会调不到），
  连带修内置工具名与配置键；**注册期 fail-fast 校验**：非法字符 / 与内置重名当场炸，不再留到
  运行期才发现。
- **旧名换算表驱动**：老配置与老会话里的 `ask_user` / `pii.reveal` 在读侧统一换算（读侧双认、
  写侧只发新名），表驱动而非散落 `if`；门禁 `check:tool-name-aliases`（67 项）。

### 成员与历史（includeReleases / closed_at）

- **`agent list includeReleases`**：只读历史视图（默认 20 / 上限 200 / `fields` 裁剪），
  成员停用后的 `closed_at` / `close_reason` 落盘（停用是终态，`retired` / `stale` 不是）；
  门禁 `check:member-history`（35 项）。

### 门禁与文档（新增 10 条探针 / ADR-104 / session-length / 投影卡规格）

- **新增 10 条探针**（全部并入 `bun run gates`）：`check:projection-declaration`（103）、
  `check:projection-modes`（52）、`check:archive-notice`（45）、`check:replay-merge`（12）、
  `check:replay-apply`（76）、`check:replay-wiring`（A1 + 16 例 selftest）、
  `check:session-events`（40）、`check:peer-notice`（68）、`check:env-scope-parity`（50）、
  `check:member-history`（35）、`check:tool-name-aliases`（67）；另有同期并入的
  `check:tool-result-clear`（76，T7 幂等 / T8 trim 分层）。**探针不自证**：多条带反事实断言
  （passthrough 的反事实改写数、C1h 的 C0b 10 例），不许出现「没输出所以绿」。
- **ADR-104 会话级上下文投射**：四模式词表 / 两层降级 / 单调收紧 / 可混用 / 按 **run** 粒度
  决策（两次粒度纠正进了 ADR 正文与 §8 声明来源与入口）。
- **`docs/architecture/session-length.md`**：会话长度四套机制与体积阈值归属 —— 会话层只做观测
  兜底、工具层做预防（体积阈值判据 `shouldCompactForToolResultVolume` 只对 `placeholder` 生效，
  `passthrough` 下压力可观测但不驱动压缩）。
- **`docs/specs/projection-card-spec.md`**：投影卡规格（服务端一次渲染 + 双层视图
  「模型视角 / 原文视角」，含一节明确结论：**卡不能充当 C1h 的豁免凭据**）。
- **本版的量化依据**（数字已进正文；原始取证材料属过程产物，按守则 01 不进本仓）：
  placeholder vs passthrough 成本账（645 段净赚 36:1、临界折扣 2.68%、冻结不变式值 +82.2）、
  chunk 丢失量化（653 run：磁盘 1.45 MB = 流式正文 100.0%）；工具名合法性清单见
  [`docs/specs/tool-name-legality.md`](docs/specs/tool-name-legality.md)。
