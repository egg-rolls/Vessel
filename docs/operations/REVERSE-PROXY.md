---
title: 公网暴露与同机反代的安全边界（0.55 P0 审计）
kind: current
triggers: [公网, 反代, 反向代理, nginx, 暴露, 威胁模型, loopback, 回环, 安全边界, P0, proxy_secret]
paths: [docs/operations/REVERSE-PROXY.md]
---

# 公网暴露与同机反代的安全边界

> 本文是 0.55 的 P0 审计结论：**反代与 gateway / hub / node 同机**时，客户端对端地址恒为
> `127.0.0.1`，于是所有「回环 = 本机 = 可信」的判定都失效。文中给出复现证据、候选修复与
> 需要产品拍板的点。本文只描述**审计与设计**；默认行为没有任何改动，新增开关一律 opt-in。

## 1. 结论摘要（先看这个）

1. **P0（已复现，最严重）**：平台入口 `POST /platform/rpc` 的 `platform.nodes.credentials`
   只要「socket 来自回环」就下发 node token，且**不需要任何凭据**。同机反代下每个公网请求
   都满足该条件 ⇒ **一条匿名请求即可逐个取走全部 node token**。
2. 拿到的 node token 是 node 的 `serve.token` / `token_env` / `VESSEL_GATEWAY_TOKEN`，
   在 node 上映射为 `role: admin` ⇒ 会话内容、run 启动（工具执行权）、权限应答、配置全部可达。
3. **同源问题（同一根因）**：node 在「回环监听 + 未配 token」时把无凭据请求解析成
   `anonymous admin`（HTTP 与 WS 首帧都一样）。同机反代 + nginx 默认 `Host: $proxy_host`
   即等于把 admin 送到公网。
4. hub 侧：`/v1/hub/directory`、`/v1/hub/events`（WS）与 `DELETE /v1/hub/nodes/:id`
   也只凭「回环 peer」放行 ⇒ 匿名读目录、匿名**吊销 node token**（拒绝服务）。
5. 没有任何启发式能区分「本机浏览器」与「同机反代转发的公网请求」：peer、Host、Origin
   三者都能被同一个反代做出与被信任请求完全一致的样子。**唯一可靠的办法是让反代出示一个
   共享密钥**（方案 A），其余方案都是范围收窄，不是根治。

## 2. 信任边界图

```
                          公网攻击者
                              │  HTTPS（反代终结 TLS）
                              ▼
            ┌─────────────────────────────────────────┐
            │  反代 nginx/caddy（与 Vessel 同机）      │
            │  · requestIP 一律 127.0.0.1             │
            │  · 默认 proxy_set_header Host $proxy_host│  ← 变成 127.0.0.1:8642
            │  · 默认不加 X-Forwarded-For             │
            └───────┬──────────────┬──────────────────┘
                    │              │
        ┌───────────▼───┐   ┌──────▼───────┐   ┌──────────────────┐
        │ 平台 127.0.0.1│   │ node 127.0.0.1│   │ hub 127.0.0.1    │
        │ :8642         │   │ :8644        │   │ :8643            │
        │ platform/rpc  │   │ /v1/rpc, /ws │   │ /v1/hub/*        │
        └───────┬───────┘   └──────┬───────┘   └──────┬───────────┘
                │                  │                  │
                │  platform.nodes.credentials（只查 loopback）
                ▼                  ▼                  ▼
        ┌──────────────────────────────────────────────────────┐
        │ node token（= node 的 serve.token，role: admin）      │
        │ → 会话内容 / run 启动（工具执行权）/ 权限应答 / 配置   │
        └──────────────────────────────────────────────────────┘
```

信任边界一句话版：

- **平台入口**：`platformToken` 配了才校验；不配则「回环 ⇒ 匿名只读」，
  而 `platform.nodes.credentials` 又把「回环」当成「可下发 node token」。
- **node 入口**：`serve.token(s)` 配了才校验；不配且监听回环 ⇒ 无凭据请求 = admin。
- **hub 入口**：`hub.token_env` 只在非回环监听时强制；回环 peer 一律视为已授权。

### 2.1 逐条：哪些判定依赖 peer 地址 / 回环

