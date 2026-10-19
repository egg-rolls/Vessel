---
adr: 51
title: 远程控制面（非回环 HTTPS 与 token/CA）
status: accepted
date: 2026-10-19
related: [36, 41, 48, 49, 50]
tags: [remote, gateway, tls, client]
---

## ADR-051：远程控制面（非回环 HTTPS 与 token/CA）

- **上下文**：ADR-036 的 gateway 默认只绑 `127.0.0.1`；ADR-041 允许显式 opt-in 的远程监听与 TLS，但客户端侧没有对应能力；ADR-048 §8 明确写着 `HttpRpcClient` 只支持本机回环 gateway、不是 F5 跨机器远程。0.6 的 F5 要求 CLI / TUI / Web 以远程客户端身份连接非回环的 TLS gateway，同时保持默认本地路径不变。本 ADR 记录已批准的 0.6 目标与实现边界；相关实现已随 `release/0.6` 合入（未发布）。
- **决策**：
  1. **连接目标**：`--connect <url>` 接受 `http(s)://` 与 `ws(s)://`；回环地址允许明文用于本地开发；**非回环地址强制 HTTPS/WSS**。URL 只允许 origin，不接受 path / query / 内嵌 token 作为连接参数。
  2. **token 来源（冻结）**：客户端解析顺序为 **CLI `--connect-token` > env（`VESSEL_CONNECT_TOKEN` / `connect.token_env`）> config `connect.token`**。非回环连接在发起网络请求前校验 token，缺失即失败，不回退匿名或明文。
  3. **CA 显式配置**：私有 CA / 自签证书通过 CLI `--ca <file>` 或 config `connect.ca_file` 显式提供；未提供时使用运行时默认信任库。Node 侧可指定 CA 文件；浏览器无法按连接指定 CA 文件，必须把 CA 装进系统/浏览器信任库，文档需写清。
  4. **无逃生口**：不提供 `--insecure`、`-k` 或“忽略证书错误”开关；不得静默降级为 HTTP/WS。失败信息区分 token 401、Origin 403、TLS 校验失败与网络错误。
  5. **WS 首帧鉴权**：事件流走 `/v1/events`；token 不放进 WS URL 或 query，连接后首帧发送 `{ kind: 'auth', token, since? }`。服务端在 5 秒内未收到合法首帧则以 4401 关闭。
  6. **事件流语义（冻结）**：客户端解析 `hello` / `event` / `gap` / `ping` 帧；`event` 形如 `{ kind: 'event', seq, job_id?, event }`。客户端记录 `lastSeq`，收到 `ping` 回 `pong`；`gap` 用 `to_seq` 触发带 `since` 的重连；`hello.latest_seq < lastSeq` 时从 `since=0` 重新对齐；重连采用 1s → 30s 指数退避加 jitter；10s 未收到 `hello` 视为失败并重连；`close()` 清理全部定时器。
  7. **权限与 ask 回路**：connect 模式下，TUI / headless 把本地 `tool.permission.response` / `ask.user.answered` 转为远端 `permission.respond` / `ask.respond` RPC；回路失败只写 stderr，不静默成功。
  8. **tenant 与节点展示**：建连后通过 `health.get` 获取 tenant 与节点信息；默认 tenant 由 token principal 决定；admin 可用 `--tenant` 显式覆盖，并合并到每次请求；CLI 打印 node/tenant，TUI 状态行展示。
  9. **独立前端连接**：Web 运行时可配置 gateway URL，优先级 `localStorage['vessel.gateway-url']` > `VITE_GATEWAY_URL` > 同源；只接受 http(s)/ws(s) origin，归一化去尾斜杠，拒绝 path/query/token；非回环强制 https；https 页面拒绝 http/ws（mixed content）。换 URL 时重建 client 并重置 seq / 时间线 / 选中会话。
  10. **对旧 ADR 的关系**：本 ADR **局部修正** ADR-048 §8“`HttpRpcClient` 只支持本机回环”的措辞；不整体 supersede ADR-041，服务端默认监听、`serve.allow_remote` 与 TLS 显式 opt-in 的决策保持有效。ADR-041 的非目标“跨机器 team 语义变化”由 ADR-052 另行扩展。
- **备选**：(a) 继续只允许回环，远程靠 SSH 端口转发——不满足独立前端与跨机控制面需求；(b) 允许 `--insecure` 便于自签调试——形成长期降级路径，不取；(c) 把 token 放进 WS query——会进入日志与代理记录，不取；(d) 自动生成并信任自签证书——隐性信任与生命周期问题，不取。
- **后果**：远程客户端多出 token/CA 配置面；证书生命周期由用户负责；非回环路径 fail-closed。默认本地连接路径保持不变。测试需覆盖非回环无 token / 明文拒绝、CA 成功、WS 首帧、`since` / `pong` / `gap` / 重连与 seq 回退。
- **关联**：ADR-036（gateway 协议）、ADR-041（远程监听与 TLS）、ADR-048（统一 RPC）、ADR-049（tenant 与 principal）、ADR-050（配置与密钥分层）、ADR-053（远程安全基线）；DECISION-014 §1 Phase A、§2、§4.4–§4.5。
