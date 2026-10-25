---
title: 装配层
kind: current
triggers: [bootstrap, cli, args, wiring, repl, headless, resume]
paths: [src/**]
---

# 装配层（`src/`）

<a id="assembly"></a>

## 装配层（`src/`）

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | 入口分发：REPL（默认）/ `--run`（唯一 headless 入口：有参=文本或 `@file`，无参=stdin）/ `--serve` / `--resume-run` / `--version` / `--tools` / `update` / `eval` / `--feishu`；非交互且无 Key 时快速失败，不进首启向导。0.8：headless 只记录退出码，不提前 `process.exit`，统一走 gateway / tenantFactory / transport / shutdown 清理后再落 `process.exitCode` |
| `src/cli-args.ts` | 纯参数解析（语法与互斥），无副作用；`--serve` 默认端口 8642；`--resume-run` 与 `--run` / `--serve` / `--tools` / 位置式输入互斥；0.4 解析 `eval` 子命令与 `--feishu` 附加开关；0.6 解析 `--connect` / `--connect-token` / `--ca`（别名 `--connect-ca`）/ `--allowed-origin`（可重复，需 `--serve`） |
| `src/cli-overrides.ts` | 0.8.1：把**显式** CLI flag 组装成 `Partial<VesselConfig>`（serve / connect / TLS / allowed-origins），作为 loader 的最高优先级层；未给出的字段不写入 |
| `src/cli-update.ts` | `update [--check] [--channel latest\|beta] [--json] [--force]`：只读检查与提示 |
| `src/update/` | 更新清单解析、GitHub 通道选择、24h 缓存、后台检查、semver 比较；不自替换 |
| `src/bootstrap.ts` | config → provider → plugins → runtime → `ReplContext`；按配置构造 delegate / team / MCP，装配 session backend 与 RunStore；进程退出时关闭 MCP / Host / RunStore。0.8：`LocalRpcClient` 的 `onEvent` 订阅 `runtimeEvents`，以只读方式转发 `events.event`。0.8.1：接受 `cliOverrides` 并传给 loader；connect token / CA 只读 `config.connect` |
| `src/plugin-loader.ts` | 插件发现（见 [extensions.md](extensions.md#discovery)） |
| `src/plugin-selection.ts` | bootstrap 与 `--tools` 共用的插件选择策略，避免默认集漂移 |
| `src/agent-service-wiring.ts` / `src/agent-owner-injection.ts` | 0.17：把父 provider / PluginHost / 限额 / 事件流交给 AgentService；owner 队列经 `BeforeLlm` 注入 |
| `src/agent-owner-server.ts` / `src/agent-owner-client.ts` | 0.17：REPL owner loopback 控制端点与 CLI attach；0.19 S3 增加 `team.list|get|post|members` 私有方法 |
| `src/team-command.ts` | 0.19 S3：`vessel team list|get|post|members [--json]` 的参数映射与渲染；成员名在 CLI 层解析为 agent id |
| `src/hub-command.ts` | 0.19 S5：`vessel hub start|directory|watch|pair|node|token|data-token` 的参数映射与渲染 |
| `src/hub/` | 0.19 S5：hub 独立前台进程（`runtime` / `server` / `registry` / `control-client` / `secret-store` / `token-broker` / `client-protocol` / `types`） |
| `src/hub-wiring.ts` / `src/node-token-store.ts` / `src/node-token-control.ts` / `src/hub-pairing.ts` | 0.19 S5：`HubControlLike` / `TeamScopeLike` 投影、节点 token 表（只存 hash）、`auth.exchange|revoke|tokens` 与一次性配对码 |
| `src/gateway-wiring.ts` | 0.15 / 0.19：`buildGatewayControlPlane` 透传 `teams` / `hubControl` / `teamScope` / `nodeTokens` |
| `src/tenant-runtime-factory.ts` | 构造单个 tenant 的独立执行面（config / provider / session / run store / context / PluginHost / trace / writer lock）；runtime 共用同一份 resolved 权限 |
| `src/session-factory.ts` | `session.backend` → sqlite / file / memory |
| `src/run-store-factory.ts` | `durable.backend/path` → `FileRunStore` / `MemoryRunStore`；未启用返回 null。0.8：透传 `tenantId`（归属校验）与 `tenantRunsDir` |
| `src/durable-wiring.ts` | checkpoint / resume 的装配适配：Host 成员优先，其次单 agent runtime |
| `src/mcp-wiring.ts` | 读取 `mcp_servers` → `createMcpPlugin`；构造 TUI / gateway 需要的状态适配器 |
| `src/serve-config.ts` | `serve.*` 默认值补全、远程/TLS 校验、证书文件检查；0.8.1 起不再接收 argv，CLI 层已由 loader 合并 |
| `src/rpc/http-client.ts` | `HttpRpcClient`：`POST /v1/rpc`、Bearer、可选 CA、WS 首帧 auth 与 `since` / `pong` / `gap` / 重连 |
| `src/transport-factory.ts` | gateway / connect token 解析；0.22.1 删除 loopback / remote transport 装配 |
| `src/hub/node-url.ts` | hub 节点 URL 归一化（非回环必须 https） |
| `src/resume-command.ts` | `--resume-run` 无参：列出 interrupted run（只读，不需要 Key）。0.8：解析 tenant 后读 `<data_dir>/tenants/<id>/runs`（与执行面一致），并透传 `tenantId` |
| `src/tools-list.ts` | `--tools` 的工具清单（不构造 runtime、不需要 Key） |
| `src/headless-runner.ts` | headless 运行器 |

**0.4 CLI / TUI 入口**：

```text

vessel eval <suite-name-or-path> [--json] [--out <path>] [--filter <tag>] [--allow-network]

vessel --feishu
```

- `eval` 是位置 0 的子命令；未知子命令 → parse error（退出码 2）。
- `eval` 的报告写盘由 `@vessel-agent/evals/report.ts` 负责，asm 只传 `outDir` / `--out`。
- `--feishu` 是附加开关：TTY + 无 `--serve` → REPL + 渠道；非 TTY + 无 `--serve` →
  仅渠道前台；`--serve` → gateway + 渠道。与 `--run` / `--pipe` / `--resume-run` /
  `--tools` / `--version` / `--help` 互斥。
- TUI：`/metrics`、`/feishu`；启动横幅只在飞书已连接时追加一行。

**REPL 的职责边界**：`ReplContext` 携带 `runtime`、`pluginHost`、`session`、`events`、`context`，以及 `mcp` / `runs` / `metrics` / `feishu` 控制面适配器。`/tools` 与 `/plugins` 从 `runtime.pluginHost` 读——不再有第二个只为展示而存在的 host。`@路径` 的展开也发生在这里（见 [runtime-api.md](runtime-api.md#messages)）。

**用户可见行为（0.3.0；0.4 见上）**：

- `/clear` 只清屏，不清空 `ContextManager`；需要新会话用 `/new`。
- `@路径` 引用在发送前展开为注入消息，界面以引用块展示，用户原文不变。
- `/reload` 只重载配置文件并刷新 provider 信息，**不重扫插件目录**；新增插件需重启进程。
- `/mcp` 列出 server（name / status / 工具数）；`/mcp reconnect <name>` 显式重连。未配置 `mcp_servers` 时给明确提示。
- `/runs` 列出 running + interrupted（running 标注 live），按 `updated_at` 倒序、同值 `run_id` 升序，最多 20 条；`/runs resume <runId>` 恢复并继续 REPL。`durable.enabled: false` 时给明确提示。
- 启动横幅：仅当存在 MCP server 或 interrupted run 时追加一行提示；headless / serve 不输出。
- `--resume-run`：无参列出 interrupted run；有参恢复（headless 与 REPL 均支持）。与 `--run` / `--serve` / `--tools` / 位置式输入互斥。
- 自动更新：`vessel update [--check] [--channel latest|beta]` 读取 Release 的 `latest.json`，只提示版本与安装命令，不下载/不自替换。交互 REPL 启动时后台检查（24h 节流、失败静默、可关闭），有新版本时发布 `update.available`，由 TUI 渲染 banner。契约见 [operations/CI-CD.md](../operations/CI-CD.md)。

