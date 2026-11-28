---
title: 密钥与令牌
kind: current
triggers: [密钥, 令牌, token, root-secret, 根密钥, 派生, _env, api_key_env, env_file, secrets, proxy_secret, 反代密钥, token rotate, 401, VESSEL_API_KEY]
paths: [packages/config/src/secrets.ts, packages/config/src/root-secret.ts, packages/config/src/env-file.ts, src/node/token-derive.ts, src/cli/commands/token-command.ts]
---

# 密钥与令牌

> 密钥解析 / 根密钥派生 / token 命令的运维手册。token 解析的架构事实见
> [architecture/config.md](../architecture/config.md#config-model) 与 [ADR-050](../adr/ADR-050-yaml-first-config-and-secrets.md)；
> 同机反代边界见 [REVERSE-PROXY](REVERSE-PROXY.md)。

## 根密钥派生：用户一个 token 都不用写

优先级永远是「**显式配置赢，没配就现算**」：

| 用途 | 生效顺序 |
|---|---|
| 平台 | `gateway.token` > `gateway.token_env` > 派生 `vessel:platform` |
| node | `node.token` > `node.token_env` > `VESSEL_GATEWAY_TOKEN` > 平台注入的 `VESSEL_NODE_TOKEN` > 派生 `vessel:node:<node_id>` |
| hub | `hub.token_env` > `VESSEL_HUB_TOKEN` > 派生 `vessel:hub` |
| 反代 | `gateway.proxy_secret_env`（**只认显式**，不会自动启用） |

- 根密钥：`<data_dir>/root-secret`，32 字节，首次启动自动生成、权限 0600；
  `security.root_secret_env` 指向的环境变量优先。权限宽于 0600 → **拒绝启动**并给 `chmod 600` 文案。
- 派生（`root-secret.ts` / `token-derive.ts`）：`HKDF-SHA256(root, salt="vessel/v1", info="vessel:<purpose>[:<id>]")`
  → 32 字节，base64url 加 `vsk_` 前缀；**不落盘、不缓存**，用时现算。
- 显式配置**不算**被派生值覆盖：只配一部分用途完全正常，其余照旧派生。
- **远程必须带 token**（缺/错一律 401）；**回环匿名语义**：未配置（用派生值）时回环匿名可用
  （不锁死本地 UI/CLI）；显式配置才收紧回环（必须带值）。

```bash
vessel token list                       # 只列 purpose + 指纹前 8 位，永不打印值
vessel token show --purpose platform    # 打印值：只回环 + 交互式终端
vessel token show --purpose node --node node-b
vessel token rotate --yes               # 新 root ⇒ 所有派生值一起换；显式配置不受影响
vessel node token [--print]             # 本机 node 自己该用的 token
```

## `_env` 规则

所有接受密钥的字段支持 `<field>_env`：`api_key_env`、`provider.api_key_env`、`feishu.app_secret_env`、
`node.token_env`、`gateway.token_env`、`gateway.proxy_secret_env` / `node.proxy_secret_env` /
`hub.proxy_secret_env`（三者用途不同，**不要复用同一个值**）。

1. 字段显式值优先；否则读 `<field>_env` 指向的环境变量；两者都没有则报错（派生兜底见上表）。
2. `_env` 与 `VESSEL_*` 按层解析、按层合并；同层显式值 > `_env`。
3. `VESSEL_API_KEY`（env 层）覆盖项目层 `api_key_env`；来源记为 `env`，可附 `env_ref`。
4. 不支持 `${VAR}` 字符串插值；需要间接引用时用 `_env`。
5. 项目 `vessel.yaml` 出现密钥 → error；密钥字段只允许 `_env`。

Platform Gateway token 独立，只读 `gateway.token` / `gateway.token_env`，不与 node token 互相回退。
principal 由 token 决定：`node.token` → admin；`node.tokens` 按条目 `role`；回环无 token → admin。

## `env_file`：密钥放文件、配置只写路径

```yaml
# ~/.vessel/config.yaml
env_file: ~/.vessel/secrets.env        # 一个路径，或一组（按顺序加载，先到先得）
```

```dotenv
export BOCHAAI_SEARCH_API_KEY=tvly-...   # export 前缀可有可无；单/双引号都行
VESSEL_TAVILY_API_KEY="..."              # 未加引号时行内 " #…" 算注释
```

1. **真实环境变量 > 文件**：文件只填空缺的键，显式 `export` 仍然赢。
2. 时机：**在 env 层之前**加载，文件值对 `VESSEL_*` 与插件 key 同样生效。
3. 相对路径按进程 cwd 解析；`~` 展开；不做 `${VAR}` 插值。
4. 显式配置的路径读不到 ⇒ 启动报错（`envFile: … does not exist`），不静默忽略。
5. 加载后不打印任何值；加载了哪些**键名**、哪些被真实 env 保留，在 `loadConfig()` 的 `envFiles` 字段供诊断。
6. 密钥永远不进 `vessel.yaml`：`env_file` 只是值的搬运工，它本身是路径不是值。

## 同机反代与默认收紧

反代与 Vessel 同机时客户端对端地址恒为 `127.0.0.1`，「回环 = 本机」不再成立。把反代密钥的环境变量名
配到 `gateway.proxy_secret_env` / `node.proxy_secret_env` / `hub.proxy_secret_env`，反代注入
`X-Vessel-Proxy-Secret` 头（**覆盖**不是追加）。未配置时不做任何事；配置后该监听只接受经反代来的
匿名请求，带 Bearer token 的客户端不受影响。默认收紧项（迁移见 [REVERSE-PROXY](REVERSE-PROXY.md)）：

- `gateway.hostname` 非回环且没有 `gateway.token` / `gateway.token_env` ⇒ 平台拒绝启动
  （`platform_listen_insecure`）；回环监听不受影响。
- `platform.nodes.credentials` 只认 `mode === 'token'`；`gateway.proxy_nodes`（缺省开）时浏览器不再取
  node token，该端点只服务 CLI / 本地自动化（见 [config-gateway](config-gateway.md)）。
- `hub.proxy_secret_env` 配置后，hub 目录 / WS 目录流 / 删节点都要求密钥头。
- `vessel doctor` 对「回环 + 没有任何 token」给 warning（只提示，不改变运行行为）。

## 示例：单 Node 部署

```yaml
# ~/.vessel/config.yaml
provider: { api_key_env: VESSEL_API_KEY }
data_dir: /srv/vessel/data
trace: { level: metadata, retention_days: 14 }
node: { token_env: VESSEL_NODE_TOKEN }        # Node API token（per-node）
gateway: { token_env: VESSEL_PLATFORM_TOKEN } # 平台 token，与 node token 分开
# ./vessel.yaml（禁止密钥）
session: { backend: file }
# .env（部署密钥）：VESSEL_NODE_TOKEN / VESSEL_PLATFORM_TOKEN / VESSEL_API_KEY
```

token 401 时检查 `node.tokens` / `node.token` / `VESSEL_GATEWAY_TOKEN`；数据面 401 分流见
[TROUBLESHOOTING-401](TROUBLESHOOTING-401.md)。