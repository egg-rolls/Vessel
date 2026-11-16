---
title: 规格索引
kind: current
triggers: [spec, design, brief, 规格, 设计, 定稿, 投影卡, 刷新丢事件, 重连回放缺口, 工具名合法性]
paths: [docs/specs/**]
---

# 规格索引

> 本目录放「某功能的定稿」（实现前读它，实现后冻结；退场即转历史，见第 09 条）。
> 放这里的前提是第 01 条：**别人不知道会不会做错** → 会，所以进共享侧；规格必须自包含，不设跳转。
> 命中后只读对应文件；未命中回落 `AGENTS.md` 硬规则。
> 本索引只登记 P3（规格与设计）。同目录的 `plan-*` / `task-*` / `handoff-*` / `*-report` /
> `*-findings` / `*-probe` / `*-measurement` / `*-cost-model` / `doc-map-proposal` 按第 01 条第 3 款
> 属个人侧，不计入本索引。

| 文件 | 一句话 | triggers | paths |
| --- | --- | --- | --- |
| [projection-card-spec](projection-card-spec.md) | 投影卡：让用户同时看到「模型看到的占位符」与原文，复用现有卡片能力 | 投影卡, 占位符与原文同时可见, 模型视角 原文视角, 压缩后原文不见了, 归档卡, externalize 句柄卡 | `packages/core/src/context/**`, `apps/web/src/domains/chat/**` |
| [refresh-gap-design](refresh-gap-design.md) | 刷新/重连后前端丢失事件：丢失窗口界定与回填方案（方案 B = `sessions.events` 磁盘回填） | 刷新丢事件, 重连回放缺口, 环形缓冲淘汰, gap 回填, 消息身份 id | `packages/serve/src/event-buffer.ts`, `apps/web/src/gateway/**`, `apps/web/src/state/event-store.ts` |
| [replay-gap-brief](replay-gap-brief.md) | 刷新后会话事件遗漏：重放总架构的调研简报（snapshot then delta / 全局单调 seq / gap 协议） | 刷新丢事件, 重放总架构, snapshot then delta, 断线重连无洞, 事件游标设计 | `docs/architecture/session-replay.md` |
| [tool-name-legality](tool-name-legality.md) | 工具名必须 provider-safe：`pii.reveal` 事故的通用教训与注册期 fail-fast | 工具名带点号, pii.reveal 改名 piiReveal, provider-safe 工具名 正则, 新增工具怎么命名 | `packages/core/src/runtime/plugin-host.ts`, `packages/core/src/types/tool.ts`, `src/legacy-tool-names.ts` |

