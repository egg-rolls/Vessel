---
title: CLI 配置命令与 config.set
kind: current
triggers: [config path, config init, config show, config set, config explain, config.get, config.set, config.sources, 白名单, 溯源, sources, 写配置, settable, ui-settings]
paths: [src/cli/commands/config-command.ts, src/config/ui-settings.ts, src/gateway/gateway-config-control.ts, packages/config/src/explain.ts]
---

# CLI 配置命令与 config.set

> 配置读写命令面运维手册。键语义按域分叶（导航见 [CONFIG](CONFIG.md)）；
> 合并模型见 [architecture/config.md](../architecture/config.md#config-model)。

## 命令

```bash
vessel config path [--json]                 # 用户/项目配置与 data_dir 的实际路径和是否存在
vessel config init [--force] [--json]       # 内嵌模板写用户配置；默认不覆盖，--force 才覆盖
vessel config show [--sources] [--json]     # 合并后配置；--sources 标注每键来自 cli|env|project|user|default
vessel config set <key> <value> [--json]    # 只写白名单键（见下）
vessel config explain <key> [--json]        # 配置溯源：逐层值 + 谁赢（WINNER）+ effective
```

- `config init` 模板只写 `api_key_env`，不写真实密钥。
- `config show` **有校验错误时 exit 1**；密钥永不输出解析后的值，只输出 `"<set>"` / `"<unset>"`。
- `config explain`（`explain.ts:explainConfigKey`）：每层「该层实际贡献的键值」（`_env` 已解析），
  不是合并结果；未设置的键不出现。`env_file` 不是独立层（注入环境变量，体现在 env 层），溯源结合
  `envFiles` 标注。未知键给编辑距离候选（`Did you mean`）；配置有错误/警告时一并输出。
- `vessel doctor [--deep] [--json]`：本地检查 + `--deep` 只读查询本地 gateway 的 `health.get` /
  `mcp.list`；不启动 gateway、不改配置；没有本地 gateway 记 info 不算失败。

## 写入语义（`ui-settings.ts:setUserConfigValue`）

只改目标键、保留其它键与块内其它键；原子写、`0600`；值先按键校验（枚举 / 布尔 / 数值范围 /
非空路径），非法 exit 2。写入经 `config.yaml` 写锁（见 [config-files](config-files.md)）。
`VESSEL_LANG` 等 env 覆盖仍高于配置：写入成功但当前显示以 env 为准。

## `config.set` 白名单（RPC 与 CLI 同一张表）

`SettableConfigKey`（`ui-settings.ts`）是唯一白名单；serve `SETTABLE_KEYS` 与 Web settings-registry
派生同源。值非法返回 `invalid_params`。RPC `config.set` 支持 `scope: 'user' | 'project'`（缺省 user；
project 写工作区 `vessel.yaml` 覆盖层，未注入项目路径 → `not_found`）。

| 组 | 键 |
|---|---|
| ui | `ui.language` / `ui.showReasoning` / `ui.statusBars` / `ui.verbosity` / `ui.showInternalEvents` / `ui.showArchived` / `ui.showRetiredSessions` / `ui.errorLevel` / `ui.addressStyle`（`name\|compact\|full`；YAML `ui.address_style`） / `ui.askUser` / `ui.expandCards` |
| ui 消息显隐 | `ui.messageVisibility.{reasoning,tools,environment,source,system}`（YAML 子块 `message_visibility`） |
| ui 深度配色 | `ui.depthColor.{enabled,rootHue,hueStep,lightnessLight,chromaLight,lightnessDark,chromaDark}`（YAML `ui.depth_color`） |
| observability | `observability.showProcessErrors` / `observability.log.{level,color,format,time}` |
| agent | `agent.cwd` / `agent.teamMemberLimit`（正整数 ≥1；YAML `agent.team_member_limit`） |
| vision | `vision.imageTokenBudgetRatio`（[0,1] 浮点；YAML `vision.image_token_budget_ratio`） |
| 空响应 | `emptyResponse.{enabled,seamless,maxRetries,nudge}`（见 [config-runtime](config-runtime.md)） |
| 看板 | `kanban.boardPath`（`scope: 'project'` 写工作区覆盖层；见 [config-runtime](config-runtime.md)） |
| 自动回收 | `autoPrune.{enabled,intervalHours,olderThanHours,dryRun}`（见 [config-data](config-data.md)） |
| 环境信息 | `envInjection.default` / `envInjection.scopes.<scope>` / `envInjection.channels.<scope>` |

- `envInjection.scopes.*` 值 `request|run|off`；`trim` / `model` 钉死 run，拒 `request`（前缀不变量），
  `off` 允许。`envInjection.channels.*` 值 `model+ui|ui-only`。scope 词表派生自 config
  `DEFAULT_ENV_CADENCE`（17 词含 health）；框架语义见
  [env-info-append-only](../architecture/env-info-append-only.md#cadence)。
- 键语义的家在各域叶子；本表只登记「可写面」。TUI `/settings` 与 WebUI Settings 写同一白名单。

## RPC 读面

`config.get` / `config.sources` 与 `config show` 同口径：永不输出解析后的密钥值，只输出
`"<set>"` / `"<unset>"`。`config.get` 附 `logEnvOverrides`（env 覆盖提示）。
视图读**活配置**：网络面读 cli `liveConfig`，本地面（vessel 元工具 `op=rpc` / TUI）读
bootstrap `liveConfigRef.current`（cli 热应用同步该引用）——yaml watch / `config.set`
写后热应用完成即反映新策略，视图=真相（q-config-get-fresh / O5）。纯本地 REPL 无热应用
⇒ 回退启动快照语义。sources/paths 仍取启动期加载结果（热应用不换文件来源）。
canonical 方法清单以 [gateway-rpc.md](../architecture/gateway-rpc.md) 方法表为准。

## 其它一次性命令（配置相关）

- `vessel logs tail [--json] [--lines N] [--instance <name>]`：只读 `<dataDir>/logs/gateway.log`
  （default）与 `gateway-<instance>.log`（命名实例），默认 50 行，`--lines` 上限 10,000；
  不跟随、不轮转，日志不存在 exit 1。日志口径见 [LOGS](LOGS.md)。
- `vessel errors`：错误清单；`ui.errorLevel: all` 与 `observability.showProcessErrors` 影响收录范围
  （见 [config-ui](config-ui.md)）。
- `vessel --data-dir <path> ...` 全局覆盖 `data_dir`，一次性命令同样按该根解析。
- agent / team / hub / prune 命令面分别见 [config-agent](config-agent.md)、[config-team](config-team.md)、
  [config-hub](config-hub.md)、[config-data](config-data.md)；gateway 生命周期见 [GATEWAY](GATEWAY.md)。