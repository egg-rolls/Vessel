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
  /** `os.networkInterfaces()` 里本机的地址集合；由调用方注入（便于在 REPL 里验证分流）。 */
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

**已接线（第二阶段，`feat/node-autojoin-wire`）**，接法不是新写一份并集，而是把 D 作为
**额外入参**交给 origins-core 定下的单一实现：

```ts
// src/gateway-command.ts（组合根）
const hubDataDir = config.hub?.dataDir ? resolve(...) : join(dataDir, 'hub');
const derivedOrigins = await readHubDerivedOrigins({ hubDataDir }); // 读 registry.json
startPlatformGateway({ /* ... */ derivedOrigins: derivedOrigins.origins }); // 传**全量** D

// packages/serve/src/platform/server.ts
const derivedOrigins = normalizeAllowedOrigins(opts.derivedOrigins);
const cspNodeOrigins = [...nodeOrigins, ...derivedOrigins];           // CSP：全量
const httpAllowedOrigins = normalizeAllowedOrigins([
  ...allowedOrigins, ...publicOrigins,
  ...resolveHttpAllowedOrigins({ /* http.allowed_origins 缺省即回环通配 */, publicOrigins,
                                 derivedOrigins }),                    // CORS：函数内部只留回环
]);
```

**为什么传全量、在 serve 内部收窄**：收窄逻辑只能有一处。调用方多传一次私网地址是
无害的（会被 `classifyOrigin !== 'loopback'` 挡掉），反过来「调用方忘了先过滤」就是
CORS 面被悄悄放大。所以把判断放在 `resolveHttpAllowedOrigins` 里，并且**只加不减**：

- 配置 `http.allowed_origins` ⇒ `配置 ∪ D_loopback`；
- 未配置 ⇒ `public_origins ∪ 三条回环通配 ∪ D_loopback`（老配置一字不改）。

**三行规则（拍板收窄，实现位置已对上）**：

| 消费点 | 用哪一部分 D | 实现位置 | 理由 |
|---|---|---|---|
| 平台 `httpAllowedOrigins`（CORS / `originAllowed`） | **只 loopback** | `resolveHttpAllowedOrigins`（`classifyOrigin === 'loopback'` 二次收窄） | 平台是浏览器主入口，CORS 面要最小；本机私网来源不该让平台回显 ACAO |
| 平台 CSP `connectSrc` / `frameSrc` | **全量 D**（loopback + 本机网卡验证过的 private） | `platform/server.ts` 的 `cspNodeOrigins` | CSP 只限制"页面能发到哪"，不放行就等于局域网 node 用不了 |
| node `serve.allowed_origins` | **全量 D** | `src/cli.ts` 的 `resolveGatewayAllowedOrigins(…, derived)` | node 才是需要局域网访问的那一侧 |

> 平台侧**怎么拿到 D**：读 hub data dir 里持久化的 `registry.json`（`readHubRegistryRecords`），
> 不打 HTTP、不要求 hub 已启动——否则「白名单依赖 hub 先起好」这个耦合会回来。文件缺失 /
> 损坏 / hub 在别的机器上 ⇒ 空集 ⇒ 平台行为与今天逐字一致。代价：D 在平台**启动时定格**
> （registry 变化要重启平台才生效，见 §10.2）。

### 4.4 消费点 B：node

node 的 `allowedOrigins` 由 `src/cli.ts` 的 `resolveGatewayAllowedOrigins(configured, injected, derived?)` 算出。目标态：

```
node.allowed_origins  (显式)
  ∪ VESSEL_PLATFORM_ORIGINS (平台注入，现状)
  ∪ D_node (hub 在 join 响应里下发的派生集，**全量**)
```

