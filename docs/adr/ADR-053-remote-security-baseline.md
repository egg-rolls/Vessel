---
adr: 53
title: 远程安全基线
status: accepted
date: 2026-10-19
related: [36, 41, 48, 49, 50, 51, 52]
tags: [security, tls, cors, tenancy]
---

## ADR-053：远程安全基线

- **上下文**：0.6 把 gateway 从回环扩展到非回环访问，并引入独立前端（跨 Origin）与跨节点通信。攻击面从“本机同名进程”变成网络、浏览器 Origin 与远端节点；如果 token、TLS、Origin、WS 鉴权与 tenant 边界不冻结，各入口会出现不一致的降级路径。本 ADR 固化已批准的安全基线；它是 0.6 的验收条件，相关实现已随 `release/0.6` 合入（未发布）。
- **决策**：
  1. **token + TLS（fail-closed）**：非回环访问必须同时具备 token 与 HTTPS/WSS；启动或连接时任一缺失即失败，不回退匿名、明文或自签默认信任。TLS 证书由用户提供 cert/key；客户端可显式提供 CA 文件。**不提供 `--insecure`**。
  2. **Host / Origin 校验**：HTTP 与 WS upgrade 共用同一 allowlist；`serve.allowed_origins` 在启动时归一化为 `URL.origin`，拒绝 `*`、path 与 query。allowlist 非空时，所有响应加 `Vary: Origin`。
  3. **CORS**：预检命中 allowlist 返回 204，仅回 `Access-Control-Allow-Origin` / `Methods` / `Headers` / `Max-Age`；**永不使用 `*`**，不使用 credentials。HTTP 与 WS 的 Origin 判定必须一致。
  4. **WS 首帧鉴权**：token 不进 URL / query / 首行日志；连接后首帧 `{ kind: 'auth', token, since? }`，5 秒超时以 4401 关闭。事件帧 `{ kind: 'event', seq, job_id?, event }` 与 `ping` / `pong` 遵循 ADR-051。
  5. **请求体上限**：保留 1 MiB body 限制，超限返回 413；该限制同时适用于 RPC、legacy REST 与跨节点消息端点。
  6. **tenant principal**：默认 tenant 由 token principal 决定；admin 可用 `--tenant` 显式覆盖；非 admin 在参数 / header / body 指定其它 tenant 返回 `forbidden`。CLI / TUI / Web 展示当前远端 tenant。`AgentMessage` 不携带可信 tenant，远端必须从 token 派生。
  7. **客户端凭据存储**：Web token 只放 `sessionStorage`（独立前端兼容 `#token=`），**不放 localStorage、不放 query**；运行时 gateway URL 可放 localStorage，但 URL 本身不得内嵌 token。
  8. **CSP**：去掉裸 `ws:` / `wss:`；由 Host 与 allowed origins 动态生成 `connect-src`；`script-src 'self'` 等其余策略不变。独立静态站点自行下发 CSP。
  9. **非目标**：mTLS / 客户端证书、HTTP/2 / ALPN、ACME / 证书自动续期、反向代理信任头、节点自动发现。均不在 0.6 范围内。
  10. **迁移与文档边界**：既有测试中“token 放 query”和“非回环一律拒绝”的断言必须与实现同批改为本基线；文档不得早于代码写“已实现”，验收以非回环无 token / 明文拒绝与 CA 成功为准。
- **备选**：(a) 允许 `*` CORS 简化独立前端——会让任意站点携带用户凭据访问 gateway，不取；(b) token 放 URL query 便于 WS 握手——进入日志、代理与浏览器历史，不取；(c) 用 mTLS 替代 bearer token——证书分发与运维成本超出 0.6 范围；(d) 信任 `X-Forwarded-*`——在无受控反代时可直接伪造。均不取。
- **后果**：独立前端部署需要显式配置 Origin 与（非回环时）TLS；不满足基线的连接直接失败。安全不变量在 HTTP、WS、RPC、跨节点与浏览器五条路径上统一，代价是部署配置更多、错误信息必须可诊断。
- **关联**：ADR-036（gateway 默认安全）、ADR-041（远程监听与 TLS）、ADR-048（RPC 鉴权与错误码）、ADR-049（tenant / principal）、ADR-050（密钥分层）、ADR-051（远程控制面）、ADR-052（跨节点 transport）；DECISION-014 §2、§3、§4.3–§4.5。
