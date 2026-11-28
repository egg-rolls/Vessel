---
title: CLI 指定目标 node（--connect / --node targeting）
kind: current
triggers: [node targeting, --node, --connect, 指定节点, 跨节点建 agent, canary 建成员, proxy, /nodes, agent create 落点, team create 落点]
paths: [src/cli/control-plane-target.ts, src/cli/agent-call.ts, src/cli/args.ts, src/cli/commands/agent/agent-command.ts, src/cli/commands/team-command.ts, packages/serve/src/platform/proxy-config.ts]
---

# CLI 指定目标 node（`--connect` / `--node` targeting）

> 场景：让 `vessel agent …` / `vessel team …` 落到**任意指定 node**，而不是默认宿主。这是「agent 自己在金丝雀跑」的关键：在 canary node 建成员/团队，不碰生产宿主。配套拓扑与双舰队隔离见 [federation-setup.md](federation-setup.md)。

## 1. 缺省路径（本地 owner）

无 `--connect` / `--node` 时逐字旧行为：`resolveAgentOwner(dataDir)` 读 `<dataDir>/agent-owner.json` → POST 本地 loopback owner 端点。它**只认本地 dataDir 里的 owner 记录**，不看 `--connect`；`--user-config` 只替换用户层配置路径，不改落点——owner 记录指向宿主 REPL，成员就建在宿主。`agent`/`team` 不吃 `VESSEL_CONNECT` env 回退（避免指向远端的 env 悄悄改写落点）。

owner 端点与 gateway 分发**同一张 canonical 方法表**（ADR-091），方法名 / params / 结果形状完全一致：targeting 只是**换传输**，命令语义与输出零改动。

## 2. 两种 targeting（显式旗标才改道）

| 形式 | 路由 | 凭据 |
|---|---|---|
| `--connect <url>` | 直连该 URL 的 `/v1/rpc`（node 或 gateway） | connect token（见 §3） |
| `--node <id>` | **本地平台**代理 `/nodes/<id>/v1/rpc` | 平台 token（自动解析，见 §3） |
| `--connect <url> --node <id>` | **远端平台**代理 `/nodes/<id>/v1/rpc` | connect token（= 该平台 token） |

- `--node` 经平台代理（`packages/serve/src/platform/proxy*.ts`）：目标地址**只来自平台注册表**（防 SSRF）；平台鉴权通过后，代理剥掉客户端 `Authorization`、覆写成 node token——**node token 永不出网关**。白名单按命名空间：`agents` / `teams` / `sessions` 与 kanban / jobs / images 等只读面都在内（`proxy-config.ts`），缺命名空间 fail-closed。
- `--node <id>` 的 `<id>` 是 **node_id**（`node.json` / `gateway nodes list` 可查），形状 `[A-Za-z0-9._-]{1,64}`（`control-plane-target.ts:NODE_ID_PATTERN`）；非法形状 CLI 直接报错。
- 旗标：`--connect <url>`、`--connect-token <token>`、`--ca <path>`（= `--connect-ca`）、`--node <id>`。`--connect-token` / `--ca` 必须伴 `--connect` 或 `--node`。
- **`agent inbox` 是本地只读队列**（`agent-inbox-command.ts`），不经 RPC，显式拒绝 `--connect`/`--node`。

## 3. token 解析（永不打印、不进 URL）

- **`--node`（本地平台）**：平台 token = `gateway.token` > `gateway.token_env` > 派生 `vessel:platform`（`<dataDir>/root-secret` HKDF，现算不落盘，只读不生成）。显式 `--connect-token` / `VESSEL_CONNECT_TOKEN` 仍最优先。canary 即 `canary-data/root-secret` 派生（或 canary-config 的 `gateway.token_env`）。
- **`--connect`（直连 node）**：`--connect-token` > `VESSEL_CONNECT_TOKEN` > `config.connect.token` > node token 键（`node.token` / `node.token_env` / `VESSEL_GATEWAY_TOKEN` / `transport.token`）。
- **只读派生回退**（`control-plane-target.ts`）：显式凭据链皆空时——经代理（`--node`）补平台 token（与本地代理路同口径）；直连补 node 生效 token（`effectiveNodeTokenAuto`，`create:false` 查询不写盘）。派生不可得（无 root-secret / 未知 node id）→ 空，逐字旧行为。
- 直连 canary node 也可用 `vessel --user-config <canary-config> --data-dir <canary-data> node token --print` 取 node token（**会回显，谨慎**）；优先用 `--node` 代理路径，免手工传 token。
- 非 loopback 必须 https + token（`http-client.ts` 强制，不回退明文）。