- 下发通道（**本单已实现**）：`POST /v1/hub/join` 响应新增 `trusted_origins: string[]`（`vessel.hub/2` additive；旧 node 忽略）。`vessel hub join` 把它写进 `<dataDir>/hub-node.json` 的 `trusted_origins`（非秘密字段，0600），gateway 启动时读出来并入。
- 第三个参数缺省 `undefined` ⇒ 与今天逐字一致；派生集解析失败时**退回 `配置 ∪ 注入`**，不因为一条坏 origin 少放行别的。
- 实时刷新（**未做**）：hub 在 `hello` 帧加 `trusted_origins`，node 收到后调 `gateway.reconfigure({ allowedOrigins })`。需要改 `packages/serve/src/hub-protocol.ts` / `hub-frames.ts`（本单文件边界外）。**现状代价**：D 在 join 那一刻定格，新 node 加入后老 node 要等到下次 join 才认识它。
- 没连上 hub / 从没 join 过 / 文件损坏 ⇒ 只有本地两项，**不降级放行**（`readHubNodeTrustedOrigins` 永不抛）。

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
- 错误码：`invalid_node_id` / `invalid_alias` / `invalid_version` / `invalid_capabilities` / `invalid_entries` / `entry_kind_mismatch` / `invalid_request`；全部 400。
- 旧字段 `public_url` **保持原语义**（"浏览器可达的 origin"，不是"公网 origin"）：局域网 http 仍允许，只有真正的公网域名强制 https；形状不合法才 400。老客户端因此完全不受影响。
- 校验发生在**消费邀请码之前**：400 不烧 code。

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

需要补的一条（**新增，已实现**）：`consume()` 把 `node_id` 写进 `hub-join.json` 但**不校验**"这个 node_id 是否已有有效 token"。补的判定放在 `src/hub/join-policy.ts`（纯函数 `decideJoinRegistration`），由 `handleJoin` 在 `consume()` **之前**调用。见 5.3。

### 5.3 首注 / 重注册 / 轮转

| 场景 | 是否要 code | 结果 |
|---|---|---|
| 首次注册（registry 无此 node_id） | **要** | 发 token，写目录（`status: connecting`） |
| 该 node_id 已有有效 token 的跨机重注册 | **要**（且视为轮转） | 发新 token，`revokeNode(node_id, newTokenId)` 吊销旧 token 并关旧连接（已有逻辑）；`code` 是"我确实被授权把这条记录接管"的证明 |
| 该 node_id 已有有效 token，但请求来自**回环 peer**（hub 与 node 同机） | 不要 | 同机自助重连；仍走同一条签发+吊销路径 |
| 该 node_id 的 token 全过期/全吊销 | **要** | 同首次注册（不允许"凭猜到的 node_id 自助复活"） |
| 已 join 的 node 断线重连 | 不要 | 用 token 走 WS，**根本不走 join** |

落地（**已实现**）：`/v1/hub/join` 在 `consume()` 之前调 `decideJoinRegistration({ hasCode, hasLiveToken, loopbackPeer })`：

| 输入 | 结果 |
|---|---|
| 带 code | 放行；`rotate = hasLiveToken`（签发后 `revokeNode(nodeId, newTokenId)`） |
| 无 code + 无有效 token | 400 `code_required` |
| 无 code + 有有效 token + 回环 peer | 放行并轮转 |
| 无 code + 有有效 token + 非回环 | 409 `node_exists` |

`loopbackPeer` 来自 `srv.requestIP()`（`isLoopbackPeer`，`::ffff:127.x` 已归一）。
`hasLiveToken` 来自 `credentials.list()` 里该 node 未吊销未过期的记录。

> 关键取舍：**"证明持有旧 token" 不作为续期凭据**。token 是 WS 凭据，不上 join 请求体，避免它出现在 HTTP 日志/代理链里；续期一律靠"一次性邀请码或同机回环"。代价：token 过期的跨机 node 需要人去 hub 敲一次 `vessel hub join-code`——这是有意的（30 天 TTL 到期本来就该有人看一眼）。

## 6. 节点表落哪、心跳、过期清理

