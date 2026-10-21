# 配置与密钥

> 适用版本：0.5+。维护者：`gov`；配置语义归 `asm`。
> 本文描述固定位置、优先级、tenant overlay 与密钥解析。架构事实见
> [ARCHITECTURE §9](../ARCHITECTURE.md) 与 [ADR-050](../adr/ADR-050-yaml-first-config-and-secrets.md)。

## 1. 配置位置

| 层 | 路径 | 放什么 |
|---|---|---|
| CLI / env | 命令行 flag、`VESSEL_*`、`.env` | 操作者覆盖与部署密钥；不是主配置 |
| tenant overlay | `tenant.tenants.<id>.config` | 单 tenant 覆盖；不得覆盖 CLI/env |
| 项目级 | `./vessel.yaml` | 项目行为：session、context、plugins、trace、tenant 覆盖；**禁止密钥** |
| 用户级 | `~/.vessel/config.yaml`（Windows `%USERPROFILE%\.vessel\config.yaml`） | provider、默认模型、`data_dir`、`tenant.default` |
| 默认值 | 代码 `DEFAULT_CONFIG` | 所有缺省值；`vessel config show` 可见 |

优先级（高到低）：

```text
CLI > env > tenant overlay > project > user > default
```

tenant overlay 只叠加在项目/用户之上，不能覆盖 CLI/env。`data_dir` 是全局键，tenant overlay 不得修改。

## 2. 关键配置块

```yaml
data_dir: ~/.vessel/data

tenant:
  default: default
  tenants:
    acme:
      name: Acme
      status: active          # active | disabled
      quota:
        max_sessions: 1000
        max_runs_per_day: 5000
        max_concurrent_runs: 2
        max_storage_bytes: 1073741824
      tools:
        allow: [bash, read, edit]
        deny: []
      config:                 # tenant overlay；白名单见 ADR-049
        provider:
          model: gpt-4

trace:
  enabled: true
  level: full                 # full | metadata | off
  retention_days: 30
  max_runs: 1000
  max_bytes: 1073741824       # 0 = 不限

session:
  backend: file               # 0.5 默认；显式 sqlite 仍可用
  # storage_path: /path/to/store

durable:
  enabled: true
  backend: file
  # path 缺省 <data_dir>/tenants/<tenant_id>/runs
  checkpoint_every: iteration

serve:
  token_env: VESSEL_GATEWAY_TOKEN
  # tokens:
  #   "<tenant-token>": { tenant_id: acme, role: write }
  # admin_token_env: VESSEL_ADMIN_TOKEN
```

tenant overlay 允许的顶层块：`provider / agent / context / limits / termination /
session / plugins / workflow / evals / feishu / tools / mcp_servers / delegate /
team / host / scheduler / transport / quota`。禁止 `data_dir / trace / serve /
tenant / update`；未知块直接报错。合并规则：对象深合并、数组整体替换、map
（`mcp_servers`）按 key 合并、`null` 拒绝。`plugins` 是**数组**，按整层替换，
不按 `name` 合并。

### 2.1 0.6.1 新增配置（已实现，冻结契约见 DECISION-015）

> 以下配置在 0.6.1 已实现。

```yaml
permission:
  auto_approve: [bash, edit]    # 工具名精确匹配；替代 bootstrap 里硬编码的 ['ask_user']

plugins:
  - name: tool-policy
    enabled: true
    config:                     # 传给 Plugin.install(host, { config })
      allow: [bash, read, edit]
  - name: redact-secrets
    enabled: true
    config:
      patterns: []

session:
  backend: file
  # storage_path: /shared/sessions   # 多 tenant 下会告警；file 后端仍按 tenant 隔离
```

- `permission.auto_approve`（TS 字段 `autoApprove`）：`string[]`，按工具名精确匹配；TUI 权限弹窗选 `always`
  时写回用户 YAML。缺省值为空（交互仍逐个询问）；`ask_user` 由装配层始终放行。
- `plugins[].config`：`Record<string, unknown>`，原样传给 `install(host, { config })`；
  未声明 `config` 时按 `install(host)` 调用，旧插件不受影响。
