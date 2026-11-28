---
title: 反代共享密钥（X-Vessel-Proxy-Secret）
kind: current
triggers: [反代, 反向代理, nginx, proxy_secret, 共享密钥, 回环, loopback, 同机, 威胁模型, X-Forwarded, trusted_proxies, 密钥轮换, 公网]
paths: [packages/serve/src/gateway/auth.ts, packages/serve/src/platform/auth.ts, packages/config/src/gateway.ts, src/hub/server.ts, packages/serve/src/plugin-host/proxy.ts]
---

# 反代共享密钥（X-Vessel-Proxy-Secret）

> 反代与 gateway / node / hub **同机**时，客户端对端地址恒为 `127.0.0.1`，所有「回环 = 本机 = 可信」
> 的判定都失效：peer、Host、Origin 三者都能被同一个反代做成与被信任请求完全一致的样子。
> **唯一能区分「本机直连」与「同机反代转发的公网请求」的机制，是让反代出示共享密钥**。
> 入口凭据矩阵与部署形态清单见 [exposure-hardening](exposure-hardening.md)；密钥的配置键规则见
> [config-secrets](config-secrets.md)。

## 机制（opt-in，未配置 = 旧行为逐字不变）

- 头名 `x-vessel-proxy-secret`（`gateway/auth.ts:PROXY_SECRET_HEADER`）。反代在**每个**转发请求上
  **覆盖注入**（不是追加）该头；客户端自带的同名头必须被反代覆盖掉。
- `gateway/auth.ts:proxySecretAllowed`：未配置（undefined / 空串）→ 恒 `true`；已配置 → 请求必须带
  同值头，比较用定长 SHA-256 哈希 + `timingSafeEqual`（不按字节提前返回）。
- 配置键只存**环境变量名**，不接受内联密钥（validator 强制）：
  `gateway.proxy_secret_env`（平台）/ `node.proxy_secret_env`（node）/ `hub.proxy_secret_env`（hub）。
  三者用途不同，**不要复用同一个值**；解析见 `config/gateway.ts:resolvePlatformProxySecret` /
  `resolveServeProxySecret`。
- 配置后的效果：该监听的「回环信任」必须同时满足「socket 回环 ∧ 密钥头成立」
  （`platform/auth.ts:resolvePlatformAuth`）。**带 Bearer token 的请求语义完全不变**；
  直连 `http://127.0.0.1:<port>` 的匿名请求不再被当作本机（要直连就连同 token 一起配）。
- 插件反代（`plugin-host/proxy.ts`）转发时剥离客户端自带的 `x-vessel-*` 与 `x-forwarded-*` 头，
  密钥不会透给插件。

## 受信边缘（X-Forwarded-* 何时被采信）

`gateway/auth.ts:resolveRequestEdge` 是唯一判定入口：

- `viaProxy` = socket 地址受信 ∧ 密钥头成立。地址受信缺省只认回环；配了 `auth.trusted_proxies`
  （精确地址或前缀）则按该列表判定。
- `X-Forwarded-Host` / `X-Forwarded-Proto` **只有 `viaProxy` 时才被采信**；否则用请求自身的
  Host / 协议。伪造 Host 但没带（或带错）密钥头 ⇒ 拿不到公网身份（403）。
- `proxyProven` = `viaProxy` ∧ **确实配置了**密钥。未配密钥时 `proxySecretAllowed` 恒真，
  `viaProxy` 只是「看起来像代理」的默认假设，不构成证据。
- `localDirect`（本机直连免登录）= `auth.allow_loopback_anonymous: true` ∧ 回环 socket ∧
  未被证明是受信反代 ∧ Host 指回环；缺省关闭（见 [config-origins](config-origins.md)）。
- https 页面经反代拿到 `wss://` CSP，正是因为 `X-Forwarded-Proto: https` 在密钥成立时被采信。

## 多机部署怎么配

- 每台被反代的前端各生成一个随机串（`openssl rand -hex 32`），只存进**该机**反代配置与该机
  Vessel 服务的环境（`systemd Environment=` / `env_file`）；密钥不跨机复用。
- 反代侧（nginx，对 `/platform/`、`/v1/`、`/ws`、`/web/build/events` 全部 location）：

  ```nginx
  proxy_set_header X-Vessel-Proxy-Secret $vessel_proxy_secret;   # 覆盖，不是追加
  ```

- Vessel 侧：

  ```yaml
  gateway:
    proxy_secret_env: VESSEL_PLATFORM_PROXY_SECRET
  node:
    proxy_secret_env: VESSEL_NODE_PROXY_SECRET
  hub:
    proxy_secret_env: VESSEL_HUB_PROXY_SECRET
  ```

- 跨机 node（node 在另一台、经它的反代访问）各自独立配置。hub 出站（node 主动连 hub）不需要
  密钥头——那条链由 node token 认证。
- 本机 CLI 不受影响：`vessel hub directory` / `hub node remove` 会从 `hub.proxy_secret_env`
  指向的**同一个环境变量**读值并自带该头（`hub-command.ts:resolveHubProxySecret`），不经过反代也能用；
  只有「经反代进来又没带头」的请求被拒。

## 密钥轮换（手工 env）

平台 token、反代密钥、hub 密钥都是「环境变量里的值」；轮换 = 换值 + 重启相关进程。

1. 生成新值：`openssl rand -hex 32`（不同用途各一份，不复用）。
2. 更新来源：改 `systemd Environment=` / `env_file` / shell `export`；**不要写进 YAML**
   （配置键只存变量名）。
3. 平台 token：更新 `gateway.token_env` 指向的变量后重启平台；浏览器需重新导入
   （连接设置粘贴，或一次性引导码，见 [config-auth](config-auth.md)）。
4. 反代密钥（`node.proxy_secret_env` / `hub.proxy_secret_env`）：Vessel 侧环境与反代侧注入值
   **必须同时**切换。顺序建议：先把新值写进 Vessel 环境并重启 → 再改反代注入值并
   `nginx -s reload`（中间短暂 401，在维护窗口做）。
5. node token：`node.token_env` 换值后重启 node；平台重新下发新值，旧值立即被拒。
6. 自检：`vessel doctor` + 页面能连；`curl` 旧 token 应 401。

## 自检（只写不跑）

```bash
# 带密钥头应 200；去掉密钥头应 403（配了 gateway.proxy_secret_env 时）
curl -s -H 'Host: <公网域名>' -H 'X-Forwarded-Proto: https' \
  -H "X-Vessel-Proxy-Secret: <值>" http://127.0.0.1:8642/health
```

不做的事：mTLS / 自动铸造与轮换命令（当前手工 env）。`X-Forwarded-*` 永远不能作为独立信任来源——
客户端可伪造，只有反代密钥成立时才被采信。