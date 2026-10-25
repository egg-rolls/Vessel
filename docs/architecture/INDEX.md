---
title: 架构索引
kind: current
triggers: [architecture, runtime, gateway, config, event, tool, plugin, session, rpc, web, host, scheduler, member, team, federation, hub]
paths: [docs/architecture/**]
---

# 架构索引

按目标或路径命中；命中后只读对应模块，不整读全部。未命中时回落 `AGENTS.md` 硬规则，不把“没搜到”当“没规则”。历史见 `docs/versions/INDEX.md` 与 `docs/adr/README.md`。

> 检索：`bun run scripts/docs-find.ts --goal "<目标>" --paths <路径>`；本索引只做导航，命中后只读模块。

| 模块 | 一句话 | triggers | paths |
|---|---|---|---|
| [overview](overview.md) | 三层结构、依赖方向、两个适配器与 core 边界 | layering, dependency, kernel, module, adapter, core | `packages/core/**`, `plugins/**` |
| [runtime-lifecycle](runtime-lifecycle.md) | `run()` / `resume()` 外壳、单 run 占位与 `finalizeRun` 终态 | run, resume, finalize, execution, checkpoint, cancel, run_already_running | `packages/core/src/runtime/**` |
| [runtime-loop](runtime-loop.md) | `toolCallingLoop` 骨架与关键约束 | loop, tool call, iteration, guardrail, hook, reasoning | `packages/core/src/runtime/**` |
| [runtime-api](runtime-api.md) | `RunOptions.messages` 注入语义与 `AgentRuntime` 公开面 | RunOptions, messages, injection, agent runtime, context, at-path | `packages/core/src/runtime/**`, `packages/core/src/types/**` |
| [interfaces](interfaces.md) | `LLMProvider` / `ContextManager` / `EventStream` 契约 | LLMProvider, ChatRequest, ContextManager, EventStream, types | `packages/core/src/types/provider.ts`, `context.ts`, `event.ts` |
| [state](state.md) | `SessionBackend` / `LimitChecker` / `RunStore` 状态 port | session, run store, checkpoint, durable, limits, corruption | `packages/core/src/types/session.ts`, `limits.ts`, `run-store.ts` |
| [tools](tools.md) | `ToolDefinition`、能力工具与权限/路径边界 | tool, bash, read, edit, permission, denylist, allowed_roots | `packages/core/src/types/tool.ts`, `plugins/tools/**` |
| [guardrails-hooks](guardrails-hooks.md) | Guardrail 四阶段与 Hook 五阶段 | guardrail, hook, replacement, tool_call, before_llm | `packages/core/src/types/guardrail.ts`, `hook.ts` |
| [extensions](extensions.md) | Plugin / PluginHost、发现与信任边界 | plugin, plugin host, loader, discovery, trust, external, mcp, skill | `packages/core/src/types/plugin.ts`, `src/plugin-loader.ts`, `plugins/**` |
| [config](config.md) | 配置层序、resolver 与配置块 | config, yaml, precedence, env, tenant overlay, secrets | `packages/config/**`, `src/cli-overrides.ts` |
| [events](events.md) | 事件命名、核心事件、回放与 trace 落盘 | event, event stream, trace, replay, observability, seq | `packages/core/src/types/event.ts`, `packages/core/src/events/**` |
| [assembly](assembly.md) | `src/` 装配层、CLI/TUI 入口与职责边界 | bootstrap, cli, args, wiring, repl, headless | `src/**` |
| [gateway](gateway.md) | 帧/端点、静态托管与安全、TLS、远程控制面 | gateway, websocket, sse, tls, origin, csp, remote | `packages/serve/src/**`, `src/rpc/**` |
| [gateway-rpc](gateway-rpc.md) | 统一 RPC 方法表与 canonical agent 生命周期契约 | rpc, method, canonical, envelope, agents.create, agents.rotate | `packages/serve/src/gateway/methods/**` |
| [gateway-web](gateway-web.md) | 权限/ask 桥、会话切换与 Web 控制台 | web, apps/web, permission bridge, ask_user, session switch | `apps/web/**`, `packages/serve/src/gateway/**` |
| [host](host.md) | RuntimeHost / Scheduler、per-run session、resume 排队与快照 | host, scheduler, concurrency, resume, snapshot, checkpoint, cancel | `packages/core/src/kernel/**`, `packages/core/src/runtime/**` |
| [member-team](member-team.md) | AgentService、Agent/Body、dispatch/rotate、peer/contractor、Team 与预算 | agent, member, team, body, dispatch, rotate, spawn, peer, contractor, freeze, presence, roster, budget | `packages/agent/**`, `src/agent-service-wiring.ts` |
| [federation-hub](federation-hub.md) | hub 目录控制面与跨节点 federation 数据面 | hub, federation, peer, pairing, directory, allowlist, hop | `src/hub/**`, `src/federation-*.ts`, `packages/serve/src/gateway/**` |

## 主题入口

- **host / scheduler / checkpoint** → [host](host.md) · [runtime-lifecycle](runtime-lifecycle.md#run) · [state](state.md#run-store)
- **member / team / agent / body** → [member-team](member-team.md) · [gateway-rpc](gateway-rpc.md#agent-lifecycle) · [docs/agents/agent.md](../agents/agent.md)
- **federation / hub / attention / 跨节点** → [federation-hub](federation-hub.md) · [gateway](gateway.md#remote) · [REMOTE.md](../operations/REMOTE.md)
