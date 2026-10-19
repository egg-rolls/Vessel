# Changelog

> 版本历史。遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。

## [0.8.0] - 2026-10-19

> 0.8 Wave 1 结构收口（基于 `release/0.8`，未发布）：只做真实行为缺陷、core 失败隔离与工具安全边界，不做 Gateway 拆分等大重构。版本号由 1 在集成线统一写入。

### Added

- **RunExecution（core）**：新增 `RunExecution` 类型，run 级状态（run id / session / branch / 计时 / usage / context）从 `AgentRuntime` 实例字段收敛到每次执行；`run()` 与 `resume()` 共用。
- **单 run 守卫**：新增 `RunAlreadyRunningError`（`code: 'run_already_running'`，继承 `RunResumeError`，从根入口与 `@vessel/core/session` 导出）；同一 runtime 已有 active run 时，新的 `run()` / `resume()` 立即失败。
- **统一终态**：`finalizeRun()` 成为 `run()` / `resume()` 唯一终态路径；新增 `run.finalize.failed` 事件（终态持久化失败时保留原始错误）。
- **失败隔离**：新增 `hook.error` 与 `guardrail.error` 事件；单个 hook 抛错发事件后继续执行，guardrail 抛错按 fail-closed 返回 `guardrail_error`。
- **本地 RPC subscribe**：装配层把 `LocalRpcClient.subscribe()` 桥接到 `runtimeEvents`（只读 `events.event` 转发）。
- **basic-tools 路径边界**：内置敏感路径 denylist；插件配置 `allowed_roots`（越界 `ask`）与 `deny_paths`（追加）；`read` / `bash cwd` 按 realpath 判定。
- **Web seq 回退重放**：`hello.latest_seq < currentSeq` 时以 `since=0` 重连并从头重放；新增 `GatewayClient.restart` 与纯函数 `planHelloSeq`。
- **durable REST 显式 tenant**：admin 可用 query `tenant_id` 或 `X-Vessel-Tenant` 指定 tenant；两者不一致返回 400。
- **文档**：新增 [ADR-054](docs/adr/ADR-054-run-execution-and-failure-isolation.md) / [ADR-055](docs/adr/ADR-055-tool-path-boundaries.md)，同步 ARCHITECTURE / AGENTS / SECURITY。

### Changed

- `resume()` 的用户取消改为 checkpoint `cancelled` + `run.cancelled`，与 `run()` 一致；不再发 `run.failed`。
- `OnError` hook 变为 best-effort：hook 自身抛错不替换原始错误，也不跳过 session / checkpoint 写入。
- `VESSEL_MODEL` / `VESSEL_BASE_URL` / `VESSEL_PROVIDER_API_KEY` 只合并对应字段；只有显式 `VESSEL_PROVIDER` 才覆盖 `provider.name`（修复项目 `provider.name: anthropic` 被改成 `openai`）。
- headless 不再提前 `process.exit`：先统一执行 gateway / tenant / transport / shutdown 清理，再设置退出码。
- `--resume-run` 读取 `<data_dir>/tenants/<id>/runs`，与执行面一致。
- `createRunStore` 透传 `tenantId`；`FileRunStore.delete()` 在 tenant 模式下先校验归属，foreign / 缺失 no-op。
- durable REST 的 tenant 解析与 RPC `runs.resume` 的 `ctx.tenantId` 对齐（admin 显式指定，其余按 principal）。

### Fixed

- 本地 REPL 的 `/runs resume`、`/workflows run|resume` 因缺少事件订阅而挂起。
- `--serve --run` 退出时跳过清理，残留 tenant `.lock`。
- 同一 runtime 并发 `run()` 互相污染 usage / session / branch。
- Web 在 gateway 重启（seq 回退）后丢失重放事件。
- durable REST 忽略 admin 的显式 tenant。
- `coreToJob` 随 run 数量无界增长（终态与 `trimRuns` 时清理）。
- `--resume-run` 在默认 tenant 布局下列不出 run。

### Security

