---
title: node 自动加入与注册表派生白名单
kind: target
triggers: [node auto join, 自动加入, 注册, registration, invite code, 邀请码, join code, 白名单, allowlist, allowed origins, origin, 派生, derive, 私网, private network, loopback, 回环, node token, 心跳, heartbeat, 过期节点, stale, 目录, directory, hub]
paths: [src/hub/**, src/gateway-command.ts, packages/config/src/node-registration.ts, docs/architecture/node-auto-join.md]
---

# node 自动加入与注册表派生白名单

> **状态：设计稿（待拍板）。** 本文描述目标态与最小闭环，不含实现。拍板后才落实现提交。
> 现态见 [federation-hub](federation-hub.md)（join code / node token / hub 目录）与 [0.55-gateway-proxies-node](0.55-gateway-proxies-node.md)（平台代理 node 数据面）。

## 1. 要解决的问题

今天「浏览器能连上一个 node」需要**手工**在某一侧写 origin 白名单：

| 浏览器页面来源 | 谁需要放行它 | 今天怎么放行 |
|---|---|---|
| 平台页面 `http://127.0.0.1:8642` | node 的 `serve.allowed_origins` | 平台 spawn 子 node 时注入 `VESSEL_PLATFORM_ORIGINS`（`src/gateway/node-supervisor.ts`） |
| Vite dev relay `http://127.0.0.1:8644` | 同上 | **没人**放行 ⇒ 403 `forbidden_origin` |
| node 自己的页面 `http://127.0.0.1:86xx` | node 自己 | 同源，天然通过 |
| 局域网/公网来的页面 | node `serve.allowed_origins` | 手工写配置 |

后果：新派生（新机器、新端口、dev relay）的 node 一律要多写一行配置；写漏了表现为 403/401，而不是「自动可用」。

本设计把「谁可以当浏览器来源」从**手写配置**改成**从 node 注册表派生**，并且只在"能证明是本机"的范围内自动。

### 非目标

- 不改 `auth.public_origins` 的语义与选择逻辑（那是另两单的地盘：`packages/serve/src/auth/origins.ts`、`packages/config/src/validator.ts` 里的 origins/backends 校验一律不动）。
- 不改平台代理（`/nodes/<node_id>/**`）的路由、方法白名单与背压（见 0.55 设计稿）。
- 不改 `apps/web/src/gateway/nodes.ts` 的会话凭据模型（token 仍只进 sessionStorage）。
- 不做跨 hub 联邦、不做节点自发现（无 mDNS/无广播）。

## 2. 现成可复用的东西（不重复造）

| 能力 | 位置 | 备注 |
|---|---|---|
| 一次性 join code | `src/hub/join-store.ts`（`issue()` / `consume()`）、`src/hub/pairing-code.ts` | `sha256(code)` 落盘、TTL 60–3600s（默认 300）、`hub_id` 绑定、单次消费、进程内 single-flight、成功先原子写 `used_at` |
| node token 签发/校验/吊销 | `src/hub/node-credential-store.ts` | 只存 `sha256(token)`；`issue` / `authenticate`（同步、常量时间）/ `revoke` / `revokeNode(nodeId, exceptTokenId)` / `onRevoke` |
| 节点目录（持久化） | `src/hub/registry.ts` + `src/hub/types.ts:HubNodeRecord` | `<hubDataDir>/registry.json`，0600 atomicWrite + 250ms debounce，`hub_registry_corrupt` fail-closed |
| 入站控制面 WS | `src/hub/inbound-control.ts`、`src/hub/server.ts`（`HUB_NODE_CONTROL_PATH`） | 首帧 auth（5s 超时）、`hub_id`/`node_id` 绑定、15s ping / 30s idle、同 node 新连接接管 |
| 出站客户端（node→hub） | `src/hub/outbound-client.ts`、`src/hub/outbound-wiring.ts` | 指数退避重连、hello 10s 超时、`hub-node.json` 非秘密状态、`hub-node-status.json` advisory |
| 平台侧节点清单 + 凭据 | `packages/serve/src/platform/registry.ts`、`rpc.ts`（`platform.nodes.list|credentials`） | 浏览器拿 node token 的唯一路径（代理开启时降级为 CLI 专用） |
| 浏览器节点元数据 | `apps/web/src/gateway/nodes.ts` | `vessel.nodes` / `vessel.node-token.<id>`（sessionStorage） |
| 白名单闸 | `packages/serve/src/gateway/auth.ts`（`originAllowed` / `normalizeAllowedOrigins` / `hostAllowed`） | 平台与 node 共用同一套纯函数 |

缺口只有三处：**注册字段不够**（节点不说自己从哪来能怎么连）、**注册表没人消费**（白名单不从它派生）、**离线时的信任没有落点**（节点不在线时白名单就没了）。

## 3. 两条集合（先把词定死，后面全靠它们）

| 集合 | 名字 | 来源 | 谁消费 | 能不能自动增长 |
|---|---|---|---|---|
| **D** | 派生来源集（derived origins） | node 注册表 + 本机网卡事实 | 平台的 CORS/CSP（`httpAllowedOrigins`/`nodeOrigins`）、node 的 `serve.allowed_origins` | **能**，但只限"可证明本机"的 origin（见 §4 不变量 I1–I4） |
| **C** | cookie 会话白名单 | `auth.public_origins` / `auth.public_origin`（显式配置） | 平台 `dataGate` 的 session 判定、`/auth/*` 的 `redirect_uri` 选择 | **不能**。注册表永不写入 C |

一句话：**D 决定"浏览器可以发请求"，C 决定"cookie 可以当身份"。** 二者不互相提升。

## 4. 白名单如何从注册表派生（本设计的核心）

### 4.1 分类：只看 origin，不看声明

新增纯函数（新建文件 `packages/config/src/node-registration.ts`，不改任何既有校验函数）：

```ts
export type OriginClass = 'loopback' | 'private' | 'public';
export function classifyOrigin(origin: string): OriginClass | null; // 非法 origin → null
```

- `loopback`：`127.0.0.0/8`、`::1`、`localhost`、`[::1]`（与 `isLoopbackHostname` 同口径）。
- `private`：`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`fc00::/7`、`fe80::/10`、`100.64/10`（CGNAT）。**只有 IP 字面量**；域名一律不是 private（`foo.local` 也不猜）。
- `public`：其余一切（含所有域名、公网 IP）。

### 4.2 派生规则

```ts
export interface DerivedOriginsInput {
  nodes: readonly { node_id: string; entries?: readonly { url: string }[]; url?: string; public_url?: string }[];
  /** `os.networkInterfaces()` 里本机的地址集合；由调用方注入（测试可控）。 */
  localAddresses: readonly string[];
  /** 缺省 true；false ⇒ private 也不自动（只留 loopback）。 */
  allowPrivate?: boolean;
  /** 上限，缺省 32；超出部分丢弃并记一条日志。 */
  maxOrigins?: number;
}
export function deriveTrustedOrigins(input: DerivedOriginsInput): string[];
```

逐条：

1. 取出每条记录的入口 origin 候选（`entries[].url` ∪ 旧 `url` ∪ `public_url`），`normalizeOriginOrNull` 归一（已有的宽松归一：只接受 `scheme://host[:port]`）。
2. `loopback` → **无条件进 D**。
3. `private` → 仅当 host 出现在 `localAddresses`（即本机确实有这张网卡）**且** `allowPrivate !== false` → 进 D。否则丢弃。
4. `public` → **永不进 D**。想让它生效只能写显式配置（`auth.public_origins` / `gateway.allowed_origins` / `node.allowed_origins`）。丢弃时 hub 日志写一行 `hub.origins.skipped_public { node_id, host }`（不含 token、不含 query）。
5. 结果去重、顺序稳定（按 `node_id` 再按 url 排序）、截断到 `maxOrigins`。
6. 任何异常 / registry 损坏 → 返回 `[]`（fail-closed），不缓存上次结果。

