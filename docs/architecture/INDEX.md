---
title: 架构索引
kind: current
triggers: [architecture, runtime, gateway, config, event, tool, plugin, session, rpc, web, host, scheduler, member, team, federation, hub, topology, company, workspace, platform, owner, guest]
paths: [docs/architecture/**]
---

# 架构索引
> Stage 4 已落地：正文描述的是 `Assembly → Runtime → ExecutionUnit → Run → Loop` 的已实现状态；目标/迁移决策仍见 [0.34-target.md](0.34-target.md) 与 [ADR-098](../adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)。

按目标或路径命中；命中后只读对应模块，不整读全部。未命中时回落 `AGENTS.md` 硬规则，不把“没搜到”当“没规则”。历史见 `docs/versions/INDEX.md` 与 `docs/adr/README.md`。

> 检索：`bun run scripts/docs-find.ts --goal "<目标>" --paths <路径>`；本索引只做导航，命中后只读模块。

| 模块 | 一句话 | triggers | paths |
|---|---|---|---|
| [overview](overview.md) | 三层结构、依赖方向、两个适配器与 core 边界 | layering, dependency, kernel, module, adapter, core | `packages/core/**`, `plugins/**` |
| [runtime-lifecycle](runtime-lifecycle.md) | `Runtime` / per-session `ExecutionUnit`、`run()` / `resumeRun()` 外壳、单 run 占位、`finalizeRun` 终态与 `RunJournal` 唯一写者 | run, resume, finalize, execution, checkpoint, cancel, run_already_running, runtime, execution unit, journal | `packages/core/src/runtime/**` |
| [runtime-loop](runtime-loop.md) | `toolCallingLoop` 骨架与关键约束 | loop, tool call, iteration, guardrail, hook, reasoning | `packages/core/src/runtime/**` |
| [runtime-api](runtime-api.md) | `RunOptions.messages` 注入语义、`Runtime` / `TenantRuntimeProfile` / `ExecutionUnitRequest` 与 `ExecutionUnit` 公开面 | RunOptions, messages, injection, runtime, tenant profile, execution unit, context, at-path | `packages/core/src/runtime/**`, `packages/core/src/types/**` |
| [context](context.md) | WorkingContext per Run、注入点、压缩与前缀不变量 | context, message, injection, compaction, self card, vessel:source, prefix, per-run | `packages/core/src/context/**`, `packages/core/src/runtime/execution-unit.ts`, `packages/core/src/session/project-messages.ts`, `packages/agent/src/runtime.ts` |
| [interfaces](interfaces.md) | `LLMProvider` / `WorkingContext` / `EventStream` 契约 | LLMProvider, ChatRequest, WorkingContext, EventStream, types | `packages/core/src/types/provider.ts`, `context.ts`, `event.ts` |
| [state](state.md) | `SessionStore` / `LimitChecker` / `RunRecordStore` 状态 port | session, run store, checkpoint, durable, limits, corruption | `packages/core/src/types/session.ts`, `limits.ts`, `run-record-store.ts` |
| [tools](tools.md) | `ToolDefinition`、能力工具与权限/路径边界 | tool, bash, read, edit, permission, denylist, allowed_roots, inbox, subscribe | `packages/core/src/types/tool.ts`, `plugins/tools/**` |
| [guardrails-hooks](guardrails-hooks.md) | Guardrail 四阶段与 Hook 五阶段 | guardrail, hook, replacement, tool_call, before_llm | `packages/core/src/types/guardrail.ts`, `hook.ts` |
| [extensions](extensions.md) | Plugin / PluginHost、发现与信任边界 | plugin, plugin host, loader, discovery, trust, external, mcp, skill | `packages/core/src/types/plugin.ts`, `src/plugin-loader.ts`, `plugins/**` |
| [plugins](plugins.md) | 能力插件与体验插件：清单、发现、激活、信任、AI 流位置与热重载 | plugin, manifest, capability, experience, contribution, activation, reload, child process, trust, catalog, vessel.catalog | `plugins/**`, `src/plugin-loader.ts`, `packages/serve/src/plugin-host/**`, `apps/web/src/domains/plugins/**` |
| [plugin-registry](plugin-registry.md) | GitHub 静态 registry、index.json、发布流程与 marketplace 安装/校验 | plugin, registry, marketplace, install, update, checksum, index.json, github | `plugins/marketplace/**`, `docs/architecture/plugin-registry.md` |
| [config](config.md) | 配置层序、resolver 与配置块 | config, yaml, precedence, env, data-dir lock, secrets | `packages/config/**`, `src/cli-overrides.ts` |
| [events](events.md) | 事件命名、核心事件、回放与 trace 落盘 | event, event stream, trace, replay, observability, seq, agent.message.notified | `packages/core/src/types/event.ts`, `packages/core/src/events/**` |
| [assembly](assembly.md) | `src/` 装配层、CLI/TUI 入口与职责边界 | bootstrap, cli, args, wiring, repl, headless | `src/**` |
| [gateway](gateway.md) | 帧/端点、静态托管与安全、TLS、远程控制面 | gateway, websocket, sse, tls, origin, csp, remote | `packages/serve/src/**`, `src/rpc/**` |
| [gateway-rpc](gateway-rpc.md) | 统一 RPC 方法表与 canonical agent 生命周期契约 | rpc, method, canonical, envelope, agents.create, sessions.create, sessions.restart, sessions.activate, plugins.catalog | `packages/serve/src/gateway/methods/**` |
| [gateway-web](gateway-web.md) | 权限/ask 桥、会话切换与 Web 控制台 | web, apps/web, permission bridge, ask_user, session switch | `apps/web/**`, `packages/serve/src/gateway/**` |
| [host](host.md) | 每 node 一个 Scheduler、per-node `Runtime` 无状态工厂、per-session EU、per-body 串行、resume 排队与快照 | host, scheduler, runtime, execution unit, concurrency, serial, resume, snapshot, checkpoint, cancel, queue | `packages/core/src/kernel/**`, `packages/core/src/runtime/**` |
| [member-team](member-team.md) | AgentService、单 Body、admit/dispatch/rotate、peer/contractor、Team 与预算 | agent, member, team, body, admit, dispatch, rotate, spawn, peer, contractor, freeze, presence, roster, budget | `packages/agent/**`, `src/agent-service-wiring.ts` |
| [agent-structure](agent-structure.md) | 成员/临时的定义、数据模型、创建路径与转换设计 | agent, member, peer, contractor, temporary, owner, create, hire, promote, demote, from_session_id, seed | `packages/agent/**`, `apps/web/src/domains/agents/**`, `apps/web/src/domains/team/**` |
| [federation-hub](federation-hub.md) | hub 目录控制面与跨节点 federation 数据面 | hub, federation, peer, pairing, directory, allowlist, hop | `src/hub/**`, `src/federation-*.ts`, `packages/serve/src/gateway/**` |
| [topology](topology.md)（kind: current） | 公司拓扑现态：Platform Gateway / Node API、四层（Platform / Workspace / Team / Agent）、插件归属、Hub 属 Platform | topology, company, workspace, platform, team, plugin scope, ownership, tenant, guest, node registry, gateway nodes, data_locked | `src/hub/**`, `src/gateway/**`, `src/plugin-loader.ts`, `packages/serve/src/platform/**`, `packages/serve/src/plugin-host/**`, `plugins/**` |
| [0.34-target](0.34-target.md)（kind: target） | 目标/迁移态：五词、附属词、分层、10 边界、C1–C4、10 裁决、4 连线、3 铁律、Stage 0–4、5 图 | target, migration, layering, agent, session, runtime, loop, run, control plane, execution unit, lease, federation | `docs/architecture/**`, `packages/core/**`, `packages/agent/**`, `src/**` |

## 主题入口

- **host / scheduler / checkpoint** → [host](host.md) · [runtime-lifecycle](runtime-lifecycle.md#run) · [state](state.md#run-store)
- **member / team / agent / body** → [member-team](member-team.md) · [gateway-rpc](gateway-rpc.md#agent-lifecycle) · [docs/agents/agent.md](../agents/agent.md)
- **federation / hub / attention / 跨节点** → [federation-hub](federation-hub.md) · [gateway](gateway.md#remote) · [REMOTE.md](../operations/REMOTE.md)
- **拓扑 / 公司 / 插件归属 / Hub 边界** → [topology](topology.md) · [plugins](plugins.md)
