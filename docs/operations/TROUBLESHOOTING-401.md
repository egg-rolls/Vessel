---
title: 数据面 401 分流（两种来源，一眼定案）
kind: current
triggers: [401, 401 Unauthorized, session_required, unauthorized, Missing or invalid token, 会话, cookie, 登录, 数据面, 直连, 8644, 8642, node 端口, host]
paths: [packages/serve/src/gateway.ts, packages/serve/src/gateway/auth.ts, src/serve-auth.ts, packages/serve/src/platform/auth.ts, packages/serve/src/platform/server.ts, packages/serve/src/platform/rpc.ts, packages/serve/src/platform/proxy.ts, packages/serve/src/auth/routes.ts, packages/serve/src/auth/session.ts, packages/config/src/validator.ts]
---

# 数据面 401 分流

> 适用：`auth.backends` 非空（启用了 WebUI 登录）的部署里，页面上某个 RPC 报 401。
> **结论只有两种**，看「请求 URL」+「响应体」就能分流，不必先怀疑服务端鉴权。
> 端口号是缺省值，按自己的配置替换。

## 1. 分流判据（用户侧一眼定案）

| 请求 URL | 响应体（关键词） | 含义 | 处置 |
|---|---|---|---|
| 直接指向 node API 端口，形如 `…:8644/v1/rpc` | `unauthorized` / `Missing or invalid token` | 浏览器在**直连 node**（direct mode）。node 只认 node token，浏览器的会话 cookie 在那里完全无效。 | **刷新页面/换新标签页**到当前产物：入口会自动变成 `<platform origin>/nodes/<node_id>/…` 前缀，这类 401 随之消失。刷新后仍直连 ⇒ 看 §5 第 1 条。 |
| 指向平台并带 `/nodes/<node_id>/` 前缀，形如 `…:8642/nodes/<id>/v1/rpc` | `session_required` | 这条路径是对的，但**会话不在当前 host**（登录在另一个 origin，或已过期）。 | 在**当前这个来源**打开 `<platform origin>/login` 重新登录（别换 origin 登录）。 |
| `<platform origin>/platform/rpc` | `session_required` 或 `platform_token_required` | 同上（会话缺失），或者试图在浏览器里使用 CLI 专用端点。 | 同上；`platform.nodes.credentials` 只发给持平台 token 的客户端。 |

一句话记法：**`Missing or invalid token` = 找错了门；`session_required` = 门对了但没带钥匙。**

## 2. 三个端口各管什么

| 端口（缺省） | 谁在听 | 它服务什么 | 它**不**服务什么 |
|---|---|---|---|
| 8642 平台网关 | 平台进程 | WebUI 静态产物、`/build.json`、`/auth/*`（登录）、`/platform/rpc`（平台 API）、`/nodes/<node_id>/**`（**数据面代理**，node token 由网关注入、不出网关） | —— 浏览器需要的一切都在这里（包括数据面） |
| 8643 Hub | hub 进程 | 节点目录与事件（`/v1/hub/*`），供平台发现节点、供 CLI 使用 | 不提供 WebUI |
| 8644 Node API | node 进程 | `/v1/rpc`、`/v1/events`（WS）、`/health`；鉴权用 **node token**（CLI / 自动化） | **不服务页面**（`GET /` 是 404 JSON），**不认**浏览器会话 cookie |

**所以 node API 端口不是 UI 入口**：在浏览器里打开它只会看到一段 404 JSON。WebUI 的正确入口是平台端口（回环部署也一样），数据面则一律走平台的 `/nodes/<node_id>/` 前缀。

## 3. 会话 cookie 按 host 区分

会话 cookie 不区分端口，但**区分 host**：`127.0.0.1`、`localhost`、公网域名是**三个不同的会话域**。

在 A 登录、在 B 打开页面 ⇒ 每一个数据面请求都是 `session_required`，表现就是「明明登录过，却突然全部 401」。切换 origin（尤其在做回环 ↔ 域名、http ↔ https 的对照时）之前，先想清楚「我是在哪个 host 登录的」。

## 4. 应访问的入口（描述式）

- **WebUI**：`<platform origin>`（缺省回环部署即 `http://127.0.0.1:8642`，不是 node 端口）。
- **登录**：`<platform origin>/login`。
- **数据面**：`<platform origin>/nodes/<node_id>/v1/rpc`、`<platform origin>/nodes/<node_id>/v1/events`。
  `<node_id>` 由 `platform.nodes.list` 给出，页面连接信息里也能看到。
- **node token**：只给 CLI / 自动化用，浏览器永远不需要它（代理模式下它不出网关）。

## 5. 常见误判

1. **「刷新没用，还是 401」**：先确认页面拿到的是**当前产物** —— `/build.json` 的 `builtAt` / `commit` 与仓库当前提交对不上，就说明标签页还是升级前的旧产物。旧产物里可能**没有**平台代理（`/nodes/` 前缀）这个能力，于是它永远直连 node 端口。这种情况**换新标签页/重新打开**即可自愈：入口会自动变成 `/nodes/<id>/…`。
2. **「刷新后仍直连 node 端口」**：说明平台代理被关掉了（`gateway.proxy_nodes: false`）。关掉代理是支持的老形态，但代价是浏览器拿不到 node token（`platform.nodes.credentials` 只发给持平台 token 的客户端），只能在连接设置里手工粘平台 token。**这种组合 `config validate` 会给一条告警**。
3. **「127.0.0.1 应该免登录」**：启用登录后，回环地址**不再**自动免登录（这是有意的收紧：同机反代下「回环」无法证明「本机用户」）。单机开发若确实要免登录，需要显式开启回环匿名开关（`auth.allow_loopback_anonymous`，缺省关闭）；多人使用或公网暴露的机器不要开。
4. **「`/auth/status` 返回 `authEnabled: true` 是故障」**：那是配置意图（启用了登录），不是故障。它同时也是**公开**端点，未登录可读。
5. **「把 `401` 当成服务端鉴权坏了」**：先看 URL 属于 §1 哪一行。服务端鉴权坏掉的表现通常是**所有**请求（含 `/auth/status`）都异常，而不是只有数据面。

## 6. 相关文档

- [REVERSE-PROXY](REVERSE-PROXY.md)：回环 / 同机反代的信任边界（为什么「回环 = 可信」不成立）。
- [CONFIG](CONFIG.md) §2.21：`http.allowed_origins`（访问控制）与 `auth.public_origins`（`redirect_uri` 来源）的边界。
- [GATEWAY](GATEWAY.md)：端口、启动形态与节点缺席诊断。
