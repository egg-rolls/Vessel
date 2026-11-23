---
title: 公网暴露与同机反代的安全边界（0.55 P0 审计）
kind: current
triggers: [公网, 反代, 反向代理, nginx, 暴露, 威胁模型, loopback, 回环, 安全边界, P0, proxy_secret]
paths: [docs/operations/REVERSE-PROXY.md]
---

# 公网暴露与同机反代的安全边界

> 本文是 0.55 的 P0 审计结论：**反代与 gateway / hub / node 同机**时，客户端对端地址恒为
> `127.0.0.1`，于是所有「回环 = 本机 = 可信」的判定都失效。文中给出复现证据、修复方案与
> 迁移步骤。§4 的共享密钥开关仍是 **opt-in**；§8 的四条收紧是**默认生效的行为变化**，
> 升级前请按 §8 的清单逐条过。移植/回滚粒度：每一条收紧各自一个 commit。

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
6. **0.55 最终口径（四条收紧，默认生效）**：
   - 平台**非回环监听 + 无 `gateway.token` ⇒ 拒绝启动**（不是警告）；回环监听不受影响；
   - `platform.nodes.credentials` **必须** `mode === 'token'`（不再接受「回环匿名」）；
   - hub 的三个回环判定（目录 / WS 目录流 / 删节点）在配置了反代密钥后**必须带密钥头**；
   - `vessel doctor` 对「回环 + 无任何 token」报警（只提示，不改语义）。
   迁移步骤见 §8；每一条的拒绝文案都写明「缺什么 / 配置键叫什么 / 一行可复制的命令」。
   **升级后最可能感知到的两件事**：① 绑 `0.0.0.0` 且无 token 的平台起不来；② 本地 WebUI
   要先用平台 token（`#token=`）导入一次才能连 node。


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

**A + B + 平台 fail-closed + hub 收紧**（0.55 最终口径）：A 是唯一能区分「本机」与「同机反代」
的机制；B / fail-closed / hub 收紧把剩下能绕过 A 的匿名面一起关掉。四项默认生效与否见 §8。

## 5. 落地清单（按 commit）

已落地，默认行为不变（opt-in）：

- 共享密钥头机制 + `serve.proxy_secret_env` / `gateway.proxy_secret_env` 两个配置键；
- 平台入口：回环信任要求密钥头；
- node 入口：无凭据的 HTTP / WS 请求要求密钥头（带 token 的请求不变）。

已落地，**默认生效的行为变化**（详见 §8）：

1. 平台 fail-closed：非回环监听 + 无 `gateway.token` ⇒ 启动被拒
   （`packages/serve/src/platform/listen-guard.ts`；`startPlatformGateway` 与 CLI 预检双处判定）；
2. `platform.nodes.credentials` 要求 `mode === 'token'`（`packages/serve/src/platform/rpc.ts`）；
3. hub 三个回环判定在配置了 `hub.proxy_secret_env` 后必须带密钥头
   （`GET /v1/hub/directory`、`GET /v1/hub/events` WS 首帧、`DELETE /v1/hub/nodes/:id`）；
4. `vessel doctor` 对「回环 + 无论任何 token」报警（只提示）。

仍未做（明确不做 / 留给后续）：

- mTLS / 反代信任头（`X-Forwarded-For`）识别。**特别提示**：`X-Forwarded-*` 不能作为
  信任来源——客户端可以自己伪造，除非反代保证覆盖；
- 密钥自动铸造 / 轮换命令（当前是手工 env，步骤见 §9）。

## 6. 设计决策记录（已拍板）

1. 「开了 `proxy_secret_env` 就只能经反代访问」——**接受**（直连 127.0.0.1 的页面不再有
   匿名身份；要直连就连同 `gateway.token` 一起配）。
2. `platform.nodes.credentials` —— **改为必须带平台 token**（方案 B）。本地 WebUI 需要在
   页面里粘贴平台 token（`#token=<值>` 或界面输入）。
3. 平台非回环监听 —— **强制 `gateway.token`（fail-closed 启动守卫）**，与 node/hub 对齐。
4. hub 的回环判定 —— **同样收紧**（要求反代对 hub 也注入密钥头；纯本机 hub 不受影响）。
5. 密钥分发 —— 当前**手工 env**；轮换步骤见 §9，自动轮换命令留后续。
6. doctor —— **只警告、不改语义**（把风险暴露出来，不替用户停服务）。

