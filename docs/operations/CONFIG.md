---
title: 配置与密钥
kind: current
triggers: [配置, 配置项, 配置文件, 配置优先级, 密钥, 令牌, 环境变量, 用户级配置, 项目级配置, 默认值, vessel.yaml, 数据目录, 覆盖, secrets]
paths: [packages/config/**, src/cli/commands/config-command.ts, src/cli/commands/token-command.ts, src/node/token-derive.ts, src/cli/commands/agent/agent-command.ts, src/cli/commands/agent/agent-inbox-command.ts, src/federation/attention-client.ts, src/federation/attention-nodes.ts, src/config/config-error-format.ts, src/cli/commands/doctor-command.ts, src/cli/commands/errors-command.ts, src/gateway/gateway-config-control.ts, src/gateway/gateway-reload-wiring.ts, src/config/hot-apply-appliers.ts, src/config/hot-apply-assembly.ts, src/gateway/interactions-dir.ts, src/cli/commands/logs-command.ts, src/shared/port-in-use.ts, src/cli/commands/prune-command.ts, src/data/prune-wiring.ts, src/session/session-lock.ts, src/session/session-lock-runtime.ts, src/config/ui-settings.ts, src/observability/usage-pricing.ts]
---

# 配置与密钥

> **Reference（>300 行）**：按需检索，不要求整读；配置语义的当前事实以
> [architecture/config.md](../architecture/config.md) 为准，本文只保留操作细节。
> 适用版本：0.5+。维护者：`gov`；配置语义归 `asm`。
> 本文描述固定位置、、优先级与密钥解析。架构事实见
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

### 2.0.0 一台机器跑多个实例：`--data-dir`

`gateway start|stop|restart|status|list`、`node start|status|stop|reload`、`doctor`、`token ...`
都接受 `--data-dir <path>`。它**只覆盖数据目录**，不改变任何其它配置语义：

```
CLI 参数 > 环境变量 VESSEL_DATA_DIR > 项目 config(data_dir) > 用户 config
```

```bash
vessel gateway start --daemon --instance b --port 18920 --data-dir /var/tmp/vessel-b
vessel gateway list --data-dir /var/tmp/vessel-b     # 只看得到 b
```

隔离保证：各自的 `platform-<port>.pid` / `.lock` / `logs/`、各自的 `nodes.json`（注册表）、
各自的 `sessions/` 与 `.locks/`、各自的 `root-secret`（派生 token 互不相同）。
默认实例的 `8642/8644` 与它的数据目录完全不受影响。

### 2.0.1 `--user-config <path>`：只换用户层

```bash
vessel gateway start --daemon --data-dir /var/tmp/vessel-b \
  --user-config /var/tmp/vessel-b/user.yaml --port 18920
```

- **只替换用户层**（`~/.vessel/config.yaml`）：项目 `vessel.yaml`、`VESSEL_*` 环境变量、
  CLI 参数的原有优先级不变（`VESSEL_USER_CONFIG` 等价，daemon/node/hub 子进程也一致携带）。
- 显式给出但**文件不存在 → 直接报错退出（exit 2）**，绝不静默回落成空配置：
  「以为验的是空配置，其实还是读了真配置」是这类隔离最常见的假绿。
  需要一个空用户层就写一个空文件（`{}`）。
- `vessel doctor` 的 `user_config` 一行会回显**当前生效的路径与来源**（只显示路径，不显示内容）。

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

node:
  token_env: VESSEL_NODE_TOKEN
  # tokens:
  #   "<client-token>": { role: write }

security:
  # 0.56：单一根密钥（派生所有 token 的来源）。不配就用 <data_dir>/root-secret。
  # root_secret_env: VESSEL_ROOT_SECRET
```

0.49 起没有 tenant overlay，也没有 `tenant` 配置块；未知块直接报错。合并规则：
对象深合并、数组整体替换、map（`mcp_servers`）按 key 合并、`null` 拒绝。
`plugins` 是**数组**，按整层替换，不按 `name` 合并。

### 2.0 `serve:` 已移除（0.55）：写 `serve:` 就**启动失败**，改名 `node:`

这个块的唯一名字是 `node:`（对应 `vessel node start`；`vessel serve` 命令 0.49 就没了）。
0.55 起 `serve:` 不是「弃用但还能用」——**读到就报错，整块一个键都不生效**：

```text
✗ serve: The "serve:" block in the user config was removed in 0.55 (the block is called
  "node:" now, ...). Fix: in that file rename each key, values unchanged —
  serve.token_env -> node.token_env, serve.allowed_origins -> node.allowed_origins.
```

| 写法 | 行为 |
|---|---|
| 只有 `node:` | 唯一被接受的写法 |
| 只有 `serve:` | **启动失败**（exit 2），整块被丢弃、逐键给出改名提示 |
| 两段都有 | **启动失败**：`serve:` 存在就报错，不看 `node:` 写了什么 |

```diff
-serve:
+node:
   token_env: VESSEL_NODE_TOKEN
```

- 字段名一个都不变（`hostname` / `port` / `allow_remote` / `tls` / `token` / `token_env` /
  `tokens` / `allowed_origins` / `plugin_http` / `proxy_secret_env`），只是块标签改名；
- 用户层与项目层各判各的：文案会说明是哪个文件里的 `serve:`；
- 为什么不做「警告 + 照旧生效」：同一份字段有两个名字，两条读法迟早会漂开（`doctor` 看一个、
  启动看另一个），而这正是这次要清掉的东西；
- `vessel doctor` 的 `config` 一行会显示同一条错误（状态 `fail`），改名后自动恢复正常；
- 验证类错误提示里的路径现在一律写 `node.*`（例如 `node.port must be an integer…`），
  与你写的键名一致。

### 2.0.1 token：用户一个都不用写（0.56 根密钥派生）

优先级永远是「**显式配置赢，没配就现算**」，所以「未配置就挂」这种形状不再存在：

| 用途 | 生效顺序 |
|---|---|
| 平台 | `gateway.token` > `gateway.token_env` > 派生 `vessel:platform` |
| node | `node.token` > `node.token_env` > `VESSEL_GATEWAY_TOKEN` > 平台注入的 `VESSEL_NODE_TOKEN` > 派生 `vessel:node:<node_id>` |
| hub | `hub.token_env` > `VESSEL_HUB_TOKEN` > 派生 `vessel:hub` |
| 反代 | `gateway.proxy_secret_env`（**只认显式**，不会自动启用） |

- 根密钥：`<data_dir>/root-secret`，32 字节，首次启动自动生成、权限 0600；
  `security.root_secret_env` 指向的环境变量优先（容器 / 只注入密钥的部署）。
  权限宽于 0600 → **拒绝启动**并给出 `chmod 600` 文案（不用可能已泄露的 root）。
- 派生：`HKDF-SHA256(root, salt="vessel/v1", info="vessel:<purpose>[:<id>]")` → 32 字节，
  base64url 加 `vsk_` 前缀；**不落盘、不缓存**，用的时候现算。
- 命令：

```bash
vessel token list                       # 只列 purpose + 指纹前 8 位，永不打印值
vessel token show --purpose platform    # 打印值：只回环 + 交互式终端
vessel token show --purpose node --node node-b
vessel token rotate --yes               # 新 root ⇒ 所有派生值一起换；显式配置不受影响
vessel node token [--print]             # 本机 node 自己该用的 token
```

- 显式配置**不算**被派生值覆盖：只配一部分用途完全正常，其余照旧派生。
- **定稿口径（0.56）**：没有显式配置 ⇒ 用派生值；**远程必须带它**（缺/错一律 401）；
  **回环匿名语义保持不变**。只有显式配置才会收紧回环。

  | 情形 | 远程请求 | 回环请求 |
  |---|---|---|
  | 未配置（用派生值） | 必须带派生值，否则 401 | 匿名可用（不锁死本地 UI/CLI） |
  | 显式配置 | 必须带该值 | 不匿名（必须带，旧行为） |

  理由：派生值总是存在，「未配置」与「不鉴权」已经不是同一件事；远程从来拿不到匿名
  通道，本地也不会因为「用户没写配置」而掉线。

### 2.1 0.6.1 新增配置（已实现，冻结契约见 DECISION-015）

> 以下配置在 0.6.1 已实现。

```yaml
permission:
  auto_approve: [bash, edit]    # 工具名精确匹配；替代 bootstrap 里硬编码的 ['ask']
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
  时写回用户 YAML。缺省值为空（交互仍逐个询问）；`ask` 由装配层始终放行（历史配置里的
  旧工具名 `ask_user` 会被归一化成 `ask`，不失效）。
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
7. **provider 传输层重试没有配置键**：策略是 core 常量 `DEFAULT_PROVIDER_RETRY_POLICY`（base 500ms / x2 / 最多 4 次 / 单次封顶 8s / ±50% 抖动），只对「一个增量都没流出」的传输层断开与过载（429 / 502 / 503 / 504）生效，`Retry-After` 优先且同样封顶。嵌入方可经 `ExecutionUnitOptions.retry` / `TenantRuntimeProfile.retry` 覆写（`maxRetries: 0` 关闭）；新增 YAML 键要连带 config schema、validator 与装配接线，本版不做。见 [runtime-loop](../architecture/runtime-loop.md#loop)。

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
- **CLI 的 `--help`、一次性命令错误、默认空状态、demo banner 跟随同一 locale**（zh-CN / en 两份 catalog；两份 catalog 的 key 数与引用落地靠评审核对，原 `check-i18n` 脚本已按宪法删除）。命令数据输出仍为英文。
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
- **权限时效**（0.13 修订，ADR-079）：权限等待默认不超时，直到应答、取消或 abort；只有 core 显式配置正数 `RuntimePermissionConfig.timeoutMs` 才抛 `PermissionTimeoutError`（`permission_timeout`）并让 run 失败。abort 抛 `PermissionAbortedError`（`permission_cancelled`）。`ask` 与权限请求一样默认无限等待，由应答 / abort / run 终态收口，提问卡片不再倒计时。详见 §2.6。

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
- **已知限制**：core 只读取 `remember`（等价 `always`），`allow session` 目前等同 `once`；`interactions.list` 可只读查询 pending / answered / orphaned 权限与内存 pending ask，但 pending ask 仍只在内存；`ask` 默认无限等待，不按时间过期。

### 2.7 可见性与 ask（0.14 / 0.14.1，ADR-080 / ADR-082）

```yaml
ui:
  verbosity: normal            # minimal | normal | debug；Web 信息层级
  show_internal_events: false  # TUI /errors 与 Web 的 L3 内部事件
  error_level: user            # user | all；TUI /errors 与 vessel errors
  ask_user: true               # 键名不变；入口默认，显式 false 关闭 ask 工具
observability:
  show_process_errors: false   # process/shutdown 错误进入 vessel errors
```

- **`ui.verbosity`**（默认 `normal`）：Web 的 `minimal` / `normal` / `debug` 三级可见性；`debug` 等同 `showInternalEvents: true` 并显示 L3 原始事件。缺失 / 非法值回退 `normal`。
- **`ui.showInternalEvents`**（默认 `false`）：TUI `/errors` 与 Web 展示内部事件；与 `verbosity: debug` 取“或”。
- **`ui.showArchived`**（默认 `false`，0.51）：Web 列表是否展示「已归档 Team / 已停用 agent」（两者都在等待被清理）。关闭时它们不出现在 Teams 列表、Agents 列表与 Team 成员侧栏（搜索同样搜不到）；打开后回到列表并带「已归档 · 待移除 / 已停用 · 待移除」标记。**隐藏不是删除**：直接 URL / 收藏链接始终能打开归档对象，打开时给一条待移除提示。会话列表不受此键影响（用户历史永不隐藏），只给归属到已停用 agent 的会话加标记。
- **`ui.errorLevel`**（默认 `user`）：`all` 时 `/errors` 与 `vessel errors` 追加 internal / process 级错误。
- **`observability.showProcessErrors`**（默认 `false`）：让 `process.error` / `shutdown.failed` 等进入 `vessel errors`。
- **`ui.expandCards`**（默认 `false`）：Web 时间线卡片（工具 / 系统消息 / 排队）是否默认展开；带可操作控件（权限 / ask / 确认）的卡片始终展开，`verbosity: debug` 等同 `true`；用户手动开合某张卡片后以手动状态为准。
- **`ui.ask_user`**（入口默认；键名未随工具改名而变，工具现名 `ask`）：交互 REPL（TTY）或 gateway/serve 才注册；`--run` / headless / 管道不注册；显式 `false` 按入口关闭，显式 `true` 也不能让无客户端入口注册。提问卡内联在 Web `RunCard`，默认无限等待，由应答 / abort / run 终态收口。
- **校验**：枚举与布尔值非法时由 validator 拒绝，不做静默回退；四个键都支持 `vessel config set`。
- **CLI 写配置**：`vessel config set ui.verbosity <minimal|normal|debug>`、`ui.showInternalEvents <true|false>`、`ui.showArchived <true|false>`、`ui.errorLevel <user|all>`、`ui.askUser <true|false>`、`ui.expandCards <true|false>`、`observability.showProcessErrors <true|false>`；与其它键一样只改用户配置、保留其它键、`0600` 原子写。

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
pricing:
  # 0.51：opt-in 模型价格表；不配置时 total_cost 恒为 0
  # 以下数值只是示例，请按你自己的账单 / 合同填写
  models:
    volcengine/deepseek-flash:   # 必须与 provider.model 精确一致
      input_per_million: 0.27    # 非缓存输入，计价货币 / 1M token
      output_per_million: 1.10
      cache_read_per_million: 0.027   # 缺省 = input_per_million；建议显式配置
      cache_write_per_million: 0.3375 # 缺省 = input_per_million；建议显式配置
```

- **`pricing.models.<model>`**（0.51，opt-in）：按 `provider.model` 精确匹配。每次 provider 响应按四项费率分别计价并累加到 `stats.totalCost`；`cache_read_per_million` / `cache_write_per_million` 缺省回落到 `input_per_million`（不猜厂商倍率，建议显式配置）。没有配置 / 模型未命中时 `total_cost` 保持 0。Vessel 不内置任何厂商价格，也不做汇率换算。

- **默认值**：`limits` 与 `termination` 全部缺省，即不设单 run 累计上限；长任务靠自动压缩、模型自然停止与用户中断收口。`request_limit` / `input_tokens_limit` / `output_tokens_limit` / `total_cost_limit` / `max_iterations` / `max_runtime_seconds` 都是显式 opt-in，未配置时对应判定跳过。
- **判定**：每轮先判终止策略（`max_iterations` / `max_runtime_seconds`），再判使用量限额；两者都按 `current >= max` 判定、首个命中生效，未配置的 key 跳过。使用量限额的检查顺序固定 request → input tokens → output tokens → total cost；终止策略先 `max_iterations`、后 `max_runtime`。同时配置 `max_iterations` 与 `request_limit` 时，两者谁先命中取决于各自取值。
- **命中行为**：`request_limit` / token / cost 与 `max_iterations` / `max_runtime` 命中时发布一次 `limit.blocked`（`error_code: 'limit_blocked'`、`scope` / `key` / `current` / `max` / `source` / `hint` / `retryable: false`、`run_id`、`session_id`），并抛 `LimitExceededError`；`run.failed` 保留原 `error` 文本，附同一结构化的 `details`。`source` 是对应的 camelCase 配置路径（如 `limits.inputTokensLimit` / `termination.maxIterations`）；错误文本前缀分别为 `Usage limits exceeded: ...` 与 `Termination policy triggered: ...`。`max_runtime` 的 `current` 是已运行秒数（毫秒精度小数）。
- **`tool_calls_limit` 已移除（0.31）**：不再有工具调用次数预算；旧配置里的该键被忽略、不报错。显式配置 `max_iterations` / `max_runtime_seconds` 时仍由它们兜底。
- **成本**：core 不内置价格；配置 `pricing.models.<provider.model>` 后，每次请求按 fresh input / cache read / cache write / output 分项计价并累加，`total_cost_limit` 才生效。没有 price 表时 `total_cost` 恒为 0，命中判定跳过。只用 `input_tokens_limit` 做成本代理会在缓存命中高的长 run 上严重误判（`prompt_tokens` 含缓存，且会随轮次累加），成本请用 `total_cost_limit`。
- **不新增配置键**：除 0.51 的 `pricing` 外，以上键均已存在，项目 / 用户层可直接覆盖 `limits` / `termination`。`LimitBlock.key` 固定为四个使用量 key 加 `max_iterations` / `max_runtime`。

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

- **单公司 data-dir 写意图锁**（`src/data/data-lock.ts`）：`exclusive` 为 `<dataDir>/.lock`，`shared` 为 `<dataDir>/.members/<pid>-<nonce>.json`；锁文件 `{ pid, started_at, host }`。冲突返回 `data_locked`。stale 规则：死 pid、不可解析超过 5s、跨主机超过 24h 自动回收；回收持 `<lock>.reclaim` 守卫（守卫超过 10s 可清理）。
- **谁取锁**：只有写意图命令（`migrate --apply`、`trace prune`、`prune --yes`、`eval`、bootstrap 的 trace prune / session 删除）获取。`--run` / REPL / gateway 启动**不取**写者锁；同一 dataDir 的第二进程仍可启动（0.49 R7=B 已知限制）。
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
- **工具面（组成，不写死数量）**：root 默认 = 能力工具（`bash` / `read` / `edit`）+ `agent` + `subscribe`；真交互 REPL（TTY）或 gateway/serve 另加 `ask`；成员 body 另有收件箱工具 `inbox`（`list` / `read` / `delete` / `insert`）。显式 `agent.enabled: false` 时不启用成员 runtime，root 剩能力工具 + `subscribe`。实际清单以 `bun run src/cli.ts --tools` 输出为准（该命令不连接 MCP，也不展开 `ask` / `inbox`）。
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
          max_repeats: 2         # 每个 cooldown 窗口内允许的重复次数，>= 1；缺省 2
          cooldown_seconds: 60   # 滑动窗口秒数，也是越界后的重试间隔，>= 1；缺省 60
```

- **全局配置**：`teams` 是顶层块，不属于任何 tenant；密钥字段仍禁止。
- 校验：必须是数组；每项对象；`workspace` 非空；归一化（展开 `~`、`path.resolve`，Windows 忽略大小写）后重复声明 → validation error；`name` 非空；`policy` 为普通对象。
- **拼写**：规范拼写是 camelCase（`denyAfterSeconds` / `maxHops` / `maxWallClockSeconds` 等），config 对象、手改 `team.json` 与运行时都用 camelCase；YAML 可写 snake_case，loader 递归转换。手改 `team.json` 写 snake_case 不会被转换。
- **严格校验**：`policy.permission` / `policy.budget` 内部是白名单；`allow_after` / `allowAfter` 报错（`allow-after is not supported; use hold or deny-after`），`max_cost` / `maxCost` 报错（`policy.budget.maxCost is not supported`，`Usage` 没有 cost 字段），未知键报错。`policy` 顶层其它键仍允许（S3 兼容）。
- **默认与边界**：`permission.unattended` 缺省 `hold`；`deny_after_seconds` 只在 `deny-after` 时允许且必填；没有全局权限 TTL（temporary 的空闲回收另见 `agent.temporary_ttl_hours`）。预算挂在 team policy，**不复用** `limits.*`；未配置的维度不限，环检测默认开启（`max_repeats: 2` / `cooldown_seconds: 60`）。
- **环检测语义（0.42 改准）**：计的是**同一有向边（from→to）的重复**，且只在**最近一个 `cooldown_seconds` 窗口**内计 —— 即「同一有向边每 `cooldown_seconds` 秒最多 `max_repeats` 次」，窗口滑过后重新计数。越界只拒绝本次投递（错误里带 `retry after`），**不落持久 blocked**、不需要人工 override：正常的多轮 hub-and-spoke（派活 → 收报告 → 发裁决）不会因为往返次数被判死。`cooldown_seconds` 下界是 `1`（`0` 等于关掉检测，违反「不可关闭、只能调阈值」）。要放宽就配 Team policy（持久），要单条会话放行才用 `budget override`（临时，只抬高或清除）。
  `budget --json` 里 `edges[].count` 是**持久真相**（落盘累计值），不代表"当前窗口内还能发几条"；「现在能不能发」的唯一动作性答案是 `blocked_until`（能发就没有该字段，不能发就给出截止时间）。当前渲染层不打印 `edges`；将来若要展示窗口用量，在渲染层按 `cooldown_seconds` 现算，不要往 wire 加派生字段。
- **`policy.allow_auto_create`**（0.39，默认 `false`）：`dispatch` 在目标 `gone` 且 resume 失败后，是否允许按来源自动创建 agent；也可在单次 `agents.dispatch` 条目上传 `allow_auto_create` 显式覆盖。手改 `team.json` 时 snake_case 别名同样被接受。
- **非法值**：配置声明非法 → validation error；手改 `team.json` 的非法预算 → warning 并忽略该预算子结构（Team 仍可用）。
- 声明只**补写缺失**的 `<dataDir>/teams/<id>/<team_id>/team.json`（`<id>` 为持久化单 id）；不创建 Agent，不覆盖已有 `name` / `policy`，与已有文件冲突只 warning。
- **默认 Team**：交互 / serve 入口在没有声明命中、也没有配置 `agent.cwd` 时，用 `<dataDir>/default` 作为默认 Team 的 workspace（不是进程 cwd）；同一 data root 下 TUI 与 gateway 的 node 子进程因此共用一个默认 Team。显式 `agent.cwd` 优先；headless（`--run` / 管道）不走这条默认 Team，其 `main` 绑到独立的 `<dataDir>/headless` 锚点。
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
  auto_start: true               # gateway 启动时自动拉起本地 hub（默认 true；direction:node 忽略）
  direction: node                # 仅 node 角色：gateway 出站加入远端 hub
  url: https://hub.example:8643  # node 角色：hub 基址（join 缺省 URL；运行时 state 优先）
  ca_file: /etc/vessel/hub-ca.pem      # node 角色：hub TLS CA（可选）
  join_code_env: VESSEL_HUB_JOIN_CODE  # node 角色：join 缺 --code 时读取（可选）
```

- `hub` 是**顶层块**；`hub.data_dir`（仅 hub 进程使用）与全局 `data_dir` 相同 → validation error `hub_data_dir_conflict`。
- `direction` 只接受 `node`：gateway 出站拨号 hub，节点不需要开放入站端口。hub 仍是独立进程；`gateway start` 在 `hub.auto_start`（默认 true）时 spawn `vessel hub start`，已有活实例 adopt；`gateway stop` 只停本次 gateway spawn 的 hub，手工启动的实例不动。`direction: node` 时网关不启动本地 hub。
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
- **受保护写入口**：只包裹「读 → 改 → 写」段。host 侧为 `src/plugin/plugin-config.ts` 的 `setPluginEnabled` 与 `src/config/ui-settings.ts` 的 `setUserConfigValue`（`vessel config set` / `/settings` / gateway 配置写入都经由后者）；marketplace 侧为 `upsertPluginConfig` / `setPluginConfigValue` / `setPluginEnabled` / `removePluginConfig`。下载、解压、安装/卸载目录操作与只读加载不在锁内。
- **stale 与 timeout**：锁文件超过 15s 未更新视为持有进程已崩溃，可被接管（Windows 上 unlink 遇 `EPERM` / `EBUSY` 会短暂重试）；等待超过 5s 抛 `config_locked`，调用方必须看到该错误，不得静默丢写。持锁进程崩溃时锁最多滞留约 15s。
- **接管守卫**：stale 清理先原子创建 `${configPath}.lock.reclaim`（`{ token, pid, acquiredAt }`），只有守卫持有者能删除 stale 锁，删除前在守卫内重读 mtime；守卫自身超过 2s 视为崩溃可清理。没有守卫时两个接管者会交错 unlink/create，晚到的 unlink 会删掉对方刚建的新锁。
- **同进程**：同一配置路径的写者按顺序串行；同一异步上下文内嵌套进入同一路径直接抛 `config_locked: nested lock`，不会排队成死锁。
- **已知限制**：守卫自身的 stale 清理仍是 best-effort（直接 unlink）；只有在守卫持有者于毫秒级窗口内崩溃、且多个进程同时清理守卫时才可能重开一层同类竞态，实测 K=32×20 未复现。
- **手动编辑不在锁内**：直接用编辑器改 `config.yaml` 不参与该协议，可能与进程内的读改写竞争；协议只能约束经由上述入口的写入。
- 不新增配置键、CLI 命令、RPC 或事件；锁仅依赖本地文件系统语义，不做跨主机锁。

### 2.18 `auth`（0.56：WebUI 登录，单用户；口令 / TOTP / GitHub）

```yaml
auth:
  # 来源白名单（0.60）：redirect_uri 只能由这里的某一项 + 固定路径拼出来。
  # 线上域名与回环直连可以**并列**（不是通配）；挑哪一个由受信边缘决定，见下。
  public_origins:
    - https://egg-rolls.top
    - http://127.0.0.1:8642
  public_origin: https://egg-rolls.top   # 兼容写法：等价于「只有一个元素的 public_origins」
  backends:
    # A. 口令后端（自建、离线可用；可选 TOTP 第二因子）
    - kind: password
      username: admin                                  # 单用户，只用于展示与按账户限流
      password_hash_env: VESSEL_PASSWORD_HASH          # 可选：argon2id PHC 串（不写就不用它）
      totp_secret_env: VESSEL_TOTP_SECRET              # 可选：base32 TOTP 密钥（不写就走绑定流程）
    # B. GitHub OAuth
    - kind: github_oauth
      client_id: <GitHub OAuth App 的 client id>
      client_secret_env: VESSEL_GITHUB_OAUTH_SECRET   # 只写变量名，不写值
      allow_user_ids: [174765587]                     # 数值 GitHub user id（不用 email）
  allowed_hosts: []          # 额外放行的反代域名；一般留空
  trusted_proxies: []        # 受信代理地址；缺省只信回环 socket
  session:
    idle_minutes: 30         # 空闲超时（滑动）
    absolute_hours: 12       # 绝对超时
    persist: true            # <dataDir>/auth/sessions.json（只存 sha256）
```

- **不配 `auth.backends`（或 `enabled: false`）= 功能不存在**：回环照旧可用，行为与 0.55 逐字一致，前端不出现登录入口（不锁死、不出现坏按钮）。
- **`public_origins` 的形状（0.60）**：数组，每项必须是**完整具体 origin** —— `scheme://host[:port]`，**无路径、无尾斜杠、无默认端口、无凭据**。
  - 写成 `egg-rolls.top`（缺 scheme）、`https://egg-rolls.top/login`（带路径）、`https://egg-rolls.top/`（尾斜杠）都会被 `config validate` / 启动前的校验**直接拒绝**，并给出正确写法示例。
  - **端口通配（`http://127.0.0.1:*`）在 0.61 起也被拒绝**：它只属于 `http.allowed_origins`（访问控制）。`public_origins` 是 `redirect_uri` 的来源，回跳地址必须是具体 origin —— 详见 [2.21](#221-httpallowed_origins061访问控制与-redirect_uri-分开)。
  - 非 https 只有 **loopback / 私网**（`localhost`、`127.0.0.0/8`、`::1`、`10.x`、`172.16–31.x`、`192.168.x`、`169.254.x`、`fc00::/7`、`fe80::/10`）可以用 `http://`；公网明文是错误（会话 cookie 会丢掉 `Secure`）。
- **与 `public_origin` 的关系**：`public_origin` 保留且不废弃，语义就是「只有一个元素的 `public_origins`」。两者同时出现时**合并去重**（`public_origin` 在前，列表按配置顺序跟上），不报错；启动日志会打一行「使用了 N 个公网来源」。只有单个 `public_origin` 的老配置行为**逐字不变**（redirect_uri 只由配置决定，不看请求）。
- **来源选择规则（关键）**：来源只由**受信边缘**（`gateway/auth.ts#resolveRequestEdge`）决定，**绝不按 `Host` 头选**：
  1. 只有 socket 属受信代理（回环，或列在 `trusted_proxies`）**且**反代密钥（`gateway.proxy_secret_env`）成立时，`X-Forwarded-Host` / `X-Forwarded-Proto` 才被采信；否则一律用请求自身；
  2. 用生效 Host 去白名单里取**同一个 Host** 的那一条（Host 相同而 scheme 不同时按生效协议挑；挑不出唯一一条 ⇒ 拒绝，不给白名单外的值）；
  3. 白名单只有一条时就是它（老行为）；一条都没配 ⇒ 不启用公网来源，`github_oauth` 后端降级并告警；
  4. 本机直连（回环 socket ∧ 未经受信代理 ∧ Host 指回环）且 Host 对不上任何条目时，退回白名单里的那个回环来源（`localhost` / `[::1]` 访问不会被 500 挡住）。
- **两条安全红线（改代码前必须对照）**：
  1. `redirect_uri` **只能**由「选中的来源 + 固定路径 `/auth/github/callback`」拼出，且选中的来源必须来自白名单；拼好之后**不再受任何请求参数影响**（`Host` / `X-Forwarded-*` / 查询串都改不了它）。
  2. **state 绑定本次来源**：`/auth/github/start` 把选中的来源与它拼出的 `redirect_uri` 一起写进在途流程；`/auth/github/callback` 用同一套受信边缘判定再选一次，**必须等于 state 里那个来源且仍在白名单内**，否则直接拒绝（回登录页 `state_invalid`，文案不含内部细节）。这是防开放重定向的关键一格。
- `public_origin` / `public_origins` 是 `redirect_uri` 的**唯一**来源：必须与 GitHub OAuth App 登记的地址逐字节一致（多个来源 ⇒ OAuth App 里要把每个域名的回调地址都登记上，GitHub 允许一个 App 配多个 callback URL）。一条都没有时**只有 `github_oauth` 后端**被忽略并告警（口令后端不需要 redirect_uri），gateway 照常启动。
- `client_secret` 只从 `client_secret_env` 指向的**环境变量**读；不要写进配置（validator 直接报错并给修复提示）。OAuth access token 用完即弃：不落盘、不进日志、不进错误文案。
- 白名单只认 `allow_user_ids` 里的**数值** user id；email 会变，这里不作为身份。

#### 2.18.1 口令后端（0.56 P2）

- **首次怎么有凭据**：不生成任何默认口令。两种合法路径 ——
  1. 启动日志打印一枚**一次性引导码**（单次 + 10 分钟 TTL），用它打开
     `http://127.0.0.1:<port>/#token=<引导码>` 会换到一个**设置会话**（只能设口令、绑 TOTP）；
  2. 自己在部署里给一个 argon2id hash（`password_hash_env` 指向的环境变量），
     生成命令：
     `bun -e 'console.log(await Bun.password.hash(process.argv[1], { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 }))' '<口令>'`
- 口令 hash：**argon2id**，参数 `m=64MiB, t=3, p=1`（参数写在 PHC 串里，将来调参不会让老 hash 失效）。没有 `Bun.password` 的运行时退回 scrypt（fail-closed，不误判为通过）。明文不落盘、不进日志。
- **限速（双维度）**：每次失败同时记 `ip:<addr>` 与 `acct:<用户名>`；第 n 次失败后下一次要等 `min(250ms × 2^(n-1), 8s)`；15 分钟窗口内累计 8 次失败 ⇒ 锁 15 分钟（两个维度任一锁定即拒绝）。状态落盘在 `<dataDir>/auth/lockout.json`，**重启不清锁**。
- **不把自己锁死**：本来机回环 + 平台 token 一条命令解锁（429 文案里也带着这条命令）：
  ```bash
  curl -fsS -X POST http://127.0.0.1:8642/auth/unlock \
    -H "Authorization: Bearer $(vessel token show --purpose platform --allow-non-interactive)"
  ```
  非回环、或没带平台 token ⇒ 403/401（公网拿不到这条捷径）。
- 端点：`POST /auth/login`（口令）、`POST /auth/login/totp`（TOTP 或恢复码）、`POST /auth/bootstrap`（一次性引导码）、`POST /auth/password/set`、`POST /auth/totp/enroll`、`POST /auth/recovery/rotate`、`POST /auth/unlock`。全部只收 `application/json` 且校验 `Origin`；设口令 / 绑 TOTP 还要既有会话的 CSRF 同步令牌。
- 凭据文件：`<dataDir>/auth/credentials.json`（0600）—— 口令 hash、TOTP base32 密钥（校验必须拿到密钥本身）、恢复码的 sha256、已用掉的 TOTP step。

#### 2.18.2 TOTP 与恢复码

- RFC 6238：HMAC-SHA1 / 6 位 / 30 秒一步（认证器缺省参数，QR 里照抄）。
- **时钟漂移容忍 ±1 步**（服务端与本机认证器相差 ≤30 秒都能过），窗口不提供配置项。
- **重放**：同一步只接受一次；上一次用掉的 step 持久化在凭据文件里，同一个码第二次提交返回 `code_replayed`（重启后仍然拒绝）。
- **恢复码**：10 个，一次性，落盘只存 `sha256`，明文只在签发那一刻返回一次（页面明确要求当场存下）。用掉即废，重复使用返回 `invalid_code`。

#### 2.18.3 `#token=` 退场（0.56 P2）

- 网页**不再**用 `#token=` 做常规登录：URL 里的这个值只作为**一次性引导码**提交给 `POST /auth/bootstrap`，`#bootstrap=` 是等价写法。值不写进 sessionStorage、不进 history（hash 立刻被剥掉）。
- 引导码单次 + 10 分钟 TTL；**重放**已用引导码 ⇒ 返回 409 `bootstrap_replayed`，并**撤销它当初签发的会话**（含设口令时轮换出来的后代会话）+ 打一行告警日志。
- 之后一律走登录页；平台 token 仍然可以手动填在「连接设置」里当 Bearer 用（那条路没变）。

- 会话：cookie 名 `__Host-vessel_sid`（https；http 退化为 `vessel_sid`），属性 `HttpOnly; SameSite=Strict; Secure`；登录成功即轮换 id（防会话固定），空闲/绝对双超时，登出立即撤销。落盘只写 `sha256(sid)` 与 subject，重启后会话仍有效但需重新取 CSRF。
- CSRF：同步令牌。`GET /auth/status` 返回 `csrfToken`（`no-store`），所有变更类请求带 `X-Vessel-CSRF`；缺失/不匹配即 403。
- 端点：`GET /auth/status`、`GET /auth/csrf`、`POST /auth/logout`、`GET /auth/github/start`、`GET /auth/github/callback`、`GET /login`（SPA 登录页），以及 2.18.1/2.18.3 的口令 / TOTP / 引导码端点。静态资源与这些端点在鉴权闸**之前**，所以配了 `gateway.token` 也能打开登录页；`POST /platform/rpc` 仍然需要 Bearer token 或会话。
- 公网部署还需要：反代保留原始 Host、注入 `X-Forwarded-Proto` 与反代密钥头；浏览器直连 node 的 `/v1`、`/ws` 也要转发到 node 端口（见 `REVERSE-PROXY.md`），否则登录后仍然连不上 node。

### 2.19 `gateway.supervise`（0.58：父进程侧存活看门狗）

```yaml
gateway:
  supervise:
    enabled: true            # 缺省开；false = 关掉（外部 systemd/k8s 已在做同一件事）
    probe_interval_ms: 2000  # 探活周期
    probe_timeout_ms: 2000   # 单次探活超时（超时算这一次失败）
    failure_threshold: 3     # 连续失败多少次判僵死（成功一次即清零）
    max_restarts_per_hour: 5 # 每小时重启上限；超了停手并报错
    backoff_start_ms: 1000   # 重启后的退避（每次翻倍）
    backoff_max_ms: 60000    # 退避上限
    recovery_probes: 5       # 连续成功多少次退出退避
```

- **为什么在父进程**：`runs.start` 之后出现的整段僵死（`docs/dev/research/run-start-stall.md`）会让子进程**进程内所有定时器一起停摆**、`/health` 超时、日志无新行 —— 这个状态下进程内部没有任何自救手段，只能由父进程（gateway）强杀重起。
- **判定纪律（宁可漏杀，不许误杀）**：单次探活 2s 超时；**连续** 3 次失败才判定（≈6–8s 窗口，跨过一次 GC / 慢磁盘抖动），成功一次立刻清零。处置 = 强制终止（POSIX `SIGKILL`）→ 重新 spawn → 记一条 `event=supervisor.stall_restart` 日志（带 `consecutive_failures` / `last_ok_ms` / `probe_timeout_ms`）。
- **防抖与上界**：重启后进入退避 1s→2s→4s…（上限 60s），连续 5 次探活成功才退出退避；一小时内重启超过 5 次就**停手**并打一行 `event=supervisor.stall_restart_gave_up`（不无限重启、不刷日志），等人工 `gateway restart`。
- **不误伤**：`gateway stop` / `gateway restart` 的关停期间看门狗先停（不探活、不重启）；子进程已退出、节点不是 `ready`/`adopted`（含 `external`）时也不动 —— 正常退出路径不变。
- **可观测**：`gateway status` 显示每个节点的最近一次探活成功/失败时刻与重启计数；数据源是 `<dataDir>/platform-watchdog[-<instance>].json`（0600、不含 token）。启动输出也会打印一行 `supervise: 开/关 …`。
- **关掉**：`enabled: false`，或环境变量 `VESSEL_GATEWAY_SUPERVISE=0`（显式覆盖配置文件）。关掉后不探活、不重启，`gateway status` 仍会显示「关」，避免下一个人误以为看门狗坏了。

### 2.20 `gateway.proxy_nodes`（0.58：平台代理 node）

```yaml
gateway:
  proxy_nodes: true    # 缺省 true；false = 回退到「浏览器取 credentials 直连 node」
```

- **默认开**：注册进平台的 node 由平台代理（`/nodes/:nodeId/**`，HTTP + WS），浏览器与 CLI
  只连平台端口。node token 只在平台进程内使用，**不再下发到浏览器**。
- **降级**：打开时 `platform.nodes.credentials` 只服务 CLI / 本地自动化（必须 `mode === 'token'`，
  回环 socket 不再豁免）。浏览器在代理模式下**不调用**它 —— 这也是「node token 不出网关」的
  前端那一半。使用方：`vessel token show --purpose node`、`doctor --deep`、federation / 运维脚本，
  以及本键为 `false` 时的老前端。
- **关掉**（`false`）：平台不提供 `/nodes/*`，前端据 `platform.whoami.proxy.enabled === false`
  回到老路径（取凭据 + 直连 node）。等价于把 node token 交回浏览器，**只用于本机调试**。
- **上限**（不可配，代理由 `DEFAULT_PLATFORM_PROXY_LIMITS` 定义）：请求体 8 MiB、并发 64、
  响应头超时 30s（流式响应不受限）、WS 连接 32、WS 水位 1 MiB / 256 KiB、单向硬阈值 8 MiB。
- **失败语义**：node 不可达 → `502 node_unreachable`；平台超时 → `504 node_timeout`；
  代理并发满 → `503 proxy_busy`；被白名单拒绝 → `403 proxy_method_*` / `404 proxy_path_*`。
  写操作不重试（幂等未知即不重试）。
- **记账**：每条代理 WS 关闭写 `gateway.ws.closed`（`via: 'proxy'`）。node 侧同名日志保留，
  统计口径按 `via` 区分，避免双写翻倍。

### 2.20.1 `gateway.remote_shutdown`（Q4-C：远程停 opt-in，缺省 false）

```yaml
gateway:
  remote_shutdown: true   # 缺省 false；true = 允许非回环 gateway.shutdown（仍三重闸 fail-closed）
```

- **管什么**：只管网关平台 RPC `gateway.shutdown` 的**远程（非回环）**受理；本机停止不受本键影响。
- **开了也还要**：平台 token 恒要求（`gateway.token` / `gateway.token_env` 的值；浏览器会话 cookie
  不构成停止能力）+ 必须经**已配置共享密钥**的 TLS 反代（`proxy_secret_env` + 反代注入密钥头）。
  非回环而未配置反代密钥 ⇒ 一律拒（fail-closed，防「opt-in = 裸公网停」误配）。
- **没开**：远程停回 401 `remote_shutdown_disabled`，提示 SSH 到主机跑 `vessel stop`（零实体兜底）。
- 远程停完整形态见 [REVERSE-PROXY.md §12](REVERSE-PROXY.md)；命令面见 [GATEWAY.md §4](GATEWAY.md)。

### 2.21 `http.allowed_origins`（0.61：访问控制，与 `redirect_uri` 来源分开）

两件事，别再混：

| 键 | 回答的问题 | 允许通配？ |
|---|---|---|
| `auth.public_origins` | 登录**回跳**到哪个 origin（`redirect_uri` 的来源） | **不允许**（必须是具体 origin） |
| `http.allowed_origins` | **浏览器能不能发 RPC**（Origin 白名单 + CORS） | 允许，但只限回环 host 的端口通配 |

> **`http.allowed_origins` 只管访问控制**：它**不会**给 OAuth 提供 `redirect_uri`。配了 OAuth
> 后端仍必须有 `auth.public_origins`，缺了 `config validate` 直接报
> `auth.publicOrigins (or auth.publicOrigin) is required when an OAuth backend is configured`；
> 只有口令后端可以只靠 `http.allowed_origins`（那时 OAuth 后端会被降级并留一条告警）。

```yaml
http:
  allowed_origins:
    - http://127.0.0.1:*      # 回环端口通配：本机任意端口的 WebUI 都能发 RPC
    - http://localhost:*      # 三个回环别名是三个不同的 Origin，逐个别名写
    - http://[::1]:*
    - https://egg-rolls.top   # 具体 origin 照常写
```

**生效集合（并集，不可收窄）**：`gateway.allowed_origins` ∪ `auth.public_origins` ∪
`http.allowed_origins`。

- `gateway.allowed_origins` 与 `auth.public_origins` **永远**生效 —— 后者是本部署自己的
  来源，挡掉它等于反代面板自己不能用；
- `http.allowed_origins` 只能**往上加**，不能减（没有「只允许这些」的模式，也没有开关）；
- 不写 `http:` 这一块 = 回落 `auth.public_origins` + 三条回环通配（`http://127.0.0.1:*`、
  `http://localhost:*`、`http://[::1]:*`）⇒ 老配置一字不改，本机任意端口的 WebUI 直接能用；
- **显式写了** `http.allowed_origins` 就是它自己（不再自动补回环通配）；写 `[]` 也**不会**
  把 `public_origins` 挡掉，只是不额外加来源。

**条目规则**：

- 非通配条目与 `auth.public_origins` **完全同一套判定**（完整 origin、无路径/尾斜杠/默认端口/
  凭据；公网必须 https）；
- **端口通配只在这里合法**，且 `:*` 只能给回环 host（`127.0.0.0/8` / `localhost` / `[::1]`）。
  公网域名写 `https://egg-rolls.top:*`、私网写 `http://192.168.1.10:*`、或写
  `http://127.0.0.1:8642:*`（端口 + 通配自相矛盾）都会在 `config validate` / 启动前被拒绝；
- 通配匹配该 hostname 的**任意端口，含默认端口**（`http://127.0.0.1` 命中 `http://127.0.0.1:*`），
  但**不跨别名**（`localhost` 不命中 `127.0.0.1:*`）。

**与凭据的关系（CSRF 面）**：

- 请求带 `Authorization: Bearer <token>` 且**校验通过** ⇒ 跳过 Origin 白名单（浏览器不会自动
  附加 `Authorization`，跨源请求连预检都带不了凭据，所以这条不是 CSRF 面）；
- **cookie 会话路径永远过白名单**：变更类请求另需 `x-vessel-csrf`（见 2.18），origin 与 CSRF
  是两道独立的闸，任何一道都不因为另一道放宽而放宽；
- 「受信反代」这条豁免**按反代密钥**判定，不按「回环 socket」（回环不能证明来源）。

**CORS**：命中白名单（含通配）时**回显该请求的 Origin**（绝不 `*`）并带 `Vary: Origin`；
`Access-Control-Allow-Credentials: true` 只在 cookie 会话路径（平台）给出，node 侧（纯 bearer）
不给；预检允许头包含 `Authorization` 与 `X-Vessel-CSRF`。

### 2.22 `auth.allow_loopback_anonymous`（0.63：本机直连免登录，缺省 false）

```yaml
auth:
  allow_loopback_anonymous: true   # 缺省 false；单机开发可接受，共享机/公网部署不要开
```

**它回答的问题只有一个：这个请求要不要** *身份*。打开后，「回环 socket + 回环 Host +
未被证明是受信反代」的请求算**本机直连**（`edge.localDirect`），平台数据面
（`/platform/rpc`、`/nodes/**`）不再要求登录；否则维持今天的严格行为 —— 配了登录后端就
`401 session_required`。

为什么需要这个开关（曾经是一条死路）：判定「是不是受信反代」用的是
`proxySecretAllowed()`，而**没配**反代密钥时它恒真 ⇒ `viaProxy` 恒真 ⇒ 旧判据下
`localDirect` 永远为假。也就是说 0.62 及以前，文档承诺过的「本机直连免登录」在任何一台
没配 `gateway.proxy_secret_env` 的机器上都走不到。0.63 起改成**显式开关**：

| 事实 | `localDirect` |
|---|---|
| 开关缺省 / `false` | **恒 false**（与 0.62 逐字一致） |
| 开关 `true` + 回环 socket + 回环 Host + 没配反代密钥 | `true` |
| 开关 `true` + 反代密钥**配了且带对**（`X-Forwarded-Host` 生效） | `false`（反代已证明，按反代路径走） |
| 开关 `true` + 非回环 socket（或 Host 不是回环） | `false` |

**代价（开之前先读这句）**：同一台机器上的**任何进程**（任何本地用户、任何脚本、任何
浏览器页面）都能不经登录读写数据面。单机开发可接受；共享主机、多用户机器、公网部署
不要开。开启时 `vessel config validate` / 启动前的配置校验会出一条 warning 复述这句话。

**它还救不了「配了反代密钥却没带对」的请求**：数据面第 4 步要求 `proxySecretOk` 成立，
这类请求会被 `401 platform_unauthorized`（`platform_unauthorized: proxy_secret_missing`）
拒掉 —— 真机实测如此，比 `localDirect` 更严。反过来说，这个开关只对「没配密钥的回环
直连」生效，不会给一条绕过反代密钥的路。

**与 §2.21 的关系**：无关。这个开关**只**影响「是否要求身份」，不改变任何一道闸的次序与
严格性 —— `http.allowed_origins` / `auth.public_origins` 的 Origin 白名单（§2.21）、Bearer
凭据闸、cookie 会话的 CSRF 闸照旧逐条生效：开了这个开关，`Origin` 不在白名单里的浏览器
请求仍然是 `403 Origin is not allowed`，变更类 cookie 请求仍然要 `x-vessel-csrf`。

**顺带影响的一处**：`redirect_uri` 的来源选择在「只有多个来源且 Host 对不上」时会退回
白名单里的回环来源，而它用的正是 `edge.localDirect`（§2.20）。所以打开这个开关也把
「本机用 `localhost` 访问、白名单只写了 `127.0.0.1`」那格救活了 —— 回退值仍是**白名单里的
原值**，不是请求里的字符串。

### 2.23 `tools_engine.mode` + `gateway.engine_pool`（engine 双路双开关，缺省关）

```yaml
tools_engine:
  mode: pool            # 缺省 child = per-node stdio 子进程；pool = 共享池直连（需池存在）
gateway:
  engine_pool:
    size: 2             # 0/缺省 = 不建池（零回归）；1 = 装配期 fail-fast；开时 ≥2
    # max_inflight: 32        # 每 engine 进程在途上限；缺省 os.cpus().length × 4
    # rss_soft_limit_mb: 512  # rss 软阈值（MB）；缺省 unset = 不启用
    # instance: alt           # 多平台实例名；poolDir = ~/.vessel/engine-pool[-<instance>]
```

- **双开关缺省关**：`tools_engine.mode` 缺省 `child`、`gateway.engine_pool.size` 缺省不建池，两个都显式打开才走池路径（node 侧仅 `mode: pool` 显式 opt-in 进 bootstrap 的池分支，池由 gateway 按 `size ≥ 2` 建并监督）。回退 = 翻配置 + 重启。
- **无静默回落**：池候选全不可用 ⇒ 抛 `ENGINE_ERROR.unavailable`，不回退 in-process / child（supervisor 纪律）；busy 在派发前快拒、不计熔断。
- **poolDir 不随 data_dir 移动**：池目录在用户全局配置目录下（`~/.vessel/engine-pool[-<instance>]`），`--data-dir` / `VESSEL_DATA_DIR` 都不移动它——隔离实例必须设 `engine_pool.instance`，否则与主实例共用同一池目录。
- **max_inflight 是物理资源保护，不是 run 累计限制**：缺省 `cpus × 4`（engine 进程 `readPoolLimits` 读取，经 spawn env 下发）；`rss_soft_limit_mb` 缺省不启用。
- 键语义的家在 [architecture/config.md](../architecture/config.md)；执行现态与路由语义见 [tools.md#engine-exec](../architecture/tools.md#engine-exec) 与 [ADR-106](../adr/ADR-106-engine-pool.md)。

### 2.24 `empty_response`（q-empty-response：空响应兜底，缺省开）

```yaml
empty_response:
  enabled: true       # 缺省 true；false = 空响应直接当终稿（修复前行为，零回归开关）
  max_retries: 2      # nudge 重试上限（不含首次响应）；缺省 2，范围 0–10；0 = 不重试只落日志
  # nudge: '继续你的任务……'   # 自定义提示文案（user 消息注入）；缺省用 core 内置文案
```

- **管什么**：模型偶发「空内容 + 无工具调用 + 终止原因」（大上下文 / 压缩后更易发）。
  无兜底时两条终止路径（`stop` / 其他 `finish_reason`）把空串当终稿 → agent 早退零输出。
  现在 core loop 追加一条「继续你的任务」nudge 重新轮询；**限次防死循环**，耗尽落
  `llm.empty_response`（`action: 'exhausted'`，internal 层事件）后回落原始终止行为——不再静默。
- **缺省即启用**：整段可缺省（= enabled=true、max_retries=2、内置文案）。影响所有 agent
  （owner + 成员）；工具调用路径与非空终稿不受影响，`finish_reason` 语义不变。
- **生效面**：装配进 tenant profile ⇒ **新 EU（新会话）生效**；已存活会话持启动时快照
  （与 `vision` 同语义）。
- **可写面**：`emptyResponse.enabled` / `emptyResponse.maxRetries` / `emptyResponse.nudge`
  三键进 `config.set` 白名单（WebUI 设置 →「运行期（core）」分组；CLI `vessel config set`）。
  键语义的家：core `EmptyResponsePolicy`（types/provider.ts）+ `DEFAULT_EMPTY_RESPONSE_*`
  （runtime/tool-calling-loop.ts）；映射在 `src/config/empty-response-settings.ts`。

## 3. 密钥与 `_env`

所有接受密钥的字段支持 `<field>_env`：

- `api_key_env`
- `provider.api_key_env`
- `feishu.app_secret_env`
- `serve.token_env`（node token）
- `gateway.token_env`（Platform Gateway token，与 node token 分开）
- `serve.proxy_secret_env` / `gateway.proxy_secret_env` / `hub.proxy_secret_env`
  （0.55：同机反代的共享密钥头；未配置 = 不做任何事，见
  [REVERSE-PROXY.md](REVERSE-PROXY.md)）。三者用途不同，**不要复用同一个值**。

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

**同机反代（0.55）**：反代与 Vessel 同机时，客户端对端地址恒为 `127.0.0.1`，
「回环 = 本机」不再成立。把反代密钥的环境变量名配到 `gateway.proxy_secret_env` /
`serve.proxy_secret_env` / `hub.proxy_secret_env`，并让反代注入 `X-Vessel-Proxy-Secret` 头
（**覆盖**，不是追加）。未配置时行为与之前逐字一致；配置后该监听只接受经反代来的匿名请求，
带 Bearer token 的客户端不受影响。

**0.55 起默认生效的收紧**（会打断部分现有部署，迁移见 [REVERSE-PROXY.md](REVERSE-PROXY.md) §8）：

- `gateway.hostname` 非回环（`0.0.0.0` / `::` / 网卡地址）且没有 `gateway.token` /
  `gateway.token_env` ⇒ **平台拒绝启动**（`platform_listen_insecure`）。回环监听不受影响。
- `platform.nodes.credentials` 只认 `mode === 'token'`：浏览器需要平台 token
  （`#token=<值>` 导入），脚本需要 `Authorization: Bearer <platform-token>`。
  **纯本机安装也一样**：不配 `gateway.token` 时页面能列节点但连不上 node。
  **0.58 起**：打开 `gateway.proxy_nodes`（缺省就是开）后浏览器不再取 node token，
  数据面走 `/nodes/:nodeId/**`（回环匿名照旧可用）；这个端点只服务 CLI / 本地自动化。
  关掉代理（`proxy_nodes: false`）时恢复上面这条完整收紧。
- `hub.proxy_secret_env` 配置后，hub 的目录 / WS 目录流 / 删节点都要求密钥头。
- `vessel doctor` 会对「回环 + 没有任何 token」给出 warning（只提示，不改变运行行为）。

### 3.1 `env_file`：密钥放文件、配置只写路径（0.56）

不想每条命令 `export` 时，把密钥写进一个文件，配置里**只写路径**：

```yaml
# ~/.vessel/config.yaml
env_file: ~/.vessel/secrets.env        # 一个路径
# env_file:                            # 或一组（按顺序加载，先到先得）
#   - ~/.vessel/secrets.env
#   - ./deploy/keys.env
```

```dotenv
# ~/.vessel/secrets.env
export BOCHAAI_SEARCH_API_KEY=tvly-...     # export 前缀可有可无
VESSEL_TAVILY_API_KEY="..."                # 单/双引号都行
VESSEL_SERPER_API_KEY=...                  # 未加引号时行内 " #…" 算注释
```

规则：

1. **优先级：真实环境变量 > 文件**。文件只填空缺的键，显式 `export` 仍然赢
   （CI 注入的临时值不会被仓库/家目录里的文件盖掉）。
2. 时机：**在 env 层之前**加载，所以文件里的值对 `VESSEL_*` 与插件 key 同样生效。
3. 相对路径按**进程 cwd** 解析；`~` 会展开；不做 `${VAR}` 插值（同 §3 第 4 条）。
4. **显式配置的路径读不到 ⇒ 启动报错**（`envFile: … does not exist`）。理由与
   `--user-config` 一致：静默忽略会让人以为加载了，其实没有。
5. 加载后**不打印任何值**；加载结果（每个文件加载了哪些**键名**、哪些因真实 env 已存在被保留）
   在 `loadConfig()` 的 `envFiles` 字段里，供诊断使用。
6. 密钥**永远不进 `vessel.yaml`**（§3 第 5 条仍生效）：`env_file` 只是「值的搬运工」，它
   本身是路径，不是值。

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
vessel config set ui.showArchived <true|false> [--json]
vessel config set ui.errorLevel <user|all> [--json]
vessel config set ui.askUser <true|false> [--json]
vessel config set ui.expandCards <true|false> [--json]
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
vessel team show <team_id|slug> [--json]
vessel team mine [--json]
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
vessel prune [--older-than <dur>] [--dry-run] [--json] [--yes]
```

- `vessel team ...` 经 owner 端点（`from = ownerId`、viewer 可见 private）；`team post` 的 `--mention` 先在同 Team roster 内解析为 agent id，日志写成功但任一投递失败时退出 1。
- `team show <team_id|slug>` 只读 `teams.get`（窗口 1/1），输出名称 / workspace 绝对路径 / policy / frozen / 成员数；参数不是 id 时回退到 `teams.list` 按名字或 workspace 目录名做**唯一**匹配，多命中直接报错。`team mine` 取 `process.cwd()`，在 `teams.list` 的 workspace 里按包含关系反查（命中多个取最深的一层，`exact` = cwd 就是 workspace），命中输出里带 `basis` 判定依据；没命中报 `no_team_for_cwd: 当前目录不属于任何 Team` 并退 1，`teams.list` 脱敏掉 workspace 时单独报 `team_workspace_unavailable`。
- `team create|update` 的 `--policy` / `--policy-file` 互斥；文件内容必须是 JSON 对象，整体替换 policy（不做 merge）。`team archive` 有 present 成员时退出 1（`team_not_empty`）。
- `vessel hub ...`：`hub start` 启动独立 hub 进程；`hub join-code` 在 hub 侧生成一次性 code，`hub join` 在节点侧消费（node → hub）；`hub directory` / `hub watch` / `hub node list|remove` 只读或吊销。token 明文只在 `hub join` 响中出现一次，不写日志。

- `vessel agent ...` 经 `<dataDir>/agent-owner.json` attach 到交互 REPL 的 owner；没有 owner 时 `agent_owner_unavailable`。命令只做参数映射，生命周期全在 owner。

- `vessel --data-dir <path> ...`（全局）覆盖 `data_dir`；同样适用于一次性命令。
- `vessel doctor --deep`：在原有本地检查之外，只读查询本地 gateway 的 `health.get` / `mcp.list`，报告 attach / runtime / MCP 实际状态；不启动 gateway、不改配置。没有本地 gateway 时记为 info，不算失败。
- `vessel logs tail`：只读 `<dataDir>/logs/gateway.log`（default）与 `gateway-<instance>.log`（命名实例），默认 50 行，`--lines` 上限 10,000；不跟随、不轮转，日志不存在时退出 1。
- `vessel prune`：判据是**状态**，不是时间。目标集合 = 已归档 team（`team.json` 的
  `archived_at` 非空）下的所有 agent ∪ 已停用（快照 `state == 'closed'`）agent。对每个目标 agent
  删它的全部会话（级联：会话壳、`sessions/<id>/` 事件目录、该会话的 run 记录与 `<run>.jsonl`、
  历史 `<sessionId>.jsonl`）、`inbox/<id>.json` 与快照里那条记录；归档 team 在它的 agent
  **全部清完**后 `teams/<tenant>/<team_id>/` 整个目录一并删掉（不删会留下空壳）。
  **没有归档、没有停用的一律不删** —— 它们的会话、runs、记录都不动。
  输出按五类汇总（team / agent / session / run / trace），`--json` 给同一份结构。
  **缺省 dry-run**：只报告条数与体积，一条都不删；必须 `--yes` 才真删，且真删先取 `data-dir`
  写意图锁（gateway / node 在跑时直接拒绝，不重试、不降级、不做部分删除）。dry-run 与真删读
  同一份计划、按同一顺序执行，因此预算的数字就是会删的数字。
  `--older-than <n><ms|s|m|h|d>`（裸数字按天）是**可选叠加**：不传就完全不看时间；传了只清
  「归档 / 停用时刻早于阈值」的对象（不是会话最后活动时间），查不到归档 / 停用时刻的默认不清。
  会话仍有活写者（写锁 / 租约 live 或不可解析）或还有 `running` / `interrupted` 可 resume 的 run
  时，该会话不删，连带着它的 agent 记录也留（记录与数据不拆散）。
  `trace` 一类是容量策略（`trace.retention_days` / `max_runs` / `max_bytes`），不看状态，与状态
  判据正交；随会话级联删掉的 trace 文件单独记在 `cascade_files`。
  **这一桶是「未归档一律不删」的唯一例外（用户知情取舍）**：留存策略可能清掉「未归档 team 的
  活 agent」的旧 run trace —— 保留它是因为日志无限增长本身是更大的问题；要彻底对齐状态判据，
  需要给 core 的 `pruneTrace` 加会话 allowlist（另一单）。
  **不清 `conversations` / budget 记录**：它们的维度是 `conversation_id`，不是 agent / team 归属，
  按 conversation 反推「属于谁」会引入猜测。

- `config path`：打印用户配置、项目配置与 `data_dir` 的实际路径和是否存在。
- `config init`：把内嵌模板写到用户配置；默认不覆盖已有文件，`--force` 才覆盖。
  模板只写 `api_key_env`，不写真实密钥。
- `config show`：输出合并后的配置；`--sources` 标注每个键来自
  `cli | env | project | user | default`。**有校验错误时 exit 1**。
- `config.get` / `config.sources`（RPC）与 `config show` 一样，永不输出解析后的
  密钥值，只输出 `"<set>"` / `"<unset>"`。
- `config.set`（RPC，0.15）：只写用户配置、只接受白名单键（`ui.language` /
  `ui.statusBars` / `ui.verbosity` / `ui.errorLevel` / `ui.showReasoning` /
  `ui.showInternalEvents` / `ui.showArchived` / `ui.askUser` / `ui.expandCards` /
  `observability.showProcessErrors` / `agent.cwd`），值非法返回 `invalid_params`。写入同样原子、`0600`、保留其它键。

### 4.1 Gateway 生命周期与配置生效（0.12）

```bash
vessel gateway start [--daemon] [--port <n>] [--host <h>] [--log <path>]
vessel gateway stop [--timeout 10s] [--keep-nodes]
vessel gateway status [--json] [--rpc]
vessel gateway restart [--daemon] [--no-keep-nodes]
vessel gateway reload [--scope config,plugins]
vessel gateway install-service [--systemd|--launchd|--schtasks]
vessel gateway uninstall-service
```

- `--serve` 是前台 `vessel gateway start` 的别名；常驻部署用 `start --daemon` 或 `install-service`。
- 运行态以 `<dataDir>/gateway.pid`（`0600`）为准；daemon 日志在 `<dataDir>/logs/gateway.log`（`0600`）。`status --json` 只输出 JSON。
- `gateway status --rpc`：经 RPC 只读查询 `health.get` 与由 `runs.list` 派生的队列计数（queued / running），不 attach runtime；`--json` 输出 `{ as_of, rpc: true, instances }`。任一实例查询失败时退出 1。
- 命名实例的交互记录与 PID / 日志一样按实例隔离（见 §2.10）；`vessel logs tail --instance <name>` 读对应日志。
- `reload` 热更新 plugins 扫描缓存、`serve.allowed_origins`、permission 规则、插件工具面、MCP（有控制面时）与 `provider.model`。`provider.model` 热应用只替换**节点缺省模型**：新 body / 新 EU 立即用新值；live 会话的 model 是构造期只读快照，仍旧值直到 rotate / 重启（前缀不变量），续接 run 真正换模型时会追加模型环境卡。provider（不含 model）/ agent（含 `agent.model`）/ TLS / token / port 的变更会出现在 `requires_restart`，必须重启。未知 scope 或读取失败返回非 0。
- **`restart` 是平台层重启（handoff，0.52）**：旧 Gateway 退出时**不终止**自己 spawn 的 node（与 hub），新 Gateway 启动时按 `gateway.pid` 三元组 / hub lock adopt 接管，所以在跑的 run 不中断。保留语义经 `<dataDir>/platform-handoff[-<instance>].json`（本进程族运行时状态，TTL 120s，消费即删）传给旧 Gateway；非 handoff 停止会先清掉残留 marker，不会把真停变成假停。
- `stop` 缺省仍是**真停**（连 node/hub 一起停）；`stop --keep-nodes` 显式表达「只停平台层」。`restart --no-keep-nodes` 是冷重启：升级二进制后想让 node 也换新代码时用它（或 `gateway stop && gateway start`），否则 node 进程还是旧版本。启动输出 / Gateway 日志里 node 行末尾的 `(adopted)` 表示该进程不是本 Gateway spawn 的，而是接管来的（`gateway status --json` 契约不变，不加字段）。
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
