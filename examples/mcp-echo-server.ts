/**
 * Minimal MCP stdio server for local development.
 * Run through Vessel's mcp_connect tool with:
 *   command: bun
 *   args: ["run", "examples/mcp-echo-server.ts"]
 */

interface Request {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

const tools = [
  {
    name: 'echo',
    description: 'Return the supplied message.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'now',
    description: 'Return the current ISO timestamp.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function reply(id: number | undefined, result: unknown): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function handle(request: Request): void {
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'vessel-mcp-echo', version: '0.1.0' },
    });
    return;
  }
  if (request.method === 'tools/list') {
    reply(request.id, { tools });
    return;
  }
  if (request.method === 'tools/call') {
    const name = request.params?.name;
    const args = request.params?.arguments as { message?: string } | undefined;
    const text =
      name === 'echo'
        ? (args?.message ?? '')
        : name === 'now'
          ? new Date().toISOString()
          : `Unknown tool: ${String(name)}`;
    reply(request.id, { content: [{ type: 'text', text }] });
    return;
  }
  if (request.id !== undefined) {
    reply(request.id, {});
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line) as Request);
    } catch {
      // Ignore malformed input so the stdio server remains alive.
    }
  }
});
