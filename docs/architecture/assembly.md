---
title: 装配层
kind: current
triggers: [bootstrap, cli, args, wiring, repl, headless, resume]
paths: [src/**]
---

# 装配层（`src/`）
> Stage 4 已落地：`bootstrap` 每 node 构造一次 `Runtime`，单 bundle 注册 profile 并把 `bundle.runtime` 暴露为 per-session 门面；成员 host 与单 bundle 共用同一个 Runtime。目标模型见 [0.34-target.md](0.34-target.md)，决策见 [ADR-098](../adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)。

<a id="assembly"></a>

## 装配层（`src/`）

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | 入口分发：REPL（默认）/ `--run`（唯一 headless 入口：有参=文本或 `@file`，无参=stdin）/ `--serve` / `--resume-run` / `--version` / `--tools` / `update` / `eval` / `--feishu`；非交互且无 Key 时快速失败，不进首启向导。0.8：headless 只记录退出码，不提前 `process.exit`，统一走 gateway / Node API / transport / shutdown 清理后再落 `process.exitCode` |
| `src/cli-args.ts` | 纯参数解析（语法与互斥），无副作用；`--serve` 默认端口 8642；`--resume-run` 与 `--run` / `--serve` / `--tools` / 位置式输入互斥；0.4 解析 `eval` 子命令与 `--feishu` 附加开关；0.6 解析 `--connect` / `--connect-token` / `--ca`（别名 `--connect-ca`）/ `--allowed-origin`（可重复，需 `--serve`） |
| `src/cli-overrides.ts` | 0.8.1：把**显式** CLI flag 组装成 `Partial<VesselConfig>`（serve / connect / TLS / allowed-origins），作为 loader 的最高优先级层；未给出的字段不写入 |
| `src/cli-update.ts` | `update [--check] [--channel latest\|beta] [--json] [--force]`：只读检查与提示 |
| `src/update/` | 更新清单解析、GitHub 通道选择、24h 缓存、后台检查、semver 比较；不自替换 |
| `src/bootstrap.ts` | config → provider → plugins → `Runtime` → `ReplContext`；每 node 构造一次 `Runtime`，单 bundle 与成员 host 共用；按配置构造 delegate / team / MCP，装配 session backend 与 RunRecordStore；进程退出时关闭 MCP / Runtime 目录 / RunRecordStore。0.8：`LocalRpcClient` 的 `onEvent` 订阅 `runtimeEvents`，以只读方式转发 `events.event`。0.8.1：接受 `cliOverrides` 并传给 loader；connect token / CA 只读 `config.connect`。Stage 4：`runs.resume` 按 `RunRecord.agent_id` 路由到成员 `AgentService`，否则按 session 取 EU |
| `src/plugin-loader.ts` | 插件发现（见 [extensions.md](extensions.md#discovery)） |
| `src/plugin-selection.ts` | bootstrap 与 `--tools` 共用的插件选择策略，避免默认集漂移 |
| `src/agent-service-wiring.ts` / `src/agent-owner-injection.ts` | 0.17：把父 provider / PluginHost / 限额 / 事件流交给 AgentService；owner 队列经 `BeforeLlm` 注入 |
| `src/agent-owner-server.ts` / `src/agent-owner-client.ts` | 0.17：REPL owner loopback 控制端点与 CLI attach；0.19 S3 增加 `team.list|get|post|members` 私有方法 |
| `src/team-command.ts` | 0.19 S3：`vessel team list|get|post|members [--json]` 的参数映射与渲染；成员名在 CLI 层解析为 agent id |
| `src/hub-command.ts` | `vessel hub start|directory|watch|join-code|join` 的参数映射与渲染；`hub pair` / `node add` / `token *` / `data-token` 已删除 |
| `src/hub/` | Hub 独立前台进程（`runtime` / `server` / `registry` / `control-client` / `secret-store` / `token-broker` / `client-protocol` / `types`）；不在 gateway 内 |
| `src/hub-wiring.ts` / `src/node-token-control.ts` | `HubControlLike` / `TeamScopeLike` 投影与节点 token 表（只存 hash）；保留 node → hub 出站控制面 |
| `src/gateway-wiring.ts` / `src/gateway/` | G1/G3 组合根：`buildGatewayControlPlane` 透传 `teams` / `hubControl` / `teamScope`；`src/gateway/` 的 `node-registry` / `node-supervisor` / `daemon` 管理本地多 Node 与 `nodes.json` |
| `src/tenant-runtime-factory.ts` | 单 bundle 工厂 `buildTenantRuntime`（名称保留，`tenantId` 是内部单 id）：构造 config / provider / session / run store / PluginHost / trace 的单份执行面，把 profile 注册到注入的 `Runtime`，插件只安装一次；`bundle.runtime` 是 per-session 门面（按 session 解析 EU），`bundle.pluginHost` 是共享 host。没有多 tenant bundle 缓存，`TenantRuntimeFactory` 已删除 |
| `src/session-factory.ts` | `session.backend` → sqlite / file / memory |
| `src/run-record-store-factory.ts` | `durable.backend/path` → `FileRunRecordStore` / `MemoryRunRecordStore`；未启用返回 null。单公司根布局，不透传 tenant 字段 |
| `src/durable-wiring.ts` | checkpoint / resume 的装配适配：Host 成员优先，其次单 agent runtime |
| `src/mcp-wiring.ts` | 读取 `mcp_servers` → `createMcpPlugin`；构造 TUI / gateway 需要的状态适配器 |
| `src/serve-config.ts` | `serve.*` 默认值补全、远程/TLS 校验、证书文件检查；0.8.1 起不再接收 argv，CLI 层已由 loader 合并 |
| `src/rpc/http-client.ts` | `HttpRpcClient`：`POST /v1/rpc`、Bearer、可选 CA、WS 首帧 auth 与 `since` / `pong` / `gap` / 重连 |
| `src/transport-factory.ts` | gateway / connect token 解析；0.22.1 删除 loopback / remote transport 装配 |
| `src/hub/node-url.ts` | hub 节点 URL 归一化（非回环必须 https） |
| `src/resume-command.ts` | `--resume-run` 无参：列出 interrupted run（只读，不需要 Key）。0.8：读根布局 `<dataDir>/runs`（与执行面一致） |
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

**REPL 的职责边界**：`ReplContext` 携带 `runtime`、`pluginHost`、`session`、`events`、`context`，以及 `mcp` / `runs` / `metrics` / `feishu` 控制面适配器。`context` 是**外壳只读镜像**：agent 启用时来自 local-run adapter 的会话镜像，否则是装配层新建的独立 `MemoryWorkingContext`；它不再与执行内核共享实例（WorkingContext 归每次 Run）。`/tools` 与 `/plugins` 从 `runtime.pluginHost` 读——不再有第二个只为展示而存在的 host。`@路径` 的展开也发生在这里（见 [runtime-api.md](runtime-api.md#messages)）。

**用户可见行为（0.3.0；0.4 见上）**：

- `/clear` 只清屏，不清空会话历史；需要新会话用 `/new`（执行内核的 `WorkingContext` 本就随 Run 重建）。
- `@路径` 引用在发送前展开为注入消息，界面以引用块展示，用户原文不变。
- `/reload` 只重载配置文件并刷新 provider 信息，**不重扫插件目录**；新增插件需重启进程。
- `/mcp` 列出 server（name / status / 工具数）；`/mcp reconnect <name>` 显式重连。未配置 `mcp_servers` 时给明确提示。
- `/runs` 列出 running + interrupted（running 标注 live），按 `updated_at` 倒序、同值 `run_id` 升序，最多 20 条；`/runs resume <runId>` 恢复并继续 REPL。`durable.enabled: false` 时给明确提示。
- 启动横幅：仅当存在 MCP server 或 interrupted run 时追加一行提示；headless / serve 不输出。
- `--resume-run`：无参列出 interrupted run；有参恢复（headless 与 REPL 均支持）。与 `--run` / `--serve` / `--tools` / 位置式输入互斥。
- 自动更新：`vessel update [--check] [--channel latest|beta]` 读取 Release 的 `latest.json`，只提示版本与安装命令，不下载/不自替换。交互 REPL 启动时后台检查（24h 节流、失败静默、可关闭），有新版本时发布 `update.available`，由 TUI 渲染 banner。契约见 [operations/CI-CD.md](../operations/CI-CD.md)。