`private` 为什么要"本机网卡验证"：注册表里的 `entries` 是 **node 自己声明的字符串**。任意 node 都能声明 `http://192.168.1.5:8642`（别人家的 LAN），若直接采信，等于让注册表把信任扩到任意私网地址。加了网卡校验之后，自动集的语义收敛成一句话：**"这台机器自己能当 origin 的地址"**。

### 4.3 消费点 A：平台

`src/gateway-command.ts` 里给 `startPlatformGateway` 的入参从
`nodeOrigins: [...nodes.map(n => n.apiUrl)]`（只喂 CSP）改为：

- `nodeOrigins: D_platform`（CSP `frameSrc`/`connectSrc`，含 registry 里的远端 loopback/私网 node）；
- 新增 `derivedOrigins: D_platform`，平台内部把它并入 `httpAllowedOrigins`（**只并入 CORS/`originAllowed`，不并入 C 的 session 判定**）。

> 注意现态：`packages/serve/src/platform/server.ts:528` 的 `httpAllowedOrigins` 只含 `gateway.allowed_origins + auth.public_origins`；`nodeOrigins` 只进 CSP。所以今天"平台页面能调 node"和"node 页面能调平台"是两套各自为政的白名单——正是本单要合并的。

### 4.4 消费点 B：node

