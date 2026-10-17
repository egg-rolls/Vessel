# Changelog

> 版本历史。遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。

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
