---
adr: 41
title: 远程监听与 TLS（显式 opt-in）
status: accepted
date: null
related: [36, 37]
---

## ADR-041：远程监听与 TLS（显式 opt-in）

- **上下文**：0.1 / 0.2 gateway 只绑 `127.0.0.1`；ADR-037 把远程监听与 TLS 列为 0.2 非目标。0.3 要支持可信网络 / VM 访问，但默认行为必须与 0.2 一致。
- **决策**：
  1. **显式 opt-in**：`serve.allow_remote: true` 且 hostname 非回环才进入远程模式；默认 `127.0.0.1` + `allow_remote: false`，行为与 0.2 字节级一致。
  2. **远程必须有 token**：沿用 `config > VESSEL_GATEWAY_TOKEN > gateway 自动生成`；非回环必须 `allow_remote=true` 且 token 非空，不得匿名；token 为空或被显式关闭时启动失败并给出明确错误。
  3. **TLS 与 `allow_remote` 相互独立**：loopback + TLS 允许（`allow_remote=false` 也可启 TLS）；非回环才要求 `allow_remote=true`。`serve.tls.cert_file` 与 `serve.tls.key_file` 必须成对提供，否则启动失败。
  4. **只做 HTTP/1.1**：不做 HTTP/2 / ALPN / mTLS / 客户端证书管理 / ACME / 证书自动续期。HTTPS 与 WSS 共用同一 server、token 与 Origin 规则。
  5. **`hello.features`** 按实际启用增加 `tls`（以及既定的 `durable-resume` / `mcp-status`）；不新增 `remote` feature。
  6. **安全不变量不因远程放宽**：Host / Origin 校验、WS 首帧鉴权、1 MiB 请求体上限、无 `*` CORS、HTML CSP 全部保留。
  7. **非目标**：反向代理信任头、跨机器 team 语义变化、远程 `/v1/team/*` 扩展。
- **备选**：(a) 默认监听 `0.0.0.0`——扩大攻击面且破坏兼容；(b) 只支持反向代理 TLS——不满足内置 opt-in 需求；(c) 自动生成自签证书——信任警告与隐性风险；(d) HTTP/2——超出范围。均不取。
- **后果**：多一条显式配置路径；证书生命周期由用户负责；文档必须提示暴露 gateway 的风险；默认路径零变化，回归以默认配置对照 0.2。远程 / TLS 测试离线（本地自签证书 + 回环端口）。
- **已知行为**：监听 `0.0.0.0` 时，banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；其它机器访问需把 host 换成实际 IP。这是显示层行为，不改变监听地址、token 鉴权或 Host/Origin 校验。
- **关联**：ADR-036（gateway 协议）、ADR-037（0.2 非目标）、DECISION-008 §4.3 / §4.4 / §8 Addendum A §8.9。