node 的 `allowedOrigins` 现由 `src/cli.ts:1228 resolveGatewayAllowedOrigins(config.node.allowedOrigins, VESSEL_PLATFORM_ORIGINS)` 算出。目标态：

```
node.allowed_origins  (显式)
  ∪ VESSEL_PLATFORM_ORIGINS (平台注入，现状)
  ∪ D_node (hub 在 join 响应里下发的派生集)
```

- 下发通道（**最小闭环**）：`POST /v1/hub/join` 响应新增 `trusted_origins: string[]`（`vessel.hub/2` additive；旧 node 忽略）。node 把它写进 `<dataDir>/hub-node.json`（非秘密字段，0600，与现有 `HubNodeState` 同文件），启动时并入。
- 实时刷新（**不在最小闭环内**，见 §10 决策 4）：hub 在 `hello` 帧加 `trusted_origins`，node 收到后调 `gateway.reconfigure({ allowedOrigins })`。需要改 `packages/serve/src/hub-protocol.ts` / `hub-frames.ts`（本单文件边界外）。
- 没连上 hub / 从没 join 过 ⇒ 只有本地两项，**不降级放行**。

### 4.5 消费点 C：浏览器

不改。`apps/web/src/gateway/nodes.ts` 的 `vessel.nodes` / `vessel.node-token.*` 与平台目录解析（`apps/web/src/gateway/platform/hub.ts:parseNode`）都不认识新字段，天然忽略。

## 5. node 启动注册流程

### 5.1 请求形状（`POST /v1/hub/join`）

```jsonc
{
  "v": 1,
  "protocol": "vessel.hub/2",
  "code": "ABCD-EFGH",          // 首次注册必需（见 5.3）
  "node_id": "9f0c…",           // node 自己生成的稳定 UUID（resolveNodeId）
  "alias": "工作站",             // 可选，人看的
  "version": "0.54.0",          // 新增：能力协商用
  "capabilities": ["gateway.rpc", "web.ui"], // 新增：枚举白名单，不是自由文本
  "entries": [                  // 新增：0..3 条，node 自己声明的入口
    { "kind": "loopback", "url": "http://127.0.0.1:8651" },
    { "kind": "private",  "url": "http://192.168.1.5:8651" },
    { "kind": "public",   "url": "https://node.example.com" }
  ],
  "incarnation": "a1b2…"        // 可选：进程代际；同 node 重复注册时用
}
```

