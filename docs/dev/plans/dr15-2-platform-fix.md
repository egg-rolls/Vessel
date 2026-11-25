# DR15-2 平台退出 race 失效 —— 根因审计与修复方案（q-dr15-exit 续作）

ISSUE-DR15-2：DR15-1 修复后 node 路径 PASS（node 自死 5.08s，gateway.server.stop
timeout_bounded 5s 准时发射），但 **platform 路径进程内 5s race 失效**：
gateway.log `platform.server.stop start` 之后**无 done / timeout_bounded / failed**，
进程存活 30s+ 由外部看门狗 force（stop.forced reason=quiesce_exit_timeout，
abnormal_exit 审计污染）。B 兜底保安全（无无限挂），但每次 platform 停多等 30s，
直接损害用户「优雅重启」目标。

分支：`fix/q-dr15-2-platform`（基线 redblue-dev ad03a308，含 DR15-1 合并 03f13c06）。
复用 worktree q-dr15-exit（install 已在）。门禁：worktree 根 `bun run build`。

## 1. 实证（canary gateway.log，两次独立运行同签名）

```
11:45:18.433 platform.shutdown.accepted
             platform.supervisor.stop start → done dur=3ms（node 已先自死）
             platform.pool.stop start → done dur=0ms
             platform.gateway.stop start
11:45:18.459 platform.auth.flush start → done dur=1ms
11:45:18.462 platform.server.stop start        ← logEvent（stderr，带时间戳）
             ……30s+ 无任何后续步骤日志……
             stop.forced component=platform pid=56812 reason=quiesce_exit_timeout（看门狗）
```

11:52:30.874 第二次运行逐字同签名（pid 84332）。orchestrator 日志确证看门狗时间线：
platform 采样 5s/10s/…/30s 皆「快照不可用（监听已关闭）」→ 30s 到点强杀。

**node 侧对照（同机同 Bun 1.3.9 同 helper）**：canary node 日志
`gateway.server.stop start 11:52:25.724 → timeout_bounded dur=5s 11:52:30.732`
——timer 准时发射，链条推进，node 自死。**差异在进程状态，不在 helper 代码。**

## 2. 挂点与机制

**挂点（实证夹逼）**：platform/server.ts stop() 内
`await raceShutdownTimeout(emit, 'platform.server.stop', server.stop(true), 5_000)`。
start 已打出 ⇒ server.stop(true) 调用已返回（实参先于函数体求值）、timer 已装填；
此后 30s+ 既无 promise settle（done）也无 timer 发射（timeout_bounded）⇒
**事件循环在 native stop 收尾路径里被饿死/卡住**（lead 假说，与全部日志证据一致；
0.56 log-hub 文件头记载过同类「定时器全停、只能 SIGKILL」的进程级失效形态）。
精确 native 帧无法静态定位（零探针宪法）；修复策略 = **移除触发条件，使
server.stop 无需等待、毫秒级 settle，根本不进入卡死路径**。

**Bun 1.3.9 stop 语义（源码核验，cdn.jsdelivr.net/gh/oven-sh/bun@bun-v1.3.9）**：
- `stopFromJS`：先取 all_closed_promise，再 `stop(abrupt)` → `stopListening`
  （abrupt=true → `app.close()` = uSockets `us_socket_context_close` 同步逐个
  closesocket + on_close 回调）→ `deinitIfWeCan`。
- **promise settle 条件**：`pending_requests == 0 && listener == null &&
  WS active_connections == 0`（server.zig:1493-1514）。任一不满足 → 永久 pending。
- `pending_requests` 在请求**完整结束**（onRequestComplete）才减；流式响应在
  body 结束前一直占着。
- uws WebSocket `end()`（graceful close）后把 socket 超时设为
  `idleTimeoutComponents.second`（WebSocket.h「Set shorter timeout … avoid long
  hanging sockets after end() on broken connections」）——**平台 Bun.serve
  `idleTimeout: 0`（0.57 为 SSE 关空闲超时）⇒ 该「较短超时」= 0 = 无超时**：
  半死对端不回 close echo ⇒ CLOSING socket 永久 active。

