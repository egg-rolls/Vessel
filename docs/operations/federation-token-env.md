---
title: Federation 共享 token 注入（env_file）与 missing_token 排障
kind: current
triggers: [federation, token, env_file, missing_token, setx, export, WSLENV, 快照, 冷重启, vessel restart, stop-nodes, 轮换, daemon]
paths: [packages/config/src/env-file.ts, src/gateway/daemon.ts, src/gateway/node-supervisor.ts]
---

# Federation 共享 token 注入（env_file）与 missing_token 排障

> 自动配对（SecretStore，零手工 env_file）是推荐路径，见 [federation-pairing](federation-pairing.md)。
> 本文是手工共享 token 的可靠注入与排障（跨机无码不可用时的兜底 / 原理参考）。
> `env_file` 机制家见 [config-secrets](config-secrets.md)；peer 配置见 [federation-peers](federation-peers.md)。

## 为什么 setx / export 不可靠（四环 env 快照断点）

跨进程 env 传播链上任何一环的快照早于 token 存在，node 就拿不到：

1. **daemon spawn 是 env 快照**（`src/gateway/daemon.ts`）：daemon 子进程拿的是*启动那一刻*
   CLI 进程的 `process.env`，之后 setx / 别的 shell export 与它无关。
2. **node 子进程继承平台启动快照**（`src/gateway/node-supervisor.ts` spawnOnly：
   `env: {...(options.env ?? process.env)}`）：`options.env` 在平台进程启动时固定；
   node 由**平台**重新 spawn，用的仍是那份旧快照——不是发起 restart 的 shell 的 env。
3. **`gateway restart` 恒平台-only**（handoff 保活 node）：新平台 adopt 旧 node 进程，
   **env 完全不刷新**。只重启平台层对 node 的 env 毫无作用。
4. **WSL ↔ Windows env 边界**：setx 只影响*新开*的 Windows 进程（且要 Explorer 收到广播）；
   WSL shell 的 export 不经 `WSLENV` 不进 Windows 进程；旧终端拉起的 powershell 继承旧 env。

**可靠做法：让 node 进程自己在启动时读文件——即 `env_file`。**

## env_file 注入（推荐）

`env_file` 在 `loadConfig()` 内部（**node 进程自己**）把文件里的 `KEY=VALUE` 注入
`process.env`，早于 federation 解析，完全绕开四环快照链（语法 / 层序见
[config-secrets](config-secrets.md)）。生成 token 并写文件（PowerShell，**不回显 token**）：

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$tok = ([BitConverter]::ToString($bytes) -replace '-','').ToLower()
Set-Content -Path D:\Application\APP\Vessel\fleets\federation.env -Value "VESSEL_FED_TOKEN=$tok"
# 文件只放用户私有目录；不进任何 git 仓库。
```

两舰队配置各加一行（**路径相同、tokenEnv 同名**）：

```yaml
env_file: D:/Application/APP/Vessel/fleets/federation.env
```

- **真实 env 优先于文件**（文件只填空缺）：轮换 token 要改文件 + 冷重启 node；已存在的
  env 旧值会压住新文件值。
- 显式配置的路径读不到 ⇒ **启动报错**（不静默跳过）。
- token 值不进 vessel.yaml / 用户配置（validator 拒绝 peer 明文 `token` 键）、不进日志 / CLI 输出。
- setx 备选（不推荐）：之后必须**从确认带该变量的新 shell** 整舰队冷重启，且启动 shell 与
  舰队进程同侧（全 Windows 或全 WSL+WSLENV）；任何一环做不到就回到 missing_token。

## 冷重启序列（仅首次注入 / 轮换 token 需要）

env_file / peer 配好后，node 进程要冷重启一次才能把 token 读进内存；此后 peer 增删走热应用。

```bash
# 舰队级冷重启（docker 式 stop → start，现态唯一整舰队重启命令）
vessel restart                      # production：default instance，由用户维护
vessel --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml \
  --data-dir D:/Application/APP/Vessel/fleets/canary-data \
  restart --instance canary         # canary：与启动同一套上下文
```

- **不要只 `gateway restart`**：恒平台-only（handoff），node 被 adopt 回来 env 不刷新，
  missing_token 依旧。`gateway restart --stop-nodes` 已弃用（解析保留但不再停 node，
  命令会打 warning 指路 `vessel restart`）。
- 不要只 taskkill 平台进程（Windows 句柄继承会让 detached 子进程继续占端口）；恒用命令
  整舰队停 / 起（`vessel stop` / `vessel restart`，见 [GATEWAY](GATEWAY.md)）。

## missing_token 决策树

1. `vessel federation peers` 显示 token=missing？→ 该 shell 没有变量不代表 node 没有；
   看 **node 日志**（`logs/node-*.log`）的 `federation.peer.skipped`。
2. node 日志 missing_token：
   a. 配置有 `env_file` 吗？路径存在吗？（缺文件会启动报错，不会静默）
   b. 文件里键名与 `token_env` 完全一致吗？（VESSEL_FED_TOKEN）
   c. node 冷重启过吗？（`vessel restart`；只 `gateway restart` 无效）
   d. 真实 env 里有**旧值**吗？（真实 env 优先于文件）
3. token=set 但 401：两侧值不一致（各自 env_file 内容不同 / 一侧真实 env 压了旧值）。
4. 同一 token 配了多个 peer：全部被丢（日志 duplicate_token）——每 peer 独立 token，
   或只保留一个 peer。

## 安全红线

token 不落盘进配置（只存 tokenEnv 名）、不打印、不进 argv（生成脚本直接写文件）；env_file
放用户私有目录不进 git；两舰队 root-secret 不同，**不得**拿 node token 冒充 federation 共享
token；缺 token / 自指 / 重复 token 一律 fail-closed 丢弃；loopback 允许 http，跨机必须 https。