import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import type { McpGatewayOptions } from '../src/mcp';
import { createGateway } from './helpers';

describe('gateway MCP status endpoint', () => {
  const gateways: Gateway[] = [];

  const start = (listServers?: () => unknown): Gateway => {
    const gw = createGateway({
      events: new MemoryEventStream(),
      ...(listServers
        ? { mcp: { listServers: listServers as unknown as McpGatewayOptions['listServers'] } }
        : {}),
    });
    gateways.push(gw);
    return gw;
  };

  const auth = (gw: Gateway): Record<string, string> => ({
    Authorization: `Bearer ${gw.token}`,
  });

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('returns mcp_disabled when no provider is injected', async () => {
    const gw = start();
    const res = await fetch(`${gw.url}/v1/mcp/servers`, { headers: auth(gw) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('mcp_disabled');
  });

  it('maps provider snapshots to the frozen wire shape', async () => {
    const gw = start(() => [
      { name: 'filesystem', status: 'connected', tools: ['read_file', 'write_file'] },
      { name: 'remote', status: 'failed', tools: [], error: 'connect timeout' },
      { name: 'off', status: 'disabled', tools: [] },
    ]);

    const res = await fetch(`${gw.url}/v1/mcp/servers`, { headers: auth(gw) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      servers: [
        { name: 'filesystem', status: 'connected', tools: ['read_file', 'write_file'] },
        { name: 'remote', status: 'failed', tools: [], error: 'connect timeout' },
        { name: 'off', status: 'disabled', tools: [] },
      ],
    });
  });

  it('drops extended fields and malformed entries, and dedupes names', async () => {
    const gw = start(() => [
      {
        name: 'fs',
        status: 'connected',
        transport: 'stdio',
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'fs-server', version: '1.0.0' },
        tools: ['t1', 42],
        extra: true,
      },
      { name: 'fs', status: 'failed', tools: ['duplicate'] },
      { name: '', status: 'connected', tools: [] },
      { name: 'bad-status', status: 'weird', tools: [] },
      'not-an-object',
      { name: 'no-tools', status: 'connected' },
    ]);

    const body = (await (
      await fetch(`${gw.url}/v1/mcp/servers`, { headers: auth(gw) })
    ).json()) as { servers: Array<Record<string, unknown>> };
    expect(body.servers).toEqual([
      { name: 'fs', status: 'connected', tools: ['t1'] },
      { name: 'no-tools', status: 'connected', tools: [] },
    ]);
  });

  it('returns 500 with a fixed message when the provider throws', async () => {
    const gw = start(() => {
      throw new Error('socket /secret/path exploded');
    });
    const res = await fetch(`${gw.url}/v1/mcp/servers`, { headers: auth(gw) });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('Failed to read MCP server status');
  });

  it('advertises mcp-status only when the provider is injected', async () => {
    const enabled = start(() => []);
    const enabledBody = (await (await fetch(`${enabled.url}/v1/health`)).json()) as {
      protocol: { features: string[] };
    };
    expect(enabledBody.protocol.features).toContain('mcp-status');

    const disabled = start();
    const disabledBody = (await (await fetch(`${disabled.url}/v1/health`)).json()) as {
      protocol: { features: string[] };
    };
    expect(disabledBody.protocol.features).not.toContain('mcp-status');
  });

  it('requires auth, rejects wrong methods and unknown subpaths', async () => {
    const gw = start(() => []);

    const unauthorized = await fetch(`${gw.url}/v1/mcp/servers`);
    expect(unauthorized.status).toBe(401);

    const post = await fetch(`${gw.url}/v1/mcp/servers`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(post.status).toBe(405);

    const unknown = await fetch(`${gw.url}/v1/mcp/other`, { headers: auth(gw) });
    expect(unknown.status).toBe(404);
  });
});
