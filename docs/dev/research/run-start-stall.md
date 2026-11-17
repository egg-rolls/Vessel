# `runs.start` 之后事件循环整段僵死 · 根因与修复（P0）

状态：**已归因、已修**。分支 `run-blowup`。

一句话：**日志 sink（stderr/stdout）写失败（EPIPE）被升级成 `uncaughtException`，而进程级错误处理器
第一件事又是写日志 —— 于是「写失败 → 异常 → 处理器再写 → 再失败」自激成无界循环**，主线程被占满：
事件循环不再转动（定时器全停、`/health` 超时、日志不再落地），每轮构造 Error + 栈字符串使 RSS 持续上涨。

## 1. 现象与读数（隔离 node，假 provider，`--data-dir` 指向副本，未碰 8642/8644）

修前（触发条件见 §3）：

| 指标 | 读数 |
|---|---|
| 主线程 CPU | **1.0 s CPU / 1.0 s wall**（独占一核），其余 33–40 线程全 idle |
| `/health` | 超时（000） |
| `node.log` | 不再有新行 |
| 进程内 `setInterval` 探针 | 完全停摆（定时器饿死） |
| provider | 一次请求都没收到 |
| WorkingSet / Private | 692→800 MB / 1.24 GB 持续上涨（~3–7 MB/s，GC 锯齿） |

> 关于「3–5 秒内 RSS 涨到 6.3 GB」：**没复现**。实测是 3–7 MB/s。6.3 GB 按这个速率要 20–30 分钟。
> 这条描述应当按「无界上涨」理解，而不是「3–5 秒内到 6.3 GB」。

修后（同一份数据目录副本、同一条启动命令）：

| 指标 | 读数 |
|---|---|
| 主线程 CPU | **0.016 s / 10 s** |
| WorkingSet / Private | **376 MB / 797 MB 恒定** |
| `/health` | **200**（连跑 3 轮全部 200） |
| run 本身 | 正常推进到 `llm request`（provider 被调用），日志正常落地 |

## 2. 根因（两条，缺一不可）

### 2.1 `packages/core/src/logging.ts` —— 日志 sink 的写失败会升级成进程级异常

`createStderrLogger` 的 `write()` 把 `process.stderr.write(...)` 包在 `try/catch` 里，看着像安全。
但 Bun/Node 的 stdout/stderr 是**流**：对端消失时（EPIPE）错误可能以**流错误**的形式异步抛出，
**绕过**调用处的 `try/catch`，变成 `uncaughtException`。实测栈（`epipe.log`）：

```
Error: EPIPE: broken pipe, write
    at write (unknown)
    at writeFast (internal:fs/streams:345:38)
    at write (packages/core/src/logging.ts:66:22)
    at loadStoredHistory (packages/core/src/runtime/execution-unit.ts:4435:17)
    at async executeRun (packages/core/src/runtime/execution-unit.ts:2323:32)
```

一个**日志 sink** 的错误不该有「升级成进程级异常」这条路径。

### 2.2 `src/process-handlers.ts` —— 错误处理器的重入门闩放错了位置（这是无界的来源）

旧实现顺序是：**先** `setExitCode` → **先** `logger.error('process error', ...)` → **先**发布事件 →
**最后**才 `if (handling) return;`。

于是：EPIPE 进 handler → 写日志 → 又 EPIPE → 又进 handler → 又写日志 → …

这是**无界**的，因为：

- `handling` 只挡住了 `shutdown`/`exit`，**挡不住写日志**；
- 每一轮都是同步就能完成的工作（写字符串 + 构造 Error），**不需要事件循环转**，
  所以定时器、HTTP、fs 全部饿死 —— 这解释了「连 `executeRun` 入口的日志都不打印」
  （日志队列根本不落地）以及「`/health` 超时」；
- `exit(1)` 只在 `shutdown()` 之后调用，而 shutdown 要等 5s 定时器 —— 那个定时器
  在事件循环被饿死时**永远等不到**，于是进程既不退出也不工作，只能强杀。

