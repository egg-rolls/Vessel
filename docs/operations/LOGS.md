---
title: 运维日志口径（一件事只有一种说法）
kind: current
triggers: [日志, log, 日志一致性, web.build, 构建, 构建日志, build.json, gateway status, 看门狗, supervisor, hub, console.log, logEvent, 事件行, key=value, 日志级别, 颜色, 降噪, log-hub]
paths: [src/web-dist.ts, src/gateway-command.ts, src/cli.ts, src/logging.ts, packages/core/src/log-hub.ts, packages/core/src/log-format.ts, packages/serve/src/log-event.ts, packages/serve/src/platform/proxy.ts, packages/serve/src/platform/proxy-config.ts, packages/serve/src/platform/proxy-ws.ts, packages/serve/src/platform/server.ts, packages/serve/src/gateway.ts, src/provider-factory.ts]
---

# 运维日志口径：一件事只有一种说法

> 用户原话：「日志系统同步优化一下，防止出现多个地方的日志不同」。
> 本文是那张**盘点表** + 落地后的**权威来源**。改日志前先在这里找到那一行，
> 只改权威来源，别在别处补一句「顺便说一下」。

## 1. 规则（唯一一条）

**每个事实只有一个权威来源；其它地方只能从它派生，不许各自拼文案。**

- 权威 = 一条事件行（`log-format.ts` 的 `EVENT_FIELDS` 定字段序）或一份内存态；
- 派生 = 读同一份状态，再用**同一个** `formatEventLine` 排版；
- 排版只有一处：`packages/core/src/log-format.ts`（单行 key=value；`serve/log-event.ts`
  只是 re-export + 转发）；
- 级别 / 脱敏 / 格式 / 时间 / 颜色只有一处：`packages/core/src/log-hub.ts`（进程级日志中枢）。
  core Logger、serve `logEvent`、插件注入的 Logger 三路都经 `emitLogLine`
  （过滤 → 脱敏 → 排版 → `writeStderrNotice`）；**不新增裸 `process.stderr.write`**
  （EPIPE 自激防护不变量见该文件头）。

「措辞」不指语言（中英各有 i18n），指**同一条事实在日志/接口/UI 上的字段与说法**。

### 1.1 日志级别与颜色（日志中枢）

- 行格式（pretty，vite 式单行）：`时间 LVL 事件名(列宽24) key=value...`，
  如 `12:03:41 WRN gateway.ws.closed node=Soulkiller who=upstream code=1011 dur=202s`。
  `[vessel]` 前缀已去除；json 格式（`format: json` / `VESSEL_LOG_JSON=1`）为单行
  `{time, level, event, ...fields}`（机器接口）。
- 级别：`observability.log.level`（debug|info|warn|error，缺省 info）+
  `modules`（事件名前缀→级别，最长前缀匹配）。优先级：`VESSEL_DEBUG` >
  `VESSEL_LOG_LEVEL` > `VESSEL_RUN_TIMING=1`（仅 run.* 强制）> config > 默认。
  热应用：改 config 不重启即生效，差异行进 `runtime.notice`。
- 颜色：`color` auto/always/never；`NO_COLOR`（任意值）/ `TERM=dumb` 优先关闭，
  `FORCE_COLOR` 非 0 强制开；auto 看 `stderr.isTTY`（daemon 落盘天然无 ANSI）。
  `COLORTERM=truecolor/24bit` 上 24bit，否则 16 色。配色表见宪法第十四条。
- 时间：`time` auto/none/clock/iso；auto = TTY 用 clock（HH:MM:SS）、落盘用 iso。
- 脱敏统一在 `emitLogLine`（先脱敏再排版，pretty/json 同一路径）；`logEvent` 也在内。
  不提供 trace 级或「显示原值」开关。
- 降噪口径：高频过程事件降 debug（不删除）；审计账（`gateway.ws.closed`）不折叠、只分级；
  同类重复按窗口折叠带 `suppressed=N`（gap_reported 60s / update.check.failed 1h）。

## 2. 盘点表（2026-11-17，0.60 之前 → 之后）

