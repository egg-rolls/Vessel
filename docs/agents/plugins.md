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

- 只有一个 plugin loader / manifest / 生命周期；插件对象走 `plugins` / `pluginHost` 注入，不塞进 runtime 构造函数。
- **能力插件**（in-process）经 `PluginHost` 注册 tool / provider / guardrail / hook；**贡献面**（pages / commands / settings / rpc / events / panels / toolbar）由 harness 层持有与收集，不是 core 的第二套扩展机制。`contributes.toolbar[]` 是 declarative 按钮声明（slot 只有 `composer`），点击由宿主按 `id` 映射，插件不拿宿主回调。
- 不新增第二套运行期扩展机制；禁止 `ModuleHost` / `ModuleRegistry`（ADR-004 / ADR-037 / ADR-099）。

## Manifest 门禁

- `package.json.vessel.contributes.rpc[].name` 必须是裸名，匹配
  `^[a-z][a-z0-9_-]*$`（宿主注册为 `plugin.<id>.<name>`）；清单的 engines / entry /
  contributes / permissions 错误同样 fail-closed。
- 提交前跑 `bun run scripts/check-rpc-methods.ts`：扫描 `plugins/**/package.json`
  （跳过 `node_modules` / `dist` / `web`），非法清单 exit 1；gateway 方法表检查同时执行。
  不要为历史非法名加 allowlist——改清单本身。
- 0.48 M4：外部插件（`source !== 'repo'`）的 HTTP path 必须是 `/plugins/<own-id>/<段>`；
  route / CLI command 需 `plugins[].expose` 显式授权（builtin 忽略），CLI 未授权 / config
  失败按未命中；冲突两级见 [plugins.md](../architecture/plugins.md#扩展面授权expose)。

<a id="discovery"></a>

## 发现顺序

- 默认扫描根与优先级（高 → 低）：`project`（`./.vessel/plugins`）→ `user`（`~/.vessel/plugins`）→ `repo`（仓库内置 `plugins/`）→ `node_modules`（仓库根与 cwd）；同 id 冲突时高优先级胜出。覆盖内置插件需 `vessel.override: true`；否则保留内置实现、告警并记 `plugin_id_conflict`（不加载覆盖者）。
- **体验插件**（子进程 + 贡献点）可热重载：gateway 监听 project / user 插件目录与 `config.yaml` 的 `plugins:`，变更去抖 300ms；按 id diff，新增为 inactive，变更先 deactivate 再替换，原 active 的重新激活，删除则注销 RPC 与静态路由。`plugins.reload`（write / admin）触发重扫并返回 `{added, removed, changed, active, errors, restart_required}`；每次 reload 广播 `plugin.changed`。
- **能力插件**是 in-process 模块，v1 不做真正卸载：改动后必须重启进程；`plugins.reload` 返回 `restart_required`，不谎报已重载。
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

- MCP 的默认 deny / 放行规则（原始工具名精确匹配，ADR-039）与 evals 的离线双门控（ADR-043）见 AGENTS 硬规则。
- skills 就是文件，经消息进来；不写 harness 层的扫描 / 解析 / 注入通道。
- `team_*` / `delegate_task` 已删除；evals / feishu / MCP 只做插件，不进 core（ADR-043/044/090）。

## 指针

- [plugins.md](../architecture/plugins.md) · [plugin-registry.md](../architecture/plugin-registry.md) · [extensions.md](../architecture/extensions.md) · [tools.md](../architecture/tools.md) · [CONFIG.md](../operations/CONFIG.md)。
