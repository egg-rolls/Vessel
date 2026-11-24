---
title: 双舰队 federation 接入（production × canary）
kind: current
triggers: [federation, peer, 双舰队, canary, 金丝雀, token, env_file, missing_token, 跨节点, federation peer add, 共享 token]
paths: [src/federation/federation-config.ts, src/cli/commands/federation-peer.ts, src/gateway/gateway-reload-wiring.ts, packages/config/src/env-file.ts]
---

# 双舰队 federation 接入（production × canary）

> 场景：同一台机器上两条版本线（生产 main checkout × 金丝雀 fleets/canary）互发
> federation 消息。数据面 **node 直连 node**（不经平台端口）；token 是显式共享秘密，
> 与两舰队各自的 node token / root-secret 无关。
> 配套 CLI：`vessel federation peer add|list|remove`（写 config + 热应用，不重启）。

## 1. 拓扑事实

| | production | canary |
|---|---|---|
| node_id | `7181ed6c-5ec2-479e-9400-fcd54b480de5` | `7377657b-dfba-4347-809d-5e88460441e0` |
| checkout | `D:/Application/APP/Vessel/Vessel`（main） | `D:/Application/APP/Vessel/fleets/canary` |
| 平台端口（Web/RPC） | 8642 | 8652 |
| **node 端口（federation 数据面）** | **8644** | **8654** |
| dataDir | 默认根 `~/.vessel/data` | `D:/Application/APP/Vessel/fleets/canary-data`（独立） |
| instance | default | canary |
| team_id | `vessel` | `vessel`（新舰队需先建，见 §4） |

- **peer.url 一律填对端 node 端口**（`http://127.0.0.1:8644` / `http://127.0.0.1:8654`），
  不是平台端口。loopback 允许 http；非 loopback 必须 https（validator 强制）。
- node_id 的权威来源是各 dataDir 的 `node.json`（`host.nodeId` 显式配置优先）。
- **DD 分离 ⇒ root-secret 不同 ⇒ 派生 node token 不同**：federation peer token 是
  独立的共享秘密，必须显式生成并在两侧注入同一个值，不能复用任何 node token。

## 2. 机制速览（为什么这样配）

- 入站 allowlist 按 **nodeId + teamId + direction** 匹配（`federation-client.ts`）；
  peer bearer token 认证，gateway 用户 token 不属于任何 peer（401）。
- `tokenEnv` 只存**环境变量名**；值在运行时从 env 解析进内存，**绝不落盘 / 打印**。
  缺 token 的 peer 直接丢弃（fail closed，日志 `federation.peer.skipped reason=missing_token`）；
  **同一 token 命中多个 peer 时全部丢弃**（入站无法确定落点）。
- `direction: both`（缺省）= 可出可入；`in` 只收（可不配 url）；`out` 只发（必须配 url）。
- `localTeamId`：对端 team 与本机 team 不同名时的映射（缺省 = 对端 teamId 即本机 teamId）。
- `allowDirectory`：显式 true 才允许对端入站 team-info 目录查询。
- `maxHops` 缺省 4（1..16）；`rateLimitPerMinute` 缺省 60（1..600，每 peer 入站）。
- **热应用**：`federation` 块变更走 config scope（`gateway-reload-wiring.ts` 的
  `applyFederation`）——重新解析 peer 后**原地**更新入站路由与出站端口持有的运行时
  对象，下一请求生效，**不重启**。`peer add/remove` 写盘后 best-effort 触发
  `gateway.reload`；没有运行中 gateway 时由配置监听（300ms debounce）或下次启动生效。
  例外：**启动时 `federation.enabled: false`** ⇒ 出站端口未构造，热启用只恢复入站，
  出站需一次重启（摘要行会明说）。

## 3. 步骤①：生成共享 token + 可靠注入（env_file 为准）

### 3.1 为什么 setx / export 不可靠（missing_token 根因）

