---
title: Web 控制台部署（独立前端 / 平台同源 / 代理数据面）
kind: current
triggers: [前端, 控制台, 静态站点, dist, 部署, CSP, connect-src, allowed_origins, gateway-url, sessionStorage, 代理, proxy_nodes, locale, 语言]
paths: [packages/serve/src/platform/proxy-config.ts, apps/web/src/gateway/url.ts, apps/web/src/gateway/connection-initial.ts]
---

# Web 控制台部署（独立前端 / 平台同源 / 代理数据面）

> 缺省形态：平台同源托管 `apps/web/dist`，浏览器**只连平台端口**，数据面经平台代理
> `/nodes/<node_id>/**`（node token 不出网关）。代理策略与上限的事实家：
> [config-gateway](config-gateway.md) / [topology](../architecture/topology.md)；401 分流见
> [TROUBLESHOOTING-401](TROUBLESHOOTING-401.md)。本文是部署与验证操作。

## 构建与同源托管（缺省）

```bash
cd apps/web && npm ci && npm run build    # 产物在 apps/web/dist
```

平台同源托管 `dist` 时**不需要** `allowed_origins`，CSP 由平台按 Host / allowlist 生成。
产物目录可配（`gateway.web_dist`，金丝雀跨 cwd 场景）见 [config-gateway](config-gateway.md)。
产物变更推送与反代缓冲见 [build-events-sse](build-events-sse.md)。

## 独立静态站点部署

把 `dist/` 部署到任意静态站点（如 `https://console.example.com`），然后：

1. **加 Origin**：浏览器直连 node 时改 `node.allowed_origins`；页面由平台托管时改
   `gateway.allowed_origins`（或启动时重复 `--allowed-origin https://console.example.com`）。
   访问控制与 `redirect_uri` 来源的边界见 [config-origins](config-origins.md)。
2. **信任证书**：自签 CA 装入系统 / 浏览器信任库（见 [remote-tls](remote-tls.md)）。
3. **设置平台地址**：`localStorage['vessel.gateway-url']` > 同源（空串）；只接受
   `scheme://host[:port]`（拒 path / query / wildcard），非回环必须 https，HTTPS 页面拒 http
   （mixed content）。**构建期 `VITE_GATEWAY_URL` 不再参与**；代理模式强制同源
   （`gateway/url.ts` / `connection-initial.ts`）。
4. **首次凭据**：连接设置里粘贴平台 / node token（只存 `sessionStorage`，不写 localStorage /
   query）；配了 `auth.backends` 的部署走登录页；`#token=` / `#bootstrap=` 是一次性引导码
   （见 [config-auth](config-auth.md)）。
5. **自行下发 CSP**，至少允许连接目标：

   ```text
   connect-src 'self' https://node-b.example.com:8644 wss://node-b.example.com:8644
   ```

界面语言：Web 壳层 zh-CN / en；初始 `localStorage['vessel.ui.language']` > `navigator.language`
（`en*` → en，其余 zh-CN），Settings → Appearance 切换立即生效；语言存本地，不影响 gateway。

## 平台代理数据面（缺省开）验证

注册进平台的 node 默认由平台代理：浏览器 ─平台会话（cookie / 平台 token）─▶
`/nodes/<node_id>/**` ─Bearer node token─▶ node `/v1/**`。`node_id` 只从注册表解析，
客户端不能指定 host/port；node token 永不出现在响应体 / 浏览器存储 / URL。

```bash
# 浏览器网络面板里应当只有平台端口的请求（只写不跑）
curl -s http://127.0.0.1:8642/nodes/<node_id>/health
curl -s -X POST http://127.0.0.1:8642/nodes/<node_id>/v1/rpc \
  -H 'content-type: application/json' \
  -d '{"v":1,"id":"1","method":"sessions.list","params":{}}'
```

- 路径 / 方法白名单、请求体 / 并发 / WS 水位上限、失败码（502 / 504 / 503 / 403）与
  `gateway.ws.closed {via:'proxy'}` 记账：见 [config-gateway](config-gateway.md)（`proxy-config.ts`
  `DEFAULT_PLATFORM_PROXY_LIMITS` 唯一来源）。
- **回退开关** `gateway.proxy_nodes: false`：平台不提供 `/nodes/*`，前端据
  `platform.whoami.proxy.enabled === false` 回到「取 credentials 直连 node」老路径
  （node token 交回浏览器，只用于本机调试；与启用登录组合会收到 config validate 告警）。
- `platform.nodes.credentials` 在代理开启时降级为 CLI 专用（必须平台 token）；使用方：
  `vessel token show --purpose node`、`doctor --deep`、federation / 运维脚本、回退老前端。
  闸的现态见 [exposure-hardening](exposure-hardening.md)。
- 反代只需转发平台端口；公网域名 + 登录部署见 [public-login](public-login.md)。