| 事实 | 之前出现在哪几处 / 各自口径 | 权威来源（之后） | 本次改动 |
|---|---|---|---|
| **Web 产物在不在建 / 成没成 / 为什么失败 / 日志在哪** | ①启动横幅 i18n 三句（`gateway.webDistBuilding/Built/BuildFailed`，自然语言）②`/build.json` 的 `building` 布尔 ③WebUI 提示条（`apps/web/src/app/useOutdatedBuild.ts` 读 `building`+`stale`）④`gateway status` **完全没有**构建态 | `web.build.*` 事件 + `webDistBuildState()`（内存）+ `<tmp>/vessel-web-build/<ts>-<pid>/meta.json`（跨进程读到的那一份） | 横幅三句**删除**（改打 `web.build.start/progress/done/fail/interrupted`）；`/build.json` 增加 `build{}` 段（由同一份状态派生，`building` 保留）；`gateway status` 增加 `web.build.running` / `web.build.last` 行（读同一份记录） |
| **Web 产物是否落后于源码（stale）** | ①启动横幅 `webDistWarning` ②`/build.json` 的 `stale`/`newestSource` ③`gateway status` / `doctor` 的 `webDistStaleLine` | `inspectWebDist()`（判据唯一；外部 `VESSEL_STATIC_DIR` 只报存在性） | 未改判据；三处仍共用它（文案按用途不同：横幅 / 机器字段 / 一行诊断，**事实同一份**） |
| **构建被中断 / 上次构建硬死留下临时目录** | 之前完全不可见（只在下次构建时静默覆盖） | `web.build.interrupted`、`web.build.stale_artifact` | 新增。Windows 没有可捕获的 SIGTERM（`process.kill` = 直接终止），所以「宿主已死」的那一次由**停止方**（`gateway stop`）代打同一行；宿主自己能说的时候停止方闭嘴（记录已终态） |
| **看门狗动作（僵死重启 / 放弃 / 恢复）** | ①`printWatchdogEvent` 手拼 `event=supervisor.* ...`（第二套排版）②`gateway status` 的看门狗快照段（读 `platform-watchdog-*.json`） | `EVENT_FIELDS` 的 `supervisor.*` + `logEvent` | 手拼行**改成** `formatEventLine`（字段序进了 `EVENT_FIELDS`），输出通道仍可注入；快照段读的是「状态快照」，与「动作事件」是两个事实，保留 |
| **Hub 起没起来** | ①启动横幅 `hub <url> (auto-started)` ②失败行 `hub_start_failed: <整句>`（裸码+整句，第三种排版）③`hub unavailable` | `hub.start_failed` 事件（启动阶段与收尾阶段同一套字段） | 两处失败行合并成一条事件；成功行仍是横幅（人读的位置），不重复打日志 |
| **节点就绪状态** | ①`node <name>: <state> (原因/耗时)` ②启动摘要的 `(starting)`/`(adopted)` ③`gateway status` 的 `node <name> <url> <up/down>` | supervisor 状态机（`SupervisedNodeInfo`）；`up/down` 是**健康探测**，与 supervisor 生命周期是两个事实 | 未改；`describeNodeState` 是这两处的单一口径。**已知**：状态词表按视图不同（生命周期 vs 健康）——这是两个事实，不是两种说法 |
| **平台/节点 token** | 不打印（安全规则）；派生值只进 `/health` 的布尔 | `src/token-derive.ts` | 不新增任何 token 日志（`AGENTS.md` 硬安全规则） |
| **拦截类诊断**（replay 预算截断 / 全局回放拒绝 / interactions 持久化与隔离 / tenant 事件扇出 / 停机清理失败） | 各文件自己拼 `[vessel] xxx: detail`（有的还把对象直接丢给 `console.warn`，终端里展开成多行 JSON） | `gateway.replay.budget_truncated`、`gateway.events.global_replay_denied`、`gateway.stop.failed`、`gateway.tenant_hub.failed`、`interactions.store.*`、`interactions.registry.reload_failed` | 全部改走 `logEvent`（`path` / `error` 用结构化字段，不再是自由文本） |
| **日志级别与颜色**（gateway 进程太吵 / 三套格式交替 / 无法按模块调级别） | core Logger 每行 JSON、`logEvent` `[vessel] event k=v`、散落 `console.*` 自由文本，三种格式写进同一个 node-*.log；级别只有环境变量且只管 Logger 一路 | core 日志中枢 `log-hub.ts`（级别/模块/格式/时间/颜色，config `observability.log` 热应用）+ 排版唯一来源 `log-format.ts` | 三路汇流 `emitLogLine`；去 `[vessel]` 前缀；pretty=vite 式单行（时间 LVL 事件名 k=v）、json=单行 `{time,level,event,...fields}`；高频过程事件降 debug、审计账分级不折叠、重复按窗口折叠带 suppressed；配色见第十四条；WebUI Settings「日志（gateway）」分组 |
| **node/platform 停止没走成优雅路径（drain 回退）** | 之前强杀是静默的，看不出「这次停止没 drain」 | 停止方代打一行：`node.drain.skipped`（`gateway-command.ts:stopGateway` legacy node 入口、`node-supervisor.ts:stopSpawnedChildren` / `NodeSupervisor.stop` 的回调接线、`node-command.ts:runNodeCommand` node stop）与 `platform.drain.skipped`（`gateway-command.ts:stopGateway` platform entry）；字段 `pid` / `name?` / `reason`（timeout 或 shutdown 失败码） | 新增（P0-run-stops P4）。**尚未登记 `EVENT_FIELDS`**（登记属代码改动，另批）；停止语义见 [gateway-lifecycle](../architecture/gateway-lifecycle.md) / [GATEWAY](GATEWAY.md) |
| **平台代理 node 的失败记账** | 之前没有代理（0.58 新增） | `platform/proxy.ts`（`PlatformProxy`）：`gateway.proxy.rpc_denied`（HTTP 体 / WS 帧方法不在白名单）、`gateway.proxy.node_timeout` / `gateway.proxy.node_unreachable`（响应头超时 / 连不上，带 `timeout_ms` 预算，缺省见 `proxy-config.ts:DEFAULT_PLATFORM_PROXY_LIMITS`）、`gateway.proxy.node_body_failed`（响应体转发失败）、`gateway.proxy.failed`（内部错误）；WS 关闭记账 `gateway.ws.closed {via:'proxy'}` 在 `proxy-ws.ts` | `node_timeout` / `node_unreachable` / `failed` / `rpc_denied` 已登记 `EVENT_FIELDS`；**`node_body_failed` 未登记**（另批）。代理现态见 [topology](../architecture/topology.md) |

