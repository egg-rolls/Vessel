---
adr: 70
title: 关闭 drain 与 interrupt 原因（可恢复的 interrupted checkpoint）
status: accepted
date: 2026-10-20
related: [40, 54, 56, 65]
tags: [runtime, shutdown, interrupt, drain, gateway, durable]
---

## ADR-070：关闭 drain 与 interrupt 原因（可恢复的 interrupted checkpoint）

- **上下文**：0.9 的关闭路径有两个问题：(a) `gateway.stop()` 只关 HTTP / WS / transport，不等待 active run；serve 的 bundle 关闭又会再 drain 一次，造成重复等待或提前释放；(b) 取消只有一个 `AbortSignal`，无法区分“进程关闭”“请求超时”“用户取消”，checkpoint 终态只能笼统记为 `cancelled` 或 `failed`，关闭时中断的 run 无法按 `interrupted` 恢复。长驻进程（gateway / REPL）需要一条可幂等、有时限、能落可恢复终态的关闭链。

- **决策**：
  1. **interrupt 带原因**。`AgentRuntime.interrupt(reason?: RunInterruptReason)`，`RunInterruptReason = 'shutdown' | 'timeout' | 'user'`，默认 `user`。`interrupt()` 与调用方 `RunOptions.signal` 合并为同一取消信号；`shutdown` / `timeout` 的 checkpoint 终态落 `interrupted`（可 `--resume-run`），`user` 保持 `cancelled` 语义。
  2. **gateway.stop 幂等且自 drain**。`stop()` 用 Promise 缓存保证幂等；先 `interrupt('shutdown')` active run，最多等待 5s 让其收尾，再关闭 WS / HTTP server；超时只记录错误，不无限等待。
  3. **关闭顺序固定**。serve 路径统一为 `await gateway.stop() → 取消共享流订阅 / 关闭 transport → beforeClose（如 workflow interrupt）→ closeAll → shutdown`，后两步传 `{ drain: false }`，保证总耗时上限仍是一次 gateway drain。该顺序抽为纯函数 `shutdownServeStack()` 便于守卫。
  4. **bundle 自己 drain 的路径**。没有 gateway 的 headless / REPL 路径由 bundle 自己 drain；只要 gateway 已启动，后续步骤不得再次 drain。
  5. **失败不阻断**。各关闭步骤异常经 `shutdown.failed`（`step` / `error` / `tenant_id`）记录后继续；进程级兜底的 shutdown 同样有 5s 上限。

- **备选**：(a) 让 `stop()` 只关连接、由 bundle 统一 drain——调用方容易忘记，且 gateway 已停止接收新 run，语义更清晰的是 stop 自己收尾；(b) 取消不区分原因——无法实现“关闭后恢复”，也无法区分用户取消；(c) 无限等待 active run——关闭可能永久挂起；(d) 每个步骤各自 drain——重复等待，且总耗时不可预测。均不取。

- **后果**：关闭是可预测的、有时限的；`interrupt('shutdown')` 中断的 durable run 会以 `interrupted` 落盘并可恢复。host 模式（直接使用 `PluginHost` 装配）不经过 `AgentRuntime.interrupt()`，durable run 与 workflow 的 drain 语义未覆盖；这是已知限制。provider 请求超时也会走 `timeout` 原因，因此超时与进程关闭在 checkpoint 上同为 `interrupted`，区分需看事件 / 日志字段。

- **关联**：ADR-040（durable run 与 checkpoint / resume）、ADR-054（RunExecution 与失败隔离）、ADR-056（持久化耐久性与损坏检测）、ADR-065（插件生命周期 v2）；`packages/core/src/runtime/agent-runtime.ts`、`packages/core/src/types/run.ts`、`packages/serve/src/gateway.ts`、`src/shutdown-sequence.ts`、`src/process-handlers.ts`、`src/bootstrap.ts`。
