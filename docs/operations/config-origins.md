---
title: Origin 白名单与访问控制
kind: current
triggers: [public_origins, public_origin, allowed_origins, http.allowed_origins, redirect_uri, Origin, CORS, 回环, loopback, allow_loopback_anonymous, 受信边缘, trusted_proxies, 端口通配, 免登录]
paths: [packages/config/src/auth-origins.ts, packages/config/src/validator.ts, packages/serve/src/gateway/auth.ts, packages/serve/src/auth/origins.ts]
---

# Origin 白名单与访问控制

> `auth.public_origins`（回跳来源）与 `http.allowed_origins`（访问控制）的运维手册。
> 登录后端见 [config-auth](config-auth.md)；反代边界见 [REVERSE-PROXY](REVERSE-PROXY.md)。

## 两件事，别再混

| 键 | 回答的问题 | 允许通配？ |
|---|---|---|
| `auth.public_origins` | 登录**回跳**到哪个 origin（`redirect_uri` 的来源） | **不允许**（必须具体 origin） |
| `http.allowed_origins` | **浏览器能不能发 RPC**（Origin 白名单 + CORS） | 允许，但只限回环 host 的端口通配 |

`http.allowed_origins` **不给 OAuth 提供 redirect_uri**：配了 OAuth 后端仍必须有
`auth.public_origins`，缺了 `config validate` 直接报
`auth.publicOrigins (or auth.publicOrigin) is required when an OAuth backend is configured`；
只有口令后端可以只靠 `http.allowed_origins`（OAuth 后端降级并留告警）。

## `auth.public_origins` 形状与选择

- 数组，每项必须是**完整具体 origin**（`scheme://host[:port]`，无路径/尾斜杠/默认端口/凭据）。
  缺 scheme、带路径、尾斜杠都直接拒绝并给正确写法示例。**端口通配（`http://127.0.0.1:*`）也拒绝**
  （`auth-origins.ts`：通配只属于 `http.allowed_origins`）。
- 非 https 只有 **loopback / 私网**（`localhost`、`127.0.0.0/8`、`::1`、`10.x`、`172.16–31.x`、
  `192.168.x`、`169.254.x`、`fc00::/7`、`fe80::/10`）可用 `http://`；公网明文是错误。
- `public_origin` 保留不废弃 = 单元素 `public_origins`；两者并存**合并去重**（前者在前），不报错。
- **来源只由受信边缘决定**（`packages/serve/src/gateway/auth.ts:resolveRequestEdge`），绝不按 Host 头选：
  1. socket 属受信代理（回环或 `trusted_proxies`）**且**反代密钥（`gateway.proxy_secret_env`）成立，
     `X-Forwarded-Host/Proto` 才被采信；否则用请求自身；
  2. 生效 Host 去白名单取**同一 Host** 的条目（scheme 不同按生效协议挑；挑不出唯一一条 ⇒ 拒绝）；
  3. 白名单只有一条就是它；一条都没配 ⇒ 不启用公网来源，OAuth 后端降级告警；
  4. 本机直连（回环 socket ∧ 未受信反代 ∧ Host 回环）且 Host 对不上任何条目 ⇒ 退回白名单里的回环来源。
- **两条安全红线**：① `redirect_uri` 只能由「选中来源 + 固定路径 callback」拼出，拼好后不受任何
  请求参数影响；② **state 绑定本次来源**：start 把来源与 redirect_uri 写进在途流程，callback 用同一套
  受信边缘判定再选一次，必须等于 state 里那个且仍在白名单内，否则拒绝（`state_invalid`）。
- 多来源 ⇒ OAuth App 里每个域名的回调地址都要登记（GitHub 允许一个 App 多个 callback URL）。

## `http.allowed_origins`

```yaml
http:
  allowed_origins:
    - http://127.0.0.1:*      # 回环端口通配；三个回环别名是三个 Origin，逐个别名写
    - http://localhost:*
    - http://[::1]:*
    - https://egg-rolls.top
```

- **生效集合 = 并集，不可收窄**：`gateway.allowed_origins` ∪ `auth.public_origins` ∪
  `http.allowed_origins`。前两者永远生效；`http.allowed_origins` 只能往上加，没有「只允许这些」模式。
- 不写 `http:` 块 = 回落 `auth.public_origins` + 三条回环通配（老配置一字不改本机任意端口可用）；
  **显式写了就是它自己**（不再自动补回环通配）；写 `[]` 也不会挡掉 `public_origins`。
- 非通配条目与 `public_origins` 完全同一套判定；**端口通配只在这里合法**且 `:*` 只能给回环 host
  （公网/私网通配、端口+通配自相矛盾都拒绝）。通配匹配该 hostname 任意端口**含默认端口**，
  但**不跨别名**（`localhost` 不命中 `127.0.0.1:*`）。
- **与凭据的关系**：Bearer 校验通过 ⇒ 跳过 Origin 白名单（浏览器不会自动附加 Authorization，
  不是 CSRF 面）；**cookie 会话路径永远过白名单**，变更类另需 `x-vessel-csrf`——两道独立的闸；
  「受信反代」豁免按反代密钥判定，不按回环 socket。
- **CORS**：命中白名单（含通配）回显该请求 Origin（绝不 `*`）+ `Vary: Origin`；
  `Access-Control-Allow-Credentials: true` 只在 cookie 会话路径（平台）给出，node 侧不给；
  预检允许头含 `Authorization` 与 `X-Vessel-CSRF`。

## `auth.allow_loopback_anonymous`（缺省 false）

只回答「这个请求要不要**身份**」：`true` 时「回环 socket + 回环 Host + 未被证明是受信反代」算
本机直连（`edge.localDirect`），平台数据面（`/platform/rpc`、`/nodes/**`）不再要求登录；
否则配了登录后端就 `401 session_required`。

| 事实 | `localDirect` |
|---|---|
| 缺省 / `false` | 恒 false |
| `true` + 回环 socket + 回环 Host + 没配反代密钥 | true |
| `true` + 反代密钥配了且带对（`X-Forwarded-Host` 生效） | false（按反代路径走） |
| `true` + 非回环 socket / Host | false |

- **代价**：同机任何进程都能不经登录读写数据面。单机开发可接受；共享机/公网不要开
  （开启时 `config validate` / 启动校验出 warning 复述）。
- 救不了「配了反代密钥却没带对」的请求（数据面要求 `proxySecretOk`，`401 platform_unauthorized`）。
- 与 Origin 白名单/CSRF 闸**无关**：那些闸照旧逐条生效。顺带救活「本机用 localhost 访问、
  白名单只写 127.0.0.1」的 redirect_uri 回退格（回退值仍是白名单原值）。