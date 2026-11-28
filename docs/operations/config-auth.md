---
title: WebUI 登录（auth 块）
kind: current
triggers: [auth, 登录, password, TOTP, 恢复码, 引导码, bootstrap, github_oauth, gitee_oauth, microsoft_oauth, 口令, argon2id, 会话, cookie, CSRF, credentials.json, lockout]
paths: [packages/config/src/auth.ts, packages/config/src/auth-strategies/registry.ts, packages/config/src/auth-strategies/password.ts, packages/serve/src/auth/routes.ts]
---

# WebUI 登录（auth 块）

> 登录后端 / 口令 / TOTP / 会话的运维手册。**Origin 白名单与 redirect_uri 来源**见
> [config-origins](config-origins.md)；公网暴露边界见 [REVERSE-PROXY](REVERSE-PROXY.md)。

## 后端：策略注册表（kind 开放取值）

`auth.backends[].kind` 的合法值由登录策略注册表（`auth-strategies/registry.ts`）决定，
不在 types / validator 里枚举：现有 `password` / `github_oauth` / `gitee_oauth` / `microsoft_oauth`；
不写 kind 缺省 `github_oauth`。加 provider = 加一个策略文件 + 注册一行。

```yaml
auth:
  backends:
    - kind: password
      username: admin                          # 单用户，只用于展示与按账户限流
      password_hash_env: VESSEL_PASSWORD_HASH  # 可选：argon2id PHC 串
      totp_secret_env: VESSEL_TOTP_SECRET      # 可选：base32 TOTP 密钥
    - kind: github_oauth                       # gitee_oauth / microsoft_oauth 同形
      client_id: <OAuth App 的 client id>
      client_secret_env: VESSEL_GITHUB_OAUTH_SECRET   # 只写变量名，不写值
      allow_user_ids: [174765587]
  session: { idle_minutes: 30, absolute_hours: 12, persist: true }
```

- **不配 `auth.backends`（或 `enabled: false`）= 功能不存在**：回环照旧可用，前端不出现登录入口。
- `allow_user_ids` 语义**按 kind 走**：github = 数值 user id；microsoft = Graph `/me` 的 GUID
  （大小写不敏感）；gitee = 数值 id 或用户名。email 不作为身份。
- `client_secret` 只从 `client_secret_env` 读（validator 拒绝明文）；OAuth access token 用完即弃：
  不落盘、不进日志、不进错误文案。OAuth 后端必须配 `auth.public_origins`（见 [config-origins](config-origins.md)）。
- 解析器（`auth.ts`）不抛错不读密钥：配置写了一半降级成「未启用登录」+ 告警，不把运维锁在外面。

## 口令后端

- **不生成任何默认口令**。两条合法路径：① 启动日志打印一枚**一次性引导码**（单次 + 10 分钟 TTL），
  打开 `http://127.0.0.1:<port>/#token=<引导码>` 换到设置会话（只能设口令、绑 TOTP）；
  ② 部署给 argon2id hash（`password_hash_env`），生成：
  `bun -e 'console.log(await Bun.password.hash(process.argv[1], { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 }))' '<口令>'`
- hash：**argon2id** `m=64MiB, t=3, p=1`（参数在 PHC 串里）；无 `Bun.password` 的运行时退回 scrypt
  （fail-closed）。明文不落盘、不进日志。
- **限速（双维度）**：每次失败同记 `ip:<addr>` 与 `acct:<用户名>`；第 n 次失败后等
  `min(250ms × 2^(n-1), 8s)`；15 分钟窗口累计 8 次 ⇒ 锁 15 分钟（任一维度锁定即拒绝）。
  状态落 `<dataDir>/auth/lockout.json`，**重启不清锁**。
- **不把自己锁死**：本机回环 + 平台 token 一条命令解锁（429 文案里带着）：
  `curl -fsS -X POST http://127.0.0.1:8642/auth/unlock -H "Authorization: Bearer $(vessel token show --purpose platform --allow-non-interactive)"`
  非回环或没带平台 token ⇒ 403/401。
- 凭据文件 `<dataDir>/auth/credentials.json`（0600）：口令 hash、TOTP base32 密钥、恢复码 sha256、
  已用 TOTP step。

## TOTP 与恢复码

- RFC 6238：HMAC-SHA1 / 6 位 / 30 秒一步；时钟漂移容忍 ±1 步（不提供配置项）。
- 重放：同一步只接受一次；已用 step 持久化，同码二次提交返回 `code_replayed`（重启后仍拒）。
- 恢复码：10 个、一次性、落盘只存 sha256，明文只在签发时返回一次；重复使用 `invalid_code`。

## `#token=` 退场与会话

- URL `#token=` 只作一次性引导码提交 `POST /auth/bootstrap`（`#bootstrap=` 等价）；值不进
  sessionStorage / history。重放已用引导码 ⇒ 409 `bootstrap_replayed` + **撤销它签发的会话**
  （含后代会话）+ 告警日志。之后一律走登录页；平台 token 仍可手动填「连接设置」当 Bearer。
- 会话 cookie `__Host-vessel_sid`（https；http 退化 `vessel_sid`），`HttpOnly; SameSite=Strict; Secure`；
  登录成功轮换 id（防会话固定）；空闲/绝对双超时；登出立即撤销。落盘只写 `sha256(sid)` 与 subject
  （`<dataDir>/auth/sessions.json`），重启后仍有效但需重新取 CSRF。
- CSRF 同步令牌：`GET /auth/status` 返回 `csrfToken`（`no-store`）；变更类请求带 `X-Vessel-CSRF`，
  缺失/不匹配 403。

## 端点

`GET /auth/status|csrf|whoami`、`POST /auth/logout|login|login/totp|bootstrap|password/set|setup/finish|totp/enroll|recovery/rotate|unlock`、
`GET /auth/github/start|callback`（各 OAuth 策略同形）、`GET /login`（SPA 登录页）、`/auth/avatar`（头像代取，SSRF 闸）。
全部只收 `application/json` 且校验 `Origin`；设口令 / 绑 TOTP 另需既有会话的 CSRF 令牌。
静态资源与这些端点在鉴权闸**之前**（配了 `gateway.token` 也能打开登录页）；`POST /platform/rpc`
仍需 Bearer token 或会话。公网部署还需反代保留 Host / 注入 `X-Forwarded-Proto` 与密钥头（见
[REVERSE-PROXY](REVERSE-PROXY.md)）。