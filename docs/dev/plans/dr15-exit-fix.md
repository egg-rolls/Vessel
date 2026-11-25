# DR15-1 退出链微修复 —— 根因审计与修复方案（q-dr15-exit）

ISSUE-DR15-1：graceful stop 后 node 进程不自死（drain 成功 + 监听已闭 + 0 run，pid 存活
12min+/3min+，`process.exit(0)` 未到达）；stop 侧 24b4eb95 移除 10s force 兜底后不限时干等
（CLI 与 --self orchestrator 皆挂）。两次独立确定性复现（15① 外部 stop / 15② --self）。

分支：`fix/q-dr15-exit`（基线 redblue-dev @ 62c39d3f）。门禁：worktree 根 `bun run build`。
宪法：零测试/零探针/零临时进程；行为验证归金丝雀 cli（lead 编排）；最小外科手术。

## 1. 退出链全图（复核后 file:line）

外部 stop / --self orchestrator 共用 `stopGateway` seam
（`src/cli/commands/gateway/gateway-command.ts:967`；orchestrator 在
`src/cli/commands/fleet/restart-command.ts:603` 调它）：

```
stopGateway 优雅步
  → shutdownGateway RPC（src/gateway/reload.ts:138，只受理 {stopping:true}，3s 请求预算）
    → node 侧 gateway.shutdown handler（packages/serve/src/gateway/methods/admin.ts:138）
      先回 {stopping:true}，setTimeout(0) defer 执行 asm 注入闭包
    → cli.ts shutdown 闭包（src/cli.ts:1726-1734）：await activeCleanup() → process.exit(0)
  → waitForProcessExit（src/gateway/stop-drain.ts:70，缺省不限时 ← stop 侧放大回归）
```

node 进程内退出链（`activeCleanup`，src/cli.ts:2090-2115）：

```
pluginWatch.close（同步）
→ await pluginHostManager.stopAll        ← drain.done 之前，复现已通过
→ gatewayUpdateCheck.stop / configWatch.close（同步）
→ await hubNodeOutbound.close            ← drain.done 之前，复现已通过
→ shutdownServeStack（src/gateway/shutdown-sequence.ts:42）
    → await beginDrain                   ← node.drain.done 在此打出（drain-to-quiesce 成功）
    → await gateway.stop()               ← packages/serve/src/gateway.ts:4687 shutdown()
        clearInterval(heartbeat)
        unsubscribe / flushTimelineTail / unsubscribeInteractions（同步 try/catch）
        closeWsClients()                 ← gateway.ws.closed who=server_drain 在此打出
        closePluginWsClients() / closeSseClients()（同步）
        await server.stop(true)          ← ★★ 挂点（gateway.ts:4722）★★
    → closeTenants：eventHub.close()（同步 void，tenant-event-hub.ts:153）
    → await result.shutdown（src/runtime/bootstrap.ts:2470-2587）
        await beginDrain（幂等，第二次调用**必然再打一条 node.drain.done**，bootstrap.ts:2352）
        unsubPermissionPersist / peerNotices.stop / imageBlobGc.stop（同步）
        await agentControl.dispose（bootstrap.ts:1849-1861）
        localPluginWatch.close（同步）
        await localPluginHostManager.stopAll
        await engineSupervisor.stop + poolTransport.dispose + engineClient.dispose
        localDispatcher.dispose / localEventHub.close（同步）
        await bundle.close（src/runtime/tenant-runtime-factory.ts:1560-1644）
        await processSessionLock.release
→ await foregroundGatewayLock.release
→ process.exit(0)
```

平台侧（外部 stop 的第一跳）：`performPlatformShutdown`
（gateway-command.ts:3322-3349）→ supervisor.stop()（node-supervisor.ts:1624，逐 node 子进程
`tryGracefulNodeShutdown`:459 → 同一 waitForProcessExit 不限时等死）→ poolSupervisor.stop()
→ platformGateway.stop()（platform/server.ts:1075-1085，内含 `await server.stop(true)`）
→ lock.release → process.exit(0)。

