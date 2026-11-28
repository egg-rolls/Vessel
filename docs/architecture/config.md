---
title: 配置模型
kind: current
triggers: [config, yaml, vessel.yaml, precedence, env, data root, gateway token, node token, secrets, 配置, 配置项, 优先级, 数据目录, 密钥, 令牌, 环境变量, tools_engine, engine_pool, 双开关, hot-apply, config-watch, models, ModelRef]
paths: [packages/config/src/loader.ts, packages/config/src/defaults.ts, packages/config/src/model-registry.ts, packages/config/src/env-injection.ts, packages/config/src/validator.ts, src/config/cli-overrides.ts, src/gateway/serve-config.ts, src/config/config-watch.ts, src/config/hot-apply-assembly.ts, src/gateway/gateway-reload-wiring.ts, src/data/permission-store.ts]
---

# 配置模型

<a id="config-model"></a>

## 合并模型

配置层按优先级从高到低：

| 层 | 路径 | 用途 |
|---|---|---|
| CLI / env | 命令行 flag、`VESSEL_*` / `.env` | 操作者与部署覆盖；密钥首选 |
| 项目级 | `./vessel.yaml` | 项目行为：session、context、plugins、trace；**禁止密钥** |
| 用户级 | `~/.vessel/config.yaml`（Windows `%USERPROFILE%/.vessel/`） | provider、默认模型、`data_dir` |
| 默认 | 代码 `DEFAULT_CONFIG` | 所有缺省值 |

**CLI > env > project > user > default**。例外（仅 `data_dir`，用户裁定#3）：显式 `--user-config`
（`userConfigPath` / `VESSEL_USER_CONFIG`）且用户层写了 `data_dir` 时，该键责任链为
**CLI > 显式 user config.data_dir > env > project > default**；非显式保持旧链。
`VESSEL_DATA_DIR_CLI=1` 是内部 env 契约（`--data-dir` 镜像 / supervisor 注入伴生），带标记按 CLI 层应用。
没有 tenant overlay / `tenant` 块；旧 `tenant:` / `serve.tokens[*].tenantId` / `adminToken` fail-fast 给逐项 Fix。

所有层只在 `loadConfig()` 合并一次；CLI 层由 `ConfigLoadOptions.cliOverrides` 传入（`Partial<VesselConfig>`，
`source=cli`），`cli-overrides.ts` 只把**显式** flag 组装成该层；`resolveServeOptions(config)` 不接收 argv。
loader 把 YAML snake_case 映射成 TS camelCase（ADR-019），map 键（`mcp_servers` / `models.credentials` /
`models.entries` / `param.extra` / info 未知键）原样保留。**未知键是 error**（带编辑距离建议）；已知未消费
字段给显式 warning。`node:` 是节点监听块唯一名字（`serve:` 读到即报错要求改名，错误路径一律 `node.*`；
类型 `NodeConfig`）。运维面（位置 / 合并规则 / 写锁 / 排查）见 [operations/config-files](../operations/config-files.md)。

## 单公司数据根