## 7. 复现与验证命令

```bash
cd /mnt/d/tmp/pubnet
bun attack-platform.ts      # 证明洞在（改造前）
bun verify-fix.ts           # 反代密钥开关三态（不配 / 缺头 / 带头）
bun verify-a-listen.ts      # 验收 a：平台 fail-closed 四形态 + 密钥缺头/错头
bun node-gateway.ts         # node 侧无凭据 = admin
bun ws-node.ts legacy       # WS 首帧不带 token 也拿到事件流
```

## 8. 升级清单（从旧行为到新行为）

0.55 的四条收紧**默认生效**。升级后现网可能出现的三种可见变化，先对号入座：

1. **平台起不来**：配置是 `gateway.hostname: 0.0.0.0`（或网卡 IP）又没有 `gateway.token`
   ⇒ 报 `platform_listen_insecure` 直接退出（`gateway restart` 会先拒绝、旧实例保持运行）。
2. **WebUI 连不上 node**：`platform.nodes.credentials` 现在要平台 token；多数本地安装没有配
   ⇒ 页面能列出节点但连不上，需要按第 2 步补 `gateway.token_env` 并用 `#token=` 导入一次。
3. **hub 请求 401/403**：只有当你**主动配了** `hub.proxy_secret_env` 才会变（不配行为不变）。

### 第 0 步：先判断自己属于哪一类

| 你的形态 | 需要做什么 |
|----------|------------|
| 纯本机（浏览器直接开 `http://127.0.0.1:8642`，没反代） | **平台能照常启动**，但 WebUI 连 node 需要平台 token：做第 2 步第 1–2 条（配 `gateway.token_env` 并导入）。不想配 token 的话页面只能读节点列表，拿不到 node 连接 |
| 同机反代 + 公网/内网访问 | 走第 1–3 步（推荐全配） |
| 平台绑 `0.0.0.0` 且没配 `gateway.token` | **必须先做第 1 步**，否则起步就被拒绝（这是有意的） |
| 多机（每台一个 node，各自可能被反代） | 每台机器单独做第 1–3 步；密钥不要跨机复用 |

### 第 1 步：平台监听（fail-closed）

1. 看当前监听：`vessel gateway status`（或 `grep -A3 '^gateway:' ~/.vessel/config.yaml`）。
2. 如果是回环（`127.0.0.1` / `localhost`）→ 无需改动。
3. 如果是 `0.0.0.0` 或具体网卡地址，二选一：
   - **推荐**：改成回环，让同机反代转发进来：
     ```yaml
     gateway:
       hostname: 127.0.0.1
     ```
   - 或者配平台 token（令牌只进环境变量）：
     ```bash
     openssl rand -hex 32          # 生成一次，粘贴到下面
     # 写进 gateway.token_env 指向的环境（systemd Environment= / .env / shell profile）
     export VESSEL_PLATFORM_TOKEN=<上面生成的值>
     ```
     ```yaml
     gateway:
       token_env: VESSEL_PLATFORM_TOKEN
     ```
4. 重启：`vessel gateway restart`。若仍被拒，报错会直接写出缺什么。

### 第 2 步：`platform.nodes.credentials` 要凭据了

1. **先确认有没有平台 token**（多数本地安装没有）：
   ```bash
   vessel config show | grep -A2 '^gateway:'
   ```
   没有 `gateway.token` / `gateway.token_env` 就补一个（令牌只进环境变量）：
   ```bash
   openssl rand -hex 32            # 生成一次
   export VESSEL_PLATFORM_TOKEN=<上面生成的值>      # 写进 systemd / .env / shell profile
   ```
   ```yaml
   gateway:
     token_env: VESSEL_PLATFORM_TOKEN
   ```
   然后 `vessel gateway restart`。
2. **浏览器导入**：地址栏用 `http://<host>:<port>/#token=<平台 token 的值>` 打开一次
   （之后只存 `sessionStorage`），或用界面里的 token 输入框。
   注意是**平台 token**，不是 node token。
