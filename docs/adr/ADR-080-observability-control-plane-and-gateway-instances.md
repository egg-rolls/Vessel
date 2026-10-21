---
adr: 80
title: 0.14 可观察性、控制面与 gateway 多实例 A
status: accepted
date: 2026-10-21
related: [30, 45, 47, 48, 66, 69, 74, 76]
tags: [observability, trace, errors, config, cli, gateway, instances]
---

## ADR-080：0.14 可观察性、控制面与 gateway 多实例 A

- **上下文**：0.13 已把权限生命周期与状态栏收口，但运行态仍难以分级：trace 只按字面量 `llm.stream.chunk` 过滤，带前缀的转发事件（如 `subagent.llm.stream.chunk`）会绕过 `trace.includeStreamChunks=false`；`run.failed` / `tool.call.failed` 只有人读 `error` 文本，调用方无法按错误码、阶段或可重试性过滤；`ui.errorLevel`、进程级错误与内部事件没有统一切换；用户只能靠读日志或事件流判断 gateway 与 run 状态。gateway 同时只能存在一个实例（单 PID 文件），无法在同一 `dataDir` 下并行跑 default 与命名实例。

- **决策**：
  1. **trace 过滤覆盖前缀形式**：`includeStreamChunks=false`（默认）时，`llm.stream.chunk` 与 `<prefix>.llm.stream.chunk` 一律不落 trace；实时事件发布不变。
  2. **结构化错误 envelope（additive）**：`run.failed` / `tool.call.failed` 在保留原 `error` 文本的同时展开 `error_code` / `category` / `phase` / `retryable`，能识别时附 `http_status`，调用方可给非敏感 `details`。`category` 取 `provider|tool|permission|config|gateway|internal`，`phase` 取 `input|llm|tool|permission|finalize|checkpoint|shutdown|run`。envelope 不携带 prompt / reasoning / 完整工具结果。
  3. **可见性配置**：`ui.verbosity: minimal|normal|debug`（默认 `normal`，Web 消费）、`ui.showInternalEvents: boolean`（默认 `false`）、`ui.errorLevel: user|all`（默认 `user`）、`observability.showProcessErrors: boolean`（默认 `false`）。非法值由 validator 拒绝，不做静默回退；四个键都支持 `vessel config set`（YAML `verbosity` / `show_internal_events` / `error_level` / `show_process_errors`）。
  4. **只读控制面 CLI**：新增 `vessel status [--json]`、`vessel agents [--json]`、`vessel errors [--json] [--limit N]`。三者都不 bootstrap、不取 tenant 写锁、不输出 token / 密钥；本地优先 attach 运行中的 gateway，或用 `--connect`。`agents` 读 canonical `agents.list`（`agents.get` 同批引入），`errors` 本地读 trace、远端读 `events.list`，默认 20 条、上限 200。
  5. **gateway 多实例 A**：PID / 日志 / 实例锁以 `(dataDir, instance)` 为键。default 仍是 `gateway.pid` / `gateway.log`，命名实例为 `gateway-<instance>.pid` / `gateway-<instance>.log`；实例锁固定 `gateway-<instance>.lock`（JSON `{pid, started_at, host}`，`0600`）。实例名匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`。新增 `vessel gateway list [--json]`；`start` 接受 `--instance` / `--port`；`stop` / `status` / `reload` / `restart` 额外接受 `--all`（三者互斥），`restart --all` 必须同时带 `--daemon`。
  6. **选择器优先级**：显式 `--instance` > 显式 `--port` > default；`gateway start --port 0` 必须同时给 `--instance`。无选择器时 0 个实例返回空、1 个取该实例、多个返回 `multiple_instances`，不猜目标。
  7. **显式 node_id 不得跨实例重复**：`host.nodeId` 与其它运行实例重复时启动前拒绝（`duplicate_node_id`）；自动生成的 node_id 不参与该检查，避免事件去重键冲突。

- **冻结契约**：
  - 事件字段：`ErrorEnvelope` 的字段名与枚举值固定；原 `error` 文本不变，新增字段只增不改。
  - 配置键：`ui.verbosity` / `ui.showInternalEvents` / `ui.errorLevel` / `observability.showProcessErrors` 的名称、类型、默认值固定；YAML 使用 snake_case。
  - CLI：命令名、`--json` 纯文本无 ANSI、`--limit` 范围（1–200）、退出码语义固定。
  - gateway 文件：`gateway.pid` / `gateway-<instance>.pid`、`gateway.log` / `gateway-<instance>.log`、`gateway-<instance>.lock`；PID 记录新增可选 `instance`（additive）。
  - canonical 方法表：0.14 新增 `agents.list` / `agents.get`，总数 38 → 40；多实例本身不新增 RPC。

- **非目标**：不做跨实例调度、故障转移或负载均衡；不支持每实例独立配置文件；不做日志轮转；不改变 trace 的内容投影（metadata / full）；不把 `gateway list` 做成远端控制面；`vessel status` 不写入任何状态。

- **验证**：`packages/core/__tests__/error-envelope.test.ts`、`trace-recorder.test.ts`、`packages/config/__tests__/visibility-0.14.test.ts`、`src/__tests__/control-plane-commands-0.14.test.ts`、`gateway-multi-instance-0.14.test.ts`、`visibility-config-set-0.14.test.ts`；`bun run typecheck`、`bunx @biomejs/biome ci .`、`bun run scripts/check-docs.ts`、`bun run scripts/check-rpc-methods.ts`。

- **关联**：ADR-030（事件名开放字符串）、ADR-045（0.4 可观测性）、ADR-047（trace-first）、ADR-048（统一 RPC 方法表）、ADR-066（结果 schema）、ADR-069（日志端口）、ADR-074（gateway 生命周期）、ADR-076（CLI 样式）；`packages/core/src/runtime/error-envelope.ts`、`packages/core/src/observability/trace-recorder.ts`、`packages/config/src/types.ts`、`src/status-command.ts`、`src/agents-command.ts`、`src/errors-command.ts`、`src/gateway/pid.ts`、`src/gateway/instance-lock.ts`、`src/gateway-command.ts`。