- 插件目录：仓库 `plugins/`、用户 `~/.vessel/plugins/`（Windows
  `%USERPROFILE%\.vessel\plugins\`）、项目 `./.vessel/plugins/`；启动时各扫描一次，
  新增插件仍需重启。安装 / 卸载只接受本地目录，不做远程市场：

```bash
vessel plugin list
vessel plugin install <path>
vessel plugin remove <name>
```

- 环境变量覆盖（0.6.1 新增）：`VESSEL_PLUGINS`（逗号分隔的插件名列表）、
  `VESSEL_SESSION_BACKEND`（`file|sqlite|memory`）、`VESSEL_MODEL`（覆盖
  `provider.model`）。优先级仍为 `CLI > env > tenant overlay > project > user > default`。

### 2.2 Provider 新旧键规则（0.10）

新版配置只写一个 `provider:` 块：

```yaml
provider:
  name: openai                      # 已注册的 provider 插件名
  base_url: https://api.example.com/v1   # 自定义端点；OpenAI 兼容
  api_key_env: VESSEL_API_KEY
  model: deepseek-chat
```

legacy 键（仅兼容）：`default_provider` / `default_model` / `providers.<name>.{apiKey,baseUrl,model}`。

1. **同层同时存在新版 `provider:` 与 legacy 键时，新版生效**；legacy 只读兼容。当前基线已保证新版优先；「并存时输出一次 deprecation warning」属于 **0.10 计划**。
2. 只有 legacy 键时，映射为 `provider:` 形状后继续生效；映射与告警属于 **0.10 计划**（当前实现只做映射）。
3. **未知 provider**：`provider.name` 不是已注册插件、且没有显式 `base_url` → `ProviderConfigError`，启动直接失败，不再静默按 OpenAI 兼容处理（**0.10 计划**）。
4. **未知 provider + 显式 `base_url`** → 按 OpenAI-compatible 端点使用，输出一次 info（不是 warning）（**0.10 计划**）。
5. 已注册 provider 缺 `model` → 启动失败（`provider_invalid`），不回退全局默认模型；未注册 provider 缺 `model` 同样要求显式配置。
6. 密钥解析统一走 `provider.api_key_env` / `provider.apiKey`（见 §3）；不要写 `${VAR}` 插值。

### 2.3 界面语言与启动清屏（`VESSEL_LANG` / `ui.language`）

```yaml
ui:
  language: zh-CN        # zh-CN（默认）| en
  clearOnStart: true     # 默认 true；仅 TTY 生效
  status_bars: both      # 0.13：top | bottom | both | none（TS 字段 statusBars）