## 2. 挂点定位：`await server.stop(true)`（gateway.ts:4722）

**结论：drain.done + ws.closed 之后阻塞 process.exit 的步骤 = gateway.stop 内部的
`await server.stop(true)`。Bun 1.3.9（Windows）的 stop promise 被残余「活跃连接」挂住，
永不 settle。**

证据链（静态，全部可复核）：

1. **日志签名夹逼**：复现时间线 = `node.drain.done` → `gateway.ws.closed who=server_drain`
   → 此后**零日志**。`gateway.ws.closed` 由 WS `close` 回调打出
   （gateway.ts:4587-4596，logWsClosed:766），发生在 `closeWsClients()` 内 —— 即
   `await server.stop(true)` 的**前一步**。而 gateway.stop 之后到 result.shutdown 之间只有
   同步的 `eventHub.close()`；result.shutdown 的第一个动作 `await beginDrain()` 幂等但
   **无条件再打一条 node.drain.done**（bootstrap.ts:2349-2357，缓存报告直接 resolve）。
   复现中 ws.closed 之后零日志 ⇒ 第二条 drain.done 没出现 ⇒ 链条没走到 result.shutdown
   ⇒ 卡在两者之间**唯一的 await**：`server.stop(true)`。
2. **监听已闭**：Bun `server.stop()` 立即关 listener、随后等活跃连接关闭才 resolve ——
   与「监听已闭但 pid 活着」完全吻合。
3. **仓内先例（同根因类）**：platform/server.ts:1076 注释（0.58）明确写着
   「先断开 SSE 长连接：`server.stop(true)` 会等活跃连接，长连接不关就等不完」——
   平台侧当年同款挂起，靠先关 buildEvents SSE + proxy WS 长连接修掉。node gateway 虽然
   也先关了自己跟踪的 wsClients / pluginWsClients / sseClients，但 Bun 视为「活跃」的连接
   不止这三个集合：SSE 响应流 controller.close() 后 TCP 连接仍被 Bun 保持（流结束 ≠ 连接关）、
   半关闭握手途中的 WS、in-flight / keep-alive HTTP 连接（Windows interop）。任何一条残留
   都把 stop promise 挂死。07:47「平台重试 172s」旧证亦属此类（连接最终超时才放行）。
4. **其余 await 全部有界（逐一静态核验，排除候查）**：
   - `ChildPluginProcess.terminate`（plugin-host/child.ts:439-488）：
     deactivate 2s → stdin.end → waitExited 2s → SIGTERM → 2s → SIGKILL → 2s，
     每段 `Promise.race(exited, timer)`；logFile.flush 是 fs 写链（child.ts:203）。
     engineSupervisor.stop（tools-engine/supervisor.ts:189）与 manager.stopAll
     （plugin-host/manager.ts:1405，Promise.all 并行 terminate）都走它 → 有界。
   - `agentControl.dispose`：ownerServer.stop 内 `server.stop(true)` **不 await**
     （agent-owner-server.ts:661，fire-and-forget）+ 文件删记录；service.drain 显式
     `timeoutMs:5000`（packages/agent/src/service.ts:7594-7606，且 run 已 drain → idle 即回）；
     teamStore/conversationStore/flushSnapshot 皆文件写。
   - `bundle.close`：serve 路径传 `drain:false` 跳过 5s interrupt drain；
     timelineDualWrite.closeAll 自带 300ms 上限；feishu.stop / mcp.close / retire EU /
     trace / runStore / eventLog.flush / session.close 皆文件 IO 或同步；
     EU.dispose（core/runtime/execution-unit.ts:4846）= plugins.dispose + journal flush +
     releaseLeases（文件锁）。
   - 锁释放：instance-lock.ts:171 / session-lock.ts:180 都是「读记录比对 + unlink」，有界。
   - `beginDrain` 幂等：node-drain.ts:224-229 缓存报告直接 resolve。
   - poolTransport.dispose / engineClient.dispose / dispatcher.dispose / eventHub.close：同步。