字段规则（由 `validateNodeRegistration()` 在**写入 registry 之前**执行，纯函数、可单测）：

- 只认白名单键；未知键丢弃（不报错，便于演进）。
- `entries[]` ≤ 3；`kind` ∈ `loopback|private|public`；`url` 必须是裸 origin（无 path/query/hash/userinfo、无尾斜杠），`public` 必须 `https`，`loopback`/`private` 允许 `http`。
- **`kind` 只是声明，hub 会用自己的 `classifyOrigin()` 重新分类**；声明与事实不一致 ⇒ 整条请求 400 `node_registration_invalid`（例：`kind: "loopback"` 但 host 是 `node.example.com`）。
- `capabilities[]` 只接受已知枚举（`gateway.rpc` / `web.ui` / `hub.control` / `federation.in`），去重、上限 8。
- `version` 只接受 `\d+\.\d+\.\d+` 形状（不比较大小，只落库给人看）。
- 旧字段 `public_url` 继续支持：等价于 `entries` 里 `kind: "public"` 那条；两者同时出现且冲突 ⇒ 400（不替用户猜）。

### 5.2 邀请码：怎么发、怎么过期、能不能重放

| 问题 | 答案 | 依据/改动 |
|---|---|---|
| 怎么发 | `vessel hub join-code`（hub 本机 CLI），明文只打印一次；`--json` 供脚本；可选 `--ttl` | 已有 `src/hub-command.ts:joinCodeCommand` |
| 谁能发 | 只有能读 `<hubDataDir>` 的人（= 本机壳层权限） | 无 HTTP 端点取码，不存在"远程领码"面 |
| 过期 | TTL 60–3600s，默认 300s；过期 ⇒ 410 `pairing_expired` | 已有 `join-store.clampTtl` |
| 重放 | 不可。`consume()` 先比对 hash，再查 `used_at`，成功时**先原子写 `used_at` 再发 token**；进程内 single-flight 保证并发只成功一次 | 已有 |
| 覆盖 | `issue()` 覆盖旧码（旧码立刻失效） | 已有 |
| 绑定 | 码里存 `hub_id`；消费时校验，A hub 的码不能给 B hub 用 | 已有 |
| 跨 node 复用 | 不能：`used_at` 之后任何 node 再来都是 `pairing_used` | 已有 |

需要补的一条（**新增**）：`consume()` 现在把 `node_id` 写进 `hub-join.json`，但**不校验**"这个 node_id 是否已有有效 token"。补规则见 5.3。

### 5.3 首注 / 重注册 / 轮转

| 场景 | 是否要 code | 结果 |
|---|---|---|
| 首次注册（registry 无此 node_id） | **要** | 发 token，写目录（`status: connecting`） |
| 该 node_id 已有有效 token 的跨机重注册 | **要**（且视为轮转） | 发新 token，`revokeNode(node_id, newTokenId)` 吊销旧 token 并关旧连接（已有逻辑）；`code` 是"我确实被授权把这条记录接管"的证明 |
| 该 node_id 已有有效 token，但请求来自**回环 peer**（hub 与 node 同机） | 不要 | 同机自助重连；仍走同一条签发+吊销路径 |
| 该 node_id 的 token 全过期/全吊销 | **要** | 同首次注册（不允许"凭猜到的 node_id 自助复活"） |
| 已 join 的 node 断线重连 | 不要 | 用 token 走 WS，**根本不走 join** |

落地：`/v1/hub/join` 在 `consume()` 之前加一次判定：

```
exists = registry.get(node_id) && credentials.list() 里有该 node_id 且未吊销未过期
if (exists && !loopbackPeer && code 为空) → 409 node_exists
```

> 关键取舍：**"证明持有旧 token" 不作为续期凭据**。token 是 WS 凭据，不上 join 请求体，避免它出现在 HTTP 日志/代理链里；续期一律靠"一次性邀请码或同机回环"。代价：token 过期的跨机 node 需要人去 hub 敲一次 `vessel hub join-code`——这是有意的（30 天 TTL 到期本来就该有人看一眼）。