观察到的「3–5 秒后才死」是**触发时机**：`runs.start` 之后开始有持续日志要写，
而此时 sink 已经断了（见 §3）。

## 3. 触发条件：sink 断开，**与 provider 无关**

决定性的对照来自**启动方式**：

| 启动方式 | stderr 句柄 | 结果 |
|---|---|---|
| `nohup … > file 2>&1 &`（启动 shell 退出即断） | 会消失 | **必僵死**（本单复现 5 次） |
| `Bun.spawn(…, stdout/stderr: Bun.file(...))`（父进程持有句柄） | 由父进程持有 | **从不僵死**（30+ 次 run 全好） |
| 强制 EPIPE（`… 2>&1 \| head -2`，读完就退出） | 确定性断开 | 修前：自激；修后：**即时干净退出** |

所以：

- **不是假 provider 特有**。provider 只决定「什么时候有日志要写」，跟自激无关。
  真 provider 一样踩 —— 只要 sink 断了、且之后还有一条日志。
- **线上会不会踩取决于 sink 生命周期**，见 §3.2：重定向到真文件/journal/容器日志的不踩；
  sink 是会消失的管道（父进程退出、`| head`、短命 supervisor 管道）就踩。
  症状是「进程活着、CPU 100%、端口不响应、日志停在某一刻」，且 **SIGTERM 杀不掉**。

## 3.1 Linux 原生复现（bun139）与 2×2 矩阵：**不是文件系统问题**

环境：WSL2 Ubuntu，**Linux 原生 bun 1.3.9**（`~/.local/bin/bun139`，非 Windows 的 `bun.exe`）。
方法：每个 case 用**独立端口**、**全新空数据目录**（不需要「毒化」数据），
**先让 node 正常启动（health 200），再断开 sink**（`2> >(head -c 200 >/dev/null)`：head 读满退出 ⇒
管道读端消失），然后连续发 3 次 `runs.start` 制造日志写。采样 10 s。

| case | 代码 | 数据 fs | sink | 主线程 CPU/10s | health | 结论 |
|---|---|---|---|---|---|---|
| CP1 | 修前 | ext4 | 正常 | **0.2 %** | 200 | ALIVE |
| **CP2** | 修前 | **ext4** | **断开** | **102.6 %** | -1 | **STUCK** |
| CP3 | **修后** | ext4 | 断开 | **0.6 %** | 200 | **ALIVE** |
| **CP4** | 修前 | **9p** | **断开** | **105.3 %** | -1 | **STUCK** |
| CP5 | 修前 | **9p** | 正常 | **0.1 %** | 200 | ALIVE |
| CP6 | 修后 | 9p | 断开 | 2.4 % | 200 | ALIVE |

三条只变一个变量的读法：

- **固定 fs、只改 sink**：ext4 上 `0.2 % → 102.6 %`，9p 上 `0.1 % → 105.3 %` ⇒ **sink 是决定因素**。
- **固定 sink（断开）、只改 fs**：ext4 `102.6 %` 与 9p `105.3 %` 无差别 ⇒ **文件系统不是变量**。
- **固定 sink（断开）、只改代码**：修前 `102.6 / 105.3 %` → 修后 `0.6 / 2.4 %` ⇒ **修复有效**。

⇒ **「WSL2 9p/DrvFs 文件系统层卡住」这个假设被证伪**：僵死在 ext4 上照样发生，机制与 fs 无关。

### `/proc` 三件套（Linux 原生僵死现场，无调试器）

pid 35593（修前 + **ext4** + sink 断开）：

| 观察 | 读数 | 判读 |
|---|---|---|
| VmRSS / Threads | 674 → **753 MB / 3 s**（≈26 MB/s） | 真实 RSS 无界增长 |
| 主线程 `task/35593/stat` | utime+stime 增量 **299 ticks / 3 s**（HZ=100 ⇒ **100 %**），`state=R`，`wchan=0` | **用户态自旋**，不是阻塞在系统调用 |
| 其余 25 线程 | 增量 0–2 ticks，`state=S`，`wchan=futex_wait_queue_me` | 全在等锁（陪绑） |

