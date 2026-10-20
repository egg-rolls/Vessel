/**
 * 最小 MCP stdio server（示例用，离线运行）。
 *
 * 协议：JSON-RPC over stdin/stdout（一行一条消息）。
 * 支持 initialize / tools/list / tools/call，只暴露一个 `echo` 工具。
 *
 * 单独运行没有意义；由 `examples/embedded-mcp.ts` 作为子进程拉起。
 */

import { createInterface } from 'node:readline';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echo the provided text back to the caller',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo' },
    },
    required: ['text'],
  },
};

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | string | undefined, result: unknown): void {
  write({ jsonrpc: '2.0', id: id ?? 0, result });
}

function replyError(id: number | string | undefined, code: number, message: string): void {
  write({ jsonrpc: '2.0', id: id ?? 0, error: { code, message } });
}

function handle(request: JsonRpcRequest): void {
  switch (request.method) {
    case 'initialize':
      reply(request.id, {
        protocolVersion:
          typeof request.params?.protocolVersion === 'string'
            ? request.params.protocolVersion
            : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'vessel-example-echo', version: '0.3.0' },
      });
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'tools/list':
      reply(request.id, { tools: [ECHO_TOOL] });
      return;

    case 'tools/call': {
      const name = request.params?.name;
      if (name !== 'echo') {
        replyError(request.id, -32602, `unknown tool: ${String(name)}`);
        return;
      }
      const args = request.params?.arguments;
      const text =
        typeof args === 'object' &&
        args !== null &&
        typeof (args as { text?: unknown }).text === 'string'
          ? (args as { text: string }).text
          : '';
      reply(request.id, { content: [{ type: 'text', text: `echo: ${text}` }] });
      return;
    }

    default:
      if (request.id !== undefined) {
        replyError(request.id, -32601, `unknown method: ${String(request.method)}`);
      }
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  try {
    const parsed = JSON.parse(trimmed) as JsonRpcRequest | JsonRpcRequest[];
    if (Array.isArray(parsed)) {
      for (const request of parsed) handle(request);
    } else {
      handle(parsed);
    }
  } catch {
    // 忽略坏帧（示例不处理 batch 错误报告）
  }
});
lines.on('close', () => process.exit(0));