## 6. 节点表落哪、心跳、过期清理

| 关注点 | 结论 |
|---|---|
| 权威存储 | hub `<hubDataDir>/registry.json`（`HubNodeRecord` 扩展：`entries?` / `capabilities?` / `version?` / `registered_at?`）。**不写内存表当权威** |
| 在线状态 | hub 进程内 `inbound-control` 的 `connections: Map<nodeId, conn>`（已有）。重启后清空，靠 node 重连重建；启动时把旧 `healthy` 全部标 `unreachable`（已有 `src/hub/runtime.ts:528`） |
| 心跳 | hub→node `ping` 15s；30s 无任何帧判 `unreachable`（已有）。node 收到 hello 即 `healthy` |
| 断线重连 | node 侧指数退避（已有 `outbound-client`）；hub 侧同 node 新连接接管旧连接（已有） |
| `last_seen` | 由 `snapshot` / 状态回调更新（已有） |
| 过期节点 | **只标记，不自动删**。`healthy` → `unreachable`（心跳）；`unreachable` 超过 `hub.retention_days`（默认 7）⇒ `status: unreachable` + `last_error: 'stale'`，仅此而已 |
| 删除 | 只有显式动作：`vessel hub nodes rm <node_id>`（已有，走 DELETE，先吊销 token 再删目录）。**绝不后台自动删 token 有效的记录**：派生白名单 D 依赖目录，自动删会让"新 node 不用手写白名单"随时间和在线状态漂移 |
| 一致性 | registry 变更（`registry.subscribe`，已有）⇒ 重算 D ⇒ 平台侧 `publishDirectory`（已有）+ 平台 CSP/CORS 更新 |

为什么状态不落"内存版权威"：hub 重启后 node 可能几分钟才回来；这段时间目录里仍要有它们的入口，否则浏览器页面在重启窗口里会突然 403。

## 7. node token 的下发 / 轮转 / 吊销 / 浏览器怎么拿

| 环节 | 方案 | 复用/新增 |
|---|---|---|
| 下发 | join 响应里明文一次（`token` + `token_id` + `expires_at`） | 已有 |
| 落盘 | hub 只存 `sha256(token)`；node 存 SecretStore（文件回退需 `hub.allow_file_secrets: true`） | 已有 |
| 轮转 | 重新 join（带 code）= 新 token + 吊销该 node 其余 token + 关旧 WS | 已有 `revokeNode(nodeId, except)` + `onRevoke` |
| 吊销 | `vessel hub nodes rm`；或 token 到期（默认 30 天） | 已有 |
| 浏览器 | **默认拿不到**：`gateway.proxy_nodes`（默认 true）下数据面走平台 `/nodes/<node_id>/**`，`platform.nodes.credentials` 只服务带平台 token 的 CLI | 已有（0.58） |
| 浏览器（代理关闭的保留形态） | `platform.nodes.credentials` → `vessel.node-token.<node_id>` 写 **sessionStorage** | 已有，本单不动 |
| 不做 | 不把 token 写进 `vessel.nodes` JSON、不进 localStorage、不进 URL、不进日志（含新加的 `hub.origins.*` 日志行——只打 `node_id` / host / 错误码） | 硬约束 |

## 8. 三条安全底线如何落到代码点