## 4. 验收：在 canary node 建 agent / team（行为验证归用户）

拓扑（见 federation-peers.md）：canary 平台 **8652**（proxy.enabled=true），canary node **8654**，node_id `7377657b-dfba-4347-809d-5e88460441e0`，dataDir `D:/Application/APP/Vessel/fleets/canary-data`。

**推荐：`--node` 代理路径**（平台 token 自动解析；canary 上下文 `--user-config` + `--data-dir` 与舰队启动一致）：

```bash
vessel --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml \
  --data-dir D:/Application/APP/Vessel/fleets/canary-data \
  team create vessel --node 7377657b-dfba-4347-809d-5e88460441e0

vessel --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml \
  --data-dir D:/Application/APP/Vessel/fleets/canary-data \
  agent create --name canary-probe --node 7377657b-dfba-4347-809d-5e88460441e0

# 只读核查：成员确实在 canary node
vessel --user-config D:/Application/APP/Vessel/fleets/canary-config.yaml \
  --data-dir D:/Application/APP/Vessel/fleets/canary-data \
  agent list --node 7377657b-dfba-4347-809d-5e88460441e0 --json
```

等价直连（需 node token）：`vessel agent create --name canary-probe --connect http://127.0.0.1:8654 --connect-token <canary-node-token>`。远端平台代理：`--connect https://canary-platform.example.com --node <id> --connect-token <canary-platform-token>`。

> 不碰生产宿主：以上命令显式 targeting canary；缺省（无旗标）才落本地 owner。生产宿主的重启/变更仍由用户维护（federation-token-env.md）。

## 5. sessions.create（RPC-only，CREATE-0.39）

按 CREATE-0.39 裁决，`sessions.create` / `sessions.restart` **只保留 RPC，不加 CLI 命令**（CLI `session` 子命令只有 status）。targeting 落地后它天然可经同一 `/v1/rpc` 打到任意 node。直连 canary node 的等价 curl：

```bash
curl -s http://127.0.0.1:8654/v1/rpc \
  -H 'Content-Type: application/json' -H "Authorization: Bearer <canary-node-token>" \
  -d '{"v":1,"id":"1","method":"sessions.create","params":{"agent_id":"<agent-id>"}}'
```

经平台代理则把 URL 换成 `http://127.0.0.1:8652/nodes/<node-id>/v1/rpc`、Authorization 换平台 token（代理自动覆写 node token）。`agents.send` 同理（CLI 已支持 `agent send … --node`）。

## 6. 安全红线

- token 永不打印、不进 URL / query；`--node` 路径客户端永远不拿 node token。
- 代理目标地址只来自注册表；路径 / RPC 方法白名单 fail-closed（`proxy-config.ts`）。
- `--node` 无 `--connect` 恒指本地平台，不吃 `VESSEL_CONNECT` env 回退。
- 非 loopback 必须 https + token；`agent inbox` 本地只读，拒绝 targeting。

## 7. 排障

- `proxy_disabled`：该平台关了 `gateway.proxy_nodes` ⇒ 改用 `--connect` 直连 node。
- `node_not_found`（404）：`--node` 的 id 不在平台注册表 ⇒ `gateway nodes list` 核对 node_id。
- `platform_unauthorized`（401）：平台 token 不对 ⇒ 核对 `--user-config`/`--data-dir` 是否指向该平台（root-secret / gateway.token_env 随之确定），或显式 `--connect-token`。
- `agent_owner_unavailable`：缺省路径找不到本地 owner（`src/agent/agent-owner-client.ts`）⇒ 先起交互 REPL，或改用 targeting。
