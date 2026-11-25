# DR15-2 迭代2 —— pending_ws=4 类别审计与修复方案（q-dr15-exit）

 lead 终裁：迭代1未闭环（pending_requests=0 ✓ 但 pending_ws=4 残留 →
platform.server.stop start 后无 done → 30s 看门狗 force）。分支
fix/q-dr15-2-iter2（基线 redblue-dev 4cdeec50，含迭代1 1989a938）。

## 1. pending_ws=4 来源分类（Bun 1.3.9 源码核验，jsdelivr bun-v1.3.9）

### 1.1 平台 server-side WS 只有一类：node-proxy（无独立宿主 UI WS 注册表）

- `PlatformWsData.kind` 唯一值 `'node-proxy'`（platform/server.ts:68-70）。
- Bun.serve websocket handler 只认 node-proxy（server.ts:746-761）；upgrade
  唯一入口 = `/nodes/<name>/ws` 代理（server.ts:~1023，注释「0.58：代理 WS 的
  **唯一**入口」）。**浏览器 UI 的事件流就是 proxy downstream WS**——lead 所说
  「宿主 UI client WS」与「proxy WS」是同一批 socket，不存在第二个注册表。
- 注册表 = `PlatformProxy.bridges`（proxy.ts:250）；upstream（platform→node）
  是 **client** WebSocket，不计入 pendingWebSockets（= server handler
  active_connections，server.zig:1329-1331/1461）。

### 1.2 ★根因升级：Bun 1.3.9 server-initiated WS close 永久泄漏 active_connections

源码（src/bun.js/api/server/ServerWebSocket.zig）：

```zig
// close()（JS ws.close，graceful）:1056-1094
this.#flags.closed = true;          // ← 先置标志
this.websocket().end(code, ...);    // uws end() = 发 close 帧等对端 echo（CLOSING）

// terminate()（JS ws.terminate，强关）:1095-1110
if (this.isClosed()) return;        // ← close() 之后 terminate 是 no-op！
this.#flags.closed = true;
this.websocket().close();           // uws close() = us_socket_close 立即关

// onClose（native 关闭回调）:285-295
const was_closed = this.isClosed(); // = flags.closed
this.#flags.closed = true;
defer { if (!was_closed) { handler.active_connections -|= 1; } }
//      ^^^^^^^^^^^ 只有「非 server-initiated」关闭才减计数！
```

**结论：凡 JS 侧 close()/terminate() 发起的关闭，flags.closed 先置 true ⇒
onClose 时 was_closed=true ⇒ active_connections 永不减 ⇒ pendingWebSockets
永久泄漏。** stop promise 的 settle 硬条件含 `!hasActiveWebSockets()`
（active_connections==0，server.zig:1493-1497）⇒ **进程生命周期内只要发生过
一次 server-initiated WS close，stop promise 就永不 resolve**。

### 1.3 4 个残留的形成路径（canary 12:18:13 实证行）

`platform.server.stop start pending_requests=0 pending_ws=4 aborted_inflight=0`
→ 此后零日志（无 done/timeout_bounded/gateway.stop done/lock.release）→ 30s force。

1. node 先死（--self 序列）→ proxy bridges 逐个 failUpstream → finish()
   （proxy-ws.ts:323-362）→ closeQuietly(client) → **ws.close()（graceful）**
   → flags.closed=true（计数泄漏 +1/条）+ socket 进 CLOSING 等浏览器 echo。
2. finish 同时把 bridge 移出 bridges 注册表（proxy.ts:719-721 wsClose→delete、
   773/777）⇒ **stop 时 closeAll() 遍历的是空/残余注册表，对已 finish 的
   CLOSING socket 完全无覆盖**——迭代1「proxy.closeAll 已关」是假闭环。
3. 浏览器（冻结/断网 tab）不 echo ⇒ CLOSING 残留。4 条 = 4 次 server-initiated
   close 的泄漏计数（socket 可能已关也可能 CLOSING，计数都不减）。

### 1.4 idleTimeout 假设纠正（迭代1审计误差）

- 顶层 `idleTimeout: 0` 只管 **HTTP**；websocket 块未设 idleTimeout ⇒
  **WS idleTimeout = 120s 缺省**（WebSocketServerContext.zig:211）。
