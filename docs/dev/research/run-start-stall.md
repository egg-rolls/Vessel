# 隔离 node 在 `runs.start` 之后事件循环整段僵死 · 排查记录（P0，未收口）

状态：**未归因、未修**。本文只记「已经拿到的硬事实 + 已经排除的东西 + 下一次该怎么做」，
用来避免下一个人从零重跑一遍。分支 `run-blowup`。

复现机：WSL2 / Windows 11（host `Soulkiller`），`bun 1.3.9 (Windows x64 baseline)`，
数据目录在 `D:` 盘。所有测量都在**自己起的隔离 node** 上（`--data-dir D:/tmp/run-blowup/data`，
`serve.port 8796`，假 provider 在 `127.0.0.1:8797`），没有碰 8642/8644。

## 1. 结论先说

| # | 结论 | 置信度 |
|---|---|---|
| **C1** | 现象是真的：**主线程整段僵死**（不是慢、不是排队），进程只能强杀；`/health` 超时、日志不再落地、进程内定时器全部停摆。 | 高（5 个进程复现） |
| **C2** | 僵死点落在**文件系统 await 的交界处**（`stat(wal.log)` / 读最后一块），即 timeline 写者 `flush()` 刚返回、读口刚开始读的那一刻。**不在** Vessel 任何一段 JS 循环里（那段路径上的循环逐个审过，全部严格推进）。 | 中高（两次独立 mark 二分，落点一致） |
| **C3** | 它**不是确定性的**：同一个仓库、同样命令，先在 20 分钟里连续 5 次僵死，之后 40 分钟里 60 次 run 一次都没有。⇒ 触发条件在**运行时/环境侧**，不在请求路径的输入上。 | 高 |
| **C4** | 「3–5 秒内 RSS 涨到 6.3 GB」这条**没能复现**。我实测的分配速率是 **3–7 MB/s**（WS 停在 ~700–800 MB，private ~1.2 GB，呈 GC 锯齿），按这个速率 6.3 GB 要 20–30 分钟。这一条应当作废或重新测量。 | 高（我这边口径一致） |
| **C5** | 线上真 provider / Linux 会不会踩：**未证实**。目前证据只支持「这是 Bun-on-Windows + WSL interop + `D:` 盘这一层的活锁」，但**没有**一条 Linux 上的读数来证实或证伪。 | 低（不能当结论用） |
| **C6** | 唯一能连着复现的形态：**上一单那台被反复强杀的 node 的数据目录副本**（§5.1）。把读口的 `settle` 短路掉就不再僵死 ⇒ 线索指向 `settle → flushSession → writer.flush()` 这条链；但**没定位到行**。 | 中（E1 单点实验） |

## 2. 僵死时的签名（外部可测，不需要打点）

| 指标 | 僵死时 |
|---|---|
| 主线程（进程的第 1 个线程）CPU | **1.0 s CPU / 1.0 s wall**（独占一核），其余 33–37 个线程全 idle |
| 进程内 `setInterval(100)` 的事件循环延迟探针 | 僵死后**再无输出**（连 250 ms 的采样都不再落地） |
| `/health` | 先变慢、随后超时（2.5–3 s 无响应） |
| 日志（`node.log`） | 无新行（连 `executeTurn` 入口的 debug 行都不打印） |
| 假 provider | 一次请求都没收到 |
| WorkingSet / PrivateBytes | 692→800 MB / 1.24 GB 缓慢锯齿增长（~3–7 MB/s），**不**是 6.3 GB |

采样命令（不打断现场，可重复）：

```
powershell -NoProfile -ExecutionPolicy Bypass -File D:/tmp/run-blowup/sample.ps1 -ProcessId <pid> -Seconds 30
powershell -NoProfile -ExecutionPolicy Bypass -File D:/tmp/run-blowup/threadlist.ps1 -ProcessId <pid>
```

## 3. 僵死点的二分（同步打点，打完已全部回滚）

事件循环整段停摆时异步日志一条都不会落地，唯一能推进的通道是**同步**写
（`src/trace-mark.ts`，`VESSEL_TRACE=1` 才生效；已随本单删除）。两次独立复现的尾巴完全一致：

```
[mark] eu.executeRun:loadStoredHistory:after msgs=4
[mark] lastSeq:enter main          ← execution-unit.ts 的 currentSeq
[mark] lastSeq:settled             ← 写者 flushSession()（seal+flushManifests+persistIndex）已返回
[mark] lastWalFactSeq:enter        ← read-port.ts: await stat(wal.log)
[mark] lastBlockSeq:enter          ← 同上：await lastBlockName(sessionDir)
（之后什么都没有）
```

也就是说：**`settle()` 返回之后、第一个真正需要 I/O 的 await 完成之前**，主线程进入了不可中断的状态。
对照同一台机器、同样输入的一次正常读数：

```
lastSeq:enter → lastSeq:settled → lastWalFactSeq:enter → size=6178 → window=6178
→ lastBlockSeq:enter → name=000002.wblk → read bytes=842 → decoded records=3 → lastSeq:scanned
```