| # | 判定 | 位置 | 同机反代下的后果 |
|---|------|------|------------------|
| 1 | 平台是否把请求当本机 | `packages/serve/src/platform/auth.ts:60-62`（`isLoopbackAddress`）、`packages/serve/src/platform/server.ts:106-119` | 恒为真 ⇒ 未配 `gateway.token` 时匿名即可用平台 RPC |
| 2 | **node 凭据下发只查 loopback** | `packages/serve/src/platform/rpc.ts:157-165` | **匿名取走全部 node token** |
| 3 | node token 怎么变成凭据 | `src/gateway-command.ts:2404-2409`（`resolveNodeCredential`） | 直接返回原始 token，无角色/范围收窄 |
| 4 | 平台 Host/Origin 守卫 | `packages/serve/src/gateway/auth.ts:199-213`、`packages/serve/src/platform/server.ts:98-104` | `hostAllowed` 放行回环 Host，也放行通配监听；`originAllowed` 对无 Origin（curl）直接放行 |
| 5 | node 的「回环无 token ⇒ admin」 | `src/serve-auth.ts:123-124`、`packages/serve/src/tenant.ts:96-99` | `authenticate(null)` → `{role:'admin'}` |
| 6 | node HTTP 只按 token 解析、不看 peer | `packages/serve/src/gateway.ts:2509-2522`、`3682-3700` | 无凭据请求在「回环监听 + 无 token」时被授予 admin |
| 7 | node WS 首帧鉴权 | `packages/serve/src/gateway.ts:2329-2334` | `{kind:'auth'}` 不带 token ⇒ admin，可订阅事件 + 发 `req` |
| 8 | hub 读端点 | `src/hub/server.ts:348-352`、`699`、`718` | 匿名读目录 / 单节点详情 |
| 9 | hub WS 目录流 | `src/hub/server.ts:651-659`、`803-807` | 匿名拿到目录帧 |
| 10 | hub 删节点 | `src/hub/server.ts:452-453` | 匿名吊销 node token + 移除目录（DoS） |
| 11 | `/v1/local/token` | `packages/serve/src/gateway.ts:3529-3546` | 有回环 socket + 回环 Host + 同源三重检查；本报告未找到绕过（见 §5 反证） |

### 2.2 一条匿名请求能拿到什么

按危害从高到低：

1. **全部 node token**（`platform.nodes.credentials`）—— 一条 POST，不带任何头。
2. **工具执行权**：用上一步的 token 调 node `/v1/rpc` 的 `runs.start` / `sessions.create`，
   或直接走 `platform.nodes.get` 的探测面确认节点可达性。
3. **会话内容**：`events.subscribe` / 会话读取（含历史与工具结果）。
4. **权限应答**：`permission.respond` / `ask.respond` 可以替用户批准工具调用。
5. **拒绝服务**：hub `DELETE /v1/hub/nodes/:id` 匿名吊销 token；`platform` 侧的重启类 RPC
   （若用户本地另配了 admin token 且未校验则不可用，此处不夸大）。

## 3. 复现证据（不入库脚本）

脚本放在 `D:/tmp/pubnet/`（不进仓库）：

- `attack-platform.ts`：起一个平台实例（默认 `platformToken` 未配、`nodes=[node-a,node-b]`），
  再用一个同机纯 TCP 转发器扮演反代（Host 用 nginx 默认的 `$proxy_host`），最后用**原始
  HTTP/1.1**发请求，打印原文。
- `node-gateway.ts` / `ws-node.ts`：node 侧「无凭据 = admin」的 HTTP 与 WS 证据。
- `verify-fix.ts`：开关（§4 方案 A）三个方向的回归验证。

关键原文（`bun attack-platform.ts`，攻击者无任何凭据、经反代）：

```
=== 同一条匿名请求：逐个取走 node token ===
HTTP/1.1 200 OK
{"v":1,"id":"audit-1","ok":true,"result":{"token":"node-a-ADMIN-TOKEN-4c1f9d2e7b","mode":"token"}}

HTTP/1.1 200 OK
{"v":1,"id":"audit-1","ok":true,"result":{"token":"node-b-ADMIN-TOKEN-88a0be31f5","mode":"token"}}
```

node 侧（`bun node-gateway.ts` 第 1 组、`bun ws-node.ts legacy`）：

```
1) 无 proxySecret（旧行为）：不带任何凭据
  → 200 {"v":1,"id":"a1","ok":true,"result":{"version":"audit",...,"methods":[...]}}
[legacy] 收到帧：{"v":1,"kind":"hello",...}      ← WS 首帧不带 token 也拿到事件流
```

