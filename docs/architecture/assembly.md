---
title: 装配层
kind: guide
triggers: [bootstrap, cli, args, wiring, repl, headless, resume, 装配, 装配层, 启动, 命令行, 参数, 无头, 恢复会话]
children: [cli-wiring.md, gateway-lifecycle.md, federation-hub.md, tools.md, extensions.md, member-team.md, config.md, state.md, plugin-embed.md]
---

# 装配层（`src/`）

> 导航页（guide）：只登记装配域叶子与跨域事实指针，不落事实。`src/` 的分层边界见 [layering.md](layering.md)；目标模型见 [0.34-target.md](0.34-target.md)，决策见 [ADR-098](../adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)（accepted；tenant 部分已被 ADR-100/T0–T5 取代）。

## 装配域叶子

- [cli-wiring.md](cli-wiring.md) —— CLI 入口分发 / 参数互斥 / headless 退出码 / REPL 职责边界 / bootstrap 装配序 / 工厂 wiring / update / 用户可见命令行为。
- [gateway-lifecycle.md](gateway-lifecycle.md) —— gateway 单点启动与进程生命周期：`src/gateway/` 监督 / adopt / 停止语义 / engine 池 / watchdog / reload。
- [federation-hub.md](federation-hub.md) —— Hub 控制面与 federation：`src/hub/`、hub-command / hub-wiring / node-url。
- [tools.md](tools.md) —— 工具与权限边界：`src/tools-engine/` 执行引擎（child + pool 双模式）。
- [extensions.md](extensions.md) —— 扩展机制与插件发现：plugin-loader / plugin-selection。
- [member-team.md](member-team.md) —— AgentService、Body 与 Team：agent-service-wiring / team-command。
- [config.md](config.md) —— 配置模型：cli-overrides 优先级层 / serve-config 校验。
- [state.md](state.md) —— 状态与持久化接口：session / run-record-store 后端契约。
- [plugin-embed.md](plugin-embed.md) —— 插件内嵌 React UI（embed 档）契约：plugin-manifest / plugin-host。

## 跨域事实指针（原模块表行删除后的事实家）

- RPC 客户端（`HttpRpcClient`）、owner 端点传输、drain / reload 受理语义 → [gateway-rpc.md](gateway-rpc.md)；HTTP/WS 协议与远程 → [gateway.md](gateway.md#remote)。
- gateway 能力矩阵与职责归属（stop / drain / 注册表 / 日志） → [gateway-capabilities.md](gateway-capabilities.md)。
- token 派生与 `token show|list|rotate` / `node token --print` → [operations/CONFIG.md](../operations/CONFIG.md)。
- 停止 / 关机运维语义 → [operations/GATEWAY.md](../operations/GATEWAY.md)。