5. **stop 侧放大回归确证**：24b4eb95 把各等死段 10s force 兜底移除 → waitForProcessExit
   缺省不限时（stop-drain.ts:79）→ node 挂死时停止方（CLI / orchestrator / 平台 supervisor）
   永远等下去。node 侧挂点是既有缺陷（平台 0.58 先例同类），stop 侧移除兜底把它放大成
   「整条舰队停不掉」。

## 3. 修复方案

### scope A（node exit 根因）

**A1 永久步骤级 shutdown 进度日志**（修复的一部分，永久代码）：

- 事件名统一 `node.shutdown.step`，字段 `{step, status: start|done|timeout|failed,
  duration_ms, timeout_ms?, error?}`；start/done 用 **info**（core log-hub 缺省过滤 debug，
  挂起诊断必须让「最后一条 start」在缺省级别可见），timeout/failed 用 warn。
- 新增共享 helper `packages/serve/src/shutdown-step.ts`（serve 包导出，src 侧经
  `@vessel-agent/serve` 导入；gateway.ts 内部直接用）：
  - `runShutdownStep(emit, step, fn)`：start → await fn → done(duration_ms)；
    异常打 failed 后**原样重抛**（各调用方既有 catch / reportShutdownFailure 模式不动）。
  - `raceShutdownTimeout(emit, step, promise, ms)`：有界等待，到点打 timeout 并返回
    'timeout'，原 promise 挂后台 catch 防 unhandled rejection。
  - emit 形状 `(level, event, fields) => void`：node 侧接 logger.info/warn，
    serve 侧接 logEvent，平台侧接 formatEventLine+print（同一事件名，grep 一处全见）。
- 覆盖：cli.ts activeCleanup 每步 + finish（SIGTERM 同链）；shutdownServeStack 每步
  （新增可选 onStep seam，缺省不打，调用方注入）；bootstrap result.shutdown 每步；
  gateway.stop 内部三段（unsubscribe_flush / close_clients / server.stop）；
  bundle.close 每步；平台 performPlatformShutdown 每步 + platform server.stop 段。
- core/log-format.ts EVENT_FIELDS  additive 登记 `node.shutdown.step` 字段序。

**A2 挂点修复：`server.stop(true)` 有界化 + best-effort 推进**：

- gateway.ts shutdown()：`server.stop(true)` 改为 `raceShutdownTimeout(..., 5_000)`。
  5s 内正常关完 → done；到点 → warn `node.shutdown.step step=gateway.server.stop
  status=timeout` 后**继续退出链**（listener 已闭，后续全是进程内清理，残余 socket 随
  process.exit 一起死）。幂等不变（stopPromise 缓存），失败仍走 reportStopError。
- platform/server.ts stop()：同款有界化（同根因类；外部 stop 链包含平台自身退出，
  0.58 的「先关长连接」保留不动，有界兜底是其纵深防御）。
- 裁定理由：挂起根因在 Bun stop promise 的连接等待语义（仓内 0.58 先例已实证），
  进程退出路径上「等 HTTP server 优雅关完」本就不该无界 —— quiesce 已由 beginDrain 保证，
  server.stop 只是关连接，bounded + 推进是正确语义，不是掩盖。

### scope B（stop 侧有界兜底，纵深防御）

**红线：drain-to-quiesce 候 run 段保持不限时（用户裁定 #5）；只 bound 等死段。**

- `waitForProcessExit`（stop-drain.ts）新增可选 `postQuiesceTimeoutMs`（缺省 undefined =
  旧行为，兼容既有调用/测试）；返回 additive `quiesceTimedOut: boolean`。