诚实标注的两个反证（说明这条链**依赖 Host 被改写成回环**，不是无条件成立）：

```
=== 反证：Host 用公网域名（反代保留原始 Host）会被 hostAllowed 挡掉 ===
HTTP/1.1 403 Forbidden  {"error":{"code":"forbidden","message":"Host header is not allowed"}}
=== 复核：请求不带 Host ⇒ Bun 自身 400（不是绕过） ===
HTTP/1.1 400 Bad Request
```

而 `gateway.hostname: 0.0.0.0`（通配监听）时该守卫整条失效 —— 平台侧**没有任何**
「非回环必须 token」的启动守卫（对比 node / hub 都有）：

```
=== 场景 2：platform 绑 0.0.0.0 + 未配 gateway token ⇒ 任意 Host 都放行 ===
HTTP/1.1 200 OK  {"..."token":"node-b-ADMIN-TOKEN-88a0be31f5"...}
```

## 4. 候选修复方案

### 方案 A（推荐）：反代共享密钥头，opt-in

**机制**：反代在每个转发请求上注入 `X-Vessel-Proxy-Secret: <secret>`。服务端配置了密钥之后：

- 「socket 来自回环」不再单独构成信任，必须同时满足「带正确的密钥头」；
- 带 Bearer token 的请求语义完全不变（本机 CLI / TUI / 客户端照旧）。

**改哪里**（本单已落地，全部默认关闭）：

| 位置 | 改动 |
|------|------|
| `packages/serve/src/gateway/auth.ts` | 新增 `PROXY_SECRET_HEADER` + `proxySecretAllowed()`（未配置 → `true`，定长哈希 + `timingSafeEqual`） |
| `packages/serve/src/platform/auth.ts` | `loopback = isLoopbackAddress(addr) && proxySecretAllowed(req, proxySecret)` |
| `packages/serve/src/platform/server.ts` / `types.ts` | 新增 `proxySecret` 选项并下传 |
| `packages/serve/src/gateway.ts` | 新增 `proxySecret` 选项：无凭据的 HTTP 请求必须带头（`3682-3692`）；WS 首帧不带 token 时必须带头（upgrade 时定值 `proxySecretAuthed`，`2327-2332`） |
| `packages/config/src/{types,validator,gateway,index}.ts` | 新增 `serve.proxy_secret_env` / `gateway.proxy_secret_env`（只存环境变量名，不接受内联密钥）+ 解析器 |
| `src/cli.ts` / `src/gateway-command.ts` | 分别把 `serve.proxy_secret_env` / `gateway.proxy_secret_env` 解析结果传进去 |

**影响**：

- 不配 = 与 0.55 之前逐字一致（已用 `verify-fix.ts` 回归：未配时匿名仍 200 + token）。
- 配了之后，该监听**只接受经反代来的请求**：直连 `http://127.0.0.1:8642` 的本地页面会
  拿不到匿名身份（需要改配 `gateway.token`，或继续走反代）。这是 opt-in 的代价，必须写进文档。
- 反代必须**覆盖**（不是追加）该头；客户端自带的同名头必须被反代覆盖掉。
  仓库里插件反代会剥离 `x-vessel-*`（`packages/serve/src/plugin-host/proxy.ts:178`），不会把密钥透给插件。

**多机部署怎么配**：

- 每台被反代的前端各生成一个随机串（`openssl rand -hex 32`），只存进该机反代配置与该机
  Vessel 服务的环境变量（`systemd Environment=` / `env_file`）。
- 反代侧（nginx）：
  `proxy_set_header X-Vessel-Proxy-Secret $vessel_proxy_secret;`（对 `/platform/`、`/v1/`、`/ws` 全部 location）。
- Vessel 侧：
  ```yaml
  gateway:
    proxy_secret_env: VESSEL_PLATFORM_PROXY_SECRET
  serve:
    proxy_secret_env: VESSEL_NODE_PROXY_SECRET
  ```
- 跨机 node（node 在另一台、经它的反代访问）各自独立配置，密钥不共享；hub 出站
  （node 主动连 hub）不需要，因为那条链由 node token 认证。

### 方案 B：`platform.nodes.credentials` 只认「平台 token」，不再认回环