3. **脚本**：打 `/platform/rpc` 时加 `Authorization: Bearer <平台 token>`。
4. 只有 node token 的旧脚本会拿到 401 `platform_unauthorized`（文案会提示要用平台 token）。
5. **只读接口不变**：`platform.nodes.list` / `platform.nodes.get` / `platform.whoami` 在回环
   （且配了反代密钥时带上密钥头）仍可匿名调用，本次只收紧「下发 node token」这一个端点。
   所以**不配 token 也不会白屏**：页面能列节点，只是连不上 node（`credentials` 401）。

### 第 3 步：hub 回环判定收紧（配了密钥才收紧）

1. 生成 hub 的反代密钥：`openssl rand -hex 32`。
2. 写进 hub 服务的环境：`export VESSEL_HUB_PROXY_SECRET=<值>`。
3. 配置键：
   ```yaml
   hub:
     proxy_secret_env: VESSEL_HUB_PROXY_SECRET
   ```
4. 反代对 hub 的 location 也加一行（**覆盖**，不是追加）：
   ```nginx
   proxy_set_header X-Vessel-Proxy-Secret $vessel_hub_proxy_secret;
   ```
5. 不配 `hub.proxy_secret_env` = hub 的回环判定保持旧行为（不新增拒绝）。
6. 本机命令行不受影响：`vessel hub directory` / `vessel hub node rm` 会从**同一个环境变量**
   读值并自带该头（不经过反代也能用）；只有「经反代进来又没带头」的请求会被拒。

### 第 4 步：node 入口（可选但推荐）

同机反代指向 node 的话，`serve.proxy_secret_env` + 反代注入头；配了之后**直连 node 的本地
CLI/TUI 必须带 `serve.token`**（它们本来就带，因此通常无感）。

### 第 5 步：自检

```bash
vessel doctor            # 有没有「回环 + 无 token」警告
vessel gateway status    # 平台在哪、是否在跑
curl -s http://127.0.0.1:8642/health   # {"status":"ok","role":"platform",...}
```

`doctor` 的 `exposure` 行会把「回环监听 + 完全没有凭据」的三个面列出来（只提示，不改行为）：

```
[warn]  exposure: node 127.0.0.1 没有 serve.token / serve.tokens：同机反代下匿名请求会被当成 admin；
        配 serve.token_env（或 serve.proxy_secret_env）后重启; 平台 127.0.0.1 没有 gateway.token：…
        hub 127.0.0.1 没有 hub.token_env：回环匿名可读目录、可删节点（吊销 node token）；…
```

三个面都有凭据/密钥时该行变成：

```
[ok]    exposure: loopback listeners are protected by a token or a proxy secret
```

纯本机使用、确认没有反代也没有其他本机进程时，可以按需忽略这条 warning；它不阻止启动。

> 回滚：四条收紧各自一个 commit（`git revert <sha>` 可单条回退）。回退后行为立即回到
> 「回环即可信」的旧形态——**只在确认该机器不暴露到公网时**才这么做。

## 9. 密钥轮换（手工，当前版本）

平台 token、反代密钥、hub 密钥都是「环境变量里的值」；轮换 = 换值 + 重启相关进程。

1. **生成新值**：`openssl rand -hex 32`（不同用途各生成一份，不要复用）。
2. **更新来源**：改 `systemd` 的 `Environment=` / `env_file` / shell 里的 `export`，不要写进
   YAML（配置键只存**变量名**，`validator` 不接受内联密钥）。
3. **平台 token**：更新 `gateway.token_env` 指向的变量后 `vessel gateway restart`；
   浏览器页面需要重新用 `#token=<新值>` 导入一次（旧值立即失效）。
4. **反代密钥**（`serve.proxy_secret_env` / `hub.proxy_secret_env`）：先改 Vessel 侧环境与
   反代侧变量名指向的值，两者**必须同时**切换；顺序建议：先把新值写进 Vessel 环境并重启 →
   再改反代注入值并 `nginx -s reload`（中间会有短暂 401，可在维护窗口做）。
5. **node token**：`serve.token_env` 换值后重启 node；hub 目录里该 node 的 token 由平台
   重新下发（`platform.nodes.credentials` 拿到的就是新值），旧值立即被拒。