| 底线 | 落点 | 反面（必须没有） |
|---|---|---|
| **B1 非回环 origin 永不自动加入** | `deriveTrustedOrigins`：只有 `loopback`（+ §4.2 的本机网卡验证 private）能进 D；`public` 永远只读显式配置 | 不存在 `if (isPrivate(host)) return true` 这种"看前缀就信"的分支 |
| **B2 cookie 路径仍必须过白名单** | `packages/serve/src/platform/server.ts` 的 `dataGate` 顺序不变：Bearer → CSRF → session → `localDirect` 匿名。D **不进** `auth.public_origins`，因此不改变 `session_required` 判定；`/auth/*` 的 `selectPublicOrigin` 输入不变 | 不允许出现"来自 D 的 Origin ⇒ 视为已登录" |
| **B3 token 不进 localStorage / 日志** | 新代码新增的日志只有 `hub.origins.derived` / `hub.origins.skipped_public` / `hub.registration.*`，字段限定 `node_id` / `count` / `host` / 稳定错误码 | 不打印 `token` / `token_hash` / `code` / `hub-join.json` 内容 |

补充两条本单自己加的：

- **B4 派生失败 fail-closed**：输入异常 → `[]`，不回退 `*`，不缓存上次结果。
- **B5 声明不可信**：node 声明的 `kind` 只用于一致性校验，分类一律由 hub 重算（§5.1）。

## 9. 失败模式：注册失败时 node 仍能本地自用

| 失败 | 行为 |
|---|---|
| hub 不在线 / `POST /v1/hub/join` 超时或 5xx | `vessel hub join` 返回非零 + 稳定错误码；gateway 启动**不受影响**（`startHubNodeOutbound` 对 `direction_not_node` / `not_joined` / `identity_mismatch` / `credential_missing` 都返回 `skipped`；唯一会抛的是 `hub-node.json` 损坏，那属于既有 fail-closed，本单不改） |
| 邀请码过期/已用 | 410 + 明确文案；node 保持未 join，本地白名单 = `node.allowed_origins ∪ VESSEL_PLATFORM_ORIGINS`（**与今天逐字相同**），本机浏览器照旧可用 |
| join 成功但 hub 随后不可达 | 出站重连退避；本地白名单保留 join 时下发的 `trusted_origins`，**不降级为放行所有** |
| registry 损坏 | hub 启动 fail-closed（`hub_registry_corrupt`，已有）；node 侧只用本地值 |
| `hub-node.json` 损坏 | `hub_node_state_corrupt`（已有）fail-closed；不静默重建（否则会丢掉 token 身份） |
| 派生集为空 | 平台 CSP/CORS 退回"只有显式配置"（与今天一致），一行 `hub.origins.derived count=0` 日志 |

## 10. 最小闭环（第二个 commit 的范围）

**只做**：注册字段 + 校验 + 目录落库 + 平台侧派生 + node 侧 join 时下发。

1. `packages/config/src/node-registration.ts`（新建）：`classifyOrigin` / `normalizeEntryOrigin` / `validateNodeRegistration` / `deriveTrustedOrigins`（全纯函数，零依赖既有 origins/backends 校验）。
2. `src/hub/types.ts`：`HubNodeRecord` 加可选 `entries` / `capabilities` / `version` / `registered_at`；`HubNodeJoinedInput` 同步；`HubNodeState` 加可选 `trusted_origins`。
3. `src/hub/join-store.ts`（仅新增判定，不改既有语义）：`consume()` 的入参已含 `node_id`，落库字段不变；409 判定放在 `server.ts`（见 4）。
4. `src/hub/server.ts`：`handleJoin` 解析新字段 → `validateNodeRegistration` → 5.3 的 409 判定 → 原有 consume/issue 流程 → 响应加 `trusted_origins`。
5. `src/hub/runtime.ts`：`onJoined` 落新字段；订阅 registry 变化重算 D 并缓存；把 D 传给 `createServer` 与 join 响应。
6. `src/hub/derive-origins.ts`（新建，薄壳）：`os.networkInterfaces()` → `localAddresses`，调 `deriveTrustedOrigins`，缓存 + 日志。
7. `src/gateway-command.ts`：`startPlatformGateway` 的 `nodeOrigins` 改 D；`packages/serve/src/platform/server.ts` 的 `httpAllowedOrigins` 并入 `opts.derivedOrigins`。
8. 测试（`bun test`，新建文件，与现有 colocated 风格一致）：
   - `packages/config/src/node-registration.test.ts`：分类（回环/私网/CGNAT/IPv6/域名）、schema（kind 与事实冲突、超过 3 条、public 非 https、未知键丢弃）、派生（回环自动 / 非本机私网不自动 / 公网永不 / 上限 / 空输入 / 顺序稳定）。
   - `src/hub/derive-origins.test.ts`：网卡注入下的 private 行为两态。
   - `src/hub/join-registration.test.ts`：新字段 → registry 记录；409 `node_exists`；回环 peer 免 code。
   - `src/hub/hello-trusted-origins.test.ts`（若做 §4.4 实时刷新才需要）。

