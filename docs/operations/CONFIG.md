# 配置与密钥

> 适用版本：0.5+。维护者：`gov`；配置语义归 `asm`。
> 本文描述固定位置、优先级与密钥解析。架构事实见
> [architecture/config.md](../architecture/config.md#config-model) 与 [ADR-050](../adr/ADR-050-yaml-first-config-and-secrets.md)。

## 1. 配置位置

| 层 | 路径 | 放什么 |
|---|---|---|
| CLI / env | 命令行 flag、`VESSEL_*`、`.env` | 操作者覆盖与部署密钥；不是主配置 |
| 项目级 | `./vessel.yaml` | 项目行为：session、context、plugins、trace；**禁止密钥** |
| 用户级 | `~/.vessel/config.yaml`（Windows `%USERPROFILE%\.vessel\config.yaml`） | provider、默认模型、`data_dir` |
| 默认值 | 代码 `DEFAULT_CONFIG` | 所有缺省值；`vessel config show` 可见 |

优先级（高到低）：

```text
CLI > env > project > user > default
```

0.49 起没有 tenant overlay，也没有 `tenant` 配置块。旧配置会被 fail-fast 并给出逐项 Fix：删除整个 `tenant:` 块、删除 `serve.tokens[*].tenantId`（只保留 `role`）、删除 `serve.adminToken` / `serve.adminTokenEnv`（改用 `serve.tokens` 的 `{ role: admin }`）。

## 2. 关键配置块

```yaml
data_dir: ~/.vessel/data

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
  # path 缺省 <data_dir>/runs
  checkpoint_every: iteration

serve:
  token_env: VESSEL_GATEWAY_TOKEN
  # tokens:
  #   "<client-token>": { role: write }
```

0.49 起没有 tenant overlay，也没有 `tenant` 配置块；未知块直接报错。合并规则：
对象深合并、数组整体替换、map（`mcp_servers`）按 key 合并、`null` 拒绝。
`plugins` 是**数组**，按整层替换，不按 `name` 合并。

### 2.1 0.6.1 新增配置（已实现，冻结契约见 DECISION-015）

> 以下配置在 0.6.1 已实现。

```yaml
permission:
  auto_approve: [bash, edit]    # 工具名精确匹配；替代 bootstrap 里硬编码的 ['ask_user']
  never_auto_approve: [agent.close]  # 自动放行的例外键（工具名或 tool.action）；未配置时有效值为 ['agent.close']

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
  # storage_path: /shared/sessions   # 显式 session 根；缺省 <data_dir>/sessions
```

- `permission.auto_approve`（TS 字段 `autoApprove`）：`string[]`，按工具名精确匹配；TUI 权限弹窗选 `always`
  时写回用户 YAML。缺省值为空（交互仍逐个询问）；`ask_user` 由装配层始终放行。
- `permission.never_auto_approve`（TS 字段 `neverAutoApprove`）：自动放行的例外键，条目为工具名或
  `tool.action`（如 `agent.close`）。命中时只把来自 `autoApprove` / 默认放行的 allow 降级为 ask；
  工具 `checkPermission` 的显式 allow / ask / deny 不受影响。未配置时装配层默认有效值为
  `['agent.close']`；显式配置整体替换默认，不合并。
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
  `provider.model`）。优先级仍为 `CLI > env > project > user > default`。

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
- **CLI 的 `--help`、一次性命令错误、默认空状态、demo banner 跟随同一 locale**（zh-CN / en 两份 catalog；key 数以 `bun run scripts/check-i18n.ts` 输出为准）。命令数据输出仍为英文。
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
- **权限时效**（0.13 修订，ADR-079）：权限等待默认不超时，直到应答、取消或 abort；只有 core 显式配置正数 `RuntimePermissionConfig.timeoutMs` 才抛 `PermissionTimeoutError`（`permission_timeout`）并让 run 失败。abort 抛 `PermissionAbortedError`（`permission_cancelled`）。`ask_user` 与权限请求一样默认无限等待，由应答 / abort / run 终态收口，提问卡片不再倒计时。详见 §2.6。

### 2.5 状态栏与显隐（0.13，ADR-078）

```yaml
ui:
  status_bars: both      # top | bottom | both | none；缺省按终端高度自动
```

- **上栏**：状态、模型、context 用量 / 百分比（宽终端加进度条）、时长、压缩次数、路径 + branch。0.13 删除 `N sess`，不再每帧查询会话列表。
- **下栏**：运行态字段 `perm ask · N auto` / `waiting <tool>`、`bash N`、`sub N`、`sess <短ID> · Ctrl+R`、queue。与上栏同宽；`<40` 列不渲染；`<18` 行默认隐藏；显示时吸收底部 hint 行（净增 2 行）。超宽按 `queue → session → sub → auto` 丢弃，`perm` / `bash` 保留。
- **快捷键**：`Ctrl+T` 切换上栏、`Ctrl+G` 切换下栏、`Ctrl+R` 打开 `/resume` picker。手动切换立即生效，并写回用户配置 `ui.status_bars`（原子写、`0600`、保留其它键）；写回失败不改变本次会话显示。
- **优先级**：`VESSEL_STATUS_BARS` > `ui.statusBars` > 自动规则。`VESSEL_STATUS_BARS` 只作启动初值（兼容 `top,bottom` 写法），手动切换不改环境变量。
- **CLI 写配置**：`vessel config set ui.statusBars <top|bottom|both|none> [--json]`；非法值拒绝。TUI 热键与 CLI 写的是同一个 YAML 键 `ui.status_bars`。

### 2.6 权限生命周期持久化（0.13，ADR-079）

- **默认等待**：交互模式下应用层把默认策略设为 `ask`，请求一直等待，不受时间限制；应用层不设置 `timeoutMs`。只有宿主（core 嵌入方）显式传入正数 `RuntimePermissionConfig.timeoutMs` 才超时。
- **持久化文件**：default 实例为 `<dataDir>/interactions-<id>.json`，命名实例为 `<dataDir>/instances/<instance>/interactions-<id>.json`（目录 `0700`），`0600` 原子写，记录 `pending` / `answered` / `orphaned`；`<id>` 是持久化单 id（缺省 `default`），不是 wire 字段。gateway 启动时加载；重启后仍为 `pending` 的记录转 `orphaned`（本进程没有对应 run）。文件损坏 / 不可读只向 stderr 报错并按空集处理，不删除原文件。
- **终态与幂等**：run 进入 `completed` / `failed` / `cancelled` 时，同 run 的 pending 清出并持久化为 `orphaned`。重复应答返回首次结果（`duplicate: true`）；不同决定返回 `conflict`；`orphaned` 返回 `run_ended`；不存在返回 `not_found`。有界清理只淘汰最旧的 `answered` / `orphaned`，pending 不淘汰。
- **关联字段**：`tool.permission.request` 带 `session_id` / `tool_call_id` / `source`；只有显式超时才带 `deadline_at`。
- **自动放行例外**：`permission.never_auto_approve`（`neverAutoApprove`）把命中的 auto 来源 allow 降级为 ask；未配置时有效值为 `['agent.close']`，使成员关闭 peer 仍走人类审批。显式 allow / deny 的工具判定不受影响；headless 无审批通道时仍 fail closed。
- **已知限制**：core 只读取 `remember`（等价 `always`），`allow session` 目前等同 `once`；`interactions.list` 可只读查询 pending / answered / orphaned 权限与内存 pending ask，但 pending ask 仍只在内存；`ask_user` 默认无限等待，不按时间过期。

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
- **`ui.ask_user`**（入口默认）：交互 REPL（TTY）或 gateway/serve 才注册；`--run` / headless / 管道不注册；显式 `false` 按入口关闭，显式 `true` 也不能让无客户端入口注册。提问卡内联在 Web `RunCard`，默认无限等待，由应答 / abort / run 终态收口。
- **校验**：枚举与布尔值非法时由 validator 拒绝，不做静默回退；四个键都支持 `vessel config set`。
- **CLI 写配置**：`vessel config set ui.verbosity <minimal|normal|debug>`、`ui.showInternalEvents <true|false>`、`ui.errorLevel <user|all>`、`ui.askUser <true|false>`、`observability.showProcessErrors <true|false>`；与其它键一样只改用户配置、保留其它键、`0600` 原子写。

### 2.8 限额与终止（默认不限制；机制见 ADR-084，默认值自 0.35 起为 opt-in）

```yaml
limits:
  # 默认不限制；以下均为显式 opt-in，配置后才生效
  # request_limit: 100            # 单 run 的 LLM 请求次数上限
  # input_tokens_limit: 1000000   # 单 run 累计输入 token 上限（含 cache_read，非上下文窗口）
  # output_tokens_limit: 50000    # 单 run 累计输出 token 上限
  # total_cost_limit: 1.5        # 单 run 累计成本上限；缺省不限制
termination:
  # 默认不限制；以下均为显式 opt-in，配置后才生效
  # max_iterations: 50            # 迭代上限
  # max_runtime_seconds: 600      # 单 run 墙钟秒数上限（等待用户授权的时间不计入）
```

- **默认值**：`limits` 与 `termination` 全部缺省，即不设单 run 累计上限；长任务靠自动压缩、模型自然停止与用户中断收口。`request_limit` / `input_tokens_limit` / `output_tokens_limit` / `total_cost_limit` / `max_iterations` / `max_runtime_seconds` 都是显式 opt-in，未配置时对应判定跳过。
- **判定**：每轮先判终止策略（`max_iterations` / `max_runtime_seconds`），再判使用量限额；两者都按 `current >= max` 判定、首个命中生效，未配置的 key 跳过。使用量限额的检查顺序固定 request → input tokens → output tokens → total cost；终止策略先 `max_iterations`、后 `max_runtime`。同时配置 `max_iterations` 与 `request_limit` 时，两者谁先命中取决于各自取值。
- **命中行为**：`request_limit` / token / cost 与 `max_iterations` / `max_runtime` 命中时发布一次 `limit.blocked`（`error_code: 'limit_blocked'`、`scope` / `key` / `current` / `max` / `source` / `hint` / `retryable: false`、`run_id`、`session_id`），并抛 `LimitExceededError`；`run.failed` 保留原 `error` 文本，附同一结构化的 `details`。`source` 是对应的 camelCase 配置路径（如 `limits.inputTokensLimit` / `termination.maxIterations`）；错误文本前缀分别为 `Usage limits exceeded: ...` 与 `Termination policy triggered: ...`。`max_runtime` 的 `current` 是已运行秒数（毫秒精度小数）。
- **`tool_calls_limit` 已移除（0.31）**：不再有工具调用次数预算；旧配置里的该键被忽略、不报错。显式配置 `max_iterations` / `max_runtime_seconds` 时仍由它们兜底。
- **成本**：core 不为内置 provider 计价，`total_cost` 默认为 0；`total_cost_limit` 只在宿主显式调用 `LimitChecker.addCost()` 后才有意义。
- **不新增配置键**：以上键均已存在，项目 / 用户层可直接覆盖 `limits` / `termination`。`LimitBlock.key` 固定为四个使用量 key 加 `max_iterations` / `max_runtime`。

### 2.9 上下文压缩行为（0.14.4，ADR-085）

> 本节只说明压缩行为，**没有新增配置键**。相关既有键：`context.max_tokens`（默认 1,000,000）与 `context.max_messages`（可选；缺省按 `max(100, floor(max_tokens / 100))` 推导）。

- **触发**：token 估算严格超过 `max_tokens × compact_threshold`（`context.compact_threshold` 缺省 0.85），或消息条数超过 `max_messages`（缺省推导值）时触发自动压缩；`auto_compact: false` 只关闭 token 阈值，条数超限仍强制压缩。
- **压力提示**：上下文达到 `max_tokens × 0.9` 且未越过阈值时每 run 发一次 `context.pressure` 事件与尾部消息，建议 `agent(rotate)`；提示上界与文案百分比都由 `compact_threshold` 派生，自动压缩开启且已超过阈值后不再提示；自动压缩默认开启时，缺省 0.85 下该提示不会出现。
- **保留区**：从最新非 system 消息向前累计估算 token，预算为 `max_tokens × 0.3`，最新 2 条非 system 消息无论如何保留；同时受条数上限 `max(2, max_messages - system 条数 - 1)` 约束。token 或条数任一超限都触发摘要；两者都未超时不压缩。非 system 少于 3 条时不压缩。
- **工具结果清空**：保留最近工具结果直到累计估算 token ≤ `max_tokens × 5%`（至少 1 条、最多 10 条）；其余结果替换为 `[cleared <tool>: <命令摘要> -> exit <n>, <n> lines]` 占位（不含完整参数 / 输出），并把 `cleared_tool_call_ids` 写入 `message.compaction`；恢复时同一确定性函数写回占位。
- **手动 `/compact`**：本地有 live EU 走 `compactContext`，idle session 走等价瞬态路径（不启动 Run；写 `message.compaction` + SessionState），connect 走 `sessions.compact` RPC；成功后 TUI 本地视图立即刷新，connect 本地视图标记 stale 至下一次 run。
- **tool 配对**：保留区第一条是 `tool` 时，边界回退到对应的 `assistant(tool_calls)`，避免压缩后出现孤立 `tool`。配对完整性优先于条数上限，保留数可能略超 `max_messages`。
- **摘要输入**：`assistant` 的工具调用渲染为 `[tool_call:<name>] <arguments>`，`tool` 结果渲染为 `[tool:<id>] <content>`；单条超过 12,000 字符截断，`reasoning_content` 不进入摘要。输入按 `min(48_000, max(2_000, floor(max_tokens / 8)))` 估算 token 分块；单块一次摘要，多块逐块 partial 后再 reduce。模板含“当前用户要求（原话）”；有旧摘要时合并而非重写；单次 provider 调用 15s 超时，输出预算 `clamp(floor(removedTokens / 8), 2048, 8192)`；per-session 连续 3 次失败熔断 10 分钟，手动 / overflow（`force`）绕过。某块失败只写占位标记并继续，全部失败时回退 `[Auto Compact: N older messages summarized. Continuing...]` 并标记 `degraded: true`，不中断 run。

### 2.10 写意图锁、数据根与交互记录（0.15 / 0.49，ADR-086）

- **单公司 data-dir 写意图锁**（`src/data-lock.ts`）：`exclusive` 为 `<dataDir>/.lock`，`shared` 为 `<dataDir>/.members/<pid>-<nonce>.json`；锁文件 `{ pid, started_at, host }`。冲突返回 `data_locked`。stale 规则：死 pid、不可解析超过 5s、跨主机超过 24h 自动回收；回收持 `<lock>.reclaim` 守卫（守卫超过 10s 可清理）。
- **谁取锁**：只有写意图命令（`migrate --apply`、`trace prune`、`eval`、bootstrap 的 trace prune / session 删除）获取。`--run` / REPL / gateway 启动**不取**写者锁；同一 dataDir 的第二进程仍可启动（0.49 R7=B 已知限制）。
- **session / run 写锁**：`<dataDir>/.locks/sessions/<sha16(session_id)>.lock` 与 `.locks/runs/<sha16(run_id)>.lock`（`0600`，内容含 `pid` / `started_at` / `host`）。同一 session 的第二个写者得到 `conflict`，消息前缀 `session_locked:`；run resume 冲突前缀 `run_locked:`。同进程重复获取用引用计数消化。
- **根布局**：数据直接位于 `<dataDir>/sessions/`、`runs/`、`events/`、`agents/`、`conversations/`、`teams/`；没有 `tenants/<id>` 层。非空 `<dataDir>/tenants/**` 或 `.t2-migrating-*` → 启动 fail-fast `non_root_layout`（错误含路径 / 条目数 / 字节数；不移动、不删除数据）。
- **持久化单 id**：`<dataDir>/tenant.json` 的 `tenant_id` 是唯一持久来源（缺省 `default`，匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`）；fresh dataDir 不落盘。损坏 / 非法 id → fail-fast，不静默回退。
- **`--data-dir <path>`**：全局覆盖 `data_dir`，优先级 `CLI > env > config`。一次性命令（doctor / logs / gateway status 等）同样按该根目录解析。`VESSEL_DATA_DIR` 仍是 env 层写法，不要写进项目 YAML。
- **interactions 按实例隔离**：default 实例写 `<dataDir>/interactions-<id>.json`；命名实例写 `<dataDir>/instances/<instance>/interactions-<id>.json`，同一 dataDir 的多实例不再互相覆盖。
- **端口占用**：`gateway start` 捕获 `EADDRINUSE` 后以 `port_in_use` 退出 1，不写 PID 文件。换 `--port` 或 `--instance`，或先停掉占用端口的进程。
- **已知限制**：写意图锁不阻止运行时写；跨主机 stale 判定依赖 24h 阈值与主机名，不保证时钟同步。

### 2.11 AgentService 与成员（0.17，ADR-088；0.19 S1/S2 修订见 ADR-091 / ADR-092）

```yaml
agent:
  enabled: true              # 0.24 默认 true；显式 false 关闭（交互与 headless 一致）
  owner_id: main             # root owner 成员 id
  default_visibility: private   # private | team | tenant
  follow_replies: false      # 目前只作为配置 / 事件字段，不自动续跑父 turn
  permission_mode: bridge    # bridge | allow | deny；缺省交互 bridge、headless allow
  read_only_tools: [read]    # deny 模式保留的工具
  model: gpt-4               # 可选：成员默认模型
  temporary_ttl_hours: 2     # temporary 空闲回收 TTL；默认 2，0 = 关闭
  inbox_max_messages: 200    # 成员收件箱上限；默认 200，按最旧裁剪
  # limits / termination 缺省继承顶层；cwd 见 §2.4
```

- **`agent.enabled`**（0.24 起默认 `true`；显式 `false` 关闭）：唯一开关。启用后注册内置 `agent` 工具（root owner 动作 `hire` / `send` / `close` / `list` / `rotate` / `post`，支持 batch；成员 Body 动作 `create` / `hire` / `close` / `rotate` / `post` / `send` / `list`；`create` 只建同 Team peer，`hire` 建调用者拥有的 contractor），启动 AgentService / TeamService，并尝试启动 loopback owner 端点。
- **`agent.owner_id`**（默认 `main`）：root owner（REPL 主 agent）的成员 id；owner 队列由父 turn 的 `BeforeLlm` 排空，不再另起 pump。
- **`agent.default_visibility`**（默认 `private`）：`create` / `hire` 未显式传 `visibility` 时的成员可见性。绑定 Team 且未显式指定时缺省为 `team`（0.19 S3），unbound 保持 `private`；peer 强制 `team`，contractor 有 Team 缺省 `team`、unbound 缺省 `private`；`private` 仅 owner 可寻址，且不写 Team 日志；单公司下 `team` / `tenant` 等价，`tenant` 只作为正交可见性标签保留。
- **`agent.permission_mode`**（缺省交互 `bridge`、headless `allow`）：`bridge` 把成员权限 / ask 弹到父窗口；`allow` 对成员复制到的工具一律放行；`deny` 只复制 `agent.read_only_tools`（默认 `['read']`）。无父事件流时 bridge 退化为 deny，不死等。0.19 S4 起有非空 `team_id` 的成员强制 bridge（忽略全局 `allow`），`deny` 保持只读工具不放宽。
- **`agent.follow_replies`**（默认 `false`）：回复在下一次 `BeforeLlm` 注入父会话；不会自动开启新的父 turn。
- **`agent.model` / `agent.limits` / `agent.termination`**：成员默认模型与限额；`limits` / `termination` 缺省继承顶层，不放大。
- **删除的键**：`team.*`、`delegate.*` 与 `team_*` / `delegate_task` 旧配置名已在 0.17 删除；配置不再接受 `team` / `delegate` 块。
- **`agent.inbox_max_messages`**（0.32，默认 `200`）：每个成员持久化收件箱的消息条数上限，超出时按最旧裁剪；只影响成员收件箱（`agent` 工具投递给 busy / rotating 成员的消息），不影响会话历史。缺省不写入配置即用 200；必须是正整数。
- **`agent.temporary_ttl_hours`**（默认 `2`，`0` = 关闭）：temporary 成员的空闲回收 TTL。只回收 `role === 'temporary'` 且仍在册的成员，`member`（含 `main`）永不回收；有在跑轮 / 排队消息 / 权限等待时跳过。回收复用 `membership='left'` + `state='closed'`，body 记录保留，可经 `reinstate` 原地复活。
- **工具面（组成，不写死数量）**：root 默认 = 能力工具（`bash` / `read` / `edit`）+ `agent` + `subscribe`；真交互 REPL（TTY）或 gateway/serve 另加 `ask_user`；成员 body 另有收件箱工具 `inbox`（`list` / `read` / `delete` / `insert`）。显式 `agent.enabled: false` 时不启用成员 runtime，root 剩能力工具 + `subscribe`。实际清单以 `bun run src/cli.ts --tools` 输出为准（该命令不连接 MCP，也不展开 `ask_user` / `inbox`）。
- **owner 端点**：只由交互 REPL / serve 监听 `127.0.0.1:0`，记录写 `<data_dir>/agent-owner.json`（`0600`，含 `pid` / `host` / `port` / `token` / `started_at` 与内部持久 id）；只接受 loopback 与 Bearer token。`--run` / headless / 管道不监听 owner 端口、不写记录，但 AgentService / TeamService 仍在进程内可用。`vessel agent create|send|dispatch|close|list [--json]` 经该记录 attach。
- **rotate（0.19，ADR-092；0.39 改道）**：成员可调用 `agent` 工具的 `rotate` 换一具新 Body（新 `session_id`、`epoch + 1`）；人用 `sessions.create`（空 session + `startup_prompt`）或 `sessions.restart`。原 owner 端点 `agents.rotate` 与 CLI `vessel agent rotate` 已删除。失败保持旧身体，不自动重试；`rotating` 期间消息排队。
- **已知限制**：排队消息写入 per-agent inbox（上限 `agent.inbox_max_messages`），重启后可由模型经 `inbox` 工具读取；已开始执行的一轮仍需显式 resume；重启后非 `left` 成员为 `state: idle` + `presence: gone`（strict `send` 返回 `member_stale`，`dispatch` 会先 resume）；`close` 只支持本机成员；canonical RPC 清单以 [gateway-rpc.md](../architecture/gateway-rpc.md) 方法表为准。

### 2.12 Team 声明（0.19 S3，ADR-091；S4 增加 policy.permission / policy.budget）

```yaml
teams:
  - name: alpha                  # 可选；缺省由装配层决定
    workspace: ~/work/alpha      # 必填；归一化后精确匹配
    policy:
      allow_auto_create: false  # dispatch resume 失败后允许自动创建；默认 false
      permission:
        unattended: deny-after   # hold（默认）| deny-after
        deny_after_seconds: 300  # deny-after 时必填，1..86400
      budget:
        max_hops: 20             # >= 1；缺省不限
        max_turns: 40            # >= 1；缺省不限
        max_tokens: 200000       # >= 1；缺省不限
        max_wall_clock_seconds: 3600   # >= 1；缺省不限
        warning_threshold: 0.8   # 0 < x < 1；缺省 0.8
        cycle:
          max_repeats: 2         # >= 1；缺省 2
          cooldown_seconds: 60   # >= 0；缺省 60
```

- **全局配置**：`teams` 是顶层块，不属于任何 tenant；密钥字段仍禁止。
- 校验：必须是数组；每项对象；`workspace` 非空；归一化（展开 `~`、`path.resolve`，Windows 忽略大小写）后重复声明 → validation error；`name` 非空；`policy` 为普通对象。
- **拼写**：规范拼写是 camelCase（`denyAfterSeconds` / `maxHops` / `maxWallClockSeconds` 等），config 对象、手改 `team.json` 与运行时都用 camelCase；YAML 可写 snake_case，loader 递归转换。手改 `team.json` 写 snake_case 不会被转换。
- **严格校验**：`policy.permission` / `policy.budget` 内部是白名单；`allow_after` / `allowAfter` 报错（`allow-after is not supported; use hold or deny-after`），`max_cost` / `maxCost` 报错（`policy.budget.maxCost is not supported`，`Usage` 没有 cost 字段），未知键报错。`policy` 顶层其它键仍允许（S3 兼容）。
- **默认与边界**：`permission.unattended` 缺省 `hold`；`deny_after_seconds` 只在 `deny-after` 时允许且必填；没有全局权限 TTL（temporary 的空闲回收另见 `agent.temporary_ttl_hours`）。预算挂在 team policy，**不复用** `limits.*`；未配置的维度不限，环检测默认开启（`max_repeats: 2` / `cooldown_seconds: 60`）。
- **`policy.allow_auto_create`**（0.39，默认 `false`）：`dispatch` 在目标 `gone` 且 resume 失败后，是否允许按来源自动创建 agent；也可在单次 `agents.dispatch` 条目上传 `allow_auto_create` 显式覆盖。手改 `team.json` 时 snake_case 别名同样被接受。
- **非法值**：配置声明非法 → validation error；手改 `team.json` 的非法预算 → warning 并忽略该预算子结构（Team 仍可用）。
- 声明只**补写缺失**的 `<dataDir>/teams/<id>/<team_id>/team.json`（`<id>` 为持久化单 id）；不创建 Agent，不覆盖已有 `name` / `policy`，与已有文件冲突只 warning。
- **默认绑定**：`create` / `hire` 无显式 workspace 时，只有带 `name` 的 Agent 才绑定；workspace 必须与声明归一化后精确相等；多个声明命中 → 不绑定 + warning。显式 `--workspace` 但无 name → `invalid_input('team binding requires a name')`。
- 绑定后默认 visibility `team`；unbound 保持 `private`。Team 只是 roster / 只写日志 / 定向寻址的分组，**不是 cwd 或安全边界**（成员仍共享父工具 cwd）。
- roster 由 Agent 记录的 `team_id + membership` 派生，不单独持久化；`online_count = present && presence === 'live'`；`body_history` 透传（≤20）。
- 无 `@` 的 post / reply / system **只写日志、不产生 run**；`@` 用结构化 agent id，先写日志再 dispatch。private 成员不写日志、不可被 `@`。
- canonical：`teams.list` / `teams.get`（read）、`teams.post` / `teams.members` / `teams.budget` / `teams.create` / `teams.update` / `teams.archive` / `teams.spawnFrozen`（write；`teams.budget` 走 `status | override`，不在 control scope 白名单）；未注入返回 `not_found`。canonical 方法与总数以 [gateway-rpc.md](../architecture/gateway-rpc.md) 方法表为准。
- Team CRUD（0.24）：`teams.create` 只允许 human / admin（team-scoped token 返回 `forbidden`），按 workspace 幂等复用并直接返回 `TeamSummary`；`teams.update` / `teams.archive` 允许 team-scoped token 操作自己的 team。`archive` 有 present 成员返回 `conflict`（`team_not_empty`）；归档后 post / members / budget override 返回 `conflict`（`team_archived`），日志 / session / agent 历史保留；hard delete 未实现。CLI：`vessel team create|update|archive|freeze|unfreeze`；`create` / `update` 支持 `--policy <json>` 或 `--policy-file <path>`（互斥，文件优先用于复杂策略，整体替换）。`freeze` / `unfreeze` 写 `teams.spawnFrozen`；冻结只拦该 Team 的增长（`team_frozen`），不暂停现有成员。
- **预算运行态**：唯一写者是 `AgentService` 的 `ConversationBudget`；状态写 `<dataDir>/conversations/<id>.json`（`0600` 原子写、1000 条按 `last_activity` 有界淘汰、损坏 fail-closed、重启不清零；`<id>` 为持久化单 id）。发送侧入队前与接收侧 turn 开始各查一次，被接收侧挡下的消息留在队列。人工 override 经 `teams.budget` / owner 端点 / CLI，只能抬高或清除；`teams.budget` 不在 control scope。事件 `team.budget.warning` / `team.budget.blocked` / `team.budget.override` 必带 `team_id`。

### 2.13 Hub 控制面（0.19 S5，ADR-093）

Hub 是**独立进程**（`vessel hub start`），不随 gateway 启动；gateway 只作为 node 出站加入远端 hub（node → hub）。

```yaml
hub:
  direction: node                # 仅 node 角色：gateway 出站加入远端 hub
  url: https://hub.example:8643  # node 角色：hub 基址（join 缺省 URL；运行时 state 优先）
  ca_file: /etc/vessel/hub-ca.pem      # node 角色：hub TLS CA（可选）
  join_code_env: VESSEL_HUB_JOIN_CODE  # node 角色：join 缺 --code 时读取（可选）
```

- `hub` 是**顶层块**；`hub.data_dir`（仅 hub 进程使用）与全局 `data_dir` 相同 → validation error `hub_data_dir_conflict`。
- `direction` 只接受 `node`：gateway 出站拨号 hub，节点不需要开放入站端口。hub 进程自身由 `vessel hub start` 启动，不在 gateway 内。
- `url` / `ca_file` / `join_code_env` 只在 node 角色使用：`url` 必须是绝对 `http(s)`、无 userinfo / path / query / hash，非回环必须 `https`；`join_code_env` 只在 `vessel hub join` 缺 `--code` 时读取。node token 明文**只走 SecretStore**。
- node 侧状态写 gateway 的 `data_dir`（`hub-node.json` / `hub-node-status.json`），不写 `hub.data_dir`。
- hub 进程的非回环 `hub.listen.hostname` 必须 `allow_remote: true` + TLS cert/key + 非空 `token_env`；不提供 `--insecure`。
- `hub` 不接受明文 `token`，只允许 `token_env`（hub 自己的读 token）；`allow_file_secrets`（默认 `false`）才允许在 SecretStore 不可用时回退 AES-256-GCM 文件，否则 fail-closed。`pairing_ttl_seconds`（默认 300，范围 60–3600）控制一次性 join code 有效期；码只存 hash、先烧后用。
- 配对与 token：`vessel hub join-code` 在 hub 侧生成一次性 code，`vessel hub join` 在节点侧消费；hub 签发 `scope: node` token 并只存 `sha256`。旧 hub → node 拨号、入站、`hub pair` / `hub node add` / `hub token *` / `hub data-token` 已删除。
- hub 只推 `{node_id, team_id, request_id?, reason, ts}` 指针，**不代理正文**；节点离线保留最后快照，只读展示。
- **NAT 数据面**：`direction: node` 只保证元数据 / 指针可达；没有浏览器可达地址的节点需要隧道 / 反向代理，并可用 `public_url` 声明节点 origin。`data_plane: direct|unreachable` 由 `public_url ?? url` 派生，hub 不做正文中继。
- **已知限制**：跨节点 A2A、多 hub 联邦、hub daemon / 系统服务注册仍未实现；一个 node 进程 / data dir 只加入一个 hub；Web 当前不消费 hub 目录 / data token。

### 2.14 TUI 指示器（`VESSEL_INDICATOR`，0.7）

- 取值 `unicode | ascii | emoji | kaomoji`，缺省 `unicode`；无效值 / 空值回退 `unicode`。
- 只影响 thinking / tool 态的前缀帧；`idle` 固定 `○ idle`。帧间隔：unicode 80ms、ascii 100ms、emoji 600ms、kaomoji 2500ms。
- 纯函数 `resolveIndicatorStyle`，消费者 `SpinnerWithVerb`；组件挂载时读取一次，运行中修改需重启 REPL。

### 2.15 多节点 attention（`attention.nodes[]`，0.23）

```yaml
attention:
  nodes:
    - name: node-b
      url: https://node-b.example.com:8642
      tokenEnv: NODE_B_ATTENTION_TOKEN
      nodeId: node-b-...      # 可选
      caFile: ./ca.pem        # 可选
```

- `name` 唯一；`url` 走绝对 http(s) / 非回环 HTTPS 规则；配置 `nodeId` 后每次使用前用 `health.get` 校验。
- **不接受内联 `token`**（未知键直接报错）；token 只从该节点的 `tokenEnv` 读取，不回退 `connect.token` / `serve.token` / `VESSEL_CONNECT_TOKEN`。
- `vessel attention --node <name>` 使用该节点；`--all-nodes` 逐节点并发、只用于列表，单节点失败不影响其它节点（任一失败 exit 1）；`--to` 多匹配必须显式 `--node`。
- 应答必须落到单个节点；不跨节点批量应答。

### 2.16 两级租约（`lease`，0.34，ADR-098）

```yaml
lease:
  ttl_ms: 30000     # 租约 TTL（毫秒）；默认 30000
  renew_ms: 10000   # 续租间隔（毫秒）；默认 10000
```

- `lease.ttlMs` / `lease.renewMs` 控制系统两级租约（binding → session）的过期与续租；缺省分别消费 `30000` / `10000`。
- 约束：`ttlMs > renewMs`，且 `renewMs >= 1000`、`ttlMs >= renewMs + 1000`；违反时 `validateConfig` 报带键名的错误。两个值都必须是正整数毫秒。
- 除默认值外不在代码里硬编码；配置后由 ExecutionUnit 续租使用。
- **仅单节点本地**：租约文件在 `<dataDir>/.locks/leases/**`，不做多节点 / 集群共识，不可当分布式锁用；跨节点迁移/接管靠 TTL 过期 + fencing token。同一 `dataDir` 多进程可用，但依赖本地文件系统语义（原子 `wx` / rename）。

### 2.17 `config.yaml` 写锁（0.47，CONTRACT-0.47）

- **锁文件**：`${configPath}.lock`，与配置文件同目录；内容 `{ token, pid, acquiredAt }`，`0600`，以 `open(..., 'wx')` 原子创建。
- **受保护写入口**：只包裹「读 → 改 → 写」段。host 侧为 `src/plugin-config.ts` 的 `setPluginEnabled` 与 `src/ui-settings.ts` 的 `setUserConfigValue`（`vessel config set` / `/settings` / gateway 配置写入都经由后者）；marketplace 侧为 `upsertPluginConfig` / `setPluginConfigValue` / `setPluginEnabled` / `removePluginConfig`。下载、解压、安装/卸载目录操作与只读加载不在锁内。
- **stale 与 timeout**：锁文件超过 15s 未更新视为持有进程已崩溃，可被接管（Windows 上 unlink 遇 `EPERM` / `EBUSY` 会短暂重试）；等待超过 5s 抛 `config_locked`，调用方必须看到该错误，不得静默丢写。持锁进程崩溃时锁最多滞留约 15s。
- **接管守卫**：stale 清理先原子创建 `${configPath}.lock.reclaim`（`{ token, pid, acquiredAt }`），只有守卫持有者能删除 stale 锁，删除前在守卫内重读 mtime；守卫自身超过 2s 视为崩溃可清理。没有守卫时两个接管者会交错 unlink/create，晚到的 unlink 会删掉对方刚建的新锁。
- **同进程**：同一配置路径的写者按顺序串行；同一异步上下文内嵌套进入同一路径直接抛 `config_locked: nested lock`，不会排队成死锁。
- **已知限制**：守卫自身的 stale 清理仍是 best-effort（直接 unlink）；只有在守卫持有者于毫秒级窗口内崩溃、且多个进程同时清理守卫时才可能重开一层同类竞态，实测 K=32×20 未复现。
- **手动编辑不在锁内**：直接用编辑器改 `config.yaml` 不参与该协议，可能与进程内的读改写竞争；协议只能约束经由上述入口的写入。
- 不新增配置键、CLI 命令、RPC 或事件；锁仅依赖本地文件系统语义，不做跨主机锁。

## 3. 密钥与 `_env`

所有接受密钥的字段支持 `<field>_env`：

- `api_key_env`
- `provider.api_key_env`
- `feishu.app_secret_env`
- `serve.token_env`（node token）
- `gateway.token_env`（Platform Gateway token，与 node token 分开）

规则：

1. 字段显式值优先；否则读 `<field>_env` 指向的环境变量；两者都没有则报错。
2. `_env` 与 `VESSEL_*` 按层解析、按层合并；同层显式值 > `_env`。
3. `VESSEL_API_KEY`（env 层）覆盖项目层 `api_key_env`；来源记为 `env`，可附 `env_ref`。
4. 0.5 不支持 `${VAR}` 字符串插值；需要间接引用时用 `_env`。
5. 项目 `vessel.yaml` 出现密钥 → error；密钥字段只允许 `_env`。

node token 解析顺序：`serve.tokens` → `serve.token` / `serve.token_env` →
`transport.token` → `VESSEL_GATEWAY_TOKEN` → 自动生成。principal 由 token 决定：
`serve.token` → admin；`serve.tokens` 按条目 `role`；回环无 token → admin。
Platform Gateway token 独立，只读 `gateway.token` / `gateway.token_env`，不与 node token 互相回退。

## 4. 命令

```bash
vessel config path [--json]
vessel config init [--force] [--json]
vessel config show [--sources] [--json]
vessel config set ui.language <zh-CN|en> [--json]
vessel config set ui.showReasoning <true|false> [--json]
vessel config set ui.statusBars <top|bottom|both|none> [--json]
vessel config set ui.verbosity <minimal|normal|debug> [--json]
vessel config set ui.showInternalEvents <true|false> [--json]
vessel config set ui.errorLevel <user|all> [--json]
vessel config set ui.askUser <true|false> [--json]
vessel config set observability.showProcessErrors <true|false> [--json]
vessel config set agent.cwd <path> [--json]
vessel doctor [--deep] [--json]
vessel logs tail [--json] [--lines N] [--instance <name>]
vessel agent create [--name <n>] [--model <m>] [--visibility private|team|tenant] [--system-prompt <s>] [--json]
vessel agent send <member> <content...> [--interrupt | --message-id <id>] [--json]
vessel agent inbox <member> [--json]
vessel agent dispatch <to> <content...> [--json]
vessel agent close <member...> [--json]
vessel agent list [--state <state>] [--visibility private|team|tenant] [--json]
vessel team list [--json]
vessel team get <team_id> [--limit N] [--json]
vessel team create <workspace> [--name N] [--description D] [--policy JSON | --policy-file FILE] [--json]
vessel team update <team_id> [--name N] [--description D | --clear-description] [--policy JSON | --policy-file FILE] [--json]
vessel team archive <team_id> [--json]
vessel team freeze <team_id> [--json]
vessel team unfreeze <team_id> [--json]
vessel team post <team_id> <content...> [--mention <name|id>]... [--json]
vessel team members <team_id> add|remove <member> [--json]
vessel hub start [--host <h>] [--port <p>] [--data-dir <hubDir>] [--allow-remote]
vessel hub directory [--hub-url <url>] [--json]
vessel hub watch [--hub-url <url>]
vessel hub join-code [--data-dir <dir>] [--ttl <s>] [--json]
vessel hub join [<hub-url>] --code <CODE> [--public-url <url>] [--ca <file>] [--json]
vessel hub node list [--json]
vessel hub node remove <pairing_id>
```

- `vessel team ...` 经 owner 端点（`from = ownerId`、viewer 可见 private）；`team post` 的 `--mention` 先在同 Team roster 内解析为 agent id，日志写成功但任一投递失败时退出 1。
- `team create|update` 的 `--policy` / `--policy-file` 互斥；文件内容必须是 JSON 对象，整体替换 policy（不做 merge）。`team archive` 有 present 成员时退出 1（`team_not_empty`）。
- `vessel hub ...`：`hub start` 启动独立 hub 进程；`hub join-code` 在 hub 侧生成一次性 code，`hub join` 在节点侧消费（node → hub）；`hub directory` / `hub watch` / `hub node list|remove` 只读或吊销。token 明文只在 `hub join` 响中出现一次，不写日志。

- `vessel agent ...` 经 `<dataDir>/agent-owner.json` attach 到交互 REPL 的 owner；没有 owner 时 `agent_owner_unavailable`。命令只做参数映射，生命周期全在 owner。

- `vessel --data-dir <path> ...`（全局）覆盖 `data_dir`；同样适用于一次性命令。
- `vessel doctor --deep`：在原有本地检查之外，只读查询本地 gateway 的 `health.get` / `mcp.list`，报告 attach / runtime / MCP 实际状态；不启动 gateway、不改配置。没有本地 gateway 时记为 info，不算失败。
- `vessel logs tail`：只读 `<dataDir>/logs/gateway.log`（default）与 `gateway-<instance>.log`（命名实例），默认 50 行，`--lines` 上限 10,000；不跟随、不轮转，日志不存在时退出 1。

- `config path`：打印用户配置、项目配置与 `data_dir` 的实际路径和是否存在。
- `config init`：把内嵌模板写到用户配置；默认不覆盖已有文件，`--force` 才覆盖。
  模板只写 `api_key_env`，不写真实密钥。
- `config show`：输出合并后的配置；`--sources` 标注每个键来自
  `cli | env | project | user | default`。**有校验错误时 exit 1**。
- `config.get` / `config.sources`（RPC）与 `config show` 一样，永不输出解析后的
  密钥值，只输出 `"<set>"` / `"<unset>"`。
- `config.set`（RPC，0.15）：只写用户配置、只接受白名单键（`ui.language` /
  `ui.statusBars` / `ui.verbosity` / `ui.errorLevel` / `ui.showReasoning` /
  `ui.showInternalEvents` / `ui.askUser` / `observability.showProcessErrors` /
  `agent.cwd`），值非法返回 `invalid_params`。写入同样原子、`0600`、保留其它键。

### 4.1 Gateway 生命周期与配置生效（0.12）

```bash
vessel gateway start [--daemon] [--port <n>] [--host <h>] [--log <path>]
vessel gateway stop [--timeout 10s]
vessel gateway status [--json] [--rpc]
vessel gateway restart [--daemon]
vessel gateway reload [--scope config,plugins]
vessel gateway install-service [--systemd|--launchd|--schtasks]
vessel gateway uninstall-service
```

- `--serve` 是前台 `vessel gateway start` 的别名；常驻部署用 `start --daemon` 或 `install-service`。
- 运行态以 `<dataDir>/gateway.pid`（`0600`）为准；daemon 日志在 `<dataDir>/logs/gateway.log`（`0600`）。`status --json` 只输出 JSON。
- `gateway status --rpc`：经 RPC 只读查询 `health.get` 与由 `runs.list` 派生的队列计数（queued / running），不 attach runtime；`--json` 输出 `{ as_of, rpc: true, instances }`。任一实例查询失败时退出 1。
- 命名实例的交互记录与 PID / 日志一样按实例隔离（见 §2.10）；`vessel logs tail --instance <name>` 读对应日志。
- `reload` 只热更新 plugins 扫描缓存与 `serve.allowed_origins`；provider / model / agent / permission / TLS / token / port 的变更会出现在 `requires_restart`，必须重启。未知 scope 或读取失败返回非 0。
- `install-service` / `uninstall-service` 只在显式执行时注册当前平台的**用户级**服务（systemd user / LaunchAgent / Windows 登录计划任务），不随启动自动修改本机。

## 5. 错误与排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动报未知键 | 用户配置拼写错误或使用了已删除字段 | 按错误路径修正；legacy 仅允许 `default_provider` / `default_model` / `providers` |
| `config show` exit 1 | 配置校验失败 | 看 stderr 的 `path: message`，逐项修正 |
| 项目 YAML 报密钥 | 项目配置出现密钥字段 | 移到用户配置的 `_env` 或 env |
| 旧配置 fail-fast | 仍有 `tenant:` 块、`serve.tokens[*].tenantId`、`serve.adminToken` / `serve.adminTokenEnv` | 按错误里的逐项 Fix 删除或改为 `serve.tokens` 的 `{ role: admin }` |
| token 401 | 已配置 token 但请求未带，或 token 不在 `serve.tokens` | 检查 `serve.tokens` / `serve.token` / `VESSEL_GATEWAY_TOKEN` |
| `data_locked` | 另一个进程持有同一 dataDir 的写意图锁（`migrate --apply` / `trace prune` / `eval`） | 停掉占用进程；不要删除活跃锁；或改用 `--connect` |
| `session_locked` / `run_locked`（RPC `conflict`） | 另一个进程正在写同一 session / run | 停掉占用进程；锁文件在 `<dataDir>/.locks/`，stale 规则见 §2.10 |
| `non_root_layout` | 存在非空 `<dataDir>/tenants/**` 或 `.t2-migrating-*` | 先归档旧数据，再在根布局启动；命令不迁移、不删除 |
| `port_in_use` | gateway 端口已被占用 | 换 `--port` / `--instance`，或停掉占用端口的进程 |

## 6. 单 Node 执行面

一个 node 恰好一份执行面；`--serve` / `vessel gateway start` 不再为多个 tenant 构建 bundle：

```text
config / provider / session backend / run store / context /
plugin host + plugins / trace recorder / metrics collector / redactor / sessionControl
```

- 单 `Runtime` / `EventStream` / `PluginHost` / settings / catalog / trace-metrics 根；事件只有一条流（ADR-089 / ADR-100）。
- 写意图命令取单公司 data-dir 写意图锁；运行时不再获取写者锁。session / run 写冲突返回 `conflict` + `session_locked` / `run_locked`。
- 本地 REPL / headless 同样只跑单公司；`--connect` 指向远端 node 的 Node API（缺省 8644）。
- 插件配置单份：`plugins.list` / `plugins.catalog` / settings 为单视图；飞书 / MCP 不再按 tenant 合并。
- Hub 是独立进程，不在 gateway 内；需要目录时单独 `vessel hub start`，node 用 `hub.direction: node` 出站加入。
- **已知限制**：同一 dataDir 的第二进程可以启动（写意图锁不覆盖运行时）；跨节点 trace / 事件仍无全局聚合。

## 7. 示例：单 Node 部署

```yaml
# ~/.vessel/config.yaml
provider:
  api_key_env: VESSEL_API_KEY
data_dir: /srv/vessel/data
trace:
  level: metadata
  retention_days: 14
serve:
  token_env: VESSEL_NODE_TOKEN       # Node API token（per-node）
gateway:
  token_env: VESSEL_PLATFORM_TOKEN   # Platform Gateway token，与 node token 分开

# ./vessel.yaml（禁止密钥）
session:
  backend: file

# .env（部署密钥）
VESSEL_NODE_TOKEN=...
VESSEL_PLATFORM_TOKEN=...
VESSEL_API_KEY=...
```

- 根布局直接写 `<dataDir>/sessions`、`runs`、`events` 等；没有 `tenants/<id>` 层。
- 一个 node 服务一个公司；平台 token 与每个 node 的 token 互不通用。
- 需要 Hub 目录时另起 `vessel hub start`（独立 dataDir）；它不随 gateway 启动。
- 旧 `<dataDir>/tenants/**` 或 `.t2-migrating-*` 非空会 `non_root_layout` fail-fast；需先归档。
