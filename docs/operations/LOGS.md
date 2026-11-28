---
title: 运维日志口径（一件事只有一种说法）
kind: current
triggers: [日志, log, 日志一致性, web.build, 构建, 构建日志, build.json, gateway status, 看门狗, supervisor, hub, console.log, logEvent, 事件行, key=value, 日志级别, 颜色, 降噪, log-hub, stop.forced, drain, shutdown.step]
paths: [src/gateway/web-dist.ts, src/cli/commands/gateway/gateway-command.ts, src/cli.ts, src/observability/logging.ts, packages/core/src/log-hub.ts, packages/core/src/log-format.ts, packages/serve/src/log-event.ts, packages/serve/src/platform/proxy.ts, packages/serve/src/platform/proxy-config.ts, packages/serve/src/platform/proxy-ws.ts, packages/serve/src/platform/server.ts, packages/serve/src/gateway.ts, src/gateway/node-supervisor.ts, src/update/gateway-check.ts]
---

# 运维日志口径：一件事只有一种说法

> 本文是日志事实的**盘点表 + 权威来源**。改日志前先在这里找到那一行，只改权威来源，别在别处补一句「顺便说一下」。

## 1. 规则（唯一一条）

**每个事实只有一个权威来源；其它地方只能从它派生，不许各自拼文案。**

- 权威 = 一条事件行（`log-format.ts` 的 `EVENT_FIELDS` 定字段序）或一份内存态；
- 派生 = 读同一份状态，再用**同一个** `formatEventLine` 排版；
- 排版只有一处：`packages/core/src/log-format.ts`（单行 key=value；`serve/log-event.ts` 只是 re-export + 转发）；
- 级别 / 脱敏 / 格式 / 时间 / 颜色只有一处：`packages/core/src/log-hub.ts`（进程级日志中枢）。core Logger、serve `logEvent`、插件注入的 Logger 三路都经 `emitLogLine`（过滤 → 脱敏 → 排版 → `writeStderrNotice`）；**不新增裸 `process.stderr.write`**（EPIPE 自激防护不变量见该文件头）。

「措辞」不指语言（中英各有 i18n），指**同一条事实在日志/接口/UI 上的字段与说法**。

### 1.1 日志级别与颜色（日志中枢）

- 行格式（pretty，vite 式单行）：`时间 LVL 事件名(列宽24) key=value...`，如 `12:03:41 WRN gateway.ws.closed node=Soulkiller who=upstream code=1011 dur=202s`。无 `[vessel]` 前缀；json 格式（`format: json` / `VESSEL_LOG_JSON=1`）为单行 `{time, level, event, ...fields}`（机器接口）。
- 级别：`observability.log.level`（debug|info|warn|error，缺省 info）+ `modules`（事件名前缀→级别，最长前缀匹配）。优先级：`VESSEL_DEBUG` > `VESSEL_LOG_LEVEL` > `VESSEL_RUN_TIMING=1`（仅 run.* 强制）> config > 默认。热应用：改 config 不重启即生效，差异行进 `runtime.notice`。
- 颜色：`color` auto/always/never；`NO_COLOR`（任意值）/ `TERM=dumb` 优先关闭，`FORCE_COLOR` 非 0 强制开；auto 看 `stderr.isTTY`（daemon 落盘天然无 ANSI）。`COLORTERM=truecolor/24bit` 上 24bit，否则 16 色。配色表见宪法第十四条。
- 时间：`time` auto/none/clock/iso；auto = TTY 用 clock（HH:MM:SS）、落盘用 iso。
- 脱敏统一在 `emitLogLine`（先脱敏再排版，pretty/json 同一路径）；`logEvent` 也在内。不提供 trace 级或「显示原值」开关。
- 降噪口径：高频过程事件降 debug（不删除）；审计账（`gateway.ws.closed`）不折叠、只分级；同类重复按窗口折叠带 `suppressed=N`，折叠在**发起方**实现：`gateway.ts` 的 `gapLogFold`（gap_reported 同 session 60s，只折叠日志行、诊断面板不折叠）、`update/gateway-check.ts`（update.check.failed 1h）。

## 2. 权威来源盘点表