「用户态自旋 + wchan=0」正是 `EPIPE → uncaughtException → 处理器写日志 → 再 EPIPE` 这条
纯用户态自激链的签名；若是驱动/fs 卡住，应表现为 `state=D/S` 且 `wchan` 指向具体内核函数。

### 一个运维事实：这种僵死 **SIGTERM 杀不掉**

实测 `kill -TERM 35593` 后进程仍在（CPU 继续涨），只有 `kill -9` 有效。
原因：信号处理需要事件循环，而事件循环正被自激饿死。
⇒ 外部 watchdog 必须用 **SIGKILL**；`SIGTERM` 会静默失败，让人误以为「进程已经停了」。

## 3.2 那线上 Linux 到底会不会踩

精确回答：**取决于 sink 的生命周期，不取决于平台或 provider**。

- **不会踩**：`… > file 2>&1 &`（重定向到**真文件**，Linux 下 fd 独立于 shell，shell 退出也不会断）、
  systemd `StandardOutput=file:`/`journal`、容器日志驱动、前台运行。
  （CP1/CP5 就是这种形态：9p 和 ext4 都是 CPU 0.1–0.2 %、ALIVE。）
- **会踩**：stdout/stderr 是**会消失的管道**——`… | head`、父进程退出、
  启动脚本/SSH 会话结束时把管道收走、某些 supervisor 的短命管道。
  Windows/WSL interop 下 `nohup … > file &` 恰好就是这种（重定向由 WSL 侧转发成管道），
  所以现场才「稳定复现」——但那是 **interop 的启动形态**，不是 9p 文件系统。

## 4. 修法（两处，都是「有界」修复）

1. **`logging.ts`：日志 sink 一次性报废 + 吸收流错误**
   - 模块级 `stderrBroken` 标志；一旦坏掉，后续所有写直接 no-op（最多损失日志，绝不损失进程）；
   - 加载时给 `process.stderr` 挂一次 `error` 监听：有监听时流错误只标记报废，
     **不再**升级成 `uncaughtException`；
   - 写调用处的 `catch` 也标记报废（兜住同步抛出的情形）。
2. **`process-handlers.ts`：重入门闩挪到最前面**
   - 进入处理器第一件事就是 `if (handling) return; handling = true;`，
     **在**写日志/发事件之前 → 自激链在第 2 次进入时被切断（有界：最多 1 次记录 + 1 次 shutdown）。

两处合起来的效果：sink 断了之后，日志静默降级（或进程按既有设计 `exit(1)` 干净退出），
**不会再出现「100% CPU 永不退出」**。

## 5. 为什么之前的排查会走偏（留给下一个人）

- **「无打点也复现」是对的，但不等于「与打点无关」**：复现真正的变量是**启动方式**，
  而不是有没有打点。用 `Bun.spawn` + 文件句柄起的实例永远不复现，用 `nohup &` 起的必复现。
- **inspector 在僵死时完全没有回包**（`Runtime.enable` / `Debugger.pause` 都无响应），
  所以堆快照 / `--cpu-prof` 拿不到；`BUN_JSC_forceRAMSize` 也不管用（内存在 JSC 堆之外）。
- **真正有效的手段**：在 `uncaughtException` / `unhandledRejection` 里打**完整栈**（前 8 条）。
  一条栈就把链路指出来了 —— 这也是本单最终定位的方式。
- 静态审查循环是**无效**路线：本单审过 `lastWalFactSeq` / `lastBlockName` / `decodeChunkBlock` /
  `readFileWindow` / `writeAll` / `readNdjsonTail` / `archive-audit` / `drainInflight` /
  `drainArchives` / `flushManifests` / `rememberProjection` / `session-event-log` 的十余个循环，
  全部严格推进 —— 因为**根因根本不在这些循环里**，而在错误处理路径的自激。

## 6. 复现/验证脚本（`D:/tmp/run-blowup`，不进仓库）