| 关注点 | 结论 |
|---|---|
| 权威存储 | hub `<hubDataDir>/registry.json`（`HubNodeRecord` 扩展：`entries?` / `capabilities?` / `version?` / `registered_at?`）。**不写内存表当权威** |
| 在线状态 | hub 进程内 `inbound-control` 的 `connections: Map<nodeId, conn>`（已有）。重启后清空，靠 node 重连重建；启动时把旧 `healthy` 全部标 `unreachable`（已有 `src/hub/runtime.ts:528`） |
| 心跳 | hub→node `ping` 15s；30s 无任何帧判 `unreachable`（已有）。node 收到 hello 即 `healthy` |
| 断线重连 | node 侧指数退避（已有 `outbound-client`）；hub 侧同 node 新连接接管旧连接（已有） |
| `last_seen` | 由 `snapshot` / 状态回调更新（已有） |
| 过期节点 | **只标记，不自动删**。`healthy` → `unreachable`（心跳，已有）。"超过 N 天标 `stale`" 与 `hub.retention_days` **本单没做**（拍板结论：prune 不做）；现状是可从 `last_seen` 判断陈旧，不做额外状态 |
| 删除 | 只有显式动作：`vessel hub nodes rm <node_id>`（已有，走 DELETE，先吊销 token 再删目录）。**绝不后台自动删 token 有效的记录**：派生白名单 D 依赖目录，自动删会让"新 node 不用手写白名单"随时间和在线状态漂移 |
| 一致性 | registry 变更（`registry.subscribe`，已有）⇒ 重算 D ⇒ 平台侧 `publishDirectory`（已有）+ 平台 CSP/CORS 更新 |

为什么状态不落"内存版权威"：hub 重启后 node 可能几分钟才回来；这段时间目录里仍要有它们的入口，否则浏览器页面在重启窗口里会突然 403。

## 7. node token 的下发 / 轮转 / 吊销 / 浏览器怎么拿

| 环节 | 方案 | 复用/新增 |
|---|---|---|
| 下发 | join 响应里明文一次（`token` + `token_id` + `expires_at`） | 已有 |
| 落盘 | hub 只存 `sha256(token)`；node 存 SecretStore（文件回退需 `hub.allow_file_secrets: true`） | 已有 |
| 轮转 | 重新 join（带 code）= 新 token + 吊销该 node 其余 token + 关旧 WS | 已有 `revokeNode(nodeId, except)` + `onRevoke` |
| 吊销 | `vessel hub nodes rm`；或 token 到期（`hub.token_ttl_days`，缺省 30 天，1–365） | 已有 + 本单新增配置项 |
| 浏览器 | **默认拿不到**：`gateway.proxy_nodes`（默认 true）下数据面走平台 `/nodes/<node_id>/**`，`platform.nodes.credentials` 只服务带平台 token 的 CLI | 已有（0.58） |
| 浏览器（代理关闭的保留形态） | `platform.nodes.credentials` → `vessel.node-token.<node_id>` 写 **sessionStorage** | 已有，本单不动 |
| 有效期 | `hub.token_ttl_days`（1–365，缺省 30）：只影响**新签发**的 token，已有记录不改写 | 本单新增 |
| 不做 | 不把 token 写进 `vessel.nodes` JSON、不进 localStorage、不进 URL、不进日志（含新加的 `hub.origins.*` 日志行——只打 `node_id` / host / 错误码） | 硬约束 |

## 8. 三条安全底线如何落到代码点

| 底线 | 落点 | 反面（必须没有） |
|---|---|---|
| **B1 非回环 origin 永不自动加入** | `deriveTrustedOrigins`：只有 `loopback`（+ §4.2 的本机网卡验证 private）能进 D；`public` 永远只读显式配置 | 不存在 `if (isPrivate(host)) return true` 这种"看前缀就信"的分支 |
| **B2 cookie 路径仍必须过白名单** | `packages/serve/src/platform/server.ts` 的 `dataGate` 顺序不变：Bearer → CSRF → session → `localDirect` 匿名。D **不进** `auth.public_origins`，因此不改变 `session_required` 判定；`/auth/*` 的 `selectPublicOrigin` 输入不变 | 不允许出现"来自 D 的 Origin ⇒ 视为已登录" |
| **B3 token 不进 localStorage / 日志** | 本单新增的日志只有 `hub.origins.derived`（count 等计数）/ `hub.origins.skipped_hosts`（debug，只有 host）/ `hub.origins.derive_failed`（错误信息）；join 侧沿用既有 `hub.server.*`（只有 `node_id` + 稳定错误码）。**没有**任何日志打印 `token` / `token_hash` / `code` / `hub-node.json` 内容 | 不出现"为排查方便打一下 token/邀请码"的代码 |

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

