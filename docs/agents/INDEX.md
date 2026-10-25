---
title: Agent 领域告诫索引
kind: current
triggers: [agents, advisory, core, agent, serve, web, tui, plugins, gov]
paths: [docs/agents/**]
---

# Agent 领域告诫索引

改对应路径前读一篇即可；未命中时以 [AGENTS.md](../../AGENTS.md) 的硬安全规则为准。本索引只做下一跳，不写规则正文。

> 检索：`bun run scripts/docs-find.ts --goal "<目标>" --paths <路径>`；本索引只做导航，命中后只读模块。

| 模块 | 一句话 | triggers | paths |
|---|---|---|---|
| [core](core.md) | core 边界、Module、事件命名、tool pipeline、compaction、config resolver、存储 | core, runtime, run, resume, loop, tool pipeline, event, config, compaction, limits, lock, storage | `packages/core/**`, `packages/config/**` |
| [agent](agent.md) | AgentService、成员/team、session/body、dispatch、预算 | agent, member, team, session, dispatch, rotate, fork, budget, visibility | `packages/agent/**` |
| [serve](serve.md) | gateway/RPC/远程/tenant 事件/hub/attention | gateway, serve, rpc, remote, tls, origin, hub, tenant, attention, node_id, shutdown | `packages/serve/**`, `src/rpc/**` |
| [web](web.md) | Web i18n、token 存储、内联交互卡 | web, apps/web, i18n, locale, sessionStorage, permission card, ask_user | `apps/web/**` |
| [tui](tui.md) | TUI + CLI 终端面文案/样式/命令注册 | tui, cli, repl, terminal, i18n, sanitize, ansi, command, help, ask_user | `packages/tui/**`, `src/i18n/**`, `src/ui-style.ts`, `src/commands/**`, `src/cli.ts` |
| [plugins](plugins.md) | 插件发现/信任/生命周期/MCP/skills | plugin, plugin host, discovery, trust, external, dispose, mcp, skill, evals | `plugins/**`, `src/plugin-loader.ts`, `src/plugin-selection.ts` |
| [gov](gov.md) | 文档生命周期、角色路径、门禁、发布/CI | docs, doc management, frontmatter, check-docs, release, ci, pr, roles, worktree | `docs/**`, `AGENTS.md`, `README.md`, `.github/**`, `scripts/**` |

## 主题入口

- **core / runtime / host / scheduler** → [core](core.md) · [architecture/host](../architecture/host.md) · [architecture/runtime-lifecycle](../architecture/runtime-lifecycle.md)
- **member / team / agent / body** → [agent](agent.md) · [architecture/member-team](../architecture/member-team.md) · [architecture/gateway-rpc](../architecture/gateway-rpc.md#agent-lifecycle)
- **federation / hub / attention / 远程** → [serve](serve.md) · [architecture/federation-hub](../architecture/federation-hub.md) · [REMOTE.md](../operations/REMOTE.md)
