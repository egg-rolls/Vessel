---
title: 跨机器远程运维（指针页）
kind: guide
triggers: [远程, 远程运维, 远程访问, 跨机器, 多机部署, 证书, CA, TLS, 令牌, 非回环, hub, 联邦, 出站, 前端]
children: [remote-connect.md, remote-tls.md, web-console-deploy.md, hub-ops.md]
---

# 跨机器远程运维（指针页）

> 本页只导航，不落事实。原 REMOTE 长文已按主题拆为下列窄叶。
> 缺省行为：平台绑 `127.0.0.1:8642`、Node API 绑 `127.0.0.1:8644`、明文；远程与 Hub 出站
> 都必须显式 opt-in（事实见各叶）。

| 叶子 | 回答什么 |
|---|---|
| [remote-connect](remote-connect.md) | 安全边界（fail-closed）、两机配置、`--connect` 客户端、派生 token、token 词表、远程权限交互、验证与排障 |
| [remote-tls](remote-tls.md) | 服务端证书（SAN / 自签 / 0600）、客户端 CA（`--ca` / 浏览器信任库）、TLS 排障、改证书必须 restart |
| [web-console-deploy](web-console-deploy.md) | Web 控制台构建与部署：同源托管 / 独立静态站点 / CSP / 平台代理数据面验证与回退开关 |
| [hub-ops](hub-ops.md) | Hub 独立进程命令面（join-code / join / directory / node remove）、文件布局、一 node 一 hub、NAT 数据面、吊销 |

## 旧章节去向（供既有入链定位）

- 原 §1 / §3.1–§3.2 / §3.5 / §3.5.1 / §5–§7 → [remote-connect](remote-connect.md)（TLS 行 → [remote-tls](remote-tls.md)）
- 原 §2（证书与 CA）→ [remote-tls](remote-tls.md)
- 原 §3.3（跨节点传输已删除）→ [architecture/gateway.md](../architecture/gateway.md#remote)；federation 寻址（原 §3.3.1）→ [federation-hub](../architecture/federation-hub.md)
- 原 §3.4（生命周期与热重载命令）→ [GATEWAY](GATEWAY.md) / [CONFIG §4.1](CONFIG.md)
- 原 §3.6（Hub 控制面）→ [hub-ops](hub-ops.md)（协议事实家 [federation-hub](../architecture/federation-hub.md)）
- 原 §4 / §4.1（独立前端 / 平台代理）→ [web-console-deploy](web-console-deploy.md)

## 相邻文档

- 同机反代 / 公网暴露：[REVERSE-PROXY](REVERSE-PROXY.md)（指针页）→ [proxy-secret](proxy-secret.md) / [public-login](public-login.md)
- federation 接入：[federation-pairing](federation-pairing.md) / [federation-peers](federation-peers.md) / [federation-token-env](federation-token-env.md)
- 配置键：[config-secrets](config-secrets.md) / [config-origins](config-origins.md) / [config-files](config-files.md)
- 401 分流：[TROUBLESHOOTING-401](TROUBLESHOOTING-401.md) · 决策：ADR-051 / 052 / 053 / 101