金丝雀实测：token 已持久化 Windows 用户 env（setx），node 仍反复
`federation.peer.skipped reason=missing_token`。四种注入（bash export / 内联 env /
WSLENV / powershell 原生）全失败。静态定位到四环断点：

1. **daemon spawn 是 env 快照**（`src/gateway/daemon.ts`）：daemon 子进程拿的是
   *启动那一刻* CLI 进程的 `process.env`，之后 setx / 别的 shell export 与它无关。
2. **node 子进程继承的是平台启动快照**（`src/gateway/node-supervisor.ts` spawnOnly：
   `env: {...(this.options.env ?? process.env)}`）：`options.env` 在平台进程启动时
   固定。`node restart` 由**平台**重新 spawn，用的仍是那份旧快照——不是发起 restart
   的 shell 的 env。
3. **`gateway restart` 缺省保活 node**（`gateway-command.ts` restartDaemonCommand：
   `keepNodes: command.keepNodes !== false`）：新平台 adopt 旧 node 进程，**env 完全
   不刷新**。只重启平台层对 node 的 env 毫无作用。
4. **WSL ↔ Windows env 边界**：setx 只影响*新开*的 Windows 进程（且要 Explorer 收到
   广播）；WSL shell 的 export 不经 `WSLENV` 不进 Windows 进程；从旧终端拉起的
   powershell 继承的也是旧 env。

结论：跨进程 env 传播链上任何一环的快照早于 token 存在，node 就拿不到。
**可靠做法是让 node 进程自己在启动时读文件**——即 `env_file`。

### 3.2 env_file（推荐，0.56 既有机制）

`env_file` 在 `loadConfig()` 内部（**node 进程自己**）把文件里的 `KEY=VALUE` 注入
`process.env`，早于 federation 解析（`bootstrap.ts` 的 loadConfig 不传 env ⇒ 默认
process.env）。完全绕开上面四环快照链。细则见 [CONFIG.md §3.1](CONFIG.md)。

生成 token 并写文件（PowerShell，**不回显 token**）：

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$tok = ([BitConverter]::ToString($bytes) -replace '-','').ToLower()
Set-Content -Path D:\Application\APP\Vessel\fleets\federation.env -Value "VESSEL_FED_TOKEN=$tok"
# 文件只放用户私有目录；不要进任何 git 仓库（fleets/ 下非 checkout 区域）。
```

两舰队配置各加一行（**路径相同、tokenEnv 同名**）：

```yaml
# production：main checkout 的 vessel.yaml（或用户配置）——由用户维护
# canary：fleets/canary-config.yaml
env_file: D:/Application/APP/Vessel/fleets/federation.env
```

注意：
- **真实 env 优先于文件**（文件只填空缺）；所以轮换 token 要改文件 + 冷重启 node
  （已存在的 env 键不会被文件覆盖）。
- 显式配置的路径读不到 ⇒ **启动报错**（不静默跳过）。
- token 值不进 vessel.yaml / 用户配置（validator 明确拒绝 peer 明文 `token` 键），
  不进日志、不进 CLI 输出。

### 3.3 setx 备选（不推荐）

`setx VESSEL_FED_TOKEN "<tok>"` 之后，必须**从确认带该变量的新 shell** 整舰队冷重启
（`gateway stop --stop-nodes` + `gateway start`，或 `gateway restart --stop-nodes`），
且启动 shell 与舰队进程同侧（全 Windows 或全 WSL+WSLENV）。任何一环做不到就回到
missing_token。env_file 没有这些前提。

## 4. 步骤②：canary 建 vessel team

新舰队 dataDir 是空的，先建团队（production 已有 vessel，跳过）：

```bash
# canary 上下文（与舰队启动同一套 --user-config / --data-dir / cwd）
vessel team create vessel
```

> 现网 canary 配置若用了 `localTeamId: canary`（对端 vessel 映射到本机 canary team），
> 则本机建 `canary` team 亦可；本指南目标态是两侧同名 `vessel`，可省 localTeamId。

## 5. 步骤③：两侧 config 互指 peer

### 5.1 CLI（推荐）

```bash
# production 侧（main checkout cwd；默认用户配置）
vessel federation peer add \
  --node-id 7377657b-dfba-4347-809d-5e88460441e0 \
  --team-id vessel \
  --url http://127.0.0.1:8654 \
  --token-env VESSEL_FED_TOKEN \
  --direction both