| 事实 | 权威来源 | 备注 |
|---|---|---|
| Web 产物在不在建 / 成没成 / 为什么失败 / 日志在哪 | `web.build.*` 事件 + `webDistBuildState()`（内存）+ `<tmp>/vessel-web-build/<ts>-<pid>/meta.json`（跨进程读的那一份） | 启动横幅不打自然语言构建句；`/build.json` 的 `build{}` 段与 `gateway status` 的 `web.build.running/last` 行都从同一份状态派生 |
| Web 产物是否落后于源码（stale） | `inspectWebDist()`（判据唯一） | 横幅 / 机器字段 / 一行诊断三处共用；显式静态目录解析 `web-dist.ts:explicitWebDistDir`：`gateway.web_dist` config > `VESSEL_STATIC_DIR` env，外部产物只报存在性 |
| 构建被中断 / 硬死留下临时目录 | `web.build.interrupted`、`web.build.stale_artifact` | Windows 没有可捕获的 SIGTERM，「宿主已死」的那次由停止方（`gateway stop`）代打；宿主自己能说时停止方闭嘴 |
| 看门狗动作（僵死重启 / 放弃 / 恢复） | `EVENT_FIELDS` 的 `supervisor.*` + `logEvent` | `gateway status` 的看门狗快照段读状态快照，与动作事件是两个事实 |
| Hub 起没起来 | `hub.start_failed` 事件（启动与收尾同一套字段） | 成功行只在横幅（人读的位置），不重复打日志 |
| 节点就绪状态 | supervisor 状态机（`SupervisedNodeInfo`）；`gateway-command.ts:describeNodeState` 单一口径 | `up/down` 是健康探测，与 supervisor 生命周期是两个事实，状态词表按视图不同 |
| 平台/节点 token | 不打印（`AGENTS.md` 硬安全规则）；派生值只进 `/health` 布尔 | `src/node/token-derive.ts` |
| 拦截类诊断 | `gateway.replay.budget_truncated`、`gateway.events.global_replay_denied`、`gateway.stop.failed`、`gateway.tenant_hub.failed`、`interactions.store.*`、`interactions.registry.reload_failed` | 全部走 `logEvent`，`path`/`error` 结构化字段 |
| 停止没走成优雅路径（drain 回退） | 停止方代打 `node.drain.skipped`（`gateway-command.ts:stopGateway`、`src/gateway/node-supervisor.ts:stopSpawnedChildren` / `NodeSupervisor.stop` 回调、`node-command.ts:runNodeCommand`）与 `platform.drain.skipped`；字段 `pid`/`name?`/`reason` | **未登记 `EVENT_FIELDS`**；证据同时持久化到目标实例日志。停止语义见 [gateway-lifecycle](../architecture/gateway-lifecycle.md) / [GATEWAY](GATEWAY.md) |
| force 非正常退出审计 | 停止方代打单行结构化 `stop.forced`（`gateway-command.ts`，字段 abnormal_exit / runs_cut / sessions / runs / signal），持久化到 node 子进程日志 | 与人类汇总（i18n `stop.forced.summary`）分离；**未登记 `EVENT_FIELDS`** |
| 退出链步骤级进度 | `node.shutdown.step`（node / 平台 / serve 共用同一事件名，已登记 `EVENT_FIELDS`） | 挂起时最后一条 start 就是挂点；done 带 `dur`；`server.stop` 的 start 行带 `pending_requests`/`pending_ws`/`proxy_ws_live`/`proxy_ws_closed`/`aborted_inflight` 诊断（Bun server-initiated close 计数泄漏，差值归因真实残留） |
| 平台代理 node 的失败记账 | `platform/proxy.ts`（`PlatformProxy`）：`gateway.proxy.rpc_denied`（方法不在白名单）、`node_timeout` / `node_unreachable`（带 `timeout_ms`，缺省见 `proxy-config.ts:DEFAULT_PLATFORM_PROXY_LIMITS`）、`node_body_failed`、`failed`；WS 关闭记账 `gateway.ws.closed {via:'proxy'}` 在 `proxy-ws.ts` | 白名单按命名空间（含 kanban / jobs / images 等只读面），缺命名空间 fail-closed 成 `rpc_denied`；`node_body_failed` **未登记 `EVENT_FIELDS`**。代理现态见 [topology](../architecture/topology.md) |

## 3. 怎么读一次构建（`web.build.*`）

一次构建**最多 4 行**（start + 可选 progress + 终态 + 可选内联尾部）：

```
12:03:41 WRN web.build.start    reason=stale target=apps/web check=timer pid=64180 log=/tmp/vessel-web-build/1794910725789-41008/build.log
12:04:11 WRN web.build.progress elapsed=30s rss=180MB    # 可选：<30s 的构建一条都不打，最多 2 条
12:04:28 WRN web.build.done     dur=17.2s assets=42 bytes=8.1MB
12:04:28 WRN web.build.fail     exit=2 dur=1.4s log=/tmp/vessel-web-build/…/build.log
| … 省略前 6 行（完整输出见上面的 log= 路径）
12:04:28 WRN web.build.interrupted signal=stop elapsed=6.1s log=/tmp/vessel-web-build/…/build.log
12:04:28 WRN web.build.stale_artifact cleaned=1 dir=/tmp/vessel-web-build
```

