---
adr: 75
title: gateway.reload 只热重载可验证的范围
status: accepted
date: 2026-10-20
related: [48, 59, 66, 74]
tags: [gateway, rpc, reload, config, plugins, hot-reload]
---

## ADR-075：gateway.reload 只热重载可验证的范围

- **上下文**：0.12 需要在不重启进程的情况下让 gateway 感知插件目录变化与部分配置变更。配置包含 provider、model、agent、permission、TLS、token、port 与 `serve.allowed_origins` 等域，其中大多数在启动时已经进入 runtime、HTTP / WS 服务或 tenant 执行面，无法安全地在运行中替换。若把“读到新配置”直接报告为“已生效”，运维会误以为 token 或端口已经切换，造成安全与可用性风险。

- **决策**：
  1. **新增 canonical RPC `gateway.reload`**：admin-only，`params { scopes?: string[] }` → `{ reloaded: string[], requires_restart: string[] }`。缺省 scope 为 `config,plugins`；未知 scope 返回 RPC 错误，不静默忽略。方法带 `result_schema`，纳入 canonical 方法总数（38 个 = 37 个 domain 方法 + `events.subscribe`）。
  2. **`plugins` scope 只刷新扫描缓存**：清空插件目录扫描缓存，使下一次 `list()` 重新扫描；已安装插件、已注册工具与 active run 不受影响。新增插件是否可运行仍遵循插件安装 / 重启语义，不把目录刷新等同于动态安装。
  3. **`config` scope 只热更新 `serve.allowed_origins`**：重新 `loadConfig()`；若 allowlist 变化且 gateway 提供 `reconfigure()`，调用 `Gateway.reconfigure({ allowedOrigins })` 并计入 `reloaded`。配置读取失败或 `reconfigure` 抛错向上传播为 RPC 错误，不返回成功。
  4. **其它配置域一律进 `requires_restart`**：provider（不含 model）、model、agent、permission、TLS、token、port 变更只报告字段名，不声称已生效。未提供 `reconfigure()` 的 gateway 把 `serve.allowedOrigins` 也放进 `requires_restart`。
  5. **CLI 经本地 HTTP RPC 调用**：`vessel gateway reload [--scope config,plugins]` 从 PID 文件取地址、从配置解析 token；token 不放 URL。未运行、无 token、RPC 错误或结果形状不符都返回非 0，并分别提示可重载项与需重启项。

- **备选**：(a) 全量重建 gateway 并替换进程内实例——active run、连接与订阅都会中断，等价于重启却伪装成热重载；(b) 只允许重启，不提供 reload——插件目录与 CORS allowlist 的小改动也要停服务；(c) 直接修改运行时字段并报告成功——TLS / token / port 无法在不重建监听器的情况下生效，属于错误报告；(d) 热重载 provider / model——进行中的 run 与已构造的 provider 实例语义无法保持一致。均不取。

- **后果**：`gateway.reload` 的能力边界清晰、可测试：plugins 一定进入 `reloaded`，config 的 allowlist 真正生效，其余字段可枚举地要求重启。运维脚本应以 `requires_restart` 非空决定是否重启，而不是只看退出码。未来若要扩大热重载范围，必须真正重建对应组件并新增 ADR，不能只改字段比较表。

- **关联**：ADR-048（统一 RPC 方法表）、ADR-059（方法按 domain 拆分）、ADR-066（result_schema）、ADR-074（gateway 生命周期）；`packages/serve/src/gateway/methods/admin.ts`、`packages/serve/src/gateway.ts`（`reconfigure`）、`src/gateway-reload-wiring.ts`、`src/gateway/reload.ts`。