## 4. 这段路径上的循环逐个审过：都不是「不推进」的那种

| 位置 | 出口条件 | 结论 |
|---|---|---|
| `read-port.ts#lastWalFactSeq` | `start===0` 返 0；窗口 `×8` 直到 `size` | 严格推进 |
| `read-port.ts#lastBlockName` | 探针 `≤32` 次、连续 3 次 `stat` 未命中即退回 readdir | 有界 |
| `wal.ts#decodeChunkBlock` | `offset = payloadEnd`；`length===0` / `payloadEnd>len` 立即 break | 严格推进 |
| `wal.ts#readFileWindow`、`writer.ts#writeAll` | `bytes<=0` 立即 return/throw | 严格推进 |
| `wal.ts#readNdjsonTail`、`writer.ts#readManifestTail` | 窗口 `×4` 到常量上界，或 `fromStart` | 有界 |
| `dual-write.ts#drainInflight`、`#drainArchives` | 集合只减不增（`.finally` 先于 allSettled 注册） | 可终止 |

## 5. 已经排除的（都做过，都否掉了）

| 试验 | 做法 | 结果 |
|---|---|---|
| 纯 Bun fs 压力 | 一个写者（append + 每 3 次 fsync + 每 5 次封块）+ 4 个读者（stat、定窗读、整文件读）15 s / 22,550 次写 | **不僵死** |
| timeline 子系统热循环 | 真代码 `createTimelineDualWrite` + `TimelineEventLog` + 广播闸门，12,320 次写 / 1,082 次 `lastSeq` / 60 s | **不僵死** |
| 高频同步打点 | launcher 里 `setInterval(10)` 的 `appendFileSync`，8 次 run | **不僵死** |
| 陈旧数据目录 / 陈旧锁 | 连续 5 轮强杀进程后**不删** data dir 再跑 | **不僵死** |
| 同一序列重跑 | 起独立 node → 等 6/20/25/30 s → run₁ → 等 4 s → run₂ → 再等 5 s 连探 3 次健康，共 8 个新进程 | **0/8 僵死** |
| 长跑压测 | 单进程 12 次 run（1.2 s 间隔）；Web 控制台式轮询（`sessions.events` 每 150 ms）+ 每 2 s 一次 `runs.start` | **不僵死** |
| 关掉广播闸门 | `timeline.dual_write: false`（本版本它只关闸门，双写端口仍开）10 次 run | 一次都没僵死（**样本太小，不算证据**） |

会话大小、datadir、日志级别、SSE vs 轮询在上一单已排除；我这边另有一条观察：僵死时**空会话**
（`messages=0`）与 4–7 条消息的会话都能踩到，与会话大小确实无关。

## 5.1 唯一一次「可重复」的现场：上一单被反复强杀的数据目录

把上一单那台 node 的数据目录 `D:/tmp/send-first/data2`（被 `Stop-Process -Force` 杀过十几轮，
目录里躺着 20 多个 `agent-owner.json.reclaim-*` 与 6,225 个块文件的会话）**拷贝一份**出来，
用隔离 node 指向副本跑：**第一次 `runs.start` 就僵死**（12:43、12:48 各一次，健康检查 000、
日志无新行），这是本单唯一能连着复现的形态。

由它做的两个实验（都只改一处、跑完已回滚）：

| 实验 | 改法 | 结果 |
|---|---|---|
| **E1** | 把读口的 `settle`（`tenant-runtime-factory.ts` 里那句 `timelineDualWrite.flushSession`）临时短路成 `return` | **不僵死**（同一份数据目录、同一条命令） |
| **E2** | 保留 `settle`，在 `writer.flush` / `sealPendingBlock` / `flushManifests` / `publishRecord` / `deliverPublication` / `gate.settle` 全程加同步打点 | 那一次**没僵死**（打点把时序改了），但正常读数显示 flush 全链 ≤ 3 ms 完成 |

同一份数据的三次「反例」也很重要（都**不**僵死）：

- `robocopy /E` 拷出来的**逐字节相同**副本（保留 mtime）；
- `cp -r` 被超时打断的**残缺**副本（`.locks` 都没有）；
- 只留 `agents/` + 目标会话 + `main` 的**极简**副本（5 KB）。

⇒ 结论（保守表述）：僵死**与「上一次是被强杀收场的」这类数据目录状态相关**，
而且被一次成功的 `flush` 「消费掉」（同一份副本上跑过一次之后就不再复现）；
但它还**依赖时序**，所以不是「某个文件坏了就一定僵死」。这条线索指向
`settle → flushSession → writer.flush()` 这条链及其后续的发布扇出，**但没能定位到行**。

## 6. 为什么我认为方向在环境侧（而不是 Vessel 逻辑）

1. **不确定**：同一输入、同一命令序列，先 5/5 必死，后 60 次全好。Vessel 层的死循环不会这样。
2. **不可中断**：僵死时 `--inspect` 对 `Runtime.enable` / `Debugger.pause` **一个回包都没有**；
   用「故意 `for(;;)` 的纯 JS 死循环」做校准，表现**一模一样**（所以这条只能说明主线程进了一个
   不检查中断的状态，**不能**用来区分 JS 与原生）。
