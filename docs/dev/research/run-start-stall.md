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
- **真线上会踩**，而且这是线上最常见的启动形态：后台启动 / `nohup` / 启动脚本退出 /
  SSH 断开 / 父进程被杀 / systemd 管道断 —— 任何一个都会让 node 的 stderr 变成死管道。
  症状就是「进程活着、CPU 100%、端口不响应、日志停在某一刻」，只能强杀。
- 反过来说：只要 stdout/stderr 由一个长期存在的持有者持有（systemd 直接重定向到文件或
  journal、容器日志驱动、前台运行），就不会踩。

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

- 没有在 Linux / 真 provider 上跑过（本机 bun 是 Windows 二进制，WSL interop）。
  但按 §3，触发条件是「sink 断开」而非平台，Linux 上同样成立。
- 没有改 `apps/web/**`、`packages/core/src/timeline/**`、`packages/config/**`。
- 仓库没有自动化测试文件，因此没有新增测试；验证走的是上面 §6 的实机复现。