## 10. 实现现状（本单已落 / 等 origins-core 合完再接）

### 10.1 已实现

| 文件 | 内容 |
|---|---|
| `packages/config/src/node-registration.ts`（新建） | `parseOrigin` / `classifyOrigin` / `classifyHost` / `addressKey` / `validateNodeRegistration` / `deriveTrustedOrigins`；全纯函数，零依赖既有 origins/backends 校验 |
| `src/hub/derive-origins.ts`（新建） | `readLocalAddresses()`（`os.networkInterfaces()`）+ `createOriginDeriver()`（缓存 + `invalidate()` 懒失效 + `hub.origins.derived` 日志） |
| `src/hub/join-policy.ts`（新建） | `decideJoinRegistration` / `hasLiveNodeToken`（§5.3 的四条判定） |
| `src/hub/types.ts` | `HubNodeRecord` + `entries` / `capabilities` / `version` / `registered_at`；`HubNodeJoinedInput` 同步；`HubNodeState.trusted_origins`；`HubNodeInboundDeps.derivedOrigins` |
| `src/hub/registry.ts` | 解析新的可选字段（坏条目单独丢弃，不判 corrupt） |
| `src/hub/server.ts` | join：载荷校验 → 邀请码判定 → 落目录 → 响应带 `trusted_origins` |
| `src/hub/runtime.ts` | `onJoined` 落新字段（`registered_at` 只写一次）；建派生器并订阅 registry 失效；`hub.token_ttl_days` 接线 |
| `src/hub/node-credential-store.ts` | `defaultTtlMs` 选项（只影响新签发） |
| `src/hub/node-state.ts` | `hub-node.json` 收 `trusted_origins`；`readHubNodeTrustedOrigins()` **永不抛错** |
| `src/cli.ts` | `resolveGatewayAllowedOrigins(configured, injected, derived?)` + 启动时读 `hub-node.json`（批准过的改动；缺省 `undefined` ⇒ 行为与今天逐字一致） |
| `src/hub-command.ts` | join 响应解析 `trusted_origins` 并写进 `hub-node.json`（**边界外 2 处同构小改，见 §11.5**） |
| `packages/config/src/{types,validator}.ts` | `hub.token_ttl_days`（1–365）+ 已知键登记 |

行为核对点（原先那批 `bun test` 用例已随宪法第三、四条删除，下面列出它们当年钉住的判据，
改到这些路径时人工核对；**本单不新增任何测试文件，正确性证据一律是可复现的运行时读数，见 §10.4**）：

- 节点注册分类（含 `::ffff:7f00:1` / `[fe80::1%25eth0]` / CGNAT / 域名）、schema、派生（回环自动 / 非本机私网不自动 / 公网永不 / 上限 / 顺序 / fail-closed）。
- 派生 origins 的缓存与 `invalidate`、`count=0` 日志、派生抛错 fail-closed。
- join 四条判定 + `hasLiveNodeToken`。
- 真 HTTP join（code 重放、无码回环重注册、`entry_kind_mismatch` 不烧 code、未知字段被丢弃）。
- `hub-node.json` 与 `registry.json` 新字段往返 + 坏条目容错。

### 10.2 第二阶段：平台侧接线（已完成，`feat/node-autojoin-wire`）

