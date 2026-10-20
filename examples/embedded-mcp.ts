/**
 * Vessel 示例：嵌入 runtime + MCP 插件（离线，无需 API Key）。
 *
 * 运行：bun run examples/embedded-mcp.ts
 *
 * 演示：
 * 1. 用与 `mcp_servers` 配置相同的形状描述一个本地 stdio MCP server；
 * 2. 把 `createMcpPlugin` 安装到 PluginHost（工具的唯一注册表）；
 * 3. 启动一个嵌入的 AgentRuntime（MemoryLLMProvider），并对 MCP 工具做一次直接调用；
 * 4. 退出时关闭 MCP 连接（子进程）。
 */

import { fileURLToPath } from 'node:url';
import {
  AgentRuntime,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  MemorySessionBackend,
} from '../packages/core/src/index';
import { createMcpPlugin } from '../plugins/mcp/client/src/index';

/** 与 vessel.yaml 的 `mcp_servers.demo` 等价（snake→camel 之后） */
const mcpServers = [
  {
    name: 'demo',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-echo-server.ts', import.meta.url))],
    enabled: true,
  },
];

async function main(): Promise<void> {
  const events = new MemoryEventStream();
  const pluginHost = new MemoryPluginHost();

  const mcp = createMcpPlugin({ servers: mcpServers, events });

  try {
    await mcp.install(pluginHost);

    const mcpTools = pluginHost
      .listTools()
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('mcp__'));
    console.log('MCP tools:', mcpTools.length > 0 ? mcpTools.join(', ') : '(none)');
    console.log(
      'MCP servers:',
      mcp
        .listServers()
        .map((server) => `${server.name}=${server.status}`)
        .join(', '),
    );

    const echo = pluginHost.getTool('mcp__demo__echo');
    if (!echo) throw new Error('mcp__demo__echo was not registered');

    const toolResult = await echo.handler(
      { text: 'hello from vessel' },
      { run_id: 'example', messages: [], events },
    );
    console.log('Tool result:', toolResult);

    // 嵌入 runtime：同一个 PluginHost 既是 MCP 工具的来源，也是默认工具集。
    const runtime = await AgentRuntime.create({
      provider: new MemoryLLMProvider(),
      model: 'mock-model',
      context: new MemoryContextManager(),
      events,
      session: new MemorySessionBackend(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 3 },
      pluginHost,
    });

    try {
      console.log('Agent:', await runtime.run('hello from the embedded runtime'));
    } finally {
      runtime.dispose();
    }
  } finally {
    // 关闭所有 MCP 子进程/连接。
    await mcp.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
