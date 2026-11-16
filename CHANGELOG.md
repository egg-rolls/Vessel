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

### 客户端（WebUI）

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