| 文件 | 内容 |
|---|---|
| `packages/serve/src/gateway/auth.ts` | `resolveHttpAllowedOrigins` 新增 `derivedOrigins` 入参：**只加不减**，且只接受 `classifyOrigin === 'loopback'` 的条目（单一收窄点） |
| `packages/serve/src/platform/server.ts` | 新增 `opts.derivedOrigins`；CSP 用 `cspNodeOrigins = nodeOrigins ∪ D`（全量），CORS 只在上面那一个函数里并入回环子集 |
| `packages/serve/src/platform/types.ts` | `derivedOrigins?: readonly string[]` + 三行规则注释 |
| `src/gateway-command.ts` | 组合根：`hubDataDir` → `readHubDerivedOrigins()` → `derivedOrigins: D`；非空时打一行 `hub.origins.derived` |
| `src/hub/registry.ts` | 新增只读入口 `readHubRegistryRecords(path)`（不校验 `hub_id`、坏记录逐条跳过、永不抛） |
| `src/hub/derive-origins.ts` | `getLoopback()`；`readHubDerivedOrigins()`（跨进程读盘 + 同一套派生规则 + 一行日志） |
| `packages/config/src/node-registration.ts` | `DerivedOriginsResult` 增加 `loopbackOrigins` / `privateOrigins` 子集 |

### 10.3 未做

1. **运行期刷新**：平台只在启动时读一次 registry。hub 侧新 node 加入后，平台要重启才放行它的 origin（D 变化不推送）。要实时化需要 `hello` 帧/目录事件 + 平台侧重建 CSP/CORS，属于下一单。
2. `hello` 帧向 node 实时下发 D + `gateway.reconfigure`（需改 `packages/serve/src/hub-protocol.ts` / `hub-frames.ts`）⇒ node 侧同样是"join 那一刻定格"。
3. `hub nodes prune`（只标 stale）、`hub nodes rotate` 独立命令、web 端展示。

### 10.4 证伪方式（复现步骤，替代测试）

按宪法第 04 条，正确性只由**可复现的运行时读数**承担。下面每一步都能独立跑出结论，
"证伪"列写的是**这条读数如果不对会看到什么**。

**复现 A：平台侧分流（第二阶段，最重要的一条）**

```bash
# 1) 临时实例：临时 HOME + 临时 dataDir + 新端口，避免污染本机配置
mkdir -p /tmp/na/home && cd /tmp/na   # Windows: D:/vessel-tmp/...
cat > vessel.yaml <<'YAML'
http: { allowed_origins: ['https://example.invalid'] }   # 显式配置 ⇒ 回环通配不生效，差异才看得见
gateway: { port: 28842 }
node: { hostname: 127.0.0.1, port: 28844 }               # 避开本机已占用的 8644
hub: { listen: { hostname: 127.0.0.1, port: 28843 } }
YAML
HOME=/tmp/na/home VESSEL_STATIC_DIR=<repo>/apps/web/dist \
  bun run <repo>/src/cli.ts gateway start --port 28842 --data-dir /tmp/na/data

# 2) 出一枚一次性邀请码（直接写 join store，不需要 hub 在线）
bun run <repo>/src/cli.ts hub join-code --json --data-dir /tmp/na/data/hub

# 3) 用真 HTTP 注册一台带两个入口的 node（loopback + 本机网卡私网）
curl -sS -X POST http://127.0.0.1:28843/v1/hub/join -H 'content-type: application/json' -d '{
  "v":1,"protocol":"vessel.hub/2","code":"<码>","node_id":"wire-node-1","version":"0.61.0",
  "capabilities":["gateway.rpc"],
  "entries":[{"kind":"loopback","url":"http://127.0.0.1:19971"},
             {"kind":"private","url":"http://<本机私网IP>:19971"}]}'
# 期望：HTTP 200 且 trusted_origins = [私网, 回环]（两个都派生出来了）

# 4) 重启平台（D 在启动时读盘派生），看一行日志
# 期望：hub.origins.derived count=2 loopback=1 private=1

# 5) CORS 探针：看 ACAO 回显哪些
curl -sS -D- -o /dev/null -X POST http://127.0.0.1:28842/v1/rpc \
  -H 'Origin: http://127.0.0.1:19971' -H 'content-type: application/json' -d '{}'   # 期望：回显该 origin
curl -sS -D- -o /dev/null -X POST http://127.0.0.1:28842/v1/rpc \
  -H 'Origin: http://<本机私网IP>:19971' -H 'content-type: application/json' -d '{}' # 期望：**无** ACAO
curl -sS -D- -o /dev/null http://127.0.0.1:28842/ | grep -i content-security-policy  # 期望：connect-src 含私网 origin
```

**证伪信号**（任何一条出现就说明实现错了）：

