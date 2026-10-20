---
adr: 69
title: 日志端口与可观测（stderr 诊断、脱敏与进程级兜底）
status: accepted
date: 2026-10-20
related: [30, 47, 54, 58]
tags: [logging, observability, redaction, trace, process]
---

## ADR-069：日志端口与可观测（stderr 诊断、脱敏与进程级兜底）

- **上下文**：0.9 之前诊断输出散落在 `console.log` / `console.warn` / 直接 `process.stdout.write`，与命令结果、JSON、REPL 渲染共用 stdout。后果是：(a) 管道 / `--json` 调用方会收到污染的输出；(b) `VESSEL_DEBUG` 会把 prompt 正文打到 stdout；(c) 日志没有级别、没有统一脱敏，异常文本可能带密钥；(d) 未捕获异常直接由运行时打印，既没有退出码约定，也没有释放锁 / gateway 的机会。同时 trace 默认记录 `llm.stream.chunk`，敏感内容落盘面过大。

- **决策**：
  1. **core 只定义端口**。新增纯类型模块 `packages/core/src/types/logging.ts`（`Logger` / `LogLevel` / `LogFields` / `LoggerOptions`）与实现 `packages/core/src/logging.ts`（`createStderrLogger` / `noopLogger`）。`Logger` 只有 `debug` / `info` / `warn` / `error`，消息是短句、结构化信息放 `fields`。
  2. **stderr 是诊断通道**。`createStderrLogger()` 一行一个 JSON（`time` / `level` / `message` / `fields`），按级别阈值过滤，默认 `info`；message 与 fields 都经 trace redactor 处理；sink 写失败静默吞掉，日志不得改变运行语义。stdout 保留给命令结果 / JSON / UX 输出。
  3. **环境变量只控制级别**。`VESSEL_LOG_LEVEL`（debug|info|warn|error）控制阈值，非法值回退 `info` 且不阻断启动；`VESSEL_DEBUG` 非空等价 debug。`VESSEL_DEBUG` 不再打印 prompt 正文到 stdout。
  4. **进程级兜底**。CLI / serve 注册 `unhandledRejection` / `uncaughtException`：`logger.error` + 发布 `process.error` 事件（只带 `kind` 与脱敏 message），同步设置退出码 1，限时（默认 5s）执行 shutdown 后 `process.exit(1)`；重复触发只清理一次。shutdown 各步骤失败统一发 `shutdown.failed`（`step` / `error` / `tenant_id`），不阻断后续步骤。
  5. **插件侧结构化**。provider 请求默认 120s 超时（`timeout_ms`，`<=0` 关闭），超时抛 `ProviderTimeoutError`（`provider_timeout`）；重试通过 `onRetry` 回调暴露结构化事件。MCP server 连接 / 工具冲突告警写 stderr 并发布 `mcp.warning`；hook-logging 默认写 stderr。
  6. **trace 默认收紧**。trace 文件以 `0600` 创建；`trace.includeStreamChunks` 默认 `false`，`llm.stream.chunk` 不落盘，需要时显式开启。

- **备选**：(a) 直接引入第三方 logger——增加依赖，且 core 的 `dependencies` 必须保持为空；(b) 日志继续走 stdout——破坏 JSON / 管道契约；(c) 只在 CLI 做脱敏——serve / 插件路径仍会泄露；(d) 未捕获异常交给运行时默认处理——没有退出码与清理保证；(e) trace 默认记录全部流式分片——落盘内容与体积都不可控。均不取。

- **后果**：宿主可以替换 `Logger`（文件 / 远程 sink）而不改 core；CLI / serve / TUI 必须显式注入，未注入时使用 `noopLogger`。新增诊断输出时不得使用 `console.log`；需要用户可见的结果仍走 stdout。日志脱敏复用 trace redactor，因此 redactor 规则的变化同时影响 trace 与日志。进程兜底的 shutdown 有 5s 上限，超时后仍退出；它不保证 durable run 的完整收尾（见 ADR-070 的限制）。

- **关联**：ADR-030（事件名开放字符串）、ADR-047（trace-first 可观测性）、ADR-054（RunExecution 与失败隔离）、ADR-058（统一工具执行管道）；`packages/core/src/logging.ts`、`packages/core/src/types/logging.ts`、`src/logging.ts`、`src/process-handlers.ts`、`src/shutdown-report.ts`、`plugins/observability/hook-logging`、`plugins/provider/{anthropic,openai}`、`plugins/mcp/client`。
