---
title: 插件发现、信任与生命周期
kind: advisory
triggers: [plugin, plugin host, discovery, trust, external, dispose, mcp, skill, evals, 插件, 插件发现, 信任, 隔离, 生命周期, 技能, 评测, 外部插件]
paths: [src/plugin/plugin-loader.ts, src/plugin/plugin-selection.ts, src/plugin/plugin-manifest.ts, packages/core/src/runtime/plugin-install.ts, plugins/media/media/src/**]
applies_to: [N, M]
---

# 插件发现、信任与生命周期

> 改插件代码或 loader 前读这一篇；信任决策与残余风险以 [AGENTS.md](../../AGENTS.md) 硬安全规则为准。机制细节（manifest / 热重载 / catalog / embed）见 [plugins.md](../architecture/plugins.md)。

## 唯一扩展机制

- 只有一个 plugin loader / manifest / 生命周期；插件对象走 `plugins` / `pluginHost` 注入，不塞进 runtime 构造函数。
- **能力插件**（in-process）经 `PluginHost` 注册 tool / provider / guardrail / hook；**贡献面**（pages / commands / settings / rpc / events / panels / toolbar / composer）由 harness 层持有与收集，不是 core 的第二套扩展机制。`contributes.toolbar[]` 是 declarative 按钮（slot 只有 `composer`），可带通用 RPC 绑定 `menu`；点击由宿主按 `id` 映射，插件不拿宿主回调。
- 不新增第二套运行期扩展机制；禁止 `ModuleHost` / `ModuleRegistry`（ADR-004 / ADR-037 / ADR-099）。

## Manifest 门禁

- `package.json.vessel.contributes.rpc[].name` 必须是裸名，匹配 `^[a-z][a-z0-9_-]*$`（宿主注册为 `plugin.<id>.<name>`）；清单的 engines / entry / contributes / permissions 错误同样 fail-closed。
- 提交前人工核对 `plugins/**/package.json` 的清单（跳过 `node_modules` / `dist` / `web`）：非法清单不许进仓；gateway 方法表以 `docs/architecture/gateway-rpc.md` 的 canonical 表为准（评审项，无校验脚本）。不要为历史非法名加 allowlist——改清单本身。
- 外部插件（`source !== 'repo'`）的 HTTP path 必须是 `/plugins/<own-id>/<段>`；route / CLI command 需 `plugins[].expose` 显式授权（builtin 忽略），CLI 未授权 / config 失败按未命中；冲突两级语义见 [plugins.md](../architecture/plugins.md#扩展面授权expose)。

<a id="discovery"></a>

## 发现与重载（作者口径）

- 扫描根优先级（高 → 低）：project `./.vessel/plugins` → user `~/.vessel/plugins` → repo 内置 `plugins/` → `node_modules`；同 id 高优先级胜出；覆盖内置需 `vessel.override: true`，否则保留内置、告警并记 `plugin_id_conflict`。
- `plugins:` 是**覆盖层语义**：默认集（全部已安装的 in-process 能力插件）恒为底，条目只做覆盖——`enabled: false` 显式关、列入即显式启用；新装插件不配置即装载。默认集与外部插件告警 / `VESSEL_NO_EXTERNAL_PLUGINS` 的实现见 `src/plugin/plugin-loader.ts` / `src/plugin/plugin-selection.ts`；策略与 P0-3 残余风险见 AGENTS 硬规则，本文件不复述。
- 体验插件（child）可热重载（目录 / config watcher + `plugins.reload`）；in-process 插件按能力分档：toggle / settings 可热，**代码改动恒需重启进程**（ESM 缓存），`restart_required` 只报真实待生效差异。机制细节见 [plugins.md](../architecture/plugins.md#热重载)。

## 生命周期

- `install()` 期间创建的资源（连接、定时器、子进程、句柄、订阅）必须实现 `dispose()` 释放；`dispose()` 必须幂等。
- `init()` 在所有插件安装完成后按安装顺序调用；不得假设“后续插件已安装”。
- 安装阶段 fail-fast：失败由 `beginPluginInstall()` 的 `rollback()` 清理（`packages/core/src/runtime/plugin-install.ts`），不要手动逐个反注册，也不要把安装失败改成隔离继续（ADR-065）。

## 异常隔离

- Hook 抛错发 `hook.failed` / `hook.error` 后继续后续 hook；`OnError` best-effort。
- Guardrail `check()` 抛错按 fail-closed（`allowed:false` + `guardrail_error`，发 `guardrail.error`）。
- 不得靠 hook / guardrail 抛异常终止 run；要阻断返回 `allowed:false`，要停止就 abort（ADR-054）。

## MCP / evals / skills

- MCP 的默认 deny / 放行规则（原始工具名精确匹配，ADR-039）与 evals 的离线双门控（ADR-043）见 AGENTS 硬规则。
- skills 就是文件，经消息进来；不写 harness 层的扫描 / 解析 / 注入通道。
- `team_*` / `delegate_task` 已删除；evals / feishu / MCP 只做插件，不进 core（ADR-043/044/090）。

## 多模态解析器（`media`，默认加载）

- `plugins/media/media`：单个 `media` 工具（`action = read | view | ocr | describe`，可缺省——按扩展名派生：图片→view、PDF/文本→read，ocr / describe 必须显式；`path` 必填，`page` / `frames` 可选）。`read` 直读文本、PDF 走 `pdftotext`；`view` 图片入 blob 池 + 登记附件回执，多模态主模型直接看图；`ocr` 走 `tesseract`；`describe` 需装配层注入多模态 bridge，未配置时明确报错、不降级。路径边界复用 basic-tools 的 `evaluatePath` / `allowed_roots`；单文件 20 MiB，单次输出 32 KiB（超出标 `truncated`）。
- **在默认集**（安装的插件默认开启，`OPT_IN_PLUGINS` 为空集）：装上即加载，无需写 `plugins:`。`install` 阶段探测后端，`view` / `read`（文本）恒可用、零外部后端；零 CLI 后端时 warn 一次并注册缩减版工具（action enum 按实测后端收缩），不崩不刷屏。第三方 CLI 只检测不安装。想关：`plugins: [{ name: media, enabled: false }]`。
- 配置（可选）：`plugins: [{ name: media, config: { allowed_roots: ["~/work"] } }]`（可选 `pdftotext` / `tesseract` 指向可执行文件、`ocr_language`、`max_output_bytes` 等，只能收紧上限）。覆盖层语义下该条目只覆盖 media 自身，不影响其它插件的默认加载。改完的配置在热应用时会被重新 install（boundary / 后端探测都重跑，旁路经 `loader.loadFresh` 拿 cache-busted 新实例）；新增/移除插件仍需重启进程。
- **边界默认继承 basic-tools**：`media` 自己没配 `allowed_roots` / `deny_paths` 时，装配层（`buildPluginConfigMap`）把 `basic-tools` 的那份填进来。优先级：**media 自身 > basic-tools 回落**；显式空数组（`allowed_roots: []`）= 明确不限制根，不会被回退覆盖。合并只在装配层做：插件 `install` 只拿得到自己那份 config，`PluginHost` 没有 config getter。

## 指针

- [plugins.md](../architecture/plugins.md) · [plugin-registry.md](../architecture/plugin-registry.md) · [extensions.md](../architecture/extensions.md) · [tools.md](../architecture/tools.md) · [CONFIG.md](../operations/CONFIG.md)。