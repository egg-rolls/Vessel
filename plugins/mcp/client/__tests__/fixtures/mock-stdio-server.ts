/**
 * 本地 mock MCP stdio server（测试 fixture）。
 *
 * 由测试用 `process.execPath` 拉起；读 stdin NDJSON，写 stdout NDJSON。
 * 环境变量：
 * - MOCK_PAGINATE=1        tools/list 分两页返回
 * - MOCK_DIE_AFTER_INIT=1  初始化后主动退出
 * - MOCK_SLOW_MS=<n>       slow 工具的延迟（默认 500）
 */

import { callMockTool, isMockToolName, MOCK_TOOLS, SLOW_TOOL } from './mock-tools.js';

interface IncomingMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

const slowMs = Number(process.env.MOCK_SLOW_MS ?? '500');

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | string, result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolsPage(cursor: string | undefined): { tools: unknown[]; nextCursor?: string } {
  if (process.env.MOCK_PAGINATE === '1') {
    if (cursor === 'page-2') return { tools: MOCK_TOOLS.slice(2) };
    return { tools: MOCK_TOOLS.slice(0, 2), nextCursor: 'page-2' };
  }
  return { tools: MOCK_TOOLS };
}

function handleMessage(message: IncomingMessage): void {
  const method = message.method;
  if (method === undefined) return;

  if (method === 'initialize') {
    const requested = message.params?.protocolVersion;
    reply(message.id ?? 0, {
      protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-stdio', version: '0.0.0' },
    });
    if (process.env.MOCK_DIE_AFTER_INIT === '1') {
      setTimeout(() => process.exit(0), 100);
    }
    return;
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return;
  }

  if (method === 'tools/list') {
    const cursor = message.params?.cursor;
    reply(message.id ?? 0, toolsPage(typeof cursor === 'string' ? cursor : undefined));
    return;
  }

  if (method === 'tools/call') {
    const id = message.id;
    if (id === undefined) return;
    const name = message.params?.name;
    if (typeof name !== 'string') {
      replyError(id, -32602, 'tools/call requires a tool name');
      return;
    }
    if (!isMockToolName(name)) {
      replyError(id, -32602, `unknown tool: ${name}`);
      return;
    }
    if (name === SLOW_TOOL) {
      setTimeout(() => {
        reply(id, { content: [{ type: 'text', text: 'slow-done' }] });
      }, slowMs);
      return;
    }
    const result = callMockTool(name, message.params?.arguments);
    if (result !== undefined) reply(id, result);
    return;
  }

  if (message.id !== undefined) {
    replyError(message.id, -32601, `unknown method: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: Buffer | string) => {
  buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (line.trim() !== '') {
      try {
        const parsed = JSON.parse(line) as IncomingMessage | IncomingMessage[];
        if (Array.isArray(parsed)) {
          for (const message of parsed) handleMessage(message);
        } else {
          handleMessage(parsed);
        }
      } catch {
        // 坏帧忽略
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