- `read` / `bash cwd` 内置 denylist 硬拒绝 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`，用于降低提示注入诱导的凭据读取；命中 `deny` 而非 `ask`。
- `allowed_roots` / `deny_paths` 为 opt-in；路径比较基于 realpath（含最近已存在祖先），`..` 与符号链接不能绕过。
- **明确边界**：这不是沙箱。`bash` 只校验 `cwd`，命令本身仍可访问其它路径；`edit` 未纳入路径边界。真正的隔离仍需沙箱类插件与受限运行环境。

### Known limitations

- 单 run 守卫是进程内、每 runtime 的；跨进程并发仍依赖 tenant 写锁与 durable 唯一写者约定。
- `finalizeRun` 持久化失败只发 `run.finalize.failed`，不重试、不补偿。
- 内置 denylist 不能通过配置移除，只能追加。
- Web seq 回退会清空本地事件存储并全量重放，成本随事件数增长。
- 0.8 Wave 1 不包含 Gateway 拆分、统一工具执行管道、插件生命周期 v2、协议 schema、fsync/损坏恢复、CLI 命令注册表与配置单一 resolver（留在 Wave 2）。

## [0.7.1] - 2026-10-19

> 0.7 的 P0 加固补丁线（基于 `release/0.7`）。与 0.5 / 0.6 / 0.7 一样只做发布干跑，不 tag、不 publish、不合并 `main`。

### Security

- **P0-1 legacy WS 租户作用域**：`run.submit` / `run.get` / `run.cancel` / `permission.respond` / `ask.respond` 等 legacy WS 方法不再绕过 principal/tenant，统一经 dispatcher 按调用方 tenant 执行；跨 tenant 读取 / 取消 / 应答返回 `forbidden/not_found`，`team.*` legacy 帧保持 `method_not_allowed`。
- **P0-2 tenant 锁回收**：锁内容改为原子发布，不可解析锁增加 mtime 宽限，stale 回收改为带互斥守卫的 compare-and-delete；同主机存活 pid 不再被 24h 年龄判为 stale，跨主机仍按年龄兜底。消除空文件窗口与双重回收导致的单写者失效。
- **P0-3 外部插件信任边界（缓解 / MITIGATED）**：默认仍加载 repo / project / user / node_modules 插件，但启动时向 stderr 打印外部插件告警；新增 `VESSEL_NO_EXTERNAL_PLUGINS=1` 显式 opt-out；显式 `plugins:` 始终可加载指定外部插件。**该风险只是缓解，未完全关闭**——外部插件仍以完整进程权限在启动时执行。

### Changed

- 插件来源优先级修正为 `repo → project → user → node_modules`，同名插件先出现者胜出（项目覆盖用户）。

### Upgrade notes

- 在不可信仓库中运行请设置 `VESSEL_NO_EXTERNAL_PLUGINS=1`。默认行为不变（外部插件仍会加载），但启动会看到告警。
- 若依赖外部插件，可继续使用默认集；只想信任指定插件时，使用显式 `plugins:` 列表。

### Known limitations

- P0-3 记录为 **MITIGATED**（残余风险经用户接受）：没有插件 manifest / 签名 / 沙箱，也没有 `install()` 超时与故障隔离。
- 0.7.1 不包含 Gateway 拆分、统一工具执行管道、RunExecution、协议 schema 与 fsync（留在 0.8）。

## [0.5.0] - 2026-10-18

> 0.5 代码就绪，发布决定在 1；0.5 仍只做发布干跑，不 tag、不 publish、不合并 `main`。

### Added

- **F1 文件优先存储**：默认 `session.backend: file`；tenant 目录布局（`sessions/` / `runs/` / `events/` / `tenant.json` / `.lock`）；原子写；单写者锁；`vessel migrate`（sqlite / file-v1 → file-v2，默认 dry-run、源只读、幂等）。
- **F2 trace**：`TraceRecorder` / `FileTraceRecorder`、`RunEvent.seq` / `tenant_id`、`readTraceEvents`、`pruneTrace`、`rebuildMetrics`、`TraceRedactor`；默认 `full`，30 天 / 1000 runs / 1 GiB。
- **F3 统一入口**：RPC 信封 v1、方法表 v1.1、capability manifest、`RpcClient`（local / http）、`--connect`；旧 REST 端点保留为兼容别名。
- **F4 多租户**：`TenantContext`、tenant 解析、token → principal、存储 / 配置 / 工具 / 权限 / quota / trace / RPC 隔离；`serve.tokens` / `serve.admin_token`；`vessel tenant list|get|create|update`。
- **F6 配置与密钥**：YAML 主配置、`config path|init|show [--sources]`、`_env` 间接引用、来源标注、密钥脱敏输出。
- **A-6 内置多租户执行**：`pluginsFor`、per-tenant `capabilities.list` / `plugins.list`、`trace.readEvents(filter, tenantId)`、`sessionData.deleteSessionData(sessionId, tenantId)`；`--serve` 为每个 active tenant 构建独立执行面（config / provider / session / run store / context / PluginHost / trace / metrics / redactor / sessionControl）与独立 EventStream、per-tenant writer lock；启动失败回滚、shutdown 释放。
- **ADR 多文件**：`docs/adr/ADR-001..050`，`docs/adr/README.md` 索引与编写约定，`docs/ADR.md` 保留为兼容 stub。
- **门禁**：`check-docs` ADR 树校验；`check-rpc-methods`；`check-config-sources`；`check-trace`。

### Changed

- `session.backend` 默认 sqlite → file；`durable.path` 默认统一到 `<data_dir>/tenants/<tenant_id>/runs`。
- 显式用户取消只发 `run.cancelled`（不再同时发 `run.failed`），`metrics.runs.cancelled` 首次可能非 0；0.4 的 cancel→failed 是历史行为。
- trace 的 `seq` 由 recorder 落盘分配并持久化；内存事件可无 seq，消费方按 `(seq ?? ts)`。
- `.env` 从推荐主配置降为部署覆盖；CLI/TUI 走 RPC 客户端。
- ADR 从单文件迁移到 `docs/adr/`；`docs/ADR.md` 只作兼容入口。

### Upgrade notes

- 旧 sqlite / file-v1 数据不会自动迁移：检测到后只提示执行 `vessel migrate`。先 dry-run，再 `--apply`。
- 显式 `session.storage_path` / `durable.path` 可以逃出 tenant，但启动时会 warn。
- 旧 `.vessel/sessions.db`、`~/.vessel/runs` 不自动删除；验证新数据后再手工处理。
- 配置优先级固定为 `CLI > env > tenant overlay > project > user > default`；项目 `vessel.yaml` 禁止密钥。

### Known limitations

- 不承诺多进程并发写同一 tenant；单写者锁是唯一保障。
- `sessions.list` / `runs.list` 为 O(N)；0.5 上限单 tenant 5,000 sessions / 20,000 runs。
- redactor 只降低泄漏面，不是合规保证；0.5 不脱敏 run checkpoint / eval 报告 / 飞书回复。
- trace 队列溢出会写 `trace.overflow`，该 trace 标记为不完整。
- `pruneTrace` 不删除 `running` / `interrupted` run；tenant 删除默认 disabled，0.5 无 `--purge`。
- `--connect` 只连本机回环 gateway；**F5 跨机器远程在 0.6**。
- 多租户执行已实现（ext 插件、web 接口、asm per-tenant 执行面）；**gateway 的 workflow / 飞书控制面仍只走 default tenant**（A-6 §13.3 方法表未包含 per-tenant 变体）。
- Windows 上 programmatic SIGINT 不触发 Bun 信号处理器，shutdown 释放 tenant 锁（A6-17/A6-21c）未自动验证；代码路径存在（`tenantFactory?.closeAll()`），需 POSIX CI 补验。
- **微信（公众号 / 企业微信）不做**；0.5 不发布。

## [0.4.0] - 2026-10-18

> 0.4 代码就绪，发布决定在 1；**0.4 只做发布干跑，不 tag、不 publish、不合并 `main`**。
> 0.1.0 / 0.2 / 0.3.0 / 0.4.0 均未发布。

### Added

- `@vessel/workflow`：声明式 workflow 插件——YAML/JSON DAG、`agent` / `tool` 步骤、模板插值、重试 / `on_error` / `when`、并行上限、run 持久化与 resume、`WorkflowControls` 控制面；工厂式插件，不进 core，不注册模型工具。
- `@vessel/evals`：默认离线的 eval harness——suite / case、脚本化 mock provider、断言白名单（`output_contains` / `output_matches` / `no_error` / `tool_called` / `tool_not_called` / `max_duration_ms` / `max_iterations` / `usage_under`）、JSON 报告、`report.ts` 写盘与 latest 查找。
- `@vessel/feishu`：飞书渠道插件——官方 SDK WebSocket 长连接、`FeishuTransport` 抽象、专用 `InProcessRuntimeHost`、per-chat session（`feishu:<chat_id>`）、文本消息、队列上限、凭据掩码；`--feishu` 附加开关。
- `@vessel/core`：`MetricsCollector` / `MetricsSnapshot`（进程内事件聚合）；`MemoryEventStreamOptions.maxHistory`（缺省 1000、显式 0 = 不限制、>0 环形缓冲）；`pruneRuns` helper（`status` / `older_than_ms` / `keep_latest`）。
- `@vessel/config`：`workflow` / `evals` / `feishu` / `observability` 四个配置块与严格校验；`feishu.agent_id` 已删除，按未知键拒绝。
- CLI：`vessel workflow run|list|show|resume|cancel`、`vessel eval <suite>`、`--feishu`（TTY → REPL + 渠道；非 TTY → 仅渠道前台；`--serve` → gateway + 渠道）。
- `@vessel/tui`：`/workflows`、`/metrics`、`/feishu`、启动横幅（interrupted workflow / 飞书已连接）。
- `@vessel/serve`：`GET /v1/metrics`、`/v1/workflows*`、`/v1/channels/feishu`、`GET /v1/evals/latest`；新错误码与 `hello.features`；慢客户端丢事件并标记 `gap`。
- `apps/web`：workflow / metrics / 飞书面板。
- 发布干跑：`scripts/release-dry-run.ts` + `Release Dry Run` CI job（PR + `release/**`；不 tag / 不 publish / 不上传）；Offline Integration 扩展 workflow / evals / feishu / core。

### Changed

- `@vessel/core` 的 `./observability` subpath 在 0.3 已存在；0.4 **改指**到新的 `src/observability/index.ts` barrel，并继续 re-export 原 events 符号（不是新增 subpath）。
- 四个新配置块全缺省时行为与 0.3 一致；`observability` 块缺省时不注入 metrics；事件历史缺省仍为 1000。
- 发布流程不变：1.0 前不发布；0.4 只干跑，tag / publish / 合并 `main` 仍由 1 决定。

### Fixed

- `@vessel/core`：长会话 context compact 后消息/事件不重复、不丢最后一条用户消息。
- `@vessel/core`：`InProcessRuntimeHost` 在 run 结束时释放 `AbortSignal` 监听器，避免泄漏；关闭路径清理成员、排队 run 与交互请求。
- `@vessel/core`：`Scheduler` 队列满 / 并发取消 / 同成员串行的并发不变量由测试固定。
- 发布干跑：`entry_file_missing`（`main` / `types` / `exports` 目标不在 tarball 中）由 warning 提升为 **error**。
- 0.3 基线已包含 PeerRegistry stop race 修复（`ec25cfc`），0.4 不回归。

### Known limitations

- workflow `type: tool` 直接调用 handler，**绕过 runtime 的 guardrail / hook**；需要 guardrail 的步骤用 `type: agent`。
- workflow resume 不保证 step 幂等；重跑可能重复副作用。
- workflow agent step 使用 Host 中已存在的成员，**共享其 session**；workflow 级会话隔离不在 0.4 承诺。
- workflow `cancel` 只支持同进程；跨进程 run 返回 `workflow_not_found`。
- `MetricsCollector` 的 `runs.cancelled` 保持 0，取消的 run 计入 `runs.failed`；resume 不计 `runs.started`，因此 `completed` 可能大于 `started`。
- `pruneRuns` 的 `kept` 受 `RunStore.list` 200 窗口限制，`keep_latest > 200` 不保证精确；prune 不自动调度。
- 事件历史上限只作用于 `MemoryEventStream`；`FileEventStore` 不自动轮转。
- 飞书只支持文本、单 chat 单 session；真实 WebSocket 连接未在离线 CI 验证（CI 使用 mock transport）；达到 `max_members` 时新 chat 回 `busy`，不逐出已有成员；不做富媒体 / 卡片 / thread / 多机器人 / OAuth。
- eval 使用 mock provider 时 usage 可能为 0；`usage_under` 的判定以实际报告为准；真实 provider 需 `config.evals.allowNetwork` + CLI `--allow-network` 双门控。
- 发布干跑通过不代表 npm 凭据、2FA、provenance 的线上配置已完成；0.4 不生成 `latest.json`。

## [0.3.0] - 2026-10-17

> 0.1.0 与 0.2 均未单独发布；0.2 的变更并入本版本。0.3.0 代码就绪，发布决定在 1。

### Added

- 0.2：`@vessel/core` Kernel——`RuntimeHost` / `AgentHandle` / `RunHandle` / `Scheduler` / `EventBus` / `Cancellation` / `Limits`，以及 `createRuntime()`。
- 0.2：`@vessel/core` subpath exports——`context` / `observability` / `kernel` / `policy` / `provider` / `session` / `transport` / `types`；根入口保持兼容。
- 0.2：in-process `Transport`；gateway loopback transport 与 `team.*` 协议。
- 0.2：`team` / `delegate_task` 共用 Host；team 仍默认 off、显式 opt-in。
- `@vessel/core`：durable run——`RunStore` port、`RunCheckpoint`、`MemoryRunStore` / `FileRunStore`；checkpoint 在 run 开始、每轮 tool-call 后、run 结束写入；`AgentRuntime.resume(runId, opts?)`、`RunnableAgent.resume?`、`RuntimeHost.resume(runId)`（不经 Scheduler）；开放事件 `run.checkpoint` / `run.resumed`。
- `@vessel/core`：resume 稳定错误 `RunResumeError`（`run_not_found` / `run_not_resumable` / `run_already_running` / `run_store_required` / `agent_not_found`）；同一 run 并发恢复首个成功，后续 `run_already_running`。
- `@vessel/mcp-client`：MCP client 插件——stdio 与 HTTP（Streamable HTTP，POST JSON-RPC + JSON/SSE 响应）两种传输；工具经 `PluginHost` 注册；`mcp__<server>__<tool>` 前缀（超 64 字符截断并加 hash）；权限默认 `ask`，`auto_approve_tools` 按原始工具名精确放行；单 server 失败隔离；控制面 `listServers()` / `getServer()` / `reconnect()` / `close()`；事件 `mcp.server.*` / `mcp.tool.*`。
- `@vessel/config`：`mcp_servers`（stdio/http、超时、tool_prefix、auto_approve_tools 等）、`durable`（enabled / backend / path / checkpoint_every）、`serve`（hostname / port / allow_remote / tls）配置块与校验。
- `@vessel/serve`：`GET /v1/durable/runs`、`POST /v1/durable/runs/<runId>/resume`、`GET /v1/mcp/servers`；新错误码 `run_not_found` / `run_not_resumable` / `run_already_running` / `durable_disabled` / `mcp_disabled`；`hello.features` 按实际启用增加 `durable-resume` / `mcp-status` / `tls`。
- `@vessel/serve`：显式 opt-in 的远程监听与 TLS——`serve.allow_remote` / `--allow-remote`、`serve.tls.cert_file` + `key_file` / `--tls-cert` + `--tls-key`；非回环必须 token；默认仍绑 `127.0.0.1` 且明文。
- `@vessel/tui`：`/mcp`（状态 / `reconnect <name>`）、`/runs`（running + interrupted，`resume <runId>`）、启动横幅提示（有 MCP server 或未完成 run 时）。
- CLI：`--resume-run [runId]`（无参列出 interrupted，有参恢复；与 `--run` / `--serve` / `--tools` / 位置式输入互斥）、`--serve-host`、`--allow-remote`、`--tls-cert`、`--tls-key`。
- `apps/web`：按 `hello.features` 显示 MCP server 面板与 interrupted run 面板；可触发 durable resume。
- examples：`examples/embedded-mcp.ts`、`examples/mcp-echo-server.ts`。

### Changed

- 0.2：定位调整为「可嵌入的多 agent 平台 runtime + 参考 harness 外壳」（ADR-037）。
- 0.2：`AgentRuntime` 仍是单 agent loop；Host 包在它外面，不重写 loop。
- durable 默认关闭（`durable.enabled: false`）：关闭时不创建 `RunStore`，行为与 0.2 一致。
- serve 默认行为不变（回环 + 明文）；REST 仍为 HTTP/1.1。
- MCP 工具默认逐次询问；`auto_approve_tools` 只接受 server 返回的原始工具名（大小写敏感）。

### Removed

- `@vessel/team` 中 0.2 的 deprecated 进程内 Host 兼容路径（`InProcessRuntimeHost` / `LegacyHostAdapter`）；team 统一注入 core `RuntimeHost`。
- 配置键 `delegate.viaHost` 与 `team.maxMembers`；旧配置按未知键报错。

### Fixed

- 无 0.3 专属修复；0.2 的 loop / SSE / 启动竞态修复已包含在基线中。

### Known limitations

- durable 只支持本机 `file` / `memory` 后端；不做跨机器恢复、分布式锁或跨进程并发写协调。
- `FileRunStore` 的原子写是 best-effort（Windows 下 rename 失败重试后整文件直写）；无保留/清理策略，`list` 可能增长。
- resume 并发守卫是 per-Host / per-store-instance；多 Host 共享同一 `FileRunStore` 或跨进程同时恢复同一 run 属部署错误，不在 0.3 协调范围。
- MCP HTTP 不做 GET 长连接、session 恢复、OAuth；MCP 工具默认需要用户确认。
- 远程/TLS：只做 HTTP/1.1；证书由用户提供，不支持 ACME / mTLS / HTTP/2。
- workflow / evals / 多租户 / 跨机器调度 / 单二进制 / npm CLI 仍未实现。
- 0.1.0 / 0.2 / 0.3.0 均未发布。

## [0.1.0] - 2026-10-17

### Added

- `@vessel/core`：AgentRuntime 与通用 tool-calling loop（流式、中断、事件、限流、session 恢复）。
- `@vessel/core`：9 个接口（Provider / Context / EventStream / Tool / Session / Limits / Guardrail / Hook / Plugin），唯一扩展机制 `Plugin` + `PluginHost`。
- `@vessel/core`：`FileEventStore` + `replayRun` 事件回放；File / SQLite / Memory 三种 session 后端。
- `@vessel/config`：YAML 配置加载、校验（未知键报错）、snake_case → camelCase 映射。
- `@vessel/tui`：Ink REPL、流式渲染、slash 命令、权限确认、`@路径` 文件引用。
- `@vessel/serve`：常驻 gateway（`--serve`），实现 `vessel.gateway/1`：WS/SSE 事件流（`seq` 续订 / `gap`）、异步运行提交与取消、会话/工具/权限/ask_user 端点、可选同源静态托管。
- `apps/web`：浏览器控制台 v1（时间线、运行取消、权限弹窗、ask_user、断线重连）。
- `@vessel/permission`：共享权限原语（工具经事件流等用户授权）。
- 能力工具 3 个：`bash` / `read` / `edit`；接缝工具 2 个：`ask_user`（仅交互）/ `delegate_task`。
- 插件包：`provider-openai` / `provider-anthropic` / `guardrail-pii` / `redact-secrets` / `tool-policy` / `hook-logging`。
- headless 入口 `--run`：文本、`@file`（`.json` 多轮 seeding）、stdin 管道。
- `VESSEL_MOCK=1` 模拟模式：无 API Key 跑通整条链路。
- CLI：`--version`（根 `package.json`）、`--tools`（headless 口径，不需要 Key）、`update [--check] [--channel latest|beta] [--json] [--force]`（check-only）；非交互且无 Key 时快速失败，不进首启向导。
- 配置块：`provider.timeout_ms`、`session.backend`（sqlite / file / memory）、`update.*`、`delegate.*`（含 `permission_mode` / `read_only_tools`）、`team.*`；顶层未知键升为 error（带拼写建议）。
- 插件包 9 个：新增 `@vessel/team`（进程内原型，`team.enabled` 显式 opt-in，注册 5 个 `team_*` 工具）。
- provider timeout 装饰器（openai / anthropic 插件）；`delegate_task` 权限 bridge / allow / deny。
- thinking 模型：OpenAI 兼容 provider 支持 `reasoning_content`（非流式解析、流式累积、下一轮请求回传、会话持久化；事件流与 TUI 不暴露思维链，ADR-038）。
- CI：质量门禁、跨平台矩阵、web 构建、examples 类型检查、mock 冒烟。
- 发布：tag `v*` 驱动，npm 发布 `@vessel/*` 与插件包（provenance、latest/beta dist-tag），生成 `latest.json`。
- 版本工具：`scripts/version.ts`（统一版本 + 一致性校验）、`scripts/latest-json.ts`。

### Fixed

- core loop 正确性修复（ADR-035）：非法 tool arguments JSON 不终止 run；失败 run 保存真实上下文；请求消息归一化（补 system、丢弃孤儿 `role:tool`、降级不完整 `tool_calls`）；`updateRealTokens` 使用本次请求 token；guardrail `replacement` 四阶段生效；Anthropic 非流式 `max_tokens` 映射为 `length`；会话标题取首轮最后一条 user；`FileEventStore` 自动创建父目录。
- SSE 长连接：`Bun.serve` `idleTimeout` 默认禁用（0），保留 15s heartbeat；`hello.from_seq` 空缓冲为 `0`、已追平为 `since + 1`。

### Changed

- 极简化重构（ADR-034）：工具集收敛为 `bash` / `read` / `edit`；插件发现只保留运行时目录扫描；skills 改为普通文件经 `RunOptions.messages` 注入。
- 事件名统一为开放字符串（ADR-030）；hook / guardrail 按 priority 排序。
- `AgentRuntime` 改为异步静态工厂 `AgentRuntime.create()`（ADR-023）。
- 工具口径：默认 4（`bash` / `read` / `edit` + `delegate_task`）；`ask_user` 仅 REPL+TTY（交互 5）；`team.enabled` 后 9。
- `--serve` 接线完成：传入 `context` / `pluginHost` / `staticDir`，G2 会话切换与 Web 静态托管生效。

### Removed

- `file-ops` / `meta-tools` / `skills-loader` / `mcp-client` / memory 插件。
- `ToolRegistry` 与 `ToolDefinition` 的死字段（`default` / `interactive` / `render` / `isEnabled` / `shouldDefer`）。
- `vessel.yaml` 的 `tools:` 声明段。
- 旧的 `docs/specs/`、`docs/api/`、`docs/guides/`、`docs/dev/`、`docs/role/`、`processes/`、`legacy/` 文档树。

### Known limitations

- MCP 未实现；接外部系统先用 `bash`（`curl` / CLI）。
- workflow / durable execution / evals 未实现；agent team 只有进程内原型（`team.enabled` 显式开启），gateway 的 `team.*` 为 0.2 草案。
- Gateway 0.1.0 单节点单 runtime：并发固定 1（队列上限 100），运行与事件历史在内存。
- 0.1.0 **不发布二进制**（ADR-006 继续有效）。
- 根 CLI `vessel` 尚未发布到 npm，`npx vessel` 暂不可用。
- `vessel update` 只做版本检查与提示（check-only），不下载、不自替换。
- `provider.timeout_ms` 只对插件式 provider 生效；未知 provider 的降级路径没有超时装饰器。
- 顶层未知配置键现在是 error（不是 warning）：旧配置里的拼写错误会让启动失败。

---

## 版本命名规则

- `x.y.z` = 语义化版本（Semantic Versioning）。
- pre-1.0 阶段：`0.x.y`，Minor（中间位）= 不兼容变更。
- 发布时打 tag：`git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0`。