# canary 侧（fleets/canary cwd；--user-config 与舰队启动一致，见 §5.3）
vessel --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml \
  federation peer add \
  --node-id 7181ed6c-5ec2-479e-9400-fcd54b480de5 \
  --team-id vessel \
  --url http://127.0.0.1:8644 \
  --token-env VESSEL_FED_TOKEN \
  --direction both
```

- add 写**用户配置** `federation.peers`（对象数组，专用命令组，不走标量
  `config.set` 白名单），保留其它键；跨进程锁 + 原子写。
- 写后 best-effort 触发运行中 gateway 热应用（输出 `running gateway reloaded`）；
  没有运行中 gateway 时提示由配置监听 / 下次启动生效。**不重启任何进程。**
- 可选 flag：`--local-team-id <slug>`（team 映射）、`--allow-directory`（开放入站
  目录查询）、`--ca-file <path>`（https 对端 CA）。
- 管理：`vessel federation peer list [--json]`（= `federation peers`，token 绝不打印，
  只显示 token_env 名与 set/missing）；`vessel federation peer remove <label|node-id>`
  （label = `<nodeId>:<teamId>`；只给 nodeId 命中多条时会列出候选要求给全 label）。

### 5.2 等价 YAML（手写 / 项目配置时）

```yaml
federation:
  enabled: true            # 缺省 true；显式 false 才关
  # max_hops: 4            # 1..16，缺省 4
  # rate_limit_per_minute: 60   # 1..600，缺省 60
  peers:
    - node_id: 7181ed6c-5ec2-479e-9400-fcd54b480de5   # canary 侧填 production
      team_id: vessel
      url: http://127.0.0.1:8644                      # 对端 node 端口
      token_env: VESSEL_FED_TOKEN
      direction: both
      # local_team_id: canary    # 仅两侧 team 不同名时
      # allow_directory: false   # 显式 true 才开目录查询
```

- YAML 用 snake_case（loader 自动转 camel）；**合法键只有** node_id / team_id / url /
  token_env / ca_file / direction / local_team_id / allow_directory。
  **不要写 `label` 键**（validator 拒绝；label 只是 CLI remove 的实参形式）。
  明文 `token` 键同样被拒绝。
- 自指 peer（node_id = 本机）与重复 `node_id:team_id` 都会被拒 / 丢弃。

### 5.3 双舰队的用户配置隔离（关键）

`peer add` 写的是 `getUserConfigPath()` = `VESSEL_USER_CONFIG`（来自全局
`--user-config`）或默认 `~/.vessel/config.yaml`。**两舰队必须各有自己的用户配置**，
否则 peer 写进同一个文件互相覆盖（自指条目还会被 fail-closed 丢弃）：

- canary 按 [version-isolation-blue-green](version-isolation-blue-green.md) 配方带
  `--user-config D:/Application/APP/Vessel/fleets/canary-config.yaml`（+ 独立
  dataDir / instance）启动；CLI 管理命令带**同一个** `--user-config`。
- 若舰队用 `--config <项目文件>` 启动：配置监听盯的是项目文件；peer add 写用户层后
  由命令内置的 `gateway.reload` 触发合并生效（项目层 federation.peers 会整体压过
  用户层——两层别同时写 peers，选一层为准）。

## 6. 步骤④：重启序列（仅首次注入 token 需要）

env_file / peer 配好后，**node 进程要冷重启一次**才能把 token 读进内存
（§3.1 的快照链）；此后 peer 增删走热应用，不再重启。

- **production：由用户维护重启**（main checkout 不由 agent 动）：
  ```bash
  vessel gateway restart --stop-nodes     # default instance；--stop-nodes 才连 node 一起冷重启
  ```
- **canary：由 main 重启**（与启动同一套上下文）：
  ```bash
  vessel --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml \
    --data-dir D:/Application/APP/Vessel/fleets/canary-data \
    gateway restart --instance canary --stop-nodes
  ```
- **不要只 `gateway restart`（缺省保活 node）**：node 被 adopt 回来，env 不刷新，
  missing_token 依旧（§3.1 第 3 环）。
- 不要只 taskkill 平台进程（Windows 句柄继承会让 detached 子进程继续占端口）；
  恒用命令整舰队停 / 起。

## 7. 步骤⑤：验证

```bash
# 1) 两侧 peer 与 token 状态（token 只显示 set/missing，绝不打印值）
vessel federation peers            # canary 侧带 --user-config
#    期望：对端条目 token=set；stderr 无 federation.peer.skipped

