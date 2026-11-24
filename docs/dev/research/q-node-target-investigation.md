# q-node-target 调查注记：CLI 为什么总落在宿主 node

日期：2026-11-24 · 分支 fix/q-node-target · 基线 9a4f8a08

## 1. 现状：两条互不相通的 CLI 传输

| 命令族 | 传输 | 目标选择 |
| --- | --- | --- |
| `agent create/send/close/list/dispatch`、`team *` | `resolveAgentOwner(dataDir)` 读 `<dataDir>/agent-owner.json` → POST loopback owner 端点 | **只认本地 dataDir 里的 owner 记录**；完全不看 `--connect` |
| `status` / `agents`（复数只读）/ `errors` / `model` / `stop` | `resolveControlPlaneTarget`（src/cli/control-plane-target.ts）→ `createHttpRpcClient` POST `{base}/v1/rpc` | 支持 `--connect <url>` / `VESSEL_CONNECT`；否则本地 gateway PID 探测 |

关键事实：

1. **owner 端点只是传输**（src/agent/agent-owner-server.ts 头注）：它用合成 owner
   principal 分发与 gateway **同一张 canonical 方法表**（`createAgentMethods` /
   `createTeamMethods` / `createSessionMethods`，ADR-091 Addendum 0.26）。
   ⇒ 方法名、params、结果形状与 gateway `/v1/rpc` 完全一致，换传输是 drop-in。
2. `--user-config` 只替换用户层配置路径（落 `VESSEL_USER_CONFIG`，cli.ts:325）。
   它影响 `loadConfig()` → dataDir，但 `agent/team` 命令的 dataDir 解析
   （registry.ts `resolveCommandDataDir`）之后仍然只找 **owner 记录**：
   canary-config 若没有改变 dataDir、或该 dataDir 的 owner 记录指向宿主 REPL，
   成员就建在宿主。这就是 canary-explorer 实证的根因。
3. `--connect` 全局旗标已存在（args.ts 主循环 case '--connect'），但
   `agent`/`team` 在 i===0 提前进入各自子命令解析器，主循环的全局旗标够不着它们；
   子命令解析器也不认识这些旗标 → `Unknown argument`。

## 2. 可复用的 targeting 机制（都已存在，零新服务端代码）

- **gateway proxy**（0.58，packages/serve/src/platform/proxy*.ts）：
  `POST {platform}/nodes/<node_id>/v1/rpc`。目标地址只来自平台注册表（防 SSRF）；
  平台鉴权（Bearer 平台 token / 回环匿名）通过后，代理**剥掉客户端 Authorization、
  覆写成 node token**——node token 永不出网关。RPC 方法按命名空间白名单：
  `agents` / `teams` / `sessions` 全部在列（proxy-config.ts ALLOWED_RPC_NAMESPACES）。
- **HttpRpcClient 已支持 `rpcPath`**（src/rpc/http-client.ts:66，平台入口
  `/platform/rpc` 就是这么接的）⇒ proxy 路由只需 `rpcPath: '/nodes/<id>/v1/rpc'`。
- **平台 token 解析**（src/node/token-derive.ts `effectivePlatformToken`）：
  `gateway.token` > `gateway.token_env` > 派生 `vessel:platform`（`<dataDir>/root-secret`
  HKDF，现算不落盘）。canary-data/root-secret 即 canary 平台 token 源。
  注意 `resolveGatewayToken`（transport-factory）读的是 **node** token 键
  （node.token / node.token_env / VESSEL_GATEWAY_TOKEN / transport.token），
  对拆分平台不正确——nodeId 分支要用 effectivePlatformToken。
- **node 直连 token**：`--connect http://127.0.0.1:8654` 时走既有
  `resolveConnectToken`（--connect-token > VESSEL_CONNECT_TOKEN > config.connect.token
  > resolveGatewayToken）。canary node token 可用
  `vessel node token --print`（canary 上下文）或 root-secret 派生取得。
- `platform.nodes.credentials` 在 proxy 开启时降级为「必须平台 token」的 CLI 专用
  端点；本设计**不用它**（proxy 路径更干净：客户端永远不拿 node token）。

## 3. 设计（最小侵入）

1. `resolveControlPlaneTarget` 增加 `nodeId?: string | null`：
   - `--connect <url> --node <id>` → baseUrl=远端平台，rpcPath=`/nodes/<id>/v1/rpc`，
     token=connect token（平台 token）；
   - 仅 `--node <id>` → 本地平台 gateway（既有 PID 探测），rpcPath 同上，
     token=effectivePlatformToken（create:false 只读，不生成 root-secret）；
     此分支**不**吃 VESSEL_CONNECT env 回退（--node 无 --connect 恒指本地平台）；
   - 无 nodeId → 逐字旧行为。
2. `agent`/`team` 子命令解析器前置摘出 targeting 旗标
   （`--connect` / `--connect-token` / `--ca` / `--connect-ca` / `--node`，
   仿 extractUserConfigFlag 先例），写入既有全局字段 + 新 `nodeTargetArg`。
   `agent inbox` 是本地只读队列，显式拒绝 targeting。
3. 新 `resolveAgentCall`（agent/team 共用）：无 targeting → 逐字旧 owner 路径；
   有 targeting → resolveControlPlaneTarget，错误映射回
   AgentOwnerRequestError/UnavailableError（渲染层零改动）。
4. `sessions.create` 按 CREATE-0.39 裁决**不加 CLI 命令**（只保留 RPC）；
   targeting 落地后它天然可经同一 `/v1/rpc`（直连或 proxy）打到任意 node，
   文档给 curl 等价命令。

## 4. 验收口径（行为验证归用户）

canary node（7377657b…，8654）建 agent/team 的备命令见
docs/operations/cli-node-targeting.md（实现后补）。只读核查：
`vessel --user-config <canary-config> agent list --node <canary-node-id> --json`。
门禁：`bun run build`（exit code + 产物读数 → gates.log）。