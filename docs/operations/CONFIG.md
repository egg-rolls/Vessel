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
（`mcp_servers`、`plugins`）按 key/name 合并、`null` 拒绝。

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
```

- `config path`：打印用户配置、项目配置与 `data_dir` 的实际路径和是否存在。
- `config init`：把内嵌模板写到用户配置；默认不覆盖已有文件，`--force` 才覆盖。
  模板只写 `api_key_env`，不写真实密钥。
- `config show`：输出合并后的配置；`--sources` 标注每个键来自
  `cli | env | project | user | default`；tenant overlay 命中列在
  `tenant_overlay_keys`。**有校验错误时 exit 1**。
- `config.get` / `config.sources`（RPC）与 `config show` 一样，永不输出解析后的
  密钥值，只输出 `"<set>"` / `"<unset>"`。

## 5. 错误与排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动报未知键 | 用户配置拼写错误或使用了已删除字段 | 按错误路径修正；legacy 仅允许 `default_provider` / `default_model` / `providers` |
| `config show` exit 1 | 配置校验失败 | 看 stderr 的 `path: message`，逐项修正 |
| 项目 YAML 报密钥 | 项目配置出现密钥字段 | 移到用户配置的 `_env` 或 env |
| `tenant overlay` 报禁止块 | 覆盖了 `data_dir` / `trace` / `serve` / `tenant` / `update` | 改到项目或用户层 |
| token 401 | 已配置 token 但请求未带，或 token 不在 `serve.tokens` | 检查 `serve.tokens` / `serve.token` / `VESSEL_GATEWAY_TOKEN` |

## 6. 示例：多租户部署

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
