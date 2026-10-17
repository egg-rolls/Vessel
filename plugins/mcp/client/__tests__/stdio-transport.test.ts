/**
 * stdio 传输层测试（直接驱动 StdioTransport，本地 fixture 子进程）。
 */

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { StdioTransport } from '../src/stdio-transport';
import type { McpServerConfig } from '../src/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-stdio-server.ts', import.meta.url));

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'mock',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    ...overrides,
  };
}

async function initialize(transport: StdioTransport): Promise<unknown> {
  return transport.request(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
    { timeoutMs: 2000 },
  );
}

async function captureError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('StdioTransport', () => {
  it('performs the initialize handshake and lists tools', async () => {
    const transport = new StdioTransport(config());
    try {
      await transport.start();
      const init = (await initialize(transport)) as {
        protocolVersion: string;
        serverInfo: unknown;
      };
      expect(init.protocolVersion).toBe('2025-06-18');
      expect(init.serverInfo).toBeDefined();

      const list = (await transport.request('tools/list', {}, { timeoutMs: 2000 })) as {
        tools: Array<{ name: string }>;
      };
      expect(list.tools.map((tool) => tool.name).sort()).toEqual(['add', 'echo', 'fail', 'slow']);
    } finally {
      await transport.close();
    }
  });

  it('calls tools and preserves isError results', async () => {
    const transport = new StdioTransport(config());
    try {
      await transport.start();
      await initialize(transport);

      const echo = (await transport.request(
        'tools/call',
        { name: 'echo', arguments: { text: 'hi' } },
        { timeoutMs: 2000 },
      )) as { content: Array<{ type: string; text: string }> };
      expect(echo.content[0]?.text).toBe('{"text":"hi"}');

      const fail = (await transport.request(
        'tools/call',
        { name: 'fail', arguments: {} },
        { timeoutMs: 2000 },
      )) as { isError: boolean; content: Array<{ text: string }> };
      expect(fail.isError).toBe(true);
      expect(fail.content[0]?.text).toBe('boom');
    } finally {
      await transport.close();
    }
  });

  it('maps JSON-RPC errors to a stable message', async () => {
    const transport = new StdioTransport(config());
    try {
      await transport.start();
      await initialize(transport);
      const message = await captureError(
        transport.request('tools/call', { name: 'missing' }, { timeoutMs: 2000 }),
      );
      expect(message).toContain('unknown tool: missing (code -32602)');
    } finally {
      await transport.close();
    }
  });

  it('enforces the request timeout', async () => {
    const transport = new StdioTransport(config({ env: { MOCK_SLOW_MS: '2000' } }));
    try {
      await transport.start();
      await initialize(transport);
      const message = await captureError(
        transport.request('tools/call', { name: 'slow' }, { timeoutMs: 100 }),
      );
      expect(message).toContain('timed out after 100ms');
    } finally {
      await transport.close();
    }
  });

  it('reports a passive process exit through onClose', async () => {
    const transport = new StdioTransport(config({ env: { MOCK_DIE_AFTER_INIT: '1' } }));
    try {
      const closed = new Promise<string>((resolve) => transport.onClose(resolve));
      await transport.start();
      await initialize(transport);
      const reason = await closed;
      expect(reason).toContain('exited');
    } finally {
      await transport.close();
    }
  });
});