## 3. 怎么读一次构建（`web.build.*`）

一次构建**最多 4 行**（start + 可选 progress + 终态 + 可选内联尾部）：

```
12:03:41 WRN web.build.start    reason=stale target=apps/web check=timer pid=64180 log=/tmp/vessel-web-build/1794910725789-41008/build.log
12:04:11 WRN web.build.progress elapsed=30s rss=180MB    # 可选：<30s 的构建一条都不打，最多 2 条
12:04:28 WRN web.build.done     dur=17.2s assets=42 bytes=8.1MB
12:04:28 WRN web.build.fail     exit=2 dur=1.4s log=/tmp/vessel-web-build/…/build.log
| … 省略前 6 行（完整输出见上面的 log= 路径）
| src/main.tsx(21,26): error TS1109: Expression expected.
…
12:04:28 WRN web.build.interrupted signal=stop elapsed=6.1s log=/tmp/vessel-web-build/…/build.log
12:04:28 WRN web.build.stale_artifact cleaned=1 dir=/tmp/vessel-web-build
```

（pretty 行 = 时间 + 级别标记 + 事件名 + 字段；`web.build.*` 全部 warn 是既有口径。
TTY 才有 clock 时间与颜色，落盘是 iso 时间、无 ANSI。）

- `reason=missing|stale`：产物完全没有 / 落后于源码；
- `check=startup|probe|timer`：谁叫起来的这次构建 —— 启动时 / 有人拉 `/build.json` 看到旧产物 / 运行中定时自查（0.61）。三条入口共用同一套判据与互斥，出问题先看这个字段；
- 终态三种：`done`（成功）、`fail`（失败，附 ≤15 行尾部，每行 ≤160 字）、`interrupted`（被打断，子进程整树已杀）；
- `progress` 的 `rss=` 只在能读到构建进程树的平台出现（Linux 读 `/proc`）；读不到就不打这个字段，绝不用网关自己的内存冒充；
- `stale_artifact` 只出现在**启动**时：上一次是被硬杀（`SIGKILL` / 关窗口）留下的临时目录，清掉一行总账；
- 构建自己的完整输出始终在 `log=` 指向的文件里（临时目录，保留 7 天）。

`gateway status` 的构建段（跨进程读同一份 `meta.json`）：

```
  web.build.running elapsed=6.1s pid=64180 log=…
  web.build.last phase=done dur=17.2s at=2026-11-17T10:23:34.409Z log=…
```

（`gateway status` 是命令结果面，走 `formatEventLine` 的事件行本体：无时间/级别前缀、无颜色。）

### 3.1 运行中自愈（0.61）：没人开浏览器也会重建

| 触发来源（`check=`） | 什么时候 | 说明 |
|---|---|---|
| `startup` | gateway 启动时 | 只跑一次；产物缺失时等它建完再起平台（fail-fast 不接受半成品） |
| `probe` | 有人请求 `/build.json` 且判到 `stale` | 浏览器轮询/SSE 就会碰到；**请求本身不打日志** |
| `timer` | 平台侧低频定时器（缺省 60s） | 完全不开浏览器时唯一能自愈的那条；**定时自查本身不打日志**，只有真起了构建才有日志 |