| 现象 | 说明什么 |
|---|---|
| 第 4 步没有 `hub.origins.derived` 日志 / `count=0` | 平台没读到 registry，或派生集为空（`http.allowed_origins` 那句话决定了是否走通配，别先怀疑 D） |
| 第 5 步「派生-回环」无 ACAO | D 的回环部分没进 `httpAllowedOrigins` |
| 第 5 步「派生-私网」**有** ACAO | 收窄失效（CORS 面被放大）——这是本设计最需要守住的一条 |
| CSP `connect-src` 缺私网 origin | 全量 D 没进 CSP，局域网 node 页面会被挡 |
| 显式配置项 `https://example.invalid` 无 ACAO | 并集把已有来源"减"掉了（违反只加不减） |

**复现 B：node 侧（第二阶段没做端到端，见 §12.2）**

`vessel hub join --hub-url http://127.0.0.1:28843 --code <码>` 之后检查
`<dataDir>/hub-node.json` 里出现 `trusted_origins`，再起 node ⇒ 该来源应出现在
node 的 `serve.allowed_origins` 里（**目前只有单元级证据，这条复现步骤还没被真机跑过**）。

**复现 C：hub 侧注册与邀请码语义**

同一枚 code 第二次 POST `/v1/hub/join` ⇒ 410 `pairing_used`；无 code 且该 node 无有效
token ⇒ 400 `code_required`；`entries` 里 `kind` 与地址事实不符 ⇒ 400
`entry_kind_mismatch`（且 code **未被消费**，同一枚还能注册合法 node）。

## 11. 拍板结论（已确认）

1. **private 口径**：按 §4.2 —— `allowPrivate` 默认 `true` + 本机网卡验证。语义 = "自动集只收可证明本机的 origin"。
2. **`src/cli.ts`**：批准。新参数可选、缺省 `undefined`、不传时行为与今天逐字一致。
3. **token 续期**：过期必须重走 join-code（不把 token 放进 join 请求体）；TTL 做成 `hub.token_ttl_days`（缺省 30，回环/本机节点可写长）。
4. **`hub nodes prune`**：不做，只标 stale。
5. **§10.1 里 `src/hub-command.ts` 的 2 处小改**（解析 join 响应的 `trusted_origins` + 写进 state）：这是 `hub-node.json` 唯一的写入点，不改这里就没有持久化通道；`HubNodeState` 里已有 3 个同形字段，改动同构。若不允许，退回"join 不下发、node 侧等 hello 帧扩展"。

## 12. 未验证 / 风险

### 12.1 真机读数（Windows 11 / bun 1.3.9，本机实测）

**组合根跑通（第二阶段，`vessel gateway start`，临时 HOME + 临时 dataDir + 新端口 28742/28743/28744）**：

1. 第 1 次启动：平台自动拉起 hub，生成 `registry.json`；`vessel hub join-code` 出码；
2. 用**真 HTTP** `POST /v1/hub/join` 注册一台 node，带两个入口（loopback + 本机网卡私网地址）：
   - `join -> HTTP 200`，响应 `trusted_origins = ["http://10.248.0.4:19971","http://127.0.0.1:19971"]`（回环 + 经本机网卡验证的私网）；
   - `registry.json` 落库：`entries = [{kind:loopback,...},{kind:private,...}]`，`version=0.61.0`，`capabilities=[gateway.rpc,web.ui]`；
3. 重启平台，启动日志出现 `hub.origins.derived count=2 loopback=1 private=1`（= 平台读盘派生成功）；
4. CORS 读数（`http.allowed_origins` 显式配置为 `https://example.invalid`，回环通配因此不生效，避免测不出差异）：

| Origin | 期望 | 实测 ACAO |
|---|---|---|
| `https://example.invalid`（显式配置） | 放行 | `https://example.invalid` ✅ |
| `http://127.0.0.1:19971`（**派生-回环**） | 放行 | 回显该 origin ✅ |
| `http://10.248.0.4:19971`（**派生-私网**） | **不放行** | 无 ACAO ✅ |
| `http://192.0.2.7:12345`（未派生私网） | 不放行 | 无 ACAO ✅ |

