---
title: Federation peer 配置与双舰队拓扑
kind: current
triggers: [federation, peer, 双舰队, canary, 金丝雀, peer add, peer remove, direction, local_team_id, allow_directory, 热应用, 用户配置隔离, 拓扑]
paths: [src/federation/federation-config.ts, src/federation/federation-peer-store.ts, src/cli/commands/federation-peer.ts, src/gateway/gateway-reload-wiring.ts]
---

# Federation peer 配置与双舰队拓扑

> 自动配对（推荐）见 [federation-pairing](federation-pairing.md)；本文是 peer 配置面与
> production × canary 拓扑事实。协议 / 入站失败顺序的事实家见
> [federation-hub](../architecture/federation-hub.md)；token 注入见 [federation-token-env](federation-token-env.md)。

## 拓扑事实（production × canary，同机两条版本线）

| | production | canary |
|---|---|---|
| node_id | `7181ed6c-5ec2-479e-9400-fcd54b480de5` | `7377657b-dfba-4347-809d-5e88460441e0` |
| checkout | `D:/Application/APP/Vessel/Vessel`（main） | `D:/Application/APP/Vessel/fleets/canary` |
| 平台端口（Web/RPC） | 8642 | 8652 |
| **node 端口（federation 数据面）** | **8644** | **8654** |
| dataDir | 默认根 `~/.vessel/data` | `D:/Application/APP/Vessel/fleets/canary-data`（独立） |
| instance / team_id | default / `vessel` | canary / `vessel`（新舰队需先建） |

- **peer.url 一律填对端 node 端口**，不是平台端口。loopback 允许 http；非 loopback 必须 https
  （validator 强制，+ `ca_file`）。
- node_id 权威来源是各 dataDir 的 `node.json`（`host.nodeId` 显式配置优先）。
- **DD 分离 ⇒ root-secret 不同 ⇒ 派生 node token 不同**：federation peer token 是独立共享秘密，
  不能复用任何 node token。新舰队先建 team：`vessel team create vessel`（与舰队启动同一套
  `--user-config` / `--data-dir` / cwd）。

## 配置面机制（federation-config.ts）

- 入站 allowlist 按 **nodeId + teamId + direction** 匹配；peer bearer token 认证，gateway 用户
  token 不属于任何 peer（401）。`tokenEnv` 只存变量名；缺 token 的 peer fail-closed 丢弃
  （`federation.peer.skipped reason=missing_token`）；**同一 token 命中多个 peer 时全部丢弃**。
- `direction: both`（缺省）可出可入；`in` 只收（可不配 url）；`out` 只发（必须配 url）。
  `localTeamId`：两侧 team 不同名时的映射；`allowDirectory`：显式 true 才开入站目录查询。
- `maxHops` 缺省 4（1..16）；`rateLimitPerMinute` 缺省 60（1..600，每 peer 入站）。
- **热应用**：`federation` 块变更走 config scope（`gateway-reload-wiring.ts:applyFederation`）——
  重解析 peer 后**原地**更新入站路由与出站运行时对象，下一请求生效，不重启。`peer add/remove`
  写盘后 best-effort `gateway.reload`；无运行中 gateway 时由配置监听（300ms debounce）或下次
  启动生效。例外：**启动时 `federation.enabled: false`** ⇒ 出站端口未构造，热启用只恢复入站，
  出站需一次重启（摘要行会明说）。

## CLI（推荐）

```bash
# production 侧（main checkout cwd；默认用户配置）
vessel federation peer add --node-id 7377657b-dfba-4347-809d-5e88460441e0 \
  --team-id vessel --url http://127.0.0.1:8654 --token-env VESSEL_FED_TOKEN --direction both
# canary 侧（--user-config 与舰队启动一致）
vessel --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml \
  federation peer add --node-id 7181ed6c-5ec2-479e-9400-fcd54b480de5 \
  --team-id vessel --url http://127.0.0.1:8644 --token-env VESSEL_FED_TOKEN --direction both
```

- add 写**用户配置** `federation.peers`（对象数组，专用命令组，不走标量 `config.set` 白名单），
  保留其它键；`withConfigLock` 跨进程锁 + 原子写。可选 flag：`--local-team-id` /
  `--allow-directory` / `--ca-file`。
- `vessel federation peer list [--json]`（= `federation peers`）：token 绝不打印，只显示
  token_env 名（secret peer 显示 `secret-store`）与 set/missing。
- `vessel federation peer remove <label|node-id>`：label = `<nodeId>:<teamId>`；只给 nodeId
  命中多条时列出候选要求给全 label。

## 等价 YAML（手写 / 项目配置）

```yaml
federation:
  enabled: true            # 缺省 true；显式 false 才关
  peers:
    - node_id: 7181ed6c-5ec2-479e-9400-fcd54b480de5   # canary 侧填 production
      team_id: vessel
      url: http://127.0.0.1:8644                      # 对端 node 端口
      token_env: VESSEL_FED_TOKEN                     # 或 token_secret: true（二选一）
      direction: both
      # local_team_id: canary    # 仅两侧 team 不同名时
      # allow_directory: false   # 显式 true 才开目录查询
```

YAML 用 snake_case（loader 自动转 camel）；合法键只有 node_id / team_id / url / token_env /
token_secret / ca_file / direction / local_team_id / allow_directory。**不要写 `label` 键**
（validator 拒绝；label 只是 CLI remove 实参）；明文 `token` 键同样被拒。自指 peer 与重复
`node_id:team_id` 都会被拒 / 丢弃。

## 用户配置隔离（关键）

`peer add` 写 `getUserConfigPath()` = `VESSEL_USER_CONFIG`（来自全局 `--user-config`）或默认
`~/.vessel/config.yaml`。**两舰队必须各有自己的用户配置**，否则 peer 写进同一文件互相覆盖
（自指条目还会被 fail-closed 丢弃）。canary 按 [version-isolation-blue-green](version-isolation-blue-green.md)
配方带 `--user-config`（+ 独立 dataDir / instance）启动，CLI 管理命令带**同一个** `--user-config`。
若舰队用 `--config <项目文件>` 启动：peer add 写用户层后由内置 `gateway.reload` 合并生效
（项目层 peers 整体压过用户层——两层别同时写 peers，选一层为准）。

## 验证（只写不跑）

```bash
vessel federation peers            # 对端条目 token=set；stderr 无 federation.peer.skipped
vessel federation post --from human@7377657b-dfba-4347-809d-5e88460441e0:vessel \
  --to human@7181ed6c-5ec2-479e-9400-fcd54b480de5:vessel "federation ping from canary"
# 期望 delivered <message_id>（hop 1）；反向对调 --from/--to；成员跨节点 send 同寻址
vessel federation team-info --to human@7181ed6c-5ec2-479e-9400-fcd54b480de5:vessel  # 需对端 allow_directory
```

入站拒绝码（接收侧日志 `federation.rejected`）：401 `federation_unauthorized`（两侧值不一致 /
未注入）· 403 `federation_not_allowed`（direction 不含 in）· 404 `federation_unknown_team`
（localTeamId 映射后无该 team）· 429 `federation_rate_limited`。