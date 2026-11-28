---
title: 暴露面收紧：入口凭据矩阵与部署自检
kind: current
triggers: [暴露, 收紧, fail-closed, platform_listen_insecure, credentials, doctor, exposure, 非回环, 0.0.0.0, 匿名, admin, 部署形态, 升级]
paths: [packages/serve/src/platform/listen-guard.ts, packages/serve/src/platform/rpc.ts, src/cli/commands/doctor-command.ts, src/gateway/serve-auth.ts]
---

# 暴露面收紧：入口凭据矩阵与部署自检

> 同机反代使「回环 = 本机」失效（威胁模型与密钥机制见 [proxy-secret](proxy-secret.md)）。
> 本文是三个入口的**现态凭据要求**与部署自检清单；配置键规则见
> [config-secrets](config-secrets.md)，401 分流见 [TROUBLESHOOTING-401](TROUBLESHOOTING-401.md)。

## 入口凭据矩阵（现态）

| 入口 | 非回环 | 回环 |
|---|---|---|
| 平台 | 无显式 `gateway.token` ⇒ **拒绝启动**（`platform_listen_insecure`）；配了 token 则 Bearer 恒要求 | 未显式配 token（用派生值）⇒ 匿名只读可用；**显式**配了 token ⇒ 回环也要 Bearer |
| node | `allow_remote: true` + token（显式或派生）+ TLS，缺一启动失败 | 无显式 token ⇒ 无凭据请求 = anonymous admin（HTTP 与 WS 首帧同）；配了 `node.proxy_secret_env` 后无凭据请求必须带密钥头 |
| hub | `hub.allow_remote: true` + TLS + `hub.token_env` | 回环 peer 视为已授权；配了 `hub.proxy_secret_env` 后目录 / WS 目录流 / 删节点必须带密钥头 |

- 平台 fail-closed：`platform/listen-guard.ts:platformListenGuard`（`startPlatformGateway` 与 CLI
  预检双处判定）。报错文案直接给出两种修法（改回环 / 配 `gateway.token_env`）。
  `gateway restart` 会先拒绝、旧实例保持运行。
- 派生 token 不算「显式配置」：用户什么都没写时不收紧回环（迁移安全）；远程则必须出示派生值
  （`platform/auth.ts:resolvePlatformAuth` 的 `explicitPlatformToken` 分支；派生规则见
  [config-secrets](config-secrets.md)）。
- 平台 token 必须与 node token 不同值（`checkPlatformTokenConflict` 拦截）。
- node 匿名判定：`src/gateway/serve-auth.ts`（`configured` = 有显式凭据才关闭回环匿名；
  派生值只作追加凭据）。

## `platform.nodes.credentials` 闸（现态）

`platform/rpc.ts`（case `platform.nodes.credentials`）：

- **代理开启**（`gateway.proxy_nodes` 缺省 true）：必须 `mode === 'token'`（平台 Bearer），
  回环 socket 不再构成理由——浏览器走 `/nodes/<node_id>/` 代理，不需要也不应该拿 node token。
- **代理关闭**（`gateway.proxy_nodes: false`）：保持旧行为，含「未显式配置 token ⇒ 回环放行」
  的迁移豁免。
- 只读接口（`platform.nodes.list` / `nodes.get` / `whoami`）不受本闸影响：回环（配了反代密钥时
  带密钥头）仍可匿名调用。不配 token 页面也能列节点，只是拿不到 node 连接。
- 使用方（代理开启时）：`vessel token show --purpose node`、`doctor --deep`、federation / 运维脚本。
- 401 文案区分「缺反代密钥」（`proxy_secret_missing`）与「缺平台 token」（`platform_token_required`）。

## 部署形态清单（对号入座）

| 形态 | 需要做什么 |
|---|---|
| 纯本机（浏览器直开 `http://127.0.0.1:8642`，无反代） | 平台照常启动。代理缺省开，浏览器经平台连 node，无需任何 token；启用登录后回环不免登录（`auth.allow_loopback_anonymous` 缺省 false，见 [config-origins](config-origins.md)） |
| 同机反代 + 公网/内网 | 平台绑回环 + `gateway.proxy_secret_env` + 反代覆盖注入密钥头（[proxy-secret](proxy-secret.md)）；公网域名登录见 [public-login](public-login.md) |
| 平台绑 `0.0.0.0` / 网卡 IP | 必须配 `gateway.token_env`，否则起步被拒（有意）；推荐改回环让同机反代转发 |
| 多机（每台一个 node） | 每台单独配密钥与 token，不跨机复用；node 远程暴露见 [remote-connect](remote-connect.md) / [remote-tls](remote-tls.md) |

浏览器导入平台 token：连接设置里粘贴（只存 `sessionStorage`）；`#token=` 是**一次性引导码**
（单次 + 10 分钟 TTL），不是长期 token 导入方式（见 [config-auth](config-auth.md)）。
脚本打 `/platform/rpc` 带 `Authorization: Bearer <平台 token>`；只拿 node token 的旧脚本会 401。

## `vessel doctor` 自检（只提示，不改运行语义）

- `tokens` 行：各用途凭据来源 + 指纹（`node:<id>=derived fp=xxxxxxxx` 形式；派生值远程需带、
  回环匿名仍可用）。
- `exposure` 行：把「回环监听 + 无**显式**凭据」的面列出来（node / 平台 / hub 三面），
  状态为 `info`；三面都有显式 token 或反代密钥时输出
  `loopback listeners have an explicit token or proxy secret`（`ok`）。
- 纯本机、确认无反代也无其他本机进程时可按需忽略；它不阻止启动。

```bash
vessel doctor            # tokens / exposure 行
vessel gateway status    # 平台在哪、是否在跑
curl -s http://127.0.0.1:8642/health
```