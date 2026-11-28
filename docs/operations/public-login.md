---
title: 公网域名 + WebUI 登录部署（GitHub OAuth）
kind: current
triggers: [公网, 域名, 登录, GitHub, OAuth, public_origins, redirect_uri, callback, 回调, state, nginx, Host, 反代, egg-rolls]
paths: [packages/serve/src/auth/origins.ts, packages/serve/src/auth/oauth.ts, packages/serve/src/auth/github-oauth.ts, packages/config/src/auth-origins.ts]
---

# 公网域名 + WebUI 登录部署（GitHub OAuth）

> 域名访问（如 `https://egg-rolls.top`）不是「回环才行」的特例：平台仍绑 `127.0.0.1`，
> 由反代**保留原始 Host**，并由反代密钥头证明「请求确实来自反代」（机制见
> [proxy-secret](proxy-secret.md)）。`auth` 配置键详见 [config-origins](config-origins.md)
> 与 [config-auth](config-auth.md)。

## Vessel 侧（不含密钥）

```yaml
gateway:
  hostname: 127.0.0.1
  port: 8642
  proxy_secret_env: VESSEL_PROXY_SECRET      # 反代密钥的变量名
auth:
  public_origins:                            # 并列白名单（不是通配）
    - https://egg-rolls.top
    # - http://127.0.0.1:8642                # 想让本机调试也能登就再加一条
  backends:
    - kind: github_oauth
      client_id: <OAuth App client id>
      client_secret_env: VESSEL_GITHUB_OAUTH_SECRET
      allow_user_ids: [<GitHub 用户 id>]
```

- `public_origin`（单来源）与 `public_origins` 语义等价，两者同时出现合并去重
  （`platform/server.ts:resolvePlatformPublicOrigins`）。
- 每条必须是裸 origin（scheme + host[:port]，无路径 / 尾斜杠 / 默认端口）；非 https 只允许
  回环 / 私网地址；**端口通配（`host:*`）只进 `http.allowed_origins`，永不进 `public_origins`**
  （`redirect_uri` 需要具体 origin）。

## 来源选择与 state 绑定（auth/origins.ts 三条红线）

1. **不按裸 Host 头选来源**：只用受信边缘事实（`resolveRequestEdge`）——socket 受信 ∧ 反代密钥
   成立时 `X-Forwarded-Host` / `X-Forwarded-Proto` 才被采信。伪造 Host 拿不到白名单里的公网身份。
2. **选择结果必须来自白名单**：`selectPublicOrigin` 只原样返回白名单里的字符串，永不拼接。
   单来源 ⇒ 就是它（与请求无关）；多来源 ⇒ 取生效 Host 相同的那条（同 Host 双协议按生效协议挑，
   歧义 fail-closed）；Host 对不上 ⇒ 仅本机直连（`edge.localDirect`）时退回白名单里的回环来源，
   否则拒绝。
3. **state 绑定本次来源**：发起时选中的来源写进在途流程，回调时用同一套边缘判定再选一次，
   两者必须相同——回调落到另一个来源直接拒绝（防开放重定向）。

## GitHub OAuth App 登记

- **Authorization callback URL** 必须是 `https://<origin>/auth/github/callback`（逐字节，无尾斜杠）；
  它只能由 `auth.public_origins` 里的某个来源拼出，代码不从请求头推导。
- 多来源并列时**每个域名都要登记**回调地址：用户用哪个域名访问，就用哪个来源拼 `redirect_uri`
  （回环直连 ⇒ 回环，经反代 ⇒ 反代声明的域名）。

## 反代侧（nginx）

```nginx
server {
  listen 443 ssl http2;
  server_name egg-rolls.top;
  location / {
    proxy_set_header Host              $host;      # 必须保留原始 Host
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Proto $scheme;    # 协议只有反代知道
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Vessel-Proxy-Secret <VESSEL_PROXY_SECRET 的值>;
    proxy_pass http://127.0.0.1:8642;
  }
  # /web/build/events 的 location 要同样注入上述头 + proxy_buffering off，见 build-events-sse.md
  location /health { proxy_pass http://127.0.0.1:8642; }
}
```

- **缺省只需转发平台端口**：`gateway.proxy_nodes` 缺省开，浏览器数据面走平台 `/nodes/<id>/`
  代理（见 [web-console-deploy](web-console-deploy.md)）。只有 `gateway.proxy_nodes: false`
  回退直连时才需要为 node 的 `/v1/` 与 `/ws` 另开 location（WS 必须带 Upgrade 头）。
- 「伪造 Host 但没带反代密钥」= 403；`X-Forwarded-Proto` 只在密钥成立时被采信，https 页面
  拿到 `wss://` CSP。
- 静态资源与 `/auth/*`、`/login` 在鉴权闸**之前**：即使配了 `gateway.token`，浏览器也能打开
  登录页；`/platform/rpc` 仍要 Bearer token 或会话 cookie。
- 启用登录后回环**不免登录**；单机开发要免登录需显式 `auth.allow_loopback_anonymous: true`
  （见 [config-origins](config-origins.md)）。

## 自检（只写不跑）

```bash
curl -s -H 'Host: egg-rolls.top' -H 'X-Forwarded-Proto: https' \
  -H "X-Vessel-Proxy-Secret: <值>" http://127.0.0.1:8642/
# 应 200 且 CSP 里是 wss://egg-rolls.top；去掉密钥头应 403
```

会话生命周期（空闲 30 分钟滑动 / 绝对 12 小时、落盘只存 sha256）见 [config-auth](config-auth.md)。