5. CSP 读数（同一进程）：

```
connect-src 'self' ws://127.0.0.1:28742 https://example.invalid wss://example.invalid
  http://127.0.0.1:19971 ws://127.0.0.1:19971          ← 派生回环，进了
  http://127.0.0.1:28744 ws://127.0.0.1:28744          ← 本地 implicit node
  http://10.248.0.4:19971 ws://10.248.0.4:19971        ← 派生私网，进了（全量 D）
  http://127.0.0.1:28743 ws://127.0.0.1:28743 http://localhost:28743 ws://localhost:28743
frame-src http://127.0.0.1:28744 http://10.248.0.4:19971 http://127.0.0.1:19971
```

结论：三行规则在真机组合根上**逐条对上**——私网只出现在 CSP，CORS 只有回环。

`os.networkInterfaces()` 的实际形状：

- zone id **不在** `address` 字符串里，而是独立数字字段 `scopeid`（如 `scopeid=25`）；`address` 形如 `fe80::4bf9:bd5:2d05:7c91`。
- 虚拟网卡全部出现：`VMware Network Adapter VMnet1/8`（`192.168.190.1` / `192.168.71.1`）、`ZeroTier One`（`172.22.171.39` / `10.29.194.189`）、`wt0`（`100.76.117.207` CGNAT + `fd37:...` ULA）、`WLAN`（`172.16.60.48` + 公网 IPv6 `2001:da8:...`）。**它们都是本机网卡** ⇒ 判定为"可证明本机"符合语义。
- `internal=true` 只出现在回环（`Loopback Pseudo-Interface 1`）：不能拿它代替地址分类。
- `new URL('http://[fe80::1%eth0]/')` 在 bun 里**直接抛错** ⇒ 手写 origin 解析（`parseOrigin`）是必须的。
- WHATWG 规范化把 `::ffff:127.0.0.1` 序列化成 `::ffff:7f00:1` ⇒ 分类器必须还原成 IPv4 再判断（已实现并有单测）。

### 12.2 仍未验证

- **node 侧端到端仍未跑过**：`vessel hub join`（CLI 写 `hub-node.json`）→ 出站客户端连 hub → gateway 启动时把 `trusted_origins` 并入 `node.allowed_origins` 这一整条，只有单元级证据（`node-state.test` / `registration-persistence.test`），**没有真进程跑过**。第二阶段只验证了**平台侧**闭环。
- **运行期刷新没有**：平台重启才读新 D。已在同一台机器上验证"重启即生效"，但"不重启也生效"不存在。
- **没验证降级读盘**：旧 hub 进程重写 `registry.json` 会静默抹掉 `entries`（parser 只按白名单重建）⇒ 派生集退化到"只有 url"。拍板接受（= 白名单退回现状）。
- **没验证** `readLocalAddresses()` 在 macOS / Linux / WSL 里的形状（只有 Windows 实测）。
- **没验证** hub 在**另一台机器**上的场景：平台读不到 `registry.json` ⇒ D 为空 ⇒ 行为与今天一致（这是设计取舍，但没有实测过这种部署）。
- 真机读数里有 2 个环境噪声需要在解读时排除：① 本机 8644 已被占，implicit node 改用 28744；② `registry.json` 是 `atomicWrite` + 250ms debounce，join 响应到落盘之间有亚秒级窗口（我的读数脚本第一次就踩到了 ENOENT）。
- 复现这条读数需要先构建 web：`apps/web` **不是** workspace 成员（`workspaces` 只有 `packages/*`、`plugins/*/*`），必须单独 `bun install`，否则 `bun run build:web` 会在 `src/stores/*` 报一片 `implicitly has an 'any' type`（缺 zustand 类型，**与代码无关**）。装好后 `build:web` 11s 通过。

### 12.3 风险（已接受）

- 回环声明无法挡住（任何 node 都能声明 `http://127.0.0.1:1`）。接受的前提是 **cookie 写操作仍必须带 CSRF 同步令牌**（另一单在验）；该前提已写进 `packages/config/src/node-registration.ts` 的注释，不只写在文档里。
