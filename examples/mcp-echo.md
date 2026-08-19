# MCP Echo 示例

启动 Vessel 后，让 Agent 调用 `mcp_connect`，参数如下：

```json
{
  "name": "echo",
  "command": "bun",
  "args": ["run", "examples/mcp-echo-server.ts"]
}
```

连接成功后，MCP 工具会注册为：

- `mcp__echo__echo`
- `mcp__echo__now`

也可以在 TUI 中使用 `/mcp` 查看连接状态、使用 `/tools` 查看已注册工具。