`data_dir` 是全局唯一根；数据直接位于 `<dataDir>/{sessions,runs,events,inbox,agents,conversations,teams}/`、
`sessions.db`、`tenant.json`，没有 `tenants/<id>` 层。`tenant.json` 只保存内部持久单 id（缺省 `default`，
匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`），不是 wire 字段；`tenants/**` 非空或残留 `.t2-migrating-*` →
fail-fast `non_root_layout`（不移动不删除）。`durable.path` 缺省 `<dataDir>/runs`。锁 / 租约 / prune 见 [operations/config-data](../operations/config-data.md)。

## 配置块总览（键语义深细节归 operations 叶子）

| 键 | 说明 |
|---|---|
| `provider.timeout_ms` | LLM 请求超时（毫秒）；`<=0` 关闭；仅插件式 provider 生效。新旧键规则见 [config-models](../operations/config-models.md) |
| `trace.*` | 缺省 true / `full` / 30 天 / 1000 runs / 1 GiB；`max_bytes: 0` = 不限；见 [TRACE](../operations/TRACE.md) |
| `session.backend` / `durable.*` / `update.*` | session `file`（默认）/ `sqlite` / `memory`；durable 默认 true，`checkpoint_every: iteration`；update 后台检查默认 true、latest/beta、自定义清单源 |
| `agent.*` | 成员配置键（含 `team_member_limit` 默认 100）见 [config-agent](../operations/config-agent.md)；`agent.cwd` 优先级：参数 > agent.cwd > 成员 cwd（Team 基础路径）> process.cwd() |
| `mcp_servers.<name>.*` | `transport`（stdio/http）、`command`/`args`/`env`、`url`/`headers`、`enabled`、`connect_timeout_ms`、`tool_timeout_ms`、`tool_prefix`、`auto_approve_tools` |
| `node.hostname` / `port` / `allow_remote` / `tls.*` / `allowed_origins` | Node API 监听；legacy 单监听默认 `127.0.0.1:8642`，拆分模式 Node API 用 `8644`；非回环必须 `allow_remote: true` + token 非空 + TLS cert/key 成对；allowed_origins 绝对 http(s)，禁 `*`/path/query，非回环必须 https，HTTP 与 WS 共用 |
| `node.token` / `token_env` / `tokens` | node token：`tokens` 为 token → `{ role }`；单 token 是 legacy 回退；admin 用 `{ role: admin }`。派生与解析见 [config-secrets](../operations/config-secrets.md) |
| `connect.*` / `transport.*` | `--connect` 客户端 token 优先级 CLI > env（`VESSEL_CONNECT_TOKEN`，缺失回退 `VESSEL_GATEWAY_TOKEN`）> config；transport 只剩 `in-process`，`transport.token` 是 gateway token 末位回退 |
| `gateway.*` | token / port（缺省 8642）/ supervise / proxy_nodes / remote_shutdown / web_dist / engine_pool 见 [config-gateway](../operations/config-gateway.md) 与 [config-runtime](../operations/config-runtime.md) |
| `evals.*` / `feishu.*` / `observability.event_history` / `metrics` | evals 默认 true / `./evals` / `~/.vessel/evals` / allow_network false；feishu 默认 false，secret 优先序 env > `app_secret_env` > `app_secret`，`agent_id` 已删（见 [FEISHU](../../plugins/im/feishu/FEISHU.md)）；event_history 缺省 1000（显式 0 = 不限）；observability 块缺省不注入 metrics，块存在时 metrics 默认 true |
| `observability.log.*` | level/modules/color/format/time；env 优先级 `VESSEL_DEBUG` > `VESSEL_LOG_LEVEL` > `VESSEL_RUN_TIMING=1`（仅 run.timing/run.llm.gap）> config；`VESSEL_LOG_JSON=1` ≡ json；见 [LOGS](../operations/LOGS.md) |
| `permission.*` / `plugins[]` | auto_approve / never_auto_approve（缺省 `['agent.close','pii_reveal']`，单源 `permission-defaults.ts`）见 [config-permission](../operations/config-permission.md)；覆盖层语义见 [agents/plugins](../agents/plugins.md) |
| `ui.*` / `env_injection` / `limits` / `termination` / `pricing` | 见 [config-ui](../operations/config-ui.md) / [env-info-append-only](env-info-append-only.md#cadence) / [config-limits](../operations/config-limits.md) |
| `vision.*` / `empty_response` / `kanban` / `auto_prune` / `context.*` | 见 [config-runtime](../operations/config-runtime.md) / [config-data](../operations/config-data.md) / [config-limits](../operations/config-limits.md) |
| `models.*` | 凭证面 + 模型面（下节）；校验 / 磁盘 / CLI 见 [config-models](../operations/config-models.md) |

`VESSEL_PLUGINS` / `VESSEL_SESSION_BACKEND` / `VESSEL_MODEL` / `VESSEL_PROVIDER_API_KEY` 是 env 层覆盖。
evals / feishu / metrics / observability 全缺省时：CLI eval 不可用、不启动飞书、不注入 metrics。`vessel.yaml` 的 `tools:` 声明段已删除（连同 `ToolConfig`）。

<a id="models"></a>

## models 机制（凭证面 + 模型面）

磁盘只有两种实体（credentials 认证端点 + entries 扁平条目），**无密钥值**；YAML 形状 / 校验 /
迁移运维见 [config-models](../operations/config-models.md) / [config-model-migration](../operations/config-model-migration.md)。

- **ModelRef 解析**（`model-registry.ts:resolveModelRef`）：① 空 ref → 有效默认（`models.default` ??
  legacy 合成条目 ?? 协议默认；`VESSEL_MODEL` 赢 `models.default`）② 别称精确命中 ③ 条目键精确命中
  ④ 显式 `legacy:<name>/<model>` ref → 严格面：按首个 `/` 切分，name 段必须命中合成凭证、model 段
  非空原样作 wire；裸 `legacy:<name>` / name 不匹配 → `ModelRefError`（不落透传）
  ⑤ 未命中且 legacyPresent → ref 原样作 wire 走 legacy 合成凭证 ⑥ 未命中且无 legacy → `ModelRefError` + 候选（无 vendor 兜底）。
- **无幻影条目**：合成凭证恒存在；合成条目只在 `legacyPresent=true` 时建——纯 default 层填充的
  `provider.model` 不是用户配置，不建条目（此时未命中 ref 走 ⑥）。
- **缺省身份 ref/wire 分离**（`DefaultModelIdentity`）：`ref` 是宿主缺省 / spawn 继承 / 热应用比较键
  （必须可重解析）；`wireModel` 只作请求体与展示。`defaultModelRefOf`：注册条目 → 条目键（alias
  规范化后）；legacyPresent=true → wire 原值；false → 显式 `legacy:<name>/<wire>` 严格 ref。
- **端点定位** = `entry.provider`（协议适配器）+ `entry.credential → credentials.baseUrl`（必填，不回落协议默认）。
  规范协议集 openai / openai-compatible / anthropic / gemini；品牌工厂名保留注册供 legacy 兼容；凭证 id 大小写均可（`CREDENTIAL_ID_RE`）。
- **param 优先级链**：请求显式（EU/harness）> 会话级 thinking 注入（BeforeLlm requestExtras）>
  `entry.param` > 全局 `provider.*`；extra 经 `mergeExtraParams` 并入（RESERVED_BODY_KEYS 写前拒绝）；
  messages 零触碰（append-only）。
- **价格合并视图**（`usage-pricing.ts`）：`entry.pricing` 按 wire 名覆盖 `pricing.models` 同名键；
  同 wire 多 entry 价格不同 → 确定性取条目键序首个 + 写前 warning。
- **legacy provider.\* 兼容面**：读时折成合成凭证 `legacy:<provider.name>` + 合成条目；env 层 /
  setup 向导 / model-follow 写入口不动。**一次性迁移**（loader 首载钩子，withConfigLock + 幂等 +
  fail-fast）细节见 [config-model-migration](../operations/config-model-migration.md)。

## hot-apply 机制

- **config-watch**（`config-watch.ts`）：`fs.watch` 用户配置，写入抖动 debounce 合并；校验通过后应用，差异行按行首
  scope token 分组、每组独立一条 notice（无前缀行归 config 兜底组）。O7 直写竞态加固：`config.set` 写盘同步 trigger 已应用一遍，同一次写入迟到的 fs.watch 事件去重，不双应用。
  **空差异如实通知**（q-config-edit-bypass）：所有 scope applier 都报空差异、但配置内容确实变了（`ui.*` / `envInjection` 非 cadence 字段等无专属差异行的键）时，装配层报 `config: hot-applied (changed: <顶层键>)`（`changedConfigKeys`，与 `diffRestartFields` 同 `stableValue` 口径），不发无内容的 `reloaded` 致「未生效 / 被旁路」误读；内容未变（回声）保留旧 `reloaded` 兜底。agent edit/write 直写 config 无独立预应用 hook——唯一热应用入口就是 config-watch，直写经正常 `fs.watch` 路径应用。
- **scope → applier 注入表**（`gateway-reload-wiring.ts`）：`config` / `plugins` 内建；
  `permission` / `tools` / `mcp` 由装配注入（只注册真实存在的 applier）。请求未注册 scope →
  `unknown reload scope`；单 scope 抛错不中断其余（失败写进该 scope 摘要）。applier 返回差异摘要行。
- **config scope 内的子应用器**：`applyProviderModel`（缺省身份比较 + `previewDefaultModel` 守门：解析不出 /
  ModelRefError ⇒ 变化域进 `requires_restart`，不把不可重解析的 wire 名热应用进宿主缺省）、`applyFederation` /
  `applyKanban` / `applyAutoPrune`（live resolver + reschedule）。未注入 ⇒ `requires_restart`，不假装生效。
  生效点 = 节点缺省模型：新 body / 新 EU 用新值，live 构造期只读快照（前缀不变量）。
- **live resolver**（`hot-apply-assembly.ts`）：runtime.notice hook 的 cadence / channel 每次发射
  实时求值（入参是 live 配置 getter，非注册时快照），热改 `env_injection` 即时生效。
- feature 收集器的 hotApply 双形态与 fail-closed 冲突闸见 [cli-wiring](cli-wiring.md)（ADR-107）。
  用户可见热生效面 / requires_restart 清单见 [operations/config-reload](../operations/config-reload.md)。
- **permission-store 写锁**：权限规则读写改用 config 包 `readUserConfigRoot` / `writeUserConfigRoot`，写统一包
  `withConfigLock`（与 `config.set` 同一把跨进程单写锁，读改写整体在锁内）；API async，读侧不加锁（原子 rename）。