- **quiesce 证据判定**（停止方无法直接读 node 的 drain.done，用采样推断）：
  - 采样成功且 live runs = 0 → quiesce（fence 已关闸，live 集合只减不增）；
  - 采样失败（快照不可用）→ quiesce：node 退出序列硬顺序 beginDrain → gateway.stop，
    **监听关闭 ⟹ drain 已完成**（本地 stop 回环连接失败 = 监听已闭）；
  - 采样成功且 live runs > 0 → **重置** quiesce 时钟（候 run 段不限时语义不动；
    也覆盖「受理后 fence 尚未打开」窗口里新受理 run 的竞态）。
  - quiesce 时钟持续满 `postQuiesceTimeoutMs` 进程仍活 → 返回 quiesceTimedOut。
  - 有 postQuiesceTimeoutMs 时采样不再依赖 onProgress 存在（supervisor.stop 无进度回调
    也要能判定）；显式 --timeout 语义不变（到点报告、不自动强杀）。
- **预算裁定：30s**（lead 建议 15-30s 取上沿）。scope A 修复后正常退出 <1-2s，
  病态但有界的清理最坏 ~15-20s（child terminate 并行 ≤8s + server.stop 5s + flush），
  30s 留足裕量防误杀；quiesce 后已无 live run，兜底强杀 runs_cut 恒 0，代价只是等待时长。
- **三个调用点同修**（CLI 与 --self orchestrator 共用 stopGateway，一处修两处生效）：
  1. `stopGateway` 优雅步（gateway-command.ts:1255）：quiesceTimedOut → 快照（监听已闭 →
     快照不可用如实标注）→ `stop.forced` 审计（reason: quiesce_exit_timeout）→
     terminateProcess(force) → 既有 kill-confirm + 条件清理。
  2. `nodeStopCommand`（node-command.ts:359）：同款。
  3. `tryGracefulNodeShutdown`（node-supervisor.ts:477）：返回 reason:'quiesce_timeout'；
     两个调用点（stopSpawnedChildren:715 / supervisor.stop:1655）→ 快照 + onForced 审计
     （NodeSupervisorOptions additive 增 onForced，组合根 gateway-command.ts:3156 旁接线）
     + force terminate。
- i18n en/zh-CN additive 新键：quiesce 兜底警示行（drain 已完成但进程未自死 → 强杀 +
  指路 node.shutdown.step 日志）。

## 4. 不做的事（最小外科手术边界）

- drain-to-quiesce 候 run 语义 / 幂等 / best-effort reportShutdownFailure 模式：零改动。
- 不给其余已有界步骤加超时（child terminate / service.drain / bundle.close 各步保持原样）。
- 不碰生产 checkout / ~/.vessel；不跑 vessel CLI 行为验证；不 restart/stop 任何进程。
- 不合并 redblue-dev/main；不删 worktree/branch。

## 5. 复验指引（lead 编排金丝雀 cli）

1. 15② 重跑：`vessel restart --self`（带在跑 run）→ 观察 node 日志
   `node.shutdown.step` 序列：gateway.server.stop start→done（或 timeout 后推进）→
   第二条 node.drain.done → shutdown.* 各步 done → 进程秒退（quiesce 后 <5s 典型）。
2. 外部 graceful stop：`vessel stop --yes` → node/平台皆自死，stopGateway 不再干等。
3. 有界兜底实证（若仍出现退出链挂起）：node.shutdown.step 最后一条 start 即挂点；
   停止方 30s 后打 stop.forced（reason=quiesce_exit_timeout, runs_cut=0）并强杀收口。
4. 14⑤⑥ 不回归：--force 路径（快照 + 强杀 + stop.forced 审计）与显式 --timeout 路径
   （到点如实报告、不自动强杀、exit 1）语义逐字不变；drain 候 run 段仍不限时 + 5s 进度。

## 6. 提交计划（增量防早退）

① 本审计文档 commit → 报 main；② scope A（挂点有界化 + 永久步骤日志）commit；
③ scope B（等死段有界兜底 + 审计）commit；④ 总门禁 `bun run build` 绿 → 最终报告
（commit hashes + 文件清单 + build 关键行 + 根因结论 + 复验指引）。