**platform 独有触发条件（node 侧不存在）**：
1. **在途代理请求挂死 node**：DR15-2 运行时 node 已先死，平台代理里浏览器/探活
   请求仍在等死 node 的回包——每请求 30s 超时（proxy.ts:413-417，日志实证
   `gateway.proxy.node_unreachable timeout=30s`）。stop 时 `pending_requests > 0`
   最长可持续 30s ⇒ stop promise 被钉死在 pending，且 native 收尾要处理这些
   半死上游连接（Windows）。
2. **浏览器侧 WS/SSE 半闭残留**：0.58 预关（closeAll/buildEvents.close）走 graceful
   close；对端是浏览器（可能已冻结/断网），不像 node 的对端是本地平台代理（必然
   立即 echo）⇒ CLOSING 残留 + idleTimeout:0 无兜底超时 ⇒ active_connections 永不归零。
3. node 侧残余只有 idle keep-alive HTTP（WS 对端守约、无在途代理请求）⇒ stop 仅
   pending、循环空闲 ⇒ timer 5s 准时发射。**这解释了 node 生效 / platform 失效。**

## 3. 修复方案（0.58 预关句柄先例的扩展：预 drains，使 stop 速回）

**核心：server.stop(true) 之前把它的三个等待条件全部清零**，使其走
`deinitIfWeCan` 立即 schedule resolve 路径（毫秒级 done），不进入native 等待/收尾
卡死路径；5s race 保留为纵深防御（触发条件移除后循环空闲，timer 真能发射）。

1. **proxy.abortInflight()（新 seam）**：PlatformProxy 跟踪在途上游请求的
   AbortController（Set；请求结束 finally 移除），stop 时全部 abort ⇒ fetch catch
   立即返回 504/502 ⇒ handler 完成 ⇒ pending_requests 归零。复用既有
   `req.signal → controller.abort()` 同款收口机制，不新造取消路径。
2. **server.closeIdleConnections()**（Bun 1.3.9 既有 API，server.zig:1276 核验）：
   stop 前关 idle keep-alive HTTP（node 侧等满 5s 的那类残余）。类型可能滞后 ⇒
   可选链安全调用。
3. 既有 buildEvents.close()（SSE）+ proxy.closeAll()（WS bridges）保留不动。
4. **永久诊断增强**：platform.server.stop start 行附
   `pending_requests` / `pending_ws`（server.pendingRequests / pendingWebSockets
   getter，server.zig:1325-1331 核验）+ `aborted_inflight` 计数——未来任何残留
   等待都可实证归因（复验矩阵②的实证基础）。
5. **raceShutdownTimeout 改 thunk 形**（`() => server.stop(true)`）：start 日志
   先于 stop 调用打出（当前实参求值顺序下 stop 同步抛错会丢 start），并支持
   startFields。node 侧调用点同步改 thunk（行为零变化）。
6. 5s race + timeout_bounded + 迟到 promise catch + timer unref：DR15-1 既有
   防护全部保留。

**预期效果**：platform.server.stop start → done dur≈0-5ms → platform.lock.release
→ process.exit(0)；orchestrator 见进程自死，**无 30s 看门狗、无 stop.forced、
无 abnormal_exit 污染**。

## 4. 不做的事（最小外科手术边界）

- node 侧退出链不动（DR15-1 PASS 已闭环；node 的 5s idle 等待是已知有界行为，
  closeIdleConnections 优化留待后续，不在本轮扩 scope）。
- 不改 idleTimeout:0（0.57 SSE 语义不动）；不改 drain-to-quiesce / 候 run 不限时
  红线 / --force / --timeout 语义；B 看门狗保留（纵深防御，修复后不应触发）。
- 不跑 vessel CLI 行为验证 / 不 restart/stop 任何进程 / 不碰生产 checkout。

## 5. 复验指引（lead 编排金丝雀 cli）

platform 路径清洁判据：gateway.log `platform.server.stop start（pending_requests=0
pending_ws=0）→ done dur≈ms` → platform.lock.release done → 进程自死；
orchestrator 无 30s 干等、无 stop.forced(reason=quiesce_exit_timeout)、无
abnormal_exit。若仍出现 timeout_bounded：start 行 pending_* 字段即残留归因。
node 路径不回归（DR15-1 判据①⑤⑥）。

## 6. 提交计划

① 本审计 commit → 报 main；② 修复 commit（proxy.abortInflight + 平台 stop 预
drains + 诊断字段 + thunk race）；③ 总门禁 build 绿 → 最终报告。