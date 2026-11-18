---
title: Bun 段错误（win32）取证 runbook：gateway 崩了之后收集什么、先看哪一行
kind: current
triggers: [segfault, 段错误, panic, bun.report, gateway 崩溃, 崩溃, crash, runbook, 取证, Segmentation fault, 0xFFFFFFFFFFFFFFFF, 资源采样, gateway.resources, VESSEL_RESOURCE_SAMPLE_MS, proxy, passthrough, pump, crc32]
paths: [docs/operations/**, packages/serve/src/platform/proxy.ts, packages/core/src/timeline/wal.ts]
---

# Bun 段错误（win32）取证 runbook

> 适用版本：0.58+（含本页落地的两项加固：代理流式转发改原生直通、时间线 crc32 在 win32
> 缺省走表驱动）。已知崩溃的根因与最小复现见 §5。

## 1. 先分清「谁崩了」

`panic(main thread): Segmentation fault …` 是**进程级**的：那个 bun 进程立刻没了，
它下面的子进程（node / hub）不会被一起杀掉，所以现场常常是「gateway 没了，node 还在」。

| 症状 | 崩的是 | 日志在哪 |
| --- | --- | --- |
| 控制台/终端出现 `panic(main thread)`，8642 打不开，8644 还能连 | 平台网关（`vessel gateway start`） | **前台启动时只在你那个终端里**；`--daemon` 时在 `<dataDir>/logs/gateway.log` |
| 某个 node 的会话全断，平台还能开 | 该 node 进程 | `<dataDir>/logs/node-<名字>.log` |
| `gateway.log` 里出现多次「Gateway 已启动（pid …）」 | 网关在反复重启 | 同上 |

**第一件事：把终端里的 panic 原文整段留档**（见 §2 第 1 项）。前台启动的 gateway 的
stdout/stderr 不落盘，这段文字**只存在于那个终端滚动缓冲里**——它一关就永远没有了。

## 2. 必须收集的五样东西

1. **panic 原文**（从 `Bun v1.3.9 …` 到 `https://bun.report/…` 一行都不漏）。
   里面的 `bun.report` 链接是**崩溃指纹**：两个不同崩溃的指纹前缀不同，同一个崩溃的指纹
   几乎逐字相同。本次事故的指纹是
   `https://bun.report/1.3.9/ea1cf6cdbbiD+hooCytjvvDstq9bq+r9eq2q9e___A2DD`。
2. **最后 30 行日志**（对应进程的）：
   ```bash
   tail -n 30 "<dataDir>/logs/node-<名字>.log"
   tail -n 30 "<dataDir>/logs/gateway.log"
   ```
3. **资源采样曲线**（0.58 起有）：`gateway.resources` 每 60 秒一行（§3）。
   ```bash
   grep -c "gateway.resources" "<dataDir>/logs/gateway.log"
   grep "gateway.resources" "<dataDir>/logs/gateway.log" | tail -n 20
   ```
   看三件事：`rss_mb` 是不是**单向上升**（泄漏）还是窄带抖动（正常）；
   `ws_active` / `ws_pending` 有没有堆积；`mode=` 是 `pump` 还是 `passthrough`。
4. **崩之前 10 分钟在做什么**：`<dataDir>/data/events/<run_id>.jsonl` 的最后几条
   `tool.call.completed`（工具名 + 命令）就是「当时在干什么」。
5. **pid 与时间**：`<dataDir>/platform-children.json`（子进程 pid + `started_at`）、
   `<dataDir>/platform-watchdog.json`、`<dataDir>/gateway.pid`。用来对齐 panic 里的
   `Elapsed:`（例如 `Elapsed: 6158418ms` = 该进程活了 102 分 38 秒）。

**别做的事**：不要为了「复现」直接拿真实数据目录起实例。0.58 那批复现 / 压测探针一律只监听
`127.0.0.1` 的随机端口、数据只落系统临时目录，从不碰 8642/8644/真实数据 —— 将来要重新验证也
得守同一条边界（探针本身已按宪法删除，结论见 §6）。

## 3. 资源采样（0.58 新）

平台网关每 60 秒打一行（`VESSEL_RESOURCE_SAMPLE_MS` 改间隔，`=0` 关掉）：

```
gateway.resources uptime_s=3600 rss_mb=184 heap_mb=42 http_requests=5697 http_failures=3
http_inflight=4 passthrough=12 mode=passthrough ws_active=2 ws_pending=0
```

**怎么读**：
- `rss_mb` 单调上升且不回落 → 真的泄漏，先按泄漏查（`heap_mb` 同步涨 = JS 侧；
  只有 `rss_mb` 涨 = 原生侧）。
- `rss_mb` 在窄带里抖、崩的时候也不高 → **不是内存问题**，是某条原生调用踩空。
  本次事故就是这样：崩的时候 `RSS: 0.18GB`，正好是空进程的基线。
- `mode=pump` → 你跑的是**已知会崩**的流式转发实现（§5），先按 §4 切回去。

## 4. 现在就能做的两条开关

两个开关都是**进程启动时读一次**，改完必须重启对应进程。

| 开关 | 取值 | 作用 |
| --- | --- | --- |
| `VESSEL_PROXY_HTTP_STREAM` | `passthrough`（win32 缺省）/ `pump` | 代理 HTTP 流式转发走「原生直通」还是「手写泵」。`pump` 在 win32 上有可复现段错误 |
| `VESSEL_CRC32_NATIVE` | `0`（win32 缺省）/ `1` | 时间线块 crc32 走表驱动还是 `node:zlib` 原生实现。两者结果逐位相同 |

**在 WSL 里设环境变量对 `bun` 无效**：`bun` 是 Windows 进程，它看到的是 Windows 的进程环境，
WSL 那边 export 的变量读不到（实测传进去是 `undefined`）。要么在 **Windows 侧**设
（`set` / `$env:` / 系统环境变量面板），要么在启动那个 Windows 进程之前，把变量显式写进它
自己的进程环境（0.58 当时用一层透传包装做过这件事，那个包装脚本已按宪法删除）。

## 5. 已知崩溃：代理 HTTP 流式转发（win32，Bun 1.3.9）

**最小触发**（形态描述；当年那份最小复现探针已按宪法删除，跑起来 0.4–1.5 秒必崩）：

1. `Bun.serve` 的 fetch 处理器返回一个**手写 `ReadableStream`**，它的数据源是
   `(await fetch(url)).body.getReader()`；
2. 浏览器/客户端在**上游流还没结束**时断开（关标签页、导航、`AbortController.abort()`）。

地址恒为 `0xFFFFFFFFFFFFFFFF`（= `(uintptr)-1`），bun.report 指纹与本次生产事故几乎逐字相同：

| 场景 | 结果 |
| --- | --- |
| `fetch()` + `reader.cancel()`，不经 `Bun.serve` | 30 秒不崩 |
| 手写泵，但**不当** `Bun.serve` 的响应体 | 30 秒不崩 |
| 手写泵**当**响应体 + 客户端中途取消 | **0.4–1.5 秒崩** |
| 手写泵 + 「取消后不碰 controller」的守卫 | **仍然崩** |
| `pipeThrough(TransformStream)` | 不崩，但请求会挂住（不可用） |
| `new Response(upstream.body)` 原生直通 | 不崩 |
| 原生直通 + `req.signal → controller.abort()` | 不崩（本次采用） |

**加固（0.58）**：win32 缺省改为原生直通，并先把「声明了长度且 ≤ 1 MiB」的响应整份读完
（代理流量的绝大多数是 JSON），把竞态窗口压到最小。加固后做过一次语义自证，读数是：
SSE 仍逐步到达（首条 <400ms、5 条摊在 ~800ms 上）、JSON 与上游逐字节相同、3 MiB 响应仍是
分 50+ 块到达（不是整份缓冲）—— 这三条就是「换成原生直通没有把流式语义弄丢」的证据。
（自证探针已按宪法删除，读数留在这里。）

## 6. 复现与读数：只留结论

> 0.58 当时用来取证 / 压测的那批探针与脚本，已按宪法第三、四条（测试与探针一律不进仓库）
> 删除，**不再提供任何可执行的复现入口**。这一节只留它们跑出来的结论，让后人知道
> 「哪些形状已经被证过、读数是什么」，而不是重新造一套探针从零再证一遍。

- **代理流式转发**：把「手写泵当 `Bun.serve` 响应体 + 下游中途取消」这个形状单独压到
  0.4–1.5 秒必崩（§5）；同一形状改成原生直通后不再崩。
- **crc32 两条实现**：`node:zlib` 原生与表驱动对同一份数据逐位相同（含 `subarray` /
  `byteOffset` 的切片），差异只在耗时（§8.4）。
- **时间线块写入 + 校验**、**平台 WS 桥 1 MiB 帧**、**`write` 工具三态写入**：各 5 分钟
  单独压，一次都没崩，读数见 §8.3（含 RSS 曲线与 per-connection 成本）。
- **代理 HTTP 流 + 下游中止**：改前 10 秒内 `panic`，改后不再崩（§8.3 表格 D 行）。

当年那批脚本的运行约束（将来要重做验证也得守）：只监听 `127.0.0.1` 随机端口、数据只落
系统临时目录，不碰 `~/.vessel`、8642、8644。

## 7. 交给 Bun 那边时需要什么

一个 issue 需要三样：`bun.report` 链接（就是 panic 最后那行）、**一份不依赖本仓业务代码的
最小复现**（§5 的两步形状自己写十几行就能重造：`Bun.serve` 的 fetch 处理器返回一个源自
`(await fetch(url)).body.getReader()` 的手写 `ReadableStream`，再让客户端中途取消 —— 本仓
当年那份探针已按宪法删除）、以及 `bun --version` + `uname`/`ver`。本仓这次的对应 issue 类型是
「`Bun.serve` served `ReadableStream` sourced from `fetch().body` + downstream cancel
⇒ segfault at 0xFFFFFFFFFFFFFFFF」。

## 8. 本次事故的取证存档（0.58，win32-x64，Bun 1.3.9）

### 8.1 panic 原文（用户终端，逐字）

```
Bun v1.3.9 (cf6cdbbb) Windows x64 (baseline)
Args: ...vessel-agent/src/cli.ts gateway start
Features: Bun.stderr(2) Bun.stdin(2) Bun.stdout(2) WebSocket(21) abort_signal(3048) fetch(5697)
          http_server jsc spawn(6) transpiler_cache(25) tsconfig(21)
Elapsed: 6158418ms | User: 83062ms | Sys: 67265ms
RSS: 0.18GB | Peak: 0.46GB | Commit: 0.93GB | Faults: 1103792 | Machine: 51.14GB
panic(main thread): Segmentation fault at address 0xFFFFFFFFFFFFFFFF
 https://bun.report/1.3.9/ea1cf6cdbbiD+hooCytjvvDstq9bq+r9eq2q9e___A2DD
```

**关键读数**：`RSS: 0.18GB` —— 这就是空进程的基线（本次所有压测脚本的起始 RSS 也在
0.16–0.20GB）。**崩的时候没有涨内存**，所以这不是「泄漏到爆」，是某条原生调用踩空。
`Faults: 1103792` 除以 6158 秒 ≈ 179 次缺页/秒，对这个规模的进程正常。

### 8.2 最后 30 行日志（`<dataDir>/logs/node-Soulkiller.log`，第 112697–112726 行）

崩的是平台网关（8642），它前台启动、**stdout 不落盘**，所以没有它自己的最后 30 行；
下表是同一时刻它唯一有落盘的子进程（node `Soulkiller`，8644）的尾部，用来回答
「崩的时候系统在干什么」。节选（重复的 `web_search 未注册` 提示行按行号标注省略）：

```
112697 [vessel] basic-tools: bash job 106a4404 started in background (wake delivery: wired)
112698 {"time":"2026-11-17T08:58:27.146Z","level":"info","message":"agent.bash_job.delivering",…"elapsed_ms":40450…}
112699 {"time":"2026-11-17T08:58:27.155Z","level":"info","message":"agent.bash_job.delivered",…"exit_code":0…}
112700 {"time":"2026-11-17T09:00:27.761Z","level":"warn","message":"update.check.failed","fields":{"error":"The operation timed out."}}
112701 [vessel] gateway.ws.closed {
112702   conn_id: "66193386",
112703   close_by: "client",
112704   close_code: 1006,
112705   session_id: "09f82ac6-82fc-4dcc-9693-a4991d663863",
112706   timeline_epoch: true,
112707   frames_sent: 12900,
112708   bytes_sent: 19538268,
112709   epochs: 15,
112710   backpressure_drops: 0,
112711   last_seq_sent: 129890,
112712   duration_ms: 3561588,
112713   buffered_bytes: 0,
112714 }
112715 …（web_search 未注册提示，重复行）
112716 {"time":"2026-11-17T09:10:51.717Z","level":"info","message":"agent.bash_job.delivery_ready","fields":{}}
112717 {"time":"2026-11-17T09:10:51.737Z","level":"warn","message":"agent.snapshot.duplicate_name","fields":{"name":"ask-batch",…}}
112718 {"time":"2026-11-17T09:10:51.738Z","level":"warn","message":"agent.snapshot.duplicate_name","fields":{"name":"ctx-truth",…}}
112719 {"time":"2026-11-17T09:10:51.738Z","level":"warn","message":"agent.snapshot.duplicate_name","fields":{"name":"read-path",…}}
112720 {"time":"2026-11-17T09:10:53.704Z","level":"info","message":"agent.resume.recover_done","fields":{"marked":9,"skipped":9,…}}
112721 {"time":"2026-11-17T09:11:01.098Z","level":"warn","message":"session liveness sweep","fields":{"repaired":4,"errors":0}}
112722 Vessel Gateway 0.54.0 · http://127.0.0.1:8644
112723 Gateway 运行中… 按 Ctrl+C 停止。
112724 （空行）
112725 [vessel] gateway.ws.closed conn=879ff54c who=client code=1001 dur=3.6s out=1 bytes_sent=733B epochs=1 last_seq=0
112726 {"time":"2026-11-17T09:13:55.970Z","level":"info","message":"image blob gc pass","fields":{"line":"image blob gc (dry-run): would delete 0 / 1 blobs …"}}
```

**怎么读**：
- 09:00:27 有一条 **59 分钟**的 WS 连接以 `1006`（异常断开、无关闭帧）收尾；
  `backpressure_drops: 0`、`buffered_bytes: 0` —— 不是平台这边掐的，是**客户端那头消失**。
  这正是 §5 那个触发条件的形状：**下游没了，上游还活着**。
- 09:10:44 起网关重启过一轮（新的 node 子进程 + 新 pid），09:11:01 节点自报 `repaired:4`：
  **网关在那之前已经死过一次**。`<dataDir>/logs/gateway.log` 里 44 行里 6 条
  「Gateway 已启动（pid …）」是同一件事的记账。
- 最后一行是 60 分钟一次的图片 blob GC（正常节拍），说明**日志不是被截断的**，
  而是进程在它之后就没有再写下一条 —— 秒级内被杀，来不及说话。

### 8.3 三条压力路径的读数（各 5 分钟，单独跑，只本机回环）

| 路径 | 规模 | 结果 | RSS（起 → 峰值 → 终） |
| --- | --- | --- | --- |
| A 块写入 + crc32（160 KB 块） | 323,584 条 / 1293.6 MB / 8298 块 | **没崩**，0 坏块，`RESULT ok` | 201 → 239 → 268 MB（写入期在 218–239 之间来回，无单向上升） |
| B 平台 WS 桥（12 连接 × 1 MiB 帧，双向） | 5,356 次回显 / 上行 6,955 MB / 下行 5,305 MB | **没崩**，0 错误，24 次关闭全部按 `1001` 记账 | 165 → 709（~80 s 处平台期）→ 196 MB |
| C `write` 工具（create/overwrite/append，8 KB） | 32,832 次调用（3×10,944） | **没崩**，0 错误，109 调用/秒 | 332 → 347 MB（+15 MB，5 分钟内线性+4.5%） |
| **D 代理 HTTP 流 + 下游中止** | 6–8 连接，读 3–6 块就断 | **10 秒内 `panic: Segmentation fault at 0xFFFFFFFFFFFFFFFF`** | 234 MB（崩时，= 基线） |

A 的读侧（`readAllBlocks`）把整份 1.3 GB 读进内存，峰值 1.99 GB —— 那是 `readAllBlocks`
「全量解码」的既有形状（只用于校验/重建），不是写入路径的泄漏；**要留意**：在 1 GB 级会话上
调用它本身就是一次内存放大器。

B 的峰值 709 MB（12 条 1 MiB 帧连接）值得记一笔：**约 40 MB RSS / 连接 @1 MiB 帧**，
而 `wsHighWaterBytes` 只有 1 MiB、全局预算只有 64 MiB —— 也就是说真正吃内存的是 Bun 自己
的 socket/泵缓冲，不是我们的队列（`ws_pending` 全程为 0）。**如果哪天要把 `wsMaxConnections`
从 32 往上调，先按 40 MB/连接算一遍**；反过来，本次没有测到任何「队列堆积 / 背压不生效」
的证据，所以没有动这几个常量（收紧会误杀慢客户端，证据不足就不改）。


### 8.4 加固前后：crc32 的成本（同一份 302.8 MB / 1894 块数据，A/B 两次）

| 实现 | 1894 块重算总耗时 | 每块（p50 = 164 KB） | 坏块 |
| --- | --- | --- | --- |
| 表驱动（`for…of` 旧写法） | 15.13 s | 7.99 ms | 0 |
| 表驱动（下标循环，本次改） | 2.08 s | 1.10 ms | 0 |
| `node:zlib` 原生 | 1.21 s | 0.64 ms | 0 |

**结论**：win32 上关掉原生 crc32 的真实代价是 **+0.46 ms / 164 KB 块**，不是 1–2 ms。
另外顺手发现真正的慢点不是「没有原生实现」，而是 `crc32Update` 用 `for…of` 遍历
`readFile()` 返回的 `Buffer`（慢 7 倍）；换成下标循环后表驱动已经够快，语义一字未改
（同一份数据在两种实现下都校验通过，0 坏块即是逐位相同的证明）。

