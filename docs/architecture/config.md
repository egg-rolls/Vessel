---
title: 配置模型
kind: current
triggers: [config, yaml, vessel.yaml, precedence, env, tenant overlay, secrets]
paths: [packages/config/**, src/cli-overrides.ts, src/serve-config.ts]
---

# 配置模型

<a id="config-model"></a>

## 配置模型

配置层按优先级从高到低为：

| 层 | 路径 | 用途 |
|---|---|---|
| CLI / env | 命令行 flag、`VESSEL_*` / `.env` | 操作者与部署覆盖；密钥首选 |
| tenant overlay | `tenant.tenants.<id>.config` | 单 tenant 覆盖；**不得覆盖 CLI/env** |
| 项目级 | `./vessel.yaml` | 项目行为：session、context、plugins、trace、tenant 覆盖；**禁止密钥** |
| 用户级 | `~/.vessel/config.yaml`（Windows `%USERPROFILE%/.vessel/`） | provider、默认模型、`data_dir`、`tenant.default` |
| 默认 | 代码 `DEFAULT_CONFIG` | 所有缺省值 |

优先级：**CLI > env > tenant overlay > project > user > default**。
tenant overlay 只叠加在项目/用户之上；`data_dir` 是全局键，tenant overlay 不得修改。

所有层只在 `loadConfig()` 合并一次。CLI 层由 `ConfigLoadOptions.cliOverrides` 传入（`Partial<VesselConfig>`，`source=cli`）；旧 `defaults` 为 deprecated 同义层，先应用、`cliOverrides` 后应用。`src/cli-overrides.ts` 只把**显式** flag 组装成该层（端口仅在显式给出时写入；`allowed_origins` 整体替换）。`resolveServeOptions(config)` 不再接收 argv，`bootstrapConnect` 也不再直接读 `process.env`。

loader 把 YAML 的 snake_case 映射成 TS 的 camelCase（ADR-019）。校验器对未知键报错——配置写错要立刻知道，不静默忽略。

### 配置块

| 键 | 说明 |
|---|---|
| `provider.timeout_ms` | LLM 请求超时（毫秒）；`<=0` 关闭。仅插件式 provider（openai / anthropic）生效 |
| `data_dir` | 全局数据根，默认 `~/.vessel/data`；`VESSEL_DATA_DIR` 覆盖；tenant overlay 不得修改 |
| `tenant.default` / `tenant.tenants.<id>.*` | `default` 缺省 tenant；`name` / `status`（`active`\|`disabled`）/ `quota`（`max_sessions` / `max_runs_per_day` / `max_concurrent_runs` / `max_storage_bytes`）/ `tools.allow|deny` / `config` overlay；白名单见 ADR-049 |
| `trace.enabled` / `level` / `retention_days` / `max_runs` / `max_bytes` | 缺省 true / `full` / 30 / 1000 / 1 GiB；`level` 为 `full`\|`metadata`\|`off`；`max_bytes: 0` = 不限 |
| `session.backend` | `file`（0.5 默认）/ `sqlite`（0.4 默认，仍可用）/ `memory`；`storagePath` 对应 sqlite 文件或 file 目录 |
| `update.autoCheck` / `channel` / `source` | 交互启动后台检查（默认 true）、`latest` / `beta`、自定义清单源 |
| `agent.enabled` / `ownerId` / `model` / `limits` / `termination` | AgentService 与内置 `agent` 工具；默认 true（0.24；显式 false 关闭） |
| `agent.defaultVisibility` / `permissionMode` / `readOnlyTools` | 成员可见性与权限模式：`bridge`（交互默认）/ `allow`（headless 默认）/ `deny`（保留 `readOnlyTools`，默认 `["read"]`）；0.17 |
| `agent.followReplies` / `cwd` / `systemPrompt` | 回复注入策略（不自动续跑父 turn）/ 默认工作目录 / 主 agent systemPrompt |
| `mcp_servers.<name>.*` | MCP server：`transport`（stdio/http）、`command`/`args`/`env`、`url`/`headers`、`enabled`、`connect_timeout_ms`、`tool_timeout_ms`、`tool_prefix`、`auto_approve_tools` |
| `durable.enabled` / `backend` / `path` / `checkpoint_every` | 默认 true（0.24；显式 false 关闭）；`backend: file \| memory`；0.5 起 `path` 默认 `<data_dir>/tenants/<tenant_id>/runs`，显式配置优先但可逃出 tenant（启动 warn）；0.3 只接受 `checkpoint_every: iteration` |
| `serve.hostname` / `port` / `allow_remote` / `tls.cert_file` / `tls.key_file` | 默认 `127.0.0.1:8642`、明文；非回环必须 `allow_remote: true`、token 非空**且 TLS cert/key 成对**（0.6 起强制） |
| `serve.allowed_origins` | 独立前端 Origin allowlist；绝对 http(s) origin，禁止 `*` / path / query；非回环必须 https；HTTP 与 WS 共用（0.6） |
| `connect.token` / `token_env` / `ca_file` | `--connect` 客户端 token 与 CA；token 优先级 CLI > env（`VESSEL_CONNECT_TOKEN`，缺失时回退 `VESSEL_GATEWAY_TOKEN`；`token_env` 由 loader 在 env 层解析）> config（0.6；0.8.1 统一经 loader，`--ca` 对应 `VESSEL_CONNECT_CA`） |
| `transport.kind` / `transport.token` | 只剩 `in-process`；`transport.token` 是 gateway token 的末位回退。`loopback` / `remote` / `transport.nodes[]` 已于 0.22.1 删除 |
| `serve.token` / `serve.token_env` / `serve.tokens` / `serve.admin_token` | 0.5：`serve.token` 为 default/admin 兼容单 token；`serve.tokens` 为 token → `{tenant_id, role}`；`serve.admin_token` 为 `*`/admin；解析顺序见 ADR-050 |
| `evals.enabled` / `dir` / `out_dir` / `allow_network` | 默认 true（0.24；显式 false 关闭）/ `./evals` / `~/.vessel/evals` / false；`allow_network: true` 仍需 CLI `--allow-network` |
| `feishu.enabled` / `app_id` / `app_secret` / `domain` / `allowed_chat_ids` / `session_prefix` / `reply_timeout_ms` / `max_reply_chars` / `max_members` | 默认 false；env `VESSEL_FEISHU_APP_ID` / `VESSEL_FEISHU_APP_SECRET` 优先；`max_members` 1..64（默认 8）；**`agent_id` 已删除，严格按未知键拒绝** |
| `observability.event_history` / `metrics` | `event_history` 缺省 1000，显式 0 = 不限制，>0 = 环形缓冲；块缺省时不注入 metrics，块存在时 `metrics` 默认 true |

`permission.auto_approve`（TS 字段 `autoApprove`）、`plugins[].config` 消费与 `VESSEL_PLUGINS` / `VESSEL_SESSION_BACKEND` / `VESSEL_MODEL` 覆盖（见 `docs/versions/0.6.1.md`）。

配置示例：

```yaml
mcp_servers:
  echo:
    transport: stdio
    command: bun
    args: ["run", "examples/mcp-echo-server.ts"]
    tool_prefix: true
    auto_approve_tools: []

durable:
  enabled: true
  backend: file
  path: ~/.vessel/runs
  checkpoint_every: iteration

serve:
  hostname: 127.0.0.1
  port: 8642
  allow_remote: false
  # tls:
  #   cert_file: /path/to/cert.pem
  #   key_file: /path/to/key.pem
```

- **顶层未知键是 error**（带编辑距离拼写建议），不是 warning——启动即失败，避免配置悄悄无效；`mcp_servers` 内未知名与 `serve.tls` 未知名同样报错。
- 已知但当前未消费的字段（`agent.name/temperature/maxTokens`、`session.maxHistory`、`guardrails`、`hooks`）给显式 warning，不静默。
- provider 默认 model 是 provider-aware：只有已登记 provider（当前 `openai`）有默认；未知 provider 必须显式配 `model`。
- `VESSEL_PROVIDER_API_KEY` 可回填顶层 `apiKey`。

**注意**：`vessel.yaml` 的 `tools:` 声明段已删除（连同 `ToolConfig` 类型）。从前"用户在配置里声明一个 shell/http 工具"这条路径没有了——有了 `bash` 之后，加能力就是写文件 + 跑命令。

evals / feishu / metrics / observability 四个块全缺省时：CLI `eval` 不可用、不启动飞书、不注入 metrics；`event_history` 仍为 1000。严格校验：类型、范围、未知键；`feishu.enabled: true` 且（env + config）无凭据 → 启动失败；`evals.allowNetwork: true` 不自动开启 CLI flag。

`data_dir` / `tenant` / `trace` 与 `serve.tokens` / `serve.admin_token`。缺省行为：`session.backend = file`、`durable.path = <tenant>/runs`、trace 默认开启 `full`（30 天 / 1000 runs / 1 GiB）、tenant 缺省 `default`。用户配置未知键仍是 error；legacy 白名单仅 `default_provider` / `default_model` / `providers`。项目 `vessel.yaml` 出现密钥、tenant overlay 出现禁止块或 `null`、`config show` 校验失败均直接报错（exit 1）。