（`web.build.*` 全部 warn 是既有口径；TTY 才有 clock 时间与颜色，落盘是 iso 时间、无 ANSI。）

- `reason=missing|stale`：产物完全没有 / 落后于源码；
- `check=startup|probe|timer`：谁叫起来的这次构建；三条入口共用同一套判据与互斥，出问题先看这个字段；
- 终态三种：`done`（成功）、`fail`（失败，附 ≤15 行尾部，每行 ≤160 字）、`interrupted`（被打断，子进程整树已杀）；
- `progress` 的 `rss=` 只在能读到构建进程树的平台出现（Linux 读 `/proc`）；读不到就不打，绝不用网关自己的内存冒充；
- `stale_artifact` 只出现在启动时：上次被硬杀留下的临时目录，清掉一行总账；
- 构建完整输出始终在 `log=` 指向的文件里（临时目录，保留 7 天）。

`gateway status` 的构建段（跨进程读同一份 `meta.json`；命令结果面走 `formatEventLine` 事件行本体：无时间/级别前缀、无颜色）：

```
  web.build.running elapsed=6.1s pid=64180 log=…
  web.build.last phase=done dur=17.2s at=2026-11-17T10:23:34.409Z log=…
```

### 3.1 运行中自愈：没人开浏览器也会重建

| 触发来源（`check=`） | 什么时候 | 说明 |
|---|---|---|
| `startup` | gateway 启动时 | 只跑一次；产物缺失时等它建完再起平台（fail-fast 不接受半成品） |
| `probe` | 有人请求 `/build.json` 且判到 `stale` | 浏览器轮询/SSE 就会碰到；请求本身不打日志 |
| `timer` | 平台侧低频定时器（缺省 60s） | 完全不开浏览器时唯一能自愈的那条；定时自查本身不打日志 |

三条入口共用同一套判据（`inspectWebDist`）、同一个互斥（`inFlightBuild`）与 60s 限频；每次构建都记 `check=`。开关（语义唯一来源 `webAutoBuildMode`）：

| 环境变量 / 配置 | 效果 |
|---|---|
| `VESSEL_WEB_AUTOBUILD_CHECK_MS` | 自查间隔，缺省 60000，下限 5000 |
| `VESSEL_WEB_AUTOBUILD=startup` | 只在启动时建；运行中不再自查 |
| `VESSEL_NO_WEB_AUTOBUILD=1` | 全关：启动也不建、运行中也不查 |
| `gateway.web_dist` config > `VESSEL_STATIC_DIR` | 指向外部产物时三档一律不接管（外部产物不归我们建） |

## 4. `console.*` 的判定（`grep -rn "console\." src packages/serve/src --include=*.ts` 后逐个判断）

保留的三类（其余一律 `logEvent`）：

1. **短命命令的结果通道** —— `print` / `printErr` 的缺省实现（`gateway status` 的表格等）、`headless-runner.ts` 的 `[vessel] …` run 结果行（等人回答 / 去哪看记录 / resume 命令）与 `ask-answer-delivery.ts` 的异步投放失败提示：进程马上退出，没有第二个副本，不是日志事件；
2. **日志中枢自己的出口**（`log-hub.ts:writeStderrNotice`，全进程唯一 stderr 写点，带 EPIPE 报废保护）；
3. **外来文本的转发** —— auth 后端告警（`platform/server.ts` 的 `[platform-auth]`）：正文不归我们控制，加前缀只会重复。

不受 `observability.log` 约束的两处：**外部插件自己写的 console**（信任边界，不拦截）；**插件子进程** stdout 是 NDJSON-RPC 通道、stderr 原样写 `<dataDir>/logs/plugin.log`（`plugin-host/child.ts`，1 MiB 轮转），不进 console。内置插件的过程日志走注入的 Logger。

## 5. 改日志的检查清单

1. 这个事实在本文的表里有行吗？没有先加一行（权威来源是谁）；只改权威来源，派生方读状态，不复制字符串；
2. 新事件名进 `EVENT_FIELDS`（字段序写死），值走 `logEvent`；耗时用 `_ms`（渲染成 `1.2s`）、字节用 `_bytes`（渲染成 `8.1MB`）、路径用 `kind: 'path'`；
3. 不给用户命令（正文里不写「请执行 xxx」），日志只陈述事实；
4. 级别选档：纯过程信息 debug、用户操作回执 info、异常 warn、失败 error；审计账不折叠，同类重复用窗口折叠带 `suppressed=N`；
5. 不新增裸 `process.stderr.write`（走 `writeStderrNotice` / Logger），不新增打印密钥的日志。