```

- 默认 **zh-CN**；`VESSEL_LANG=en` 或 `ui.language: en` 切换英文。
- 优先级：`VESSEL_LANG > ui.language > LANG > LC_ALL > zh-CN`；每个值独立归一化（`zh` / `zh-*` / `zh_*` → `zh-CN`，`en` / `en-*` → `en`），非法值跳过该层，不报错。
- **TUI 内切换**：`/settings language <zh-CN|en>` 经装配层注入的 `ctx.settings.setLanguage` 写回用户配置 `ui.language`（原子写、`0600`、保留其它键），成功后立即 `setLocale` 重渲染，无需重启。未注入 `ctx.settings` 的宿主只能只读查看；写入失败显示 `error.command.settings`。
- **CLI 写配置**：`vessel config set ui.language <zh-CN|en> [--json]`。
- `VESSEL_LANG` 仍高于 `config.ui.language`：显式设置环境变量时，`/settings` 与 `config set` 会写入配置，但当前显示以环境变量为准。
- **TUI 界面文案已接入 `t()`**（zh-CN / en 两份 catalog）。命令名、工具名、错误码、provider / 模型名不翻译；命令的数据输出（会话、trace、metrics、成本等）保持英文。
- **CLI 的 `--help`、一次性命令错误、默认空状态、demo banner 跟随同一 locale**（zh-CN / en 各 85 个 key）。命令数据输出仍为英文。
- **Web 壳层**：`apps/web/src/i18n/` 覆盖导航、面包屑、Settings 六个 tab、Appearance 与通用按钮；locale 取 `localStorage['vessel.ui.language']` > `navigator.language`，可在 Settings → Appearance 切换并立即生效；未收录页面回退中文。Web 不是全量本地化。
- **`ui.clearOnStart`**（默认 `true`）：TTY 进入 REPL 前写 `\x1b[2J\x1b[H` 清可视区并归位光标；设为 `false` 时保留终端历史；非 TTY / headless 不清屏。

### 2.4 思考流与默认工作目录（0.11.1→0.12.0，ADR-077）

```yaml
ui:
  showReasoning: false     # 默认 false；显式 true 才发布 reasoning_delta

agent:
  cwd: ~/project           # 默认工作目录；支持 ~
```

- **`ui.showReasoning`**（默认 `false`）：只有显式 `true` 时，provider 返回的 `reasoning_content` 才转为 `reasoning_delta` 并经 `llm.stream.chunk` 发布；TUI / Web 折叠展示「思考过程」。`trace.includeStreamChunks` 仍默认 `false`，思考增量默认不落 trace。`vessel config set ui.showReasoning <true|false>` 写入用户配置。
- **`agent.cwd`**：`bash` 未显式传 `cwd` 时使用该目录；`read` / `edit` 的相对路径按它解析。支持 `~`，相对路径按进程 cwd 解析为绝对路径；未配置 / 空串等价于不设置。优先级固定为 **工具参数 `cwd` > `agent.cwd` > `process.cwd()`**。
- **边界不变**：`agent.cwd` 只提供默认目录，不放宽内置 denylist 或 `allowed_roots`；越界仍按原有 `deny` / `ask` 语义处理。配置的目录不存在时，工具在调用时返回明确错误，不静默回退到进程 cwd。0.14.2 起 `bash` 还会在命令文本中匹配内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`），命中直接拒绝（`path_denied`）；该检查只做字符串匹配、不是沙箱，任何配置都不能放宽或替换它。
- **CLI 写配置**：`vessel config set agent.cwd <path>`；空值被拒绝。与 `ui.language` 一样只改用户配置、保留其它键、`0600` 原子写。
- **权限时效**（0.13 修订，ADR-079）：权限等待默认不超时，直到应答、取消或 abort；只有 core 显式配置正数 `RuntimePermissionConfig.timeoutMs` 才抛 `PermissionTimeoutError`（`permission_timeout`）并让 run 失败。abort 抛 `PermissionAbortedError`（`permission_cancelled`）。`ask_user` 提问卡仍按事件时间推导 `event.ts + 120s`；权限卡片不再按 TTL 丢弃。详见 §2.6。

### 2.5 状态栏与显隐（0.13，ADR-078）

```yaml
ui:
  status_bars: both      # top | bottom | both | none；缺省按终端高度自动
```

- **上栏**：状态、模型、context 用量 / 百分比（宽终端加进度条）、时长、压缩次数、路径 + branch。0.13 删除 `N sess`，不再每帧查询会话列表。
- **下栏**：运行态字段 `perm ask · N auto` / `waiting <tool>`、`bash N`、`sub N`、`sess <短ID> · Ctrl+R`、tenant、queue。与上栏同宽；`<40` 列不渲染；`<18` 行默认隐藏；显示时吸收底部 hint 行（净增 2 行）。超宽按 `tenant → queue → session → sub → auto` 丢弃，`perm` / `bash` 保留。
- **快捷键**：`Ctrl+T` 切换上栏、`Ctrl+G` 切换下栏、`Ctrl+R` 打开 `/resume` picker。手动切换立即生效，并写回用户配置 `ui.status_bars`（原子写、`0600`、保留其它键）；写回失败不改变本次会话显示。
- **优先级**：`VESSEL_STATUS_BARS` > `ui.statusBars` > 自动规则。`VESSEL_STATUS_BARS` 只作启动初值（兼容 `top,bottom` 写法），手动切换不改环境变量。
- **CLI 写配置**：`vessel config set ui.statusBars <top|bottom|both|none> [--json]`；非法值拒绝。TUI 热键与 CLI 写的是同一个 YAML 键 `ui.status_bars`。

### 2.6 权限生命周期持久化（0.13，ADR-079）

- **默认等待**：交互模式下应用层把默认策略设为 `ask`，请求一直等待，不受时间限制；应用层不设置 `timeoutMs`。只有宿主（core 嵌入方）显式传入正数 `RuntimePermissionConfig.timeoutMs` 才超时。
- **持久化文件**：`<dataDir>/interactions-<tenant>.json`，`0600` 原子写，记录 `pending` / `answered` / `orphaned`。gateway 启动时加载；重启后仍为 `pending` 的记录转 `orphaned`（本进程没有对应 run）。文件损坏 / 不可读只向 stderr 报错并按空集处理，不删除原文件。
- **终态与幂等**：run 进入 `completed` / `failed` / `cancelled` 时，同 run 的 pending 清出并持久化为 `orphaned`。重复应答返回首次结果（`duplicate: true`）；不同决定返回 `conflict`；`orphaned` 返回 `run_ended`；不存在返回 `not_found`。有界清理只淘汰最旧的 `answered` / `orphaned`，pending 不淘汰。
- **关联字段**：`tool.permission.request` 带 `session_id` / `tool_call_id` / `source`；只有显式超时才带 `deadline_at`。
- **已知限制**：core 只读取 `remember`（等价 `always`），`allow session` 目前等同 `once`；没有 `interactions.pending` RPC，刷新恢复依赖事件重放缓冲；`ask_user` 提问卡仍按事件时间 120s 过期，未接入持久化交互记录。

### 2.7 可见性与 ask_user（0.14 / 0.14.1，ADR-080 / ADR-082）

```yaml
ui:
  verbosity: normal            # minimal | normal | debug；Web 信息层级
  show_internal_events: false  # TUI /errors 与 Web 的 L3 内部事件
  error_level: user            # user | all；TUI /errors 与 vessel errors
  ask_user: true               # 入口默认；显式 false 关闭 ask_user
observability:
  show_process_errors: false   # process/shutdown 错误进入 vessel errors
```

- **`ui.verbosity`**（默认 `normal`）：Web 的 `minimal` / `normal` / `debug` 三级可见性；`debug` 等同 `showInternalEvents: true` 并显示 L3 原始事件。缺失 / 非法值回退 `normal`。
- **`ui.showInternalEvents`**（默认 `false`）：TUI `/errors` 与 Web 展示内部事件；与 `verbosity: debug` 取“或”。
- **`ui.errorLevel`**（默认 `user`）：`all` 时 `/errors` 与 `vessel errors` 追加 internal / process 级错误。
- **`observability.showProcessErrors`**（默认 `false`）：让 `process.error` / `shutdown.failed` 等进入 `vessel errors`。
- **`ui.ask_user`**（入口默认）：交互 REPL（TTY）或 gateway/serve 才注册；`--run` / headless / 管道不注册；显式 `false` 按入口与 tenant 关闭，显式 `true` 也不能让无客户端入口注册。提问卡内联在 Web `RunCard`，有效期仍为事件时间 `event.ts + 120s`。
- **校验**：枚举与布尔值非法时由 validator 拒绝，不做静默回退；四个键都支持 `vessel config set`。
- **CLI 写配置**：`vessel config set ui.verbosity <minimal|normal|debug>`、`ui.showInternalEvents <true|false>`、`ui.errorLevel <user|all>`、`ui.askUser <true|false>`、`observability.showProcessErrors <true|false>`；与其它键一样只改用户配置、保留其它键、`0600` 原子写。

### 2.8 限额与终止（0.14.3，ADR-084）

```yaml
limits:
  request_limit: 100            # 单 run 的 LLM 请求次数上限
  tool_calls_limit: 50          # 单 run 的工具调用次数上限
  input_tokens_limit: 1000000   # 单 run 累计输入 token 上限
  output_tokens_limit: 50000    # 单 run 累计输出 token 上限
  # total_cost_limit: 1.5      # 单 run 累计成本上限；缺省不限制
termination:
  max_iterations: 50            # 迭代上限
  max_runtime_seconds: 300      # 单 run 墙钟秒数上限
```

- **默认值**（0.14.3）：`request_limit` 100、`tool_calls_limit` 50、`input_tokens_limit` 1,000,000（原 100,000，与 `context.maxTokens` 对齐）、`output_tokens_limit` 50,000；`max_iterations` 50（原 20）、`max_runtime_seconds` 300。`total_cost_limit` 无默认值。
- **判定**：每轮先判终止策略（`max_iterations` / `max_runtime_seconds`），再判使用量限额；两者都按 `current >= max` 判定、首个命中生效。使用量限额的检查顺序固定 request → tool calls → input tokens → output tokens → total cost；终止策略先 `max_iterations`、后 `max_runtime`。默认 `max_iterations` 50 先于 `request_limit` 100 触发；要提高请求次数的实际上限，两者需一起调整。
- **命中行为**：两类限额走同一路径——发布一次 `limit.blocked`（`error_code: 'limit_blocked'`、`scope` / `key` / `current` / `max` / `source` / `hint` / `retryable: false`、`run_id`、`session_id`），并抛 `LimitExceededError`；`run.failed` 保留原 `error` 文本，附同一结构化的 `details`。`source` 是对应的 camelCase 配置路径（如 `limits.inputTokensLimit` / `termination.maxIterations`）；错误文本前缀分别为 `Usage limits exceeded: ...` 与 `Termination policy triggered: ...`。`max_runtime` 的 `current` 是已运行秒数（毫秒精度小数）。
- **成本**：core 不为内置 provider 计价，`total_cost` 默认为 0；`total_cost_limit` 只在宿主显式调用 `LimitChecker.addCost()` 后才有意义。
- **不新增配置键**：以上键均已存在，tenant overlay 可覆盖 `limits` / `termination`。`LimitBlock.key` 固定为五个使用量 key 加 `max_iterations` / `max_runtime`。

### 2.9 上下文压缩行为（0.14.4，ADR-085）

> 本节只说明压缩行为，**没有新增配置键**。相关既有键：`context.max_tokens`（默认 1,000,000）与 `context.max_messages`（可选；缺省按 `max(100, floor(max_tokens / 100))` 推导）。

- **触发**：token 估算超过 `max_tokens × 0.8`，或消息条数超过 `max_messages`（缺省推导值）时触发自动压缩；`auto_compact: false` 只关闭 token 阈值，条数超限仍强制压缩。
- **保留区**：从最新非 system 消息向前累计估算 token，预算为 `max_tokens × 0.3`，最新 2 条非 system 消息无论如何保留；同时受条数上限 `max(2, max_messages - system 条数 - 1)` 约束。token 或条数任一超限都触发摘要；两者都未超时不压缩。非 system 少于 3 条时不压缩。
- **tool 配对**：保留区第一条是 `tool` 时，边界回退到对应的 `assistant(tool_calls)`，避免压缩后出现孤立 `tool`。配对完整性优先于条数上限，保留数可能略超 `max_messages`。
- **摘要输入**：`assistant` 的工具调用渲染为 `[tool_call:<name>] <arguments>`，`tool` 结果渲染为 `[tool:<id>] <content>`；单条超过 12,000 字符截断，`reasoning_content` 不进入摘要。输入按 `min(48_000, max(2_000, floor(max_tokens / 8)))` 估算 token 分块；单块一次摘要，多块逐块 partial 后再 reduce。某块失败只写占位标记并继续，全部失败时回退 `[Auto Compact: N older messages summarized. Continuing...]`，不中断 run。

## 3. 密钥与 `_env`

所有接受密钥的字段支持 `<field>_env`：

- `api_key_env`
- `provider.api_key_env`
- `feishu.app_secret_env`
- `serve.token_env`
- `serve.admin_token_env`

规则：

1. 字段显式值优先；否则读 `<field>_env` 指向的环境变量；两者都没有则报错。
2. `_env` 与 `VESSEL_*` 按层解析、按层合并；同层显式值 > `_env`。
3. `VESSEL_API_KEY`（env 层）覆盖项目层 `api_key_env`；来源记为 `env`，可附 `env_ref`。
4. 0.5 不支持 `${VAR}` 字符串插值；需要间接引用时用 `_env`。
5. 项目 `vessel.yaml` 出现密钥 → error；tenant 的密钥字段只允许 `_env`。

token 解析顺序：`serve.tokens` → `serve.admin_token` → `serve.token` /
`serve.token_env` → `transport.token` → `VESSEL_GATEWAY_TOKEN` → 自动生成。
principal 映射见 [ADR-049](../adr/ADR-049-multi-tenant-isolation.md)。

## 4. 命令

```bash
vessel config path [--json]
vessel config init [--force] [--json]
vessel config show [--sources] [--json] [--tenant <id>]
vessel config set ui.language <zh-CN|en> [--json]
vessel config set ui.showReasoning <true|false> [--json]
vessel config set ui.statusBars <top|bottom|both|none> [--json]
vessel config set ui.verbosity <minimal|normal|debug> [--json]
vessel config set ui.showInternalEvents <true|false> [--json]
vessel config set ui.errorLevel <user|all> [--json]
vessel config set ui.askUser <true|false> [--json]
vessel config set observability.showProcessErrors <true|false> [--json]
vessel config set agent.cwd <path> [--json]
vessel doctor [--json]
```

- `config path`：打印用户配置、项目配置与 `data_dir` 的实际路径和是否存在。
- `config init`：把内嵌模板写到用户配置；默认不覆盖已有文件，`--force` 才覆盖。
  模板只写 `api_key_env`，不写真实密钥。
- `config show`：输出合并后的配置；`--sources` 标注每个键来自
  `cli | env | project | user | default`；tenant overlay 命中列在
  `tenant_overlay_keys`。**有校验错误时 exit 1**。
- `config.get` / `config.sources`（RPC）与 `config show` 一样，永不输出解析后的
  密钥值，只输出 `"<set>"` / `"<unset>"`。

### 4.1 Gateway 生命周期与配置生效（0.12）

```bash
vessel gateway start [--daemon] [--port <n>] [--host <h>] [--log <path>]
vessel gateway stop [--timeout 10s]
vessel gateway status [--json]
vessel gateway restart [--daemon]
vessel gateway reload [--scope config,plugins]
vessel gateway install-service [--systemd|--launchd|--schtasks]
vessel gateway uninstall-service
```

- `--serve` 是前台 `vessel gateway start` 的别名；常驻部署用 `start --daemon` 或 `install-service`。
- 运行态以 `<dataDir>/gateway.pid`（`0600`）为准；daemon 日志在 `<dataDir>/logs/gateway.log`（`0600`）。`status --json` 只输出 JSON。
- `reload` 只热更新 plugins 扫描缓存与 `serve.allowed_origins`；provider / model / agent / permission / TLS / token / port 的变更会出现在 `requires_restart`，必须重启。未知 scope 或读取失败返回非 0。
- `install-service` / `uninstall-service` 只在显式执行时注册当前平台的**用户级**服务（systemd user / LaunchAgent / Windows 登录计划任务），不随启动自动修改本机。

## 5. 错误与排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动报未知键 | 用户配置拼写错误或使用了已删除字段 | 按错误路径修正；legacy 仅允许 `default_provider` / `default_model` / `providers` |
| `config show` exit 1 | 配置校验失败 | 看 stderr 的 `path: message`，逐项修正 |
| 项目 YAML 报密钥 | 项目配置出现密钥字段 | 移到用户配置的 `_env` 或 env |
| `tenant overlay` 报禁止块 | 覆盖了 `data_dir` / `trace` / `serve` / `tenant` / `update` | 改到项目或用户层 |
| token 401 | 已配置 token 但请求未带，或 token 不在 `serve.tokens` | 检查 `serve.tokens` / `serve.token` / `VESSEL_GATEWAY_TOKEN` |

## 6. 内置多租户执行（A-6）

`--serve` 模式为每个已配置且 `status: active` 的 tenant 构建独立执行面：

```text
config（tenant overlay）/ provider / session backend / run store / context /
plugin host + plugins / trace recorder / metrics collector / redactor / sessionControl
```

- 每个 tenant 独立 `EventStream`；runtime 事件先进入该流，再桥接到 gateway 共享流（事件带 `tenant_id`）。
- 每个 active tenant 持有自己的 writer lock；启动失败必须回滚已获取的锁，shutdown 全部释放；锁冲突返回 `tenant_locked`。
- `disabled` / 未配置 tenant → `forbidden`，不得创建半成品。
- 本地 REPL / headless 仍一次只跑一个 tenant（`--tenant` 选择）；`--connect` 由远端 gateway 决定 tenant。
- 每个 tenant bundle 还构建 workflow / feishu / MCP；插件配置按 tenant 合并，飞书 `app_id` 跨 tenant 重复会在装配期拒绝启动。
- **状态**：ext 插件 tenant 行为、web A-6.3 接口增量（`pluginsFor`、per-tenant `capabilities.list` / `plugins.list`、`trace.readEvents(filter, tenantId)`、`sessionData.deleteSessionData(sessionId, tenantId)`）与 asm 的 per-tenant 执行接线**均已实现**。
- **已知限制**：gateway 的 workflow / 飞书控制面仍只走 default tenant（A-6 §13.3 方法表未包含 per-tenant 变体）。

## 7. 示例：多租户部署

```yaml
# ~/.vessel/config.yaml
provider:
  api_key_env: VESSEL_API_KEY
data_dir: /srv/vessel/data
tenant:
  default: default
trace:
  level: metadata
  retention_days: 14

# ./vessel.yaml（禁止密钥）
session:
  backend: file

# .env（部署密钥）
VESSEL_GATEWAY_TOKEN=...
VESSEL_ADMIN_TOKEN=...
VESSEL_API_KEY=...
```