6. **轮换之后自检**：`vessel doctor` + 打开页面确认能连；`curl` 旧 token 应当 401。

## 10. 0.56：公网域名 + GitHub 登录（单用户）

域名访问（如 `https://egg-rolls.top`）不再是「回环才行」的特例：平台仍绑 `127.0.0.1`，
由反代保留原始 Host，并由反代侧的密钥头证明「这个请求确实来自反代」。

**Vessel 侧**（`vessel.yaml`，不含密钥）：

```yaml
gateway:
  hostname: 127.0.0.1
  port: 8642
  proxy_secret_env: VESSEL_PROXY_SECRET      # 反代密钥的变量名
auth:
  # 0.60：来源白名单可以并列（线上域名 + 回环）。
  # 只想让公网域名登录就只写这一条；想让本机调试也能登就再加 http://127.0.0.1:8642。
  public_origins:
    - https://egg-rolls.top
  # public_origin: https://egg-rolls.top   # 等价的老写法（单来源），两者同时出现会合并去重
  backends:
    - kind: github_oauth
      client_id: <OAuth App client id>
      client_secret_env: VESSEL_GITHUB_OAUTH_SECRET
      allow_user_ids: [174765587]
```

**反代侧**（nginx 片段，平台 + node 两段都要，登录后浏览器直连的是 node）：

```nginx
server {
  listen 443 ssl http2;
  server_name egg-rolls.top;
  # 1) 必须保留原始 Host；2) 协议只有反代知道，必须显式告知
  location / {
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    # 3) 反代密钥：没有它，平台不把回环 peer 当受信来源
    proxy_set_header X-Vessel-Proxy-Secret <VESSEL_PROXY_SECRET 的值>;
    proxy_pass http://127.0.0.1:8642;
  }
  # node 的 /v1 与 /ws（WebSocket 必须带 Upgrade 头），否则登录后仍然连不上 node
  location /v1/ { proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme;
                  proxy_set_header X-Vessel-Proxy-Secret <同样的值>; proxy_pass http://127.0.0.1:<node 端口>; }
  location /ws    { proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade;
                    proxy_set_header Connection "upgrade"; proxy_set_header Host $host;
                    proxy_set_header X-Forwarded-Proto $scheme;
                    proxy_set_header X-Vessel-Proxy-Secret <同样的值>;
                    proxy_pass http://127.0.0.1:<node 端口>; }
  location /health { proxy_pass http://127.0.0.1:8642; }
}
```

- GitHub OAuth App 的 **Authorization callback URL** 必须是 `https://egg-rolls.top/auth/github/callback`（逐字节，无尾斜杠）——它只能由 `auth.public_origins` 里的某个来源拼出来，代码不会从请求头推导。
- **多个来源时（`auth.public_origins` 并列，例如线上域名 + `http://127.0.0.1:8642`）**：登录页走哪个域名由**受信边缘**决定 —— 用户用哪个域名访问，就用哪个来源拼 `redirect_uri`（回环直连 ⇒ 回环，经反代 ⇒ 反代声明的域名）；`state` 里绑定本次来源，回调落到另一个来源会被直接拒绝。所以每个域名都要在 GitHub OAuth App 里登记回调地址。
- 「伪造 Host 但没带反代密钥」= 403；`X-Forwarded-Proto` 只有在密钥成立时才被采信，所以 https 页面拿到的是 `wss://`。
- 静态资源与 `/auth/*`、`/login` 在鉴权闸之前：即使配了 `gateway.token`，浏览器也能打开登录页；`/platform/rpc` 仍然要 Bearer token 或会话 cookie。
- 只想临时验证：`curl -H 'Host: egg-rolls.top' -H 'X-Forwarded-Proto: https' -H "X-Vessel-Proxy-Secret: <值>" http://127.0.0.1:8642/` 应 200 且 CSP 里是 `wss://egg-rolls.top`；去掉密钥头应 403。
- 回滚：删掉 `auth` 块 + 反代的 `X-Vessel-Proxy-Secret`/`X-Forwarded-*`，行为立即回到 0.55（回环可用），不需要改代码。

