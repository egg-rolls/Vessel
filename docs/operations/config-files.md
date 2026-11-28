---
title: 配置文件与优先级
kind: current
triggers: [配置文件, 配置优先级, vessel.yaml, 用户配置, 项目配置, --user-config, --data-dir, data_dir, 合并, 未知键, serve, node, 配置写锁, config_locked, DEFAULT_CONFIG, 多实例]
paths: [packages/config/src/loader.ts, packages/config/src/defaults.ts, packages/config/src/sources.ts, packages/config/src/user-config.ts, packages/config/src/config-lock.ts, src/config/cli-overrides.ts]
---

# 配置文件与优先级

> 配置文件 / 层序 / 合并 / 写锁的运维手册。合并模型与热应用机制见
> [architecture/config.md](../architecture/config.md#config-model)，决策见
> [ADR-050](../adr/ADR-050-yaml-first-config-and-secrets.md)；域导航见 [CONFIG](CONFIG.md)。

## 配置位置与优先级

| 层 | 路径 | 放什么 |
|---|---|---|
| CLI / env | 命令行 flag、`VESSEL_*`、`.env` | 操作者覆盖与部署密钥；不是主配置 |
| 项目级 | `./vessel.yaml` | 项目行为：session、context、plugins、trace；**禁止密钥** |
| 用户级 | `~/.vessel/config.yaml`（Windows `%USERPROFILE%\.vessel\config.yaml`） | provider、默认模型、`data_dir` |
| 默认值 | 代码 `DEFAULT_CONFIG`（`defaults.ts`） | 所有缺省值；`vessel config show` 可见 |

优先级（高到低）：**CLI > env > project > user > default**。所有层只在 `loadConfig()` 合并一次；
YAML snake_case 由 loader 映射成 TS camelCase（`mcp_servers` 等 map 键原样保留）。

**例外（仅 `data_dir`，用户裁定#3）**：显式 `--user-config`（或 `VESSEL_USER_CONFIG`）且该配置写了
`data_dir` 时：**CLI > 显式 user config.data_dir > env(VESSEL_DATA_DIR) > project > default**。
缺省加载（没给 `--user-config`）时 env 仍优先。`--data-dir` 与 supervisor/registry 注入的
`VESSEL_DATA_DIR` 带内部标记 `VESSEL_DATA_DIR_CLI=1`，按 CLI 级权威应用。其它键不受本例外影响。

## `--data-dir <path>`：一台机器多个实例

`gateway start|stop|restart|status|list`、`node start|status|stop|reload`、`doctor`、`token ...`
都接受 `--data-dir`。它**只覆盖数据目录**（CLI > `VESSEL_DATA_DIR` > 项目 config > 用户 config），
不改变其它配置语义。隔离保证：各自的 `platform-<port>.pid` / `.lock` / `logs/`、各自的
`nodes.json`、`sessions/` 与 `.locks/`、各自的 `root-secret`（派生 token 互不相同）。
默认实例的 `8642/8644` 与它的数据目录完全不受影响。

```bash
vessel gateway start --daemon --instance b --port 18920 --data-dir /var/tmp/vessel-b
vessel gateway list --data-dir /var/tmp/vessel-b     # 只看得到 b
```

## `--user-config <path>`：只换用户层

- **只替换用户层**（`~/.vessel/config.yaml`）：项目 `vessel.yaml`、`VESSEL_*`、CLI 的原有优先级
  不变（`VESSEL_USER_CONFIG` 等价，daemon/node/hub 子进程一致携带）。例外见上文 `data_dir` 责任链。
- 显式给出但**文件不存在 → 报错退出（exit 2）**，绝不静默回落成空配置。需要空用户层就写空文件（`{}`）。
- `vessel doctor` 的 `user_config` 行回显当前生效路径与来源（只显示路径，不显示内容）。

## 合并规则与关键块

对象深合并、数组整体替换、map（`mcp_servers`）按 key 合并、`null` 拒绝。`plugins` 是**数组**，
按整层替换，不按 `name` 合并；覆盖层语义（安装的插件默认开启）见 [agents/plugins.md](../agents/plugins.md)。

```yaml
data_dir: ~/.vessel/data
trace: { enabled: true, level: full, retention_days: 30, max_runs: 1000, max_bytes: 1073741824 }
session: { backend: file }        # 显式 sqlite 仍可用
durable: { enabled: true, backend: file, checkpoint_every: iteration }  # path 缺省 <data_dir>/runs
node: { token_env: VESSEL_NODE_TOKEN }
security: {}                      # root_secret_env 可选；不配就用 <data_dir>/root-secret
```

- **没有 `tenant` 配置块 / tenant overlay**。旧配置 fail-fast 并给逐项 Fix：删除 `tenant:` 块、
  删除 `serve.tokens[*].tenantId`（只保留 `role`）、删除 `serve.adminToken` / `serve.adminTokenEnv`
  （改用 `serve.tokens` 的 `{ role: admin }`）。
- **`serve:` 块已移除，唯一名字是 `node:`**：读到 `serve:` 就启动失败（exit 2），整块一个键都不生效，
  逐键给改名提示（`serve.token_env -> node.token_env` 等）；两段都有也报错。字段名一个都不变
  （`hostname` / `port` / `allow_remote` / `tls` / `token` / `token_env` / `tokens` / `allowed_origins` /
  `plugin_http` / `proxy_secret_env`），只是块标签改名。用户层与项目层各判各的；`vessel doctor`
  的 `config` 行显示同一条错误。验证错误提示里的路径一律写 `node.*`。
- **顶层未知键是 error**（带编辑距离拼写建议），启动即失败；legacy 白名单仅
  `default_provider` / `default_model` / `providers`。项目 YAML 出现密钥 → error（见
  [config-secrets](config-secrets.md)）。`config show` 校验失败 exit 1。

## `config.yaml` 写锁（`config-lock.ts`）

- 锁文件 `${configPath}.lock`（`{ token, pid, acquiredAt }`，`0600`，`open(..., 'wx')` 原子创建），
  只包裹「读 → 改 → 写」段：host 侧 `setPluginEnabled` / `setUserConfigValue`（`vessel config set` /
  `/settings` / gateway 配置写入都经后者），marketplace 侧插件配置写入口。下载 / 安装目录操作与只读加载不在锁内。
- stale：锁超过 15s 未更新可被接管；等待超过 5s 抛 `config_locked`，调用方必须看到该错误，不得静默丢写。
  接管先原子创建 `${configPath}.lock.reclaim` 守卫（超过 2s 视为崩溃可清理），只有守卫持有者能删 stale 锁。
- 同进程同路径写者串行；同一异步上下文嵌套进入同一路径直接抛 `config_locked: nested lock`。
  `isConfigLockHeld` 供迁移钩子在锁内免嵌套原地执行。
- **手动编辑不在锁内**：编辑器直接改 `config.yaml` 可能与进程内读改写竞争。锁仅依赖本地文件系统语义，不做跨主机锁。

## 排查

| 现象 | 处理 |
|---|---|
| 启动报未知键 | 按错误路径修正拼写；legacy 仅允许 `default_provider` / `default_model` / `providers` |
| `config show` exit 1 | 看 stderr 的 `path: message`，逐项修正 |
| 项目 YAML 报密钥 | 移到用户配置的 `_env` 或 env（[config-secrets](config-secrets.md)） |
| 旧配置 fail-fast | 按错误里的逐项 Fix 删 `tenant:` / `tenantId` / `adminToken` |
| `serve:` 启动失败 | 整块改名 `node:`，字段不变 |
| `config_locked` | 另一进程正写同一配置；等 15s stale 接管或停掉占用进程，不要手删活跃锁 |