**不做（下一步/另单）**：hello 帧实时下发 + `reconfigure`（需要改 `packages/serve/src/hub-protocol.ts`）、`hub nodes prune`、web 端展示、`hub nodes rotate` 独立命令。

## 11. 待拍板

1. **private 自动的口径**（§4.2）。任务书里"私网入口自动进白名单"与"非回环 origin 永不自动加入"字面上冲突。我的取舍：自动集只收"可证明本机"的 origin（回环 + 本机网卡上的私网地址），其它私网声明与全部公网声明一律要显式配置。若你要求**严格只回环**，把 `allowPrivate` 默认改成 false 即可（一行）。
2. **`src/cli.ts` 的一行改动**：node 侧把 join 下发的 `trusted_origins` 接到启动参数，必须在 `src/cli.ts:1228` 那处 `resolveGatewayAllowedOrigins(...)` 多传一个参数。`src/cli.ts` 不在我的文件边界内，需要你批准这处（约 3 行）。
3. **token 过期后的跨机续期**（§5.3）：我按"必须再来一次 join-code"设计，接受"30 天到期要人介入"。若你要"旧 token 自助续期"，需要把 token 放进 join 请求体（凭据进 HTTP 面），我不建议。
4. **`hub nodes prune`**：本单不做（只标 stale）。需要的话是独立小单。

## 12. 未验证 / 风险

- **未跑过真机**：本文档阶段没有实现，也没有起过新 hub/node 来验证派生集在真实网卡（Windows + WSL 双栈、`::ffff:127.0.0.1`）上的分类结果。`os.networkInterfaces()` 在 Bun/Windows 下返回的地址形状（是否含 `fe80::` 带 scope id、是否含虚拟网卡如 vEthernet/WSL）**没有实测**。
- **没验证**：`registry.json` 加可选字段后与旧 hub 进程的互操作。parser 只按白名单解析（`src/hub/registry.ts` 的 `parseRecord` 末尾自己重建对象），未知键被丢弃而**不会**判 `hub_registry_corrupt`；但反过来，**旧 hub 进程重写文件会静默抹掉 `entries` 等新字段**（派生集随之退化到"只有 loopback 的 url"）。这条没跑过，且需要你决定是否接受"降级安装 = 白名单退化为现状"。
- **没验证**：旧 node（不认识 `trusted_origins`）与新 hub 的兼容，预期忽略；反过来新 node + 旧 hub 预期无该字段 ⇒ 退回现状。
- 风险：`deriveTrustedOrigins` 的输入包含**远端 node 自我声明的 entries**。本设计用"本机网卡验证"挡住任意私网声明，但**回环声明无法挡住**（任何 node 都能声明 `http://127.0.0.1:1`）。影响面：D 只用于 CORS/CSP 与 node 侧 `allowed_origins`，且 `localhost` 类 origin 只有本机代码能提供，所以可接受——但这条要你确认接受。
- 风险：把 D 并入平台 `httpAllowedOrigins` 会让"任何本机回环 origin"都能过 Origin 闸。与今天的 `localDirect`/回环匿名语义同向，但**扩大了 CORS 表面积**（ACAO 回显）。如果觉得过宽，可把 D 只用于 CSP、`httpAllowedOrigins` 维持现状（§4.3 里一行开关）。