# 2) canary → production 投递一条测试消息（human→human 写对端 Team 日志）
vessel federation post \
  --from human@7377657b-dfba-4347-809d-5e88460441e0:vessel \
  --to   human@7181ed6c-5ec2-479e-9400-fcd54b480de5:vessel \
  "federation ping from canary"
#    期望：delivered <message_id> to human@7181ed6c…:vessel (hop 1)

# 3) 反向（production → canary）同理对调 --from/--to。

# 4) 成员跨节点 send（agent 工具面）：send to main@7181ed6c-…:vessel，
#    入站按 nodeId/teamId/direction 匹配后唤醒对端成员。

# 5) 目录查询（需对端 peer 配 --allow-directory）：
vessel federation team-info --to human@7181ed6c-5ec2-479e-9400-fcd54b480de5:vessel
```

入站拒绝码分流（接收侧日志 `federation.rejected`）：
- `federation_unauthorized`（401）：token 不匹配任何 peer ⇒ 两侧值不一致 / 未注入。
- `federation_not_allowed`（403）：peer direction 不含 in。
- `federation_unknown_team`（404）：本机无该 team（localTeamId 映射后）⇒ 建 team / 改映射。
- `federation_rate_limited`（429）：超 rate_limit_per_minute。

## 8. 安全红线

- token **不落盘进配置**（只存 tokenEnv 名；值在 env / env_file）、**不打印**
  （CLI / 日志 / 摘要行只含身份与计数）、**不进 argv**（生成脚本直接写文件）。
- env_file 放用户私有目录，不进 git；两舰队 root-secret 不同，**不得**拿 node token
  冒充 federation 共享 token。
- 缺 token / 自指 / 重复 token 一律 fail-closed 丢弃，不生成空凭据、不静默择一。
- loopback 允许 http；跨机必须 https（+ ca_file）。
- 入站目录查询默认关（allow_directory 显式 true 才开）。

## 9. 排障：missing_token 决策树

1. `vessel federation peers` 显示 token=missing？
   → 该 shell 没有变量不代表 node 没有；看 **node 日志**（`logs/node-*.log`）的
   `federation.peer.skipped`。
2. node 日志 missing_token：
   a. 配置有 `env_file` 吗？路径存在吗？（缺文件会启动报错，不会静默）
   b. 文件里键名与 `token_env` 完全一致吗？（VESSEL_FED_TOKEN）
   c. node 冷重启过吗？（`gateway restart --stop-nodes`；缺省 restart 保活 node 无效）
   d. 真实 env 里有**旧值**吗？（真实 env 优先于文件，旧值会压住新文件值）
3. token=set 但 401：两侧值不一致（各自 env_file 内容不同 / 一侧真实 env 压了旧值）。
4. 同一 token 配了多个 peer：全部被丢（日志 duplicate_token）——每 peer 独立 token，
   或只保留一个 peer。