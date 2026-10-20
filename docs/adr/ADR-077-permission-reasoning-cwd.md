---
adr: 77
title: 权限交互时效、思考流与 agent.cwd（0.11.1 修复并入 0.12.0）
status: accepted
date: 2026-10-20
related: [29, 38, 55, 59]
tags: [permission, timeout, reasoning, cwd, web, tui, interaction]
---

## ADR-077：权限交互时效、思考流与 agent.cwd（0.11.1 修复并入 0.12.0）

- **上下文**：0.11.0 之后发现四个相互关联的正确性问题，原计划以 0.11.1 补丁线发布，后决定并入 0.12.0，不存在独立的 0.11.1 版本。它们分别是：Web 权限弹窗用过期的历史请求重新计时；权限等待超时被当成普通工具错误导致模型反复重试；思考增量默认外泄到 UI / trace；工具默认工作目录始终是进程 cwd，配置无法固定。前三者都涉及交互时效与事件语义，第四者涉及工具路径边界，合并在一个补丁批次中实现与验证。

- **决策**：
  1. **交互过期由事件时间推导**：Web 权限 / 提问的 `expiresAt = event.ts + 120s`（与 gateway interaction TTL 对齐）；缺失 / 非法 `ts`（旧 gateway）才回退当前时间。重放或刷新后的旧请求直接丢弃；入队时按 `requestId` 去重；应答返回 `not_found` 时移除弹窗并提示过期；同一 `requestId` 用同步占位守卫只允许一次提交。
  2. **权限超时是致命错误**：core 权限等待超时抛 `PermissionTimeoutError`（`code: 'permission_timeout'`），run 失败并保留该错误，不交给模型重试。等待时间固定 120s。
  3. **思考流显式 opt-in**：新增 `ui.showReasoning`（默认 `false`）。只有显式 `true` 时 provider 回调的 `reasoning_content` 才转为 `reasoning_delta` 并经 `llm.stream.chunk` 发布；TUI / Web 将增量合并为独立、可折叠的思考块。`trace.includeStreamChunks` 仍默认 `false`，思考增量默认不落 trace。
  4. **默认工作目录 `agent.cwd`**：支持 `~` 与相对路径（相对进程 cwd 解析）；优先级固定为工具参数 `cwd` > `agent.cwd` > `process.cwd()`。`bash` 未显式传 `cwd` 时使用它，`read` / `edit` 的相对路径按它解析；显式 `cwd` 仍优先，内置 denylist 与 `allowed_roots` 继续生效，配置的目录不放宽边界。
  5. **写入口统一**：`vessel config set` 支持 `ui.showReasoning` 与 `agent.cwd`，与 `ui.language` 一样只改用户配置、保留其它键、`0600` 原子写。

- **备选**：(a) 让 Web 在收到事件时重新计时——重放场景下会无限续期，服务端已丢弃的请求仍可点击；(b) 权限超时后继续让模型重试——掩盖配置问题并产生重复权限请求；(c) 默认发布思考流——思维链可能包含敏感内容，且 trace 体积与噪音显著增加；(d) 只让 `bash` 支持默认 cwd——`read` / `edit` 的相对路径会落在进程 cwd，与用户配置不一致；(e) 把 `agent.cwd` 作为强制沙箱——超出 `allowed_roots` 的语义会被改变。均不取。

- **后果**：权限交互的时效由事件本身决定，重连 / 刷新不会复活旧请求；超时成为可观测的失败原因。思考流默认关闭，需要显式开启并接受 trace 默认不记录增量。`agent.cwd` 统一 bash / read / edit 的默认目录，但不改变路径边界判定。由于 0.11.1 不单独发布，以上修复只出现在 0.12.0 的 CHANGELOG 与代码中；依赖 0.11.1 版本号的调用方应直接使用 0.12.0。

- **关联**：ADR-029（交互暂停事件流）、ADR-038（reasoning_content）、ADR-055（工具路径边界）、ADR-059（方法模块）；`packages/core/src/runtime/permission-policy.ts`、`packages/core/src/provider/providers.ts`、`apps/web/src/gateway/interactions.ts`、`apps/web/src/state/event-store.ts`、`src/reasoning.ts`、`src/path-resolution.ts`、`plugins/tools/basic-tools/src/index.ts`。