**机制**：把 `packages/serve/src/platform/rpc.ts:157` 的 `ctx.auth.loopback` 改成
`ctx.auth.mode === 'token'`（或再加一个 `gateway.require_token_for_credentials: true` 开关）。

**影响**：精确堵住 token 外泄这一条，改动最小；但本地匿名 WebUI 也就不再能自动连 node
（用户必须配 `gateway.token` 并在页面里粘贴），属于**产品可见的行为变化**。另外它只堵
「取 token」这一步，node / hub 的匿名面仍在（攻击者仍可直接打 node，若 node 无 token）。

**多机部署**：每个平台都必须配 `gateway.token`（与 node token 不同值，已由
`checkPlatformTokenConflict` 保证），浏览器用 `#token=` 或手填。

### 方案 C：一次性引导码（bootstrap code）换会话凭据

**机制**：平台启动时把短期一次性码写到 `0600` 文件 + 打印到终端；匿名客户端必须先用它换
一个短期 session token，之后的所有 RPC 都带该 token。

**影响**：不要求用户改反代，但引入「凭据生命周期」这一层，且**挡不住**从公网打 node 的那条
线；实现量远大于 A（新端点、TTL、撤销、前端改造）。

**多机部署**：每台平台一份码；自动化场景需要额外的无头注入通道。

### 推荐

**A**，理由：唯一能真正区分「本机」与「同机反代」的机制；默认关闭所以不破现有部署；
一次实现同时覆盖 platform / node（hub 可按同一模式跟进）；多机配置成本只是「每台一份随机串
+ 反代一行指令」。B 可以叠在 A 之上作为纵深（但需要产品拍板是否接受本地匿名 UI 的变化）。

## 5. 本单落地了什么 / 没落地什么

已落地（全部 opt-in，默认行为不变）：

- 共享密钥头机制 + `serve.proxy_secret_env` / `gateway.proxy_secret_env` 两个配置键；
- 平台入口：回环信任要求密钥头（`platform.nodes.credentials` 因此不再被匿名利用）；
- node 入口：无凭据的 HTTP / WS 请求要求密钥头（带 token 的请求不变）。

**没落地（等拍板 / 后续单）**：

- hub 的三个回环判定（`src/hub/server.ts:348/452/651`）——同一模式可加，但 hub 还有
  `allow_remote` + TLS + token 的既有守卫，改动面要单独评估；
- 「平台非回环监听必须 token」的启动守卫（与 node/hub 对齐）——会改变现有部署的启动结果，
  属于行为变化，需拍板；
- 方案 B 的凭据端点收紧；
- mTLS / 反代信任头（`X-Forwarded-For`）识别。**特别提示**：`X-Forwarded-*` 不能作为
  信任来源——客户端可以自己伪造，除非反代保证覆盖。

## 6. 需要用户拍板的点

1. **是否接受「开了 `proxy_secret_env` 就只能经反代访问」**（直连 127.0.0.1 的页面不再有匿名身份）。
   备选：同时要求配 `gateway.token`，把直连模式改成「token 模式」。
2. **`platform.nodes.credentials` 的长期归属**：是永远允许「回环匿名下发 node token」，
   还是改成必须带平台 token（方案 B）？这决定本地 WebUI 是否还需要粘贴 token。
3. **平台是否要在非回环监听时强制 `gateway.token`（fail-closed 启动守卫）**：与 node/hub 对齐
   会挡住一类「0.0.0.0 + 无 token」的现网部署（它们现在能启动且匿名可读）。
4. **hub 的回环判定是否同样收紧**（会要求反代对 hub 也注入密钥头；纯本机 hub 不受影响）。
5. **密钥轮换与分发方式**：手工 env、还是纳入 SecretStore / 后续 `vessel gateway rotate` 一类命令。
6. **是否把「没配任何 token 的回环监听」在 `vessel doctor` 里降级为 warning/error**
   （只提示、不改语义，风险最低的一种收口）。

## 7. 复现与验证命令

```bash
cd /mnt/d/tmp/pubnet
bun attack-platform.ts    # 证明洞在
bun verify-fix.ts         # 证明开关三态（不配 / 缺头 / 带头）
bun node-gateway.ts       # node 侧无凭据 = admin
bun ws-node.ts legacy     # WS 首帧不带 token 也拿到事件流
```