三条入口**共用同一套判据**（`inspectWebDist`）、**同一个互斥**（`inFlightBuild`）与
**60s 限频**；每次构建都记 `check=`，所以「谁在反复触发」查得出来。

开关（**语义只有这一份**，见 `webAutoBuildMode`）：

| 环境变量 | 效果 |
|---|---|
| `VESSEL_WEB_AUTOBUILD_CHECK_MS` | 自查间隔，缺省 60000，下限 5000（再密就是在反复跑 `tsc --noEmit`） |
| `VESSEL_WEB_AUTOBUILD=startup` | **只在启动时**建；运行中不再自查（给慢机器/构建很贵的部署留退路） |
| `VESSEL_NO_WEB_AUTOBUILD=1` | 全关：启动也不建、运行中也不查 |
| `VESSEL_STATIC_DIR` | 指向外部产物时三档一律不接管（外部产物不归我们建） |

## 4. `console.*` 的判定（`grep` 后的逐个判断）

判定命令：

```
grep -rn "console\.\(log\|warn\|error\|info\)" src packages/serve/src --include=*.ts | grep -v "\.test\."
```

保留的四类（其余一律 `logEvent`）：

1. **短命命令的结果通道** —— `print` / `printErr` 的缺省实现（`console.log` / `console.error`），
   是命令的最终输出（`gateway status` 的表格、`update` 的提示、`resume` 的列表……），
   这些不是日志事件，收口到 `logEvent` 反而会毁掉给人读的表格；
2. **日志中枢自己的出口**（`log-hub.ts` 的 `writeStderrNotice`，全进程唯一 stderr 写点，
   带 EPIPE 报废保护）—— `logEvent` / core Logger 都转发到这里，不再各自 console；
3. **外来文本的转发** —— 插件子进程 stdout（`plugin-host/manager.ts`）、auth 后端告警
   （`platform/server.ts` 的 `[platform-auth]`）：正文不归我们控制，加前缀只会重复；
4. **构建失败的内联尾部**（`web-dist.ts` 的 `console.error("| …")`）：它是**证据**不是事件，
   用户要的是「一眼看出为什么失败」。

**外部插件自己写的 console 不在级别控制之内**（插件信任边界，不拦截）：它们仍会原样
出现在进程输出里，不受 `observability.log` 约束；内置插件的过程日志已改走注入的 Logger。

2026-11-17 收口掉的具体行：`gateway.ts`（3 处手拼诊断）、`interactions-store.ts`（6 处）、
`interactions-registry.ts`（1 处，原来把对象丢给 `console.warn`）、`tenant-event-hub.ts`（1 处）、
`gateway-command.ts`（看门狗 4 种事件 + hub 失败 2 处，原来是手拼 `event=` / `裸码: 整句`）、
`trace-wiring.ts`（1 处，`[vessel] trace.write.failed(reason): err` → `trace.write.failed`）。

仍然保留、且**不是**「同一事实两种说法」的几处（已逐个判断过）：

| 站点 | 为什么留 |
|---|---|
| `src/headless-runner.ts` 的 6 行 `[vessel] …` | headless 一次性运行的**结果通道**：告诉人「这次 run 在等人回答 / 去哪个目录看记录」。进程马上退出，没有第二个副本 |
| `src/ask-answer-delivery.ts` 的 2 行 | 同上：异步投放失败的最终提示（含 request id），不是日志事件 |
| `src/provider-factory.ts` 的 2 行 | 配置降级**一次性**告知（用哪个 provider / 为什么回退），只在构造时出现 |
| `packages/serve/src/plugin-host/manager.ts` 2 行 | 插件**子进程**的 stdout 转发：正文是外来文本，加事件名只会重复 |
| `packages/serve/src/platform/server.ts` 的 `[platform-auth]` | auth 后端告警转发（正文来自后端），同上 |

## 5. 改日志的检查清单

1. 这个事实在本文的表里有行吗？没有先加一行（权威来源是谁）；
2. 只改权威来源；派生方读状态，不复制字符串；
3. 新事件名进 `EVENT_FIELDS`（`packages/core/src/log-format.ts`，字段序写死），值走 `logEvent`；
4. 耗时用 `_ms`（渲染成 `1.2s`）、字节用 `_bytes`（渲染成 `8.1MB`）、路径用 `kind: 'path'`；
5. 不给用户命令（正文里不写「请执行 xxx」），日志只陈述事实；
6. 级别选档：纯过程信息 debug、用户操作回执 info、异常 warn、失败 error；
   审计账不折叠；同类重复用窗口折叠带 `suppressed=N`；
7. 不新增裸 `process.stderr.write`（走 `writeStderrNotice` / Logger），不新增打印密钥的日志。
