---
title: CLI 入口与装配 wiring
kind: current
triggers: [bootstrap, cli, args, wiring, repl, headless, resume, update, eval, feishu, factory, ReplContext, 装配, 启动, 命令行, 参数, 无头, 恢复会话, 退出码, 工厂]
paths: [src/cli.ts, src/cli/args.ts, src/config/cli-overrides.ts, src/cli/help-spec.ts, src/cli/commands/cli-update.ts, src/runtime/bootstrap.ts, src/cli/headless-runner.ts, src/cli/commands/resume-command.ts, src/tools-engine/tools-list.ts, src/cli/commands/**, src/update/**, src/session/session-factory.ts, src/run/run-record-store-factory.ts, src/gateway/transport-factory.ts, src/plugin/mcp-wiring.ts, src/run/durable-wiring.ts, src/gateway/serve-config.ts, src/runtime/tenant-runtime-factory.ts, src/agent/local-run-adapter.ts, src/cli/commands/eval-command.ts, src/plugin/eval-wiring.ts, src/cli/feishu-command.ts]
---

# CLI 入口与装配 wiring（`src/`）
> 装配层唯一事实：CLI 入口分发 / 参数互斥 / headless 退出码 / REPL 职责边界 / bootstrap 装配序 / 工厂 wiring / update / 用户可见命令行为。域导航见 [assembly.md](assembly.md)，分层边界见 [layering.md](layering.md)。

## CLI 入口与参数

- `cli.ts` 入口分发：REPL（默认）/ `--run`（唯一 headless 入口：有参=文本或 `@file`，无参=stdin）/ `--serve` / `--resume-run` / `--version` / `--tools` / `update` / `eval` / `--feishu`；非交互且无 Key 时快速失败，不进首启向导。一次性命令经 `commands/registry.ts`（match → 执行 → 返回退出码，cli.ts 统一落 exitCode）；主 REPL / serve / headless 路径不经过这里。
- headless 退出码：只记录退出码，不提前 `process.exit`，统一走 gateway / Node API / transport / shutdown 清理后再落 `process.exitCode`（`headless-runner.ts`）。
- `cli-args.ts` 纯参数解析（语法与互斥），无副作用：`--serve` 默认端口 8642；`--resume-run` 与 `--run` / `--serve` / `--tools` / 位置式输入互斥；解析 `eval` 子命令与 `--feishu` 附加开关；`--connect` / `--connect-token` / `--ca`（别名 `--connect-ca`）/ `--allowed-origin`（可重复，需 `--serve`）。
- `cli-help-spec.ts` 是 CLI 按位置 help 的声明式数据（用法 / flag / 摘要），一份数据同时喂命令页、子命令列表与用法错误提示，避免帮助文案与错误提示两份漂移。
- `cli-overrides.ts` 把**显式** CLI flag 组装成 `Partial<VesselConfig>`（serve / connect / TLS / allowed-origins），作为 loader 的最高优先级层，未给出的字段不写入；bootstrap 接受 `cliOverrides` 并传给 loader（合并层语义见 [config.md](config.md#config-model)）。

## eval / --feishu 入口

- `eval` 是位置 0 的子命令；未知子命令 → parse error（退出码 2）。报告写盘由 `@vessel-agent/evals/report.ts` 负责，装配只传 `outDir` / `--out`。
- `--feishu` 是附加开关：TTY + 无 `--serve` → REPL + 渠道；非 TTY + 无 `--serve` → 仅渠道前台；`--serve` → gateway + 渠道。与 `--run` / `--pipe` / `--resume-run` / `--tools` / `--version` / `--help` 互斥。TUI 提供 `/metrics`、`/feishu`；启动横幅只在飞书已连接时追加一行。

## bootstrap 装配序与工厂

- `bootstrap.ts`：config → provider → plugins → `Runtime` → `ReplContext`；每 node 构造一次 `Runtime`，单 bundle 与成员 host 共用；按配置构造 delegate / team / MCP，装配 session backend 与 RunRecordStore；进程退出时关闭 MCP / Runtime 目录 / RunRecordStore。`LocalRpcClient` 的 `onEvent` 订阅 `runtimeEvents`，以只读方式转发 `events.event`。connect token / CA 只读 `config.connect`。`runs.resume` 按 `RunRecord.agent_id` 路由到成员 `AgentService`、否则按 session 取 EU（见 [member-team.md](member-team.md)）。
- `tenant-runtime-factory.ts:buildTenantRuntime` 单 bundle 工厂（名称保留，`tenantId` 是内部单 id）：构造 config / provider / session / run store / PluginHost / trace 的单份执行面，把 profile 注册到注入的 `Runtime`，插件只安装一次；`bundle.runtime` 是 per-session 门面（按 session 解析 EU），`bundle.pluginHost` 是共享 host。没有多 tenant bundle 缓存，`TenantRuntimeFactory` 已删除。
- `session-factory.ts`：`session.backend` → sqlite / file / memory。
- `run-record-store-factory.ts`：`durable.backend/path` → `FileRunRecordStore` / `MemoryRunRecordStore`；未启用返回 null。单公司根布局，不透传 tenant 字段。
- `durable-wiring.ts`：checkpoint / resume 的装配适配：Host 成员优先，其次单 agent runtime。
- `mcp-wiring.ts`：读取 `mcp_servers` → `createMcpPlugin`；构造 TUI / gateway 需要的状态适配器。
- `serve-config.ts:resolveServeOptions`：`serve.*` 默认值补全、远程/TLS 校验、证书文件检查；不再接收 argv，CLI 层已由 loader 合并（语义见 [config.md](config.md#config-model)）。
- `transport-factory.ts`：gateway / connect token 解析；loopback / remote transport 装配已删除。

## 声明式 feature 收集器与插件表面共享（ADR-107）

> 决策见 [ADR-107](../adr/ADR-107-assembly-feature-collector.md)（accepted）；设计稿与分期见外层仓 `docs/dev/reports/architecture-block-bootstrap-design.md` §3-§6。本节区分〔现行〕/〔实施中〕/〔提案〕，落地时翻标签并同步 frontmatter paths。

- 〔现行〕**两调用方手写 deps 是冲突与缺口的结构性根源**：`cli.ts`（网络面）与 `bootstrap.ts`（本地面，`createLocalRpcDispatcher` = `startGateway({localOnly:true})`，`packages/serve/src/local.ts`）各自手写一份 `GatewayOptions`。实证：并行 feature 反复撞 opts 尾部同一区域（merge 冲突）；R-1/R-6 两次「只接网络面、忘本地面」bug；双份 `plugins()` 数据源漂移（cli 读活配置有 disabled 补行，bootstrap 读启动配置没有，且跳过 child 行、未传 `pluginCatalog`）。
- 〔实施中，q-bootstrap-p0-surface〕**P0 共享工厂**：`src/plugin/plugin-surface.ts:createPluginSurface(input) → { entries(), catalog() }`，抽 cli 的 pluginRuntimeEntries / bundlePluginEntries / pluginCatalog 装配为两表面同源工厂（纯移动 + 参数化 `getConfig`）；bootstrap 本地面换源补 child 行与 `pluginCatalog`。验收硬闸：网络面输出逐字节不变 + 本地面 marketplace/usage 行可见 + catalog 非空。不改 serve 兜底（装配层拥有清单的契约边界）。
- 〔提案，P2 未实施〕**AssemblyFeature 声明式收集器**：`src/assembly/`（装配层，非 core），每宿主原生 feature 声明 `register(ctx) → Partial<GatewayOptions> + hotApply + result + shutdown`，装配层收集成一份 deps 两表面共消费。显式 import 清单（拒目录扫描/装饰器）；phase 硬闸（host → startOwner → dispatcher → surface）保 spawn 快照不变式；deps 值惰性活引用；键冲突 fail-closed；顺序承重脊柱永不进收集器。
- 〔提案〕**边界红线**（ADR-107 决策 6）：收集器只收编宿主原生 harness 接线面；能力注册（tool/provider/guardrail/hook）一律仍经 `Plugin.install(host)` 含宿主原生能力；插件永不进 feature 清单（loader/manifest/install 单一路径不变）；收集器不在 core、core 不感知。

## REPL 的职责边界

`ReplContext` 携带 `runtime`、`pluginHost`、`session`、`events`、`context`，以及 `mcp` / `runs` / `metrics` / `feishu` 控制面适配器。`context` 是**外壳只读镜像**：agent 启用时来自 `local-run-adapter.ts` 的会话镜像，否则是装配层新建的独立 `MemoryWorkingContext`；它不再与执行内核共享实例（WorkingContext 归每次 Run）。`/tools` 与 `/plugins` 从 `runtime.pluginHost` 读——不再有第二个只为展示而存在的 host。`@路径` 的展开发生在 shell 层（注入语义见 [runtime-api.md](runtime-api.md#messages)）。slash 命令全部从 ReplContext 取数，渲染层在 `packages/tui/src/cli/commands/commands.ts`。

## 用户可见命令行为

- `/clear` 只清屏，不清空会话历史；需要新会话用 `/new`（执行内核的 `WorkingContext` 本就随 Run 重建）。
- `@路径` 引用在发送前展开为注入消息，界面以引用块展示，用户原文不变。
- `/reload` 只重载配置文件并刷新 provider 信息，**不重扫插件目录**；新增插件需重启进程（`cli.ts:reloadVesselConfig`，与 `gateway.reload` 的 `reloadConfig` 同源）。
- `/mcp` 列出 server（name / status / 工具数）；`/mcp reconnect <name>` 显式重连。未配置 `mcp_servers` 时给明确提示。
- `/runs` 列出 running + interrupted（running 标注 live），按 `updated_at` 倒序、同值 `run_id` 升序，最多 20 条；`/runs resume <runId>` 恢复并继续 REPL。`durable.enabled: false` 时给明确提示。
- 启动横幅：仅当存在 MCP server 或 interrupted run 时追加一行提示；headless / serve 不输出。
- `--resume-run`：无参列出 interrupted run（`resume-command.ts`，只读、不需要 Key，读根布局 `<dataDir>/runs`，与执行面一致）；有参恢复（headless 与 REPL 均支持）。与 `--run` / `--serve` / `--tools` / 位置式输入互斥。
- `--tools` 的工具清单（`tools-list.ts`，不构造 runtime、不需要 Key）。

## update 行为

- `cli-update.ts`：`update [--check] [--channel latest|beta] [--json] [--force]`，只读检查与提示。`update/` 负责更新清单解析、GitHub 通道选择、24h 缓存、后台检查、semver 比较；不自替换。
- 读取 Release 的 `latest.json`，只提示版本与安装命令，不下载 / 不自替换。交互 REPL 启动时后台检查（24h 节流、失败静默、可关闭），有新版本时发布 `update.available`，由 TUI 渲染 banner。契约见 [operations/CI-CD.md](../operations/CI-CD.md)。