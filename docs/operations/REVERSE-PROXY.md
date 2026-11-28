---
title: 公网暴露与同机反代（指针页）
kind: guide
triggers: [公网, 反代, 反向代理, nginx, 暴露, 威胁模型, loopback, 回环, 安全边界, proxy_secret, 登录, 域名, SSE, 远程停]
children: [proxy-secret.md, exposure-hardening.md, public-login.md, build-events-sse.md, remote-shutdown.md]
---

# 公网暴露与同机反代（指针页）

> 本页只导航，不落事实。原 REVERSE-PROXY 长文已按主题拆为下列窄叶；
> 代码与错误文案仍指向本文件路径（`doctor` / `platform_listen_insecure`），按此表跳转。

| 叶子 | 回答什么 |
|---|---|
| [proxy-secret](proxy-secret.md) | 威胁模型（同机反代下回环≠本机）、`X-Vessel-Proxy-Secret` 机制、受信边缘与 `X-Forwarded-*` 采信规则、多机分发、密钥轮换 |
| [exposure-hardening](exposure-hardening.md) | 平台 / node / hub 入口凭据矩阵（fail-closed 启动守卫、credentials 闸、回环匿名现态）、部署形态清单、`vessel doctor` 自检 |
| [public-login](public-login.md) | 公网域名 + WebUI 登录部署：`auth.public_origins` 来源选择、state 绑定、GitHub OAuth 回调登记、nginx Host 保留 |
| [build-events-sse](build-events-sse.md) | `/web/build/events` SSE 产物推送、反代必须 `proxy_buffering off`、cookie 鉴权、轮询回退 |
| [remote-shutdown](remote-shutdown.md) | `vessel stop --connect`：平台 `gateway.shutdown` 六闸、等死确认、远程不强杀 |

## 旧章节去向（供既有入链定位）

- 原 §1–§4（威胁模型 / 信任边界 / 共享密钥方案）→ [proxy-secret](proxy-secret.md)
- 原 §5–§9（默认收紧 / 升级清单 / doctor / 轮换）→ [exposure-hardening](exposure-hardening.md) + [proxy-secret](proxy-secret.md)（轮换）
- 原 §10（公网域名 + GitHub 登录）→ [public-login](public-login.md)
- 原 §11（SSE 与反代缓冲）→ [build-events-sse](build-events-sse.md)
- 原 §12（远程停）→ [remote-shutdown](remote-shutdown.md)

## 相邻文档

- 配置键：[config-secrets](config-secrets.md)（token / 派生 / `_env`）· [config-origins](config-origins.md)（origin 白名单 / 回环匿名开关）· [config-auth](config-auth.md)（登录后端 / 引导码）
- 401 分流：[TROUBLESHOOTING-401](TROUBLESHOOTING-401.md) · 生命周期：[GATEWAY](GATEWAY.md)
- 跨机直连（无反代）：[remote-connect](remote-connect.md) · [remote-tls](remote-tls.md)
- 审计复现证据与候选方案讨论属历史，见 git 历史（本文件 0.55 时期版本），不入库常驻。