---
title: 架构索引
kind: current
triggers: [architecture, runtime, gateway, config, event, tool, plugin, session, rpc, web, host, scheduler, member, team, federation, hub, topology, company, workspace, platform, owner, guest]
paths: [docs/architecture/**]
---

# 架构索引
> Stage 4 已落地：正文描述的是 `Assembly → Runtime → ExecutionUnit → Run → Loop` 的已实现状态；目标/迁移决策仍见 [0.34-target.md](0.34-target.md) 与 [ADR-098](../adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)（accepted；tenant 部分已被 ADR-100/T0–T5 取代）。

按目标或路径命中；命中后只读对应模块，不整读全部。未命中时回落 `AGENTS.md` 硬规则，不把“没搜到”当“没规则”。历史见 `docs/versions/INDEX.md` 与 `docs/adr/README.md`。

> 检索：`bun run scripts/docs-find.ts --goal "<目标>" --paths <路径>`；本索引只做导航，命中后只读模块。

| 模块 | 一句话 | triggers | paths |
|---|---|---|---|
| [overview](overview.md) | 三层结构、依赖方向、两个适配器与 core 边界 | layering, dependency, kernel, module, adapter, core | `packages/core/**`, `plugins/**` |
| [runtime-lifecycle](runtime-lifecycle.md) | `Runtime` / per-session `ExecutionUnit`、`run()` / `resumeRun()` 外壳、单 run 占位、`finalizeRun` 终态与 `RunJournal` 唯一写者 | run, resume, finalize, execution, checkpoint, cancel, run_already_running, runtime, execution unit, journal | `packages/core/src/runtime/**` |
| [runtime-loop](runtime-loop.md) | `toolCallingLoop` 骨架、关键约束与 provider 重试 | loop, tool call, iteration, guardrail, hook, reasoning, retry, provider error | `packages/core/src/runtime/**` |
| [runtime-api](runtime-api.md) | `RunOptions.messages` 注入语义、`Runtime` / `TenantRuntimeProfile` / `ExecutionUnitRequest` 与 `ExecutionUnit` 公开面 | RunOptions, messages, injection, runtime, tenant profile, execution unit, context, at-path | `packages/core/src/runtime/**`, `packages/core/src/types/**` |
| [context](context.md) | WorkingContext per Run、注入点、压缩与前缀不变量 | context, message, injection, compaction, self card, vessel:source, prefix, per-run | `packages/core/src/context/**`, `packages/core/src/runtime/execution-unit.ts`, `packages/core/src/session/project-messages.ts`, `packages/agent/src/runtime.ts` |
| [session-length](session-length.md) | 会话长度的四套机制（投射 / 压缩 / 体积阈值 / rotate）与「体积阈值该放会话层还是工具层」的归属决策 | session length, context window, token budget, projection, placeholder, compaction, compact threshold, tool result volume, volume threshold, rotate, handoff, pagination | `packages/core/src/context/context-manager.ts`, `packages/core/src/runtime/execution-unit.ts`, `packages/agent/src/tool.ts` |
| [env-info-append-only](env-info-append-only.md) | 落盘消息只能 append：环境信息一类卡、scope 词表、增量视图、请求级占位 | append-only, env info, environment, notice, scope, tool surface, model change, files, doc-subscription, prompt.system_context, changed | `packages/core/src/runtime/execution-unit.ts`, `packages/agent/src/env-info-scope.ts`, `plugins/context/doc-subscription/src/notice.ts`, `apps/web/src/domains/chat/env-notice.ts`, `scripts/check-append-only-context.ts` |
| [interfaces](interfaces.md) | `LLMProvider` / `WorkingContext` / `EventStream` 契约 | LLMProvider, ChatRequest, WorkingContext, EventStream, types | `packages/core/src/types/provider.ts`, `context.ts`, `event.ts` |
| [state](state.md) | `SessionStore` / `LimitChecker` / `RunRecordStore` 状态 port | session, run store, checkpoint, durable, limits, corruption | `packages/core/src/types/session.ts`, `limits.ts`, `run-record-store.ts` |
| [tools](tools.md) | `ToolDefinition`、能力工具与权限/路径边界 | tool, bash, read, edit, permission, denylist, allowed_roots, inbox, subscribe | `packages/core/src/types/tool.ts`, `plugins/tools/**` |
| [guardrails-hooks](guardrails-hooks.md) | Guardrail 四阶段与 Hook 五阶段 | guardrail, hook, replacement, tool_call, before_llm | `packages/core/src/types/guardrail.ts`, `hook.ts` |
| [extensions](extensions.md) | Plugin / PluginHost、发现与信任边界 | plugin, plugin host, loader, discovery, trust, external, mcp, skill | `packages/core/src/types/plugin.ts`, `src/plugin-loader.ts`, `plugins/**` |
| [plugins](plugins.md) | 能力插件与体验插件：清单、发现、激活、信任、AI 流位置与热重载 | plugin, manifest, capability, experience, contribution, activation, reload, child process, trust, catalog, vessel.catalog | `plugins/**`, `src/plugin-loader.ts`, `packages/serve/src/plugin-host/**`, `apps/web/src/domains/plugins/**` |
| [plugin-registry](plugin-registry.md) | GitHub 静态 registry、index.json、发布流程与 marketplace 安装/校验 | plugin, registry, marketplace, install, update, checksum, index.json, github | `plugins/marketplace/**`, `docs/architecture/plugin-registry.md` |
| [config](config.md) | 配置层序、resolver 与配置块 | config, yaml, precedence, env, data-dir lock, secrets | `packages/config/**`, `src/cli-overrides.ts` |
| [events](events.md) | 事件命名、核心事件、回放与 trace 落盘 | event, event stream, trace, replay, observability, seq, agent.message.notified | `packages/core/src/types/event.ts`, `packages/core/src/events/**` |
| [event-log-policy](event-log-policy.md) | 会话事件日志落盘口径：只有一种格式（timeline：`wal.log` / `wal.blocks/` / 归档段）、0.54 之前的旧格式在 0.55 不再支持（`legacy_session_unsupported`，不读不写不迁移）、瞬时 chunk 不占 `timeline_seq`、`llm.stream.summary` / `llm.request` 只落骨架 | event log, timeline, wal, 落盘, 瞬时 chunk, legacy_session_unsupported, 旧格式, llm.request, stream summary | `packages/core/src/timeline/writer.ts`, `packages/core/src/timeline/blocks.ts`, `packages/core/src/timeline/legacy-format.ts` |
| [session-replay](session-replay.md) | 会话重放总架构：唯一读路径（单游标 + 单区间回填 + 四条硬校验）、`timeline.hello` 声明与 `count`、等式与 `published_head`、污点条与 `timeline.gap_reported`、单区间封顶与按段续拉 | replay, session replay, 单游标, client_timeline_seq, timeline_seq, 区间回填, 四条校验, timeline.hello, published_head, holes, tainted, 污点条, 无洞, 回填 | `apps/web/src/gateway/timeline-protocol.ts`, `apps/web/src/gateway/subscription.ts`, `apps/web/src/state/event-store.ts`, `packages/serve/src/protocol.ts`, `packages/serve/src/gateway/timeline-protocol.ts` |
| [unacked-queue-closure](unacked-queue-closure.md) | 0.53 不遗漏判据里「已发布、未落盘」那个集合在 0.54 的结案：I2 令其为空集、等式退化为 `timeline ∪ WAL` 两段、0.53 四问逐条「不需要」、chunk 的 150 ms 内存窗口边界、A5 断言探针与「契约 ≠ 现状」 | unacked, 未确认队列, 未落盘, 已发布未落盘, timeline_head, wal_head, published_head, 发布早于 WAL, holes, 对账, 结案 | `packages/core/src/timeline/writer.ts`, `packages/core/src/timeline/blocks.ts`, `packages/core/src/timeline/holes.ts`, `src/timeline-dual-write.ts`, `scripts/check-timeline-holes.ts` |
| [assembly](assembly.md) | `src/` 装配层、CLI/TUI 入口与职责边界 | bootstrap, cli, args, wiring, repl, headless | `src/**` |
| [gateway](gateway.md) | 帧/端点、静态托管与安全、TLS、远程控制面 | gateway, websocket, sse, tls, origin, csp, remote | `packages/serve/src/**`, `src/rpc/**` |
| [gateway-lifecycle](gateway-lifecycle.md) | 单点启动与进程生命周期**职责边界**：gateway / node / hub 谁拥有谁、五行动作表、分段启动与错误域隔离（细节见 operations/GATEWAY.md） | gateway, lifecycle, 生命周期, 单点启动, adopt, 分段启动, 错误域, 隔离, detached, 孤儿, stop | `src/gateway/**`, `src/gateway-command.ts`, `docs/operations/GATEWAY.md` |
| [gateway-rpc](gateway-rpc.md) | 统一 RPC 方法表与 canonical agent 生命周期契约 | rpc, method, canonical, envelope, agents.create, sessions.create, sessions.restart, sessions.activate, plugins.catalog | `packages/serve/src/gateway/methods/**` |
| [gateway-web](gateway-web.md) | 权限/ask 桥、会话切换与 Web 控制台 | web, apps/web, permission bridge, ask, session switch | `apps/web/**`, `packages/serve/src/gateway/**` |
| [host](host.md) | 每 node 一个 Scheduler、per-node `Runtime` 无状态工厂、per-session EU、per-body 串行、resume 排队与快照 | host, scheduler, runtime, execution unit, concurrency, serial, resume, snapshot, checkpoint, cancel, queue | `packages/core/src/kernel/**`, `packages/core/src/runtime/**` |
| [member-team](member-team.md) | AgentService、单 Body、admit/dispatch/rotate、peer/contractor、Team 与预算 | agent, member, team, body, admit, dispatch, rotate, spawn, peer, contractor, freeze, presence, roster, budget | `packages/agent/**`, `src/agent-service-wiring.ts` |
| [agent-structure](agent-structure.md) | 成员/临时的定义、数据模型、创建路径与转换设计 | agent, member, peer, contractor, temporary, owner, create, hire, promote, demote, from_session_id, seed | `packages/agent/**`, `apps/web/src/domains/agents/**`, `apps/web/src/domains/team/**` |
| [federation-hub](federation-hub.md) | hub 目录控制面与跨节点 federation 数据面 | hub, federation, peer, pairing, directory, allowlist, hop | `src/hub/**`, `src/federation-*.ts`, `packages/serve/src/gateway/**` |
| [topology](topology.md)（kind: current） | 公司拓扑现态：Platform Gateway / Node API、四层（Platform / Workspace / Team / Agent）、插件归属、Hub 属 Platform | topology, company, workspace, platform, team, plugin scope, ownership, tenant, guest, node registry, gateway nodes, data_locked | `src/hub/**`, `src/gateway/**`, `src/plugin-loader.ts`, `packages/serve/src/platform/**`, `packages/serve/src/plugin-host/**`, `plugins/**` |
| [gateway-capabilities](gateway-capabilities.md) | 四组能力矩阵（A 生命周期 / B 对外暴露 / C 连接发现 / D 运维）、现状三值、可判定验收判据、不做时的替代方案 | gateway capability, lifecycle, tls, ticket, rate limit, audit, metrics, health probe, circuit breaker, adopt, version gate, registry, routing | `packages/serve/src/platform/**`, `src/gateway-command.ts`, `src/gateway/**` |
| [message-invariants](message-invariants.md)（kind: current） | **两条产品核心不变量**：① 可见性对等（UI 必须含 agent 看到的全部消息）② 请求 messages append-only（改写中间内容会打掉 prefix 缓存）；实现推论与门禁方向 | message, append-only, prefix, prompt cache, pii, mask, handle, visibility, symmetry, transcript, request | `docs/architecture/message-invariants.md` |
| [0.34-target](0.34-target.md)（kind: target） | 目标/迁移态：五词、附属词、分层、10 边界、C1–C4、10 裁决、4 连线、3 铁律、Stage 0–4、5 图 | target, migration, layering, agent, session, runtime, loop, run, control plane, execution unit, lease, federation | `docs/architecture/**`, `packages/core/**`, `packages/agent/**`, `src/**` |
| [0.55-gateway-proxies-node](0.55-gateway-proxies-node.md)（kind: target） | 目标/迁移态：WebUI/CLI 只连 gateway，由平台代理 node 的 HTTP + WS；`platform.nodes.credentials` 退化为 CLI 专用；延迟预算、方法白名单、WS 背压/半开/心跳与 `gateway.ws.closed` 唯一口径、`node_id` 缺省规则、7 条风险 | gateway proxy, node 代理, 直连, platform.nodes.credentials, node token, ws, 背压, 半开, 心跳, csp, 延迟预算, 多节点, 鉴权, 白名单 | `packages/serve/src/platform/**`, `src/gateway-command.ts`, `src/gateway/**`, `apps/web/src/gateway/**` |

## 主题入口

- **host / scheduler / checkpoint** → [host](host.md) · [runtime-lifecycle](runtime-lifecycle.md#run) · [state](state.md#run-store)
- **member / team / agent / body** → [member-team](member-team.md) · [gateway-rpc](gateway-rpc.md#agent-lifecycle) · [docs/agents/agent.md](../agents/agent.md)
- **federation / hub / attention / 跨节点** → [federation-hub](federation-hub.md) · [gateway](gateway.md#remote) · [REMOTE.md](../operations/REMOTE.md)
- **拓扑 / 公司 / 插件归属 / Hub 边界** → [topology](topology.md) · [plugins](plugins.md)
- **gateway 职责 / 票据 / 单点预算** → [gateway-capabilities](gateway-capabilities.md) · [ADR-103](../adr/ADR-103-gateway-responsibilities.md) · [gateway-plan](../dev/research/gateway-plan.md)
- **node 代理 / 不再直连 node / node token 不出平台** → [0.55-gateway-proxies-node](0.55-gateway-proxies-node.md) · [topology](topology.md)