- uws end() 后 socket 超时 = idleTimeoutComponents.second = margin =
  **16s**（WebSocketContextData.h:84-94；timeout handler 对 isShuttingDown
  直接 forceClose，uws WebSocketContext.h:394-405）⇒ CLOSING 本应 +16s 自然收口。
- **但事件循环在 stop(true) native 收尾里同步卡死**（迭代1 thunk 形：start 已打、
  timer 已装填、stop 调用后 30s+ 无任何发射）⇒ JS timer 与 uws timeout 全停 ⇒
  16s 自然兜底也没机会跑。node 侧无 CLOSING 残留（对端是守约的本地平台代理，
  立即 echo）⇒ 循环空闲 ⇒ 5s race 准时发射 ⇒ DR15-1 PASS 靠 race 推进，
  **不是靠 stop promise resolve**（node 同样泄漏计数）。

## 2. 修复方案（适配计数泄漏现实）

**★lead 指令修正建议**：「显式关全部 WS 使 stop 前 pending_ws==0」在 Bun 1.3.9
不可达——server-initiated close 必泄漏计数（§1.2），关得越多泄漏越多。
可行目标 = **消除 CLOSING 残留（卡死触发条件）+ 不依赖 stop promise resolve**：

1. **proxy finish/shutdown 路径改 terminate()**（ServerWebSocket.zig:1095 核验
   1.3.9 存在）：立即 us_socket_close，无 close 帧握手、无 CLOSING 残留。
   closeQuietly 结构类型加可选 terminate?()，有则优先（downstream server WS）；
   upstream client WS 无 terminate 则 close()（client 侧不计 pendingWebSockets）。
   代价：浏览器见 1006  abrupt 而非 1001——UI 对任何 close 都重连，可接受；
   finish 的 gateway.ws.closed 审计照打（who=platform 记账不变）。
   **注意 terminate 必须在任何 graceful close 之前**（close 后 terminate no-op）。
2. **platform stop 不 await 不可 resolve 的 promise**：server.stop(true) 的
   native 关闭（app.close → us_socket_context_close 逐 socket closesocket）
   在调用内**同步**完成；promise 只是异步通知（且因泄漏永不 resolve）。
   改为：start 日志（附诊断）→ 调用 stop(true) → **调用返回即打 done
   dur=调用耗时** → `void promise.catch(()=>undefined)` 防 unhandled rejection
   → 立即推进 lock.release → process.exit。start→done≈ms 实证保留。
3. **迭代1成果保留**：abortInflight（pending_requests 归零 ✓）+
   closeIdleConnections + buildEvents.close + proxy.closeAll（改 terminate 后
   对存活 bridge 立即收口）。
4. **永久 pending_ws 分类诊断**（start 行恒显字段）：
   - `pending_ws`：Bun 计数（含泄漏）；
   - `pending_requests` / `aborted_inflight`（迭代1已有）；
   - `proxy_ws_live`：bridges.size（stop 时存活 bridge 数）；
   - `proxy_ws_closed`：proxy 累计 server-initiated downstream close 计数
     （≈泄漏量；pending_ws - proxy_ws_closed ≈ 真实未关 socket 数，归因用）。
5. **B 看门狗保留**：native 同步卡死无法进程内 bound（零探针宪法下不可静态
   定位精确帧）；terminate 消除 CLOSING 残留后 app.close 无 WS 可搅 ⇒ 预期
   不再卡；万一仍卡，30s 兜底保安全（纵深防御）。

**预期**：pending_ws=4（泄漏计数，诊断如实显示）但 proxy_ws_live=0、无 CLOSING
残留 → stop 调用毫秒级返回 → done≈ms → lock.release → 自死，无 30s 无 force。
复验判据①修正为「start→done≈ms」（pending_ws 字段如实反映泄漏，不再要求 ==0；
真实残留归因看 pending_ws - proxy_ws_closed）。

## 3. 红线

node 退出链不动（DR15-1 CLOSED，thunk spot-check）；idleTimeout:0 HTTP 语义 /
候 run 不限时 / --force / --timeout 零变化；最小外科手术 platform+proxy 聚焦。

## 4. 提交计划

① 本审计 commit → 报 main 候指令；② 修复 commit（terminate 收口 + stop 不
await + 分类诊断）；③ 门禁绿最终报告。