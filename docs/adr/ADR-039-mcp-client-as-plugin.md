---
adr: 39
title: MCP client 作为插件接入
status: accepted
date: null
related: [30, 34, 37]
---

## ADR-039：MCP client 作为插件接入

- **上下文**：0.1 曾删除旧 MCP 客户端，并留下边界「MCP 若回归，形态也是一个插件，不给 core 加接口」（ADR-034 第 8 条）。0.3 需要接外部工具生态；MCP 是协议桥，不是领域无关的 runtime 能力。若把它放进 core，既违背能力准入，也会让 loop 与接口面为一种协议扩张。
- **决策**：
  1. **形态**：工厂式插件 `plugins/mcp/client/`，包名 `@vessel/mcp-client`；`createMcpPlugin(options)` 返回 `McpClientPlugin`。由 asm 装配层在 `FACTORY_PLUGINS` 中构造。
  2. **边界**：**不是 core 模块**；不新增 core 接口、不新增扩展机制；工具只经 `PluginHost.registerTool` 注册；core 的 9 个扩展接口与 loop 拓扑不变。
  3. **传输**：stdio（JSON-RPC over child process stdin/stdout）与 HTTP（MCP Streamable HTTP）。HTTP 最小范围：POST JSON-RPC；请求头 `Accept: application/json, text/event-stream`；响应支持纯 JSON 与 SSE 帧解析；不做 GET 长连接、session 恢复、OAuth。
  4. **工具名**：`toolPrefix !== false` 时为 `mcp__<server>__<tool>`，非法字符替换为 `_`；完整工具名超过 64 字符时截断到 64 并在末尾追加 `_` + 8 位 hash，避免碰撞。`toolPrefix === false` 时用原名；与既有工具冲突则**跳过并告警，不覆盖**。
  5. **权限**：`checkPermission` 一律 `'ask'`；仅 `autoApproveTools` 中的工具返回 `'allow'`。名单使用 server 返回的**原始工具名**（加前缀前），大小写敏感、精确匹配。禁止默认放行。
  6. **失败隔离**：单 server 连接失败或中途断开不得导致进程启动失败；告警并发 `mcp.server.failed` / `mcp.server.disconnected`，其余 server 继续。工具调用失败发 `mcp.tool.failed`，作为普通工具错误折回语言空间。
  7. **生命周期与控制面**：`install()` 建连；`close()` 关闭所有子进程/连接；asm 在进程退出时调用。控制面冻结为 `McpPluginControls`：`listServers()`（同步快照）、`getServer(name)`、`reconnect(name)`；`enabled:false` 的 server 也出现在列表中，status 为 `disabled`。`reconnect` 未知名字抛 `mcp_server_not_found`，禁用 server 抛 `mcp_server_disabled`。
  8. **状态类型**：`McpServerStatus { name, status: 'connected' | 'failed' | 'disabled', transport, tools, error?, protocolVersion?, serverInfo? }`。asm 负责把它适配成 TUI 的 `McpControl` 与 gateway 的状态源；tui / web 不直接 import 插件实现。
  9. **事件**（开放字符串，ADR-030）：`mcp.server.connected` / `mcp.server.failed` / `mcp.server.disconnected` / `mcp.tool.called` / `mcp.tool.failed`。
  10. **依赖**：core 依赖保持为空；插件默认自实现 JSON-RPC。若需引入 MCP SDK，需 1 单独批准；新 workspace 包首次安装由 ext 在自己 worktree 执行并提交 `bun.lock`（Addendum B §9.3 Q3），且同期 asm 不得改依赖。
  11. **安全**：`command` / `args` 以数组形式 spawn，不经 shell 拼接；`env` 只来自配置；远程 server 的 TLS 校验不得默认关闭。
- **备选**：(a) 进 core 做成 MCP 模块——违反能力准入与 ADR-034 / ADR-037；(b) 每个 MCP 工具静态生成插件——无法按配置动态增删 server；(c) 另起工具注册机制——违反单一扩展机制。均不取。
- **后果**：外部工具与内置工具走同一 `PluginHost`；core 零改动；工具总数变为动态（文档写「4 个基础 + N 个 MCP」）。代价：插件承担子进程 / 连接生命周期、超时、重连与状态维护；默认 ask 带来首次确认摩擦（刻意）。
- **关联**：ADR-034（MCP 延后条款）、ADR-037（Module ≠ Plugin）、ADR-030（开放事件名）、DECISION-008 §4.2 / §8 Addendum A / §9.1 / §9.3。