| 文件 | 作用 |
|---|---|
| `cfg-sendfirst.yaml` | 隔离 node 配置（`serve.port 8796`、provider 指向本地假 provider） |
| `fake-provider.ts` | 假 provider（`127.0.0.1:8797`，OpenAI 兼容 SSE） |
| `launcher-g3.ts` | **定位用**：把 `uncaughtException`/`unhandledRejection` 的完整栈写进 `epipe.log` |
| `launcher-g4.ts` | 修后验证用（干净 launcher + 隔离 env） |
| `launcher-g5.ts` | 确定性 EPIPE 验证（配合 `2>&1 \| head -2`） |
| `keepalive.ts` | 正常路径验证（`Bun.spawn` + 文件句柄，父进程持有，sink 不断） |
| `sample.ps1` / `threadlist.ps1` / `listp.ps1` / `killp.ps1` | 外部采样 / 线程级 CPU / 列 PID / 按 PID 杀 |

**Linux 原生（bun139）这一轮**（`/mnt/d/tmp/vb`）：

| 文件 | 作用 |
|---|---|
| `linux-launcher.ts` | Linux 隔离 launcher（数据目录/HOME/端口从 env 来，并自报 pid 以便采样 `/proc`） |
| `matrix2.ts` | **§3.1 的 2×2 矩阵**：独立端口 + 先启动再断 sink（`2> >(head -c 200 >/dev/null)`）+ 连续 `runs.start`，采 CPU/RSS/health |
| `probe.ts` | 对任意 pid 采 `/proc`：VmRSS + 每线程 utime/stime 增量 + state + wchan |
| `cfg-<port>.yaml` | 每 case 独立端口配置（由 `matrix2.ts` 生成） |

Linux 复现命令（一条跑完即得 §3.1 那一行）：

```
cd /mnt/d/tmp/vb
~/.local/bin/bun139 run matrix2.ts CP2     # 修前 + ext4 + sink 断开 ⇒ 期望 STUCK
~/.local/bin/bun139 run matrix2.ts CP3     # 修后 + ext4 + sink 断开 ⇒ 期望 ALIVE
# 采样任何僵死进程
~/.local/bin/bun139 run probe.ts <pid> 3
```

`matrix2.ts` 会在每个 case 前后 `git checkout` 对应版本，**跑完最后会把代码恢复到修后版本**；
若中途被 kill，务必手动 `git checkout HEAD -- packages/core/src/logging.ts src/process-handlers.ts`。

关键命令：

```
# 修后验证（会僵死的启动方式）：跑完看 health
cd D:/Application/APP/Vessel/worktrees/run-blowup
bun run D:/tmp/run-blowup/fake-provider.ts &
nohup bun run D:/tmp/run-blowup/launcher-g4.ts node start \
  --config D:/tmp/run-blowup/cfg-sendfirst.yaml > D:/tmp/run-blowup/node.log 2>&1 &
curl -s -XPOST localhost:8796/v1/rpc -H 'authorization: Bearer test-token-8796' \
  -H 'content-type: application/json' \
  -d '{"v":1,"id":"1","method":"runs.start","params":{"input":"hi"}}'
curl -s -o /dev/null -w '%{http_code}\n' localhost:8796/health   # 修后：200

# 确定性 EPIPE
bun run D:/tmp/run-blowup/launcher-g5.ts node start \
  --config D:/tmp/run-blowup/cfg-sendfirst.yaml 2>&1 | head -2
```

## 7. 本单没做的事

- 真 provider 没跑（只用假 provider，但按 §3.2 provider 不是变量：自激只跟 sink 有关）。
- 没在 systemd / 容器里验过 sink 生命周期（按 §3.2 的判据，那两种形态不会踩，但没实测）。
- 没有改 `apps/web/**`、`packages/core/src/timeline/**`、`packages/config/**`。
- 仓库没有自动化测试文件，因此没有新增测试；验证走的是 §3.1 的 2×2 矩阵与 §6 的实机复现。
- Linux 侧只验了 bun 1.3.9（与 Windows 同版本）；`~/.local/bin/bun`（1.4.4）没做对照。
