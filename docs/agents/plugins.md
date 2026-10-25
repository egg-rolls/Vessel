---
title: 插件发现、信任与生命周期
kind: advisory
triggers: [plugin, plugin host, discovery, trust, external, dispose, mcp, skill, evals]
paths: [plugins/**, src/plugin-loader.ts, src/plugin-selection.ts]
applies_to: [N, M]
---

# 插件发现、信任与生命周期

> 改 `plugins/**` 或 plugin loader 前读这一篇；信任决策与残余风险以 [AGENTS.md](../../AGENTS.md) 硬安全规则为准。

## 唯一扩展机制

- 一切走 `Plugin` + `PluginHost`；插件对象走 `plugins` / `pluginHost` 注入，不塞进 runtime 构造函数。
- 插件可注册 tool / provider / guardrail / hook；不新增第二套运行期扩展机制（ADR-004）。

<a id="discovery"></a>

## 发现顺序

- 默认扫描根：`repo`（仓库 `plugins/`）→ `project`（`./.vessel/plugins`）→ `user`（`~/.vessel/plugins`）→ `node_modules`（仓库根与 cwd）；同名插件**先出现者胜出**。
- 插件目录只在进程启动时扫描一次；新增或改动插件需重启进程，`/reload` 不重扫。
- 默认集、外部插件告警与 `VESSEL_NO_EXTERNAL_PLUGINS` 的实现见 `src/plugin-loader.ts` / `src/plugin-selection.ts`；策略与 P0-3 残余风险见 AGENTS 硬规则，本文件不复述。

## 生命周期

- `install()` 期间创建的资源（连接、定时器、子进程、句柄、订阅）必须实现 `dispose()` 释放；`dispose()` 必须幂等。
- `init()` 在所有插件安装完成后按安装顺序调用；不得假设“后续插件已安装”。
- 安装阶段 fail-fast：失败由 `beginPluginInstall()` 的 `rollback()` 清理，不要手动逐个反注册，也不要把安装失败改成隔离继续（ADR-065）。

## 异常隔离

- Hook 抛错发 `hook.failed` / `hook.error` 后继续后续 hook；`OnError` best-effort。
- Guardrail `check()` 抛错按 fail-closed（`allowed:false` + `guardrail_error`，发 `guardrail.error`）。
- 不得靠 hook / guardrail 抛异常终止 run；要阻断返回 `allowed:false`，要停止就 abort（ADR-054）。

## MCP / evals / skills

- MCP 的默认 deny 与放行规则见 AGENTS 硬规则；实现按原始工具名精确匹配（ADR-039）。
- evals 的离线双门控见 AGENTS 硬规则；运行器与报告见 ADR-043。
- skills 就是文件，经消息进来；不写 harness 层的扫描 / 解析 / 注入通道。
- `team_*` / `delegate_task` 已删除；evals / feishu / MCP 只做插件，不进 core（ADR-043/044/090）。

## 指针

- [extensions.md](../architecture/extensions.md) · [tools.md](../architecture/tools.md) · [CONFIG.md](../operations/CONFIG.md)。