3. **落点永远在 fs await 边界**，而不是某段 JS 的中间；那段 JS 里没有任何「不推进」的循环（§4）。
4. 这台机器上同类症状历史上出现过：0.55 §6.3 第 4 条当时记的就是「打点副作用」。
   **现在看，那个直觉可能指对了方向** —— 不是打点写错了什么，而是打点改变了 fs 的调用节律。

反过来，**不能**据此宣布线上安全：Linux 没测，真 provider（长连接 SSE、慢 chunk）也没测。

## 7. 复现脚本与命令（都在 `D:/tmp/run-blowup`，不进仓库）

| 文件 | 作用 |
|---|---|
| `cfg.yaml` / `cfg-sendfirst.yaml` | 隔离 node 配置：`serve.port 8796`、`token_env`、`provider.base_url=http://127.0.0.1:8797/v1` |
| `fake-provider.ts` | 假 provider（`127.0.0.1:8797`，OpenAI 兼容 SSE，3 个 content 帧 + finish + `[DONE]`） |
| `launcher.ts` | 隔离 env（`USERPROFILE`/`VESSEL_DATA_DIR`/`VESSEL_LOG_LEVEL=debug`）+ 进程内 RSS/延迟采样，再 `import src/cli.ts` |
| `launcher-nosample.ts` | 同上但**完全不打点**（用来排除打点自身的影响） |
| `launcher-sf.ts` / `launcher-e1.ts` / `launcher-e2.ts` / `launcher-f1.ts` / `launcher-f2.ts` | 指向「上一单那台反复被强杀的 node」的数据目录副本（`data-sendfirst` / `data-e1` / `data-e2` / `data-f1` / `data-f2`） |
| `trial3.ts` | 统计用：起干净 node → 等 → run₁ → 等 → run₂ → **等 5 s 再连探 3 次**（探早了会漏） |
| `trial4.ts` | Web 控制台式：后台轮询 + 定时 `runs.start` |
| `iso3.ts` | 只装 timeline 双写 + 读口的热循环（子系统级复现） |
| `fsstress.ts` | 纯 Bun fs 压力（运行时级复现） |
| `sample.ps1` / `threadlist.ps1` / `listp.ps1` / `killp.ps1` | 外部采样 / 线程级 CPU / 列与本单 PID / 按 PID 杀 |

起停（现成的就是 `trial3.ts`）：

```
cd D:/Application/APP/Vessel/worktrees/run-blowup
bun run D:/tmp/run-blowup/fake-provider.ts &
bun run D:/tmp/run-blowup/launcher.ts node start --config D:/tmp/run-blowup/cfg.yaml
curl -s -XPOST localhost:8796/v1/rpc -H 'authorization: Bearer test-token-8796' \
  -H 'content-type: application/json' -d '{"v":1,"id":"1","method":"runs.start","params":{"input":"hi"}}'
```

## 8. 下一次该抓什么（按代价从低到高）

1. **装一个能给原生栈的东西**：`cdb.exe`（Windows SDK Debuggers）或 `procdump -ma`。
   这个状态下**只有原生栈有用** —— JS 侧（inspector）进不去，日志不落地。拿到主线程栈就能立刻
   分清是 Bun 的 fs 层还是 JSC 在执行某段编译后的循环。
2. **换平台验伪**：同一序列在 Linux 上跑 `bun`（本机的 bun 是 Windows 二进制，没法用
   `perf`/`gdb` 附加，连 `/proc/<pid>/status` 里的 RSS 都没有意义）。Linux 上复现不了，
   基本可以判定为 Bun-Windows 层问题并摘掉这条 P0。
3. 若必须在本机定位：手边现成的入口是 §5.1 —— 用 `D:/tmp/send-first/data2` 的**新副本**
   （每次都要新副本，成功 flush 一次就不复现了）起隔离 node，先 `Profiler.start` 再触发
   `runs.start`，僵死后**强杀**，看能否拿到 `.cpuprofile`。
4. 沿 §5.1 的线索继续二分（E1 已经指向 `settle` / `flushSession`）：把
   `drainInflight` / `writer.flush` / `sealPendingBlock` / `deliverPublication` 的
   **每一条** await 前后都放同步打点（不是只放在函数首尾），跑新副本，看最后一条打点是哪。
5. 现场保底措施（不管归因如何都值得做）：托管进程给 node 加**外部** watchdog（父进程探
   `/health`，连续 N 次超时即 restart）—— 这个僵死状态内部**没有任何手段自救**（定时器都不跑）。

## 9. 本单没做的事（别当成做过）

- 没有修任何产品代码：**没有找到可归因的行**，按纪律不猜着改。
- 没有给「修前/修后 RSS 上限 + `/health` 可用性」的对照读数（没有修，也就没有修后）。
- 没有在 Linux / 真 provider 上跑过。