## 11. 0.57：产物变更推送（`/web/build/events`，SSE）与反代缓冲

平台会用一条 **SSE 长连接**（`GET /web/build/events`）把「Web 产物变了」推给浏览器：
产物重建 / 变成「源码比产物新」时，服务端在 5 秒内推一帧 `/build.json` 的内容（含
`stale` / `newestSource`），前端据此在顶部提示。`/build.json` 仍是唯一事实源 ——
推送断了、被缓冲住、或连接数满（上限 32 条，超了回 503），前端会**自动退回**
自适应轮询（10s → 30s → 60s，连续失败到上限就停）。

**反代必须关掉缓冲**，否则 SSE 帧会被攒在反代里、事件不即时（表现：提示要等到
连接结束才出现，或者干脆不出现）：

```nginx
  # SSE：产物变更推送。缓冲一开，帧就不再即时。
  location /web/build/events {
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Vessel-Proxy-Secret <VESSEL_PROXY_SECRET 的值>;
    proxy_buffering     off;     # 关键：否则事件攒到连接结束才到
    proxy_cache         off;
    proxy_read_timeout  1h;     # 空闲连接有 25s 心跳，别让它被读超时掐掉
    proxy_pass http://127.0.0.1:8642;
  }
```

- 平台侧已发 `X-Accel-Buffering: no` 与 `Cache-Control: no-store, no-transform`，nginx
  会据此不缓冲；但**显式写 `proxy_buffering off` 才是确定行为**（别的反代/CDN 不一定认这个头）。
- **鉴权用 cookie，不要把 token 放进 URL**：`EventSource` 带不了 `Authorization` 头，所以这条
  通道认「会话 cookie（登录后同源自动带）+ 回环 / Bearer」。token-in-URL 会落进反代日志
  与浏览器历史，这条通道**不接受**它（`/v1/events` 的 token 例外仅限那一个端点）。
- 没配登录后端（`authEnabled:false`）的部署：这条通道与 `/build.json`、静态站点同等开放
  （匿名可读），它不比静态文件多泄漏任何东西。
- 自检：`curl -N -H 'Host: egg-rolls.top' -H 'X-Vessel-Proxy-Secret: <值>' http://127.0.0.1:8642/web/build/events`
  应立即看到 `retry: 5000` 与一帧 `data: {...}`，之后每 25s 一行 `: ping`。

## 12. 远程停（Q4-C，2026-11-23：`vessel stop --connect`）

- **形态**：CLI **直连**平台 `/platform/rpc` 的 `gateway.shutdown`（params `{}` → `{stopping:true}`
  只受理），不经浏览器→node 代理。代理 DENIED 闸门**零改动**：经代理转发 `gateway.shutdown`
  到 node 仍 403；平台 RPC 绝不透传 node。
- **三重闸（fail-closed）**：`gateway.remote_shutdown: true`（opt-in，缺省 false）+ 平台 token
  （`gateway.token` / `gateway.token_env` 的值，恒要求；回环匿名 / 浏览器会话 cookie 一律拒）
  + **已配置**反代共享密钥且头匹配（`proxy_secret_env`；TLS 在反代终结，平台保持回环）。
  非回环而未配置反代密钥 ⇒ 一律拒（防「opt-in = 裸公网停」误配）。回环判定用原始 socket 地址
  与「经已配置反代」两个信号，不用合取后的 auth.loopback（否则经反代的远程会被判成回环绕过 opt-in）。
- **等死确认**：停止方轮询 `platform.health.get` 至请求失败（不再可达）≤ `--timeout`；措辞是
  「平台已不可达（shutdown 已受理）」，**不声称进程已死**（反代自身故障不可区分）。超时如实 exit 1。
- **远程不强杀**（生命周期强杀恒本机）；未开 opt-in → 401 `remote_shutdown_disabled` → 提示
  **SSH 到主机跑 `vessel stop`**（零实体兜底）。
- 本机停止不受 `remote_shutdown` 影响；平台优雅路径同时关闭 Windows owned engine 孤儿缺口
  （见 [GATEWAY.md §4](GATEWAY.md)）；配置键见 [CONFIG.md §2.20.1](CONFIG.md)。



