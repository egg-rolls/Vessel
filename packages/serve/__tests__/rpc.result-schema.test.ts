import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { MemoryEventStream, MemorySessionBackend, type RunEvent } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { PROTOCOL_VERSION } from '../src/protocol';
import {
  createRpcDispatcher,
  defineMethods,
  RPC_VERSION,
  type RpcMethodContext,
  validateResult,
} from '../src/rpc';
import { createGateway } from './helpers';

const gateways: Gateway[] = [];
const previousFlag = process.env.VESSEL_VALIDATE_RESULTS;

afterEach(() => {
  for (const gw of gateways.splice(0)) gw.stop();
  if (previousFlag === undefined) delete process.env.VESSEL_VALIDATE_RESULTS;
  else process.env.VESSEL_VALIDATE_RESULTS = previousFlag;
});

function localContext(
  _method: unknown,
  _params: unknown,
  principal: RpcMethodContext['principal'],
  connection: RpcMethodContext['connection'],
): RpcMethodContext {
  return {
    principal,
    tenantId: principal.tenant_id === '*' ? 'default' : principal.tenant_id,
    isAdmin: principal.role === 'admin',
    allTenants: false,
    connection,
  };
}

function testDispatcher(onResultInvalid?: (violation: { method: string; path: string }) => void) {
  const table = defineMethods([
    {
      name: 'test.good',
      permission: 'read',
      result_schema: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      handler: () => ({ value: 'ok' }),
    },
    {
      name: 'test.bad',
      permission: 'read',
      result_schema: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      handler: () => ({ value: 42, secret: 'payload-must-not-leak' }),
    },
  ]);
  return createRpcDispatcher({
    table,
    localPrincipal: { tenant_id: 'default', role: 'admin' },
    makeContext: localContext,
    ...(onResultInvalid ? { onResultInvalid } : {}),
  });
}

describe('rpc result_schema', () => {
  it('declares result_schema for all 48 canonical methods', () => {
    const gw = createGateway({ events: new MemoryEventStream() });
    gateways.push(gw);
    const methods = gw.manifest().methods;
    expect(methods).toHaveLength(48);
    expect(methods.filter((method) => method.result_schema === undefined)).toEqual([]);
  });

  it('declares validatable result_schema for the three S5 auth methods', () => {
    const gw = createGateway({ events: new MemoryEventStream() });
    gateways.push(gw);
    const byName = new Map(gw.manifest().methods.map((method) => [method.name, method]));

    const exchange = byName.get('auth.exchange');
    const exchangeSchema = exchange?.result_schema as Record<string, unknown> | undefined;
    expect(exchangeSchema).toBeDefined();
    expect(
      validateResult(exchangeSchema, {
        token: 'tok-1',
        token_id: 'token-1',
        scope: 'control',
        tenant_id: 'default',
        team_id: 'team-1',
        node_id: 'node-1',
        hub_id: 'hub-1',
        pairing_id: 'node-1:default',
        expires_at: 1,
      }),
    ).toBeNull();
    expect(validateResult(exchangeSchema, { token: 'tok-1', scope: 'control' })).not.toBeNull();

    const revoke = byName.get('auth.revoke');
    const revokeSchema = revoke?.result_schema as Record<string, unknown> | undefined;
    expect(revokeSchema).toBeDefined();
    expect(validateResult(revokeSchema, { token_id: 'token-1', revoked_at: 1 })).toBeNull();
    expect(validateResult(revokeSchema, { token_id: 'token-1' })).not.toBeNull();

    const tokens = byName.get('auth.tokens');
    const tokensSchema = tokens?.result_schema as Record<string, unknown> | undefined;
    expect(tokensSchema).toBeDefined();
    expect(
      validateResult(tokensSchema, {
        tokens: [
          {
            token_id: 'token-1',
            scope: 'view',
            tenant_id: 'default',
            issued_by: 'pairing',
            created_at: 1,
            expires_at: 2,
          },
        ],
      }),
    ).toBeNull();
    expect(validateResult(tokensSchema, { tokens: [{ token_id: 'token-1' }] })).not.toBeNull();
  });

  it('keeps a single protocol version source', () => {
    expect(RPC_VERSION).toBe(PROTOCOL_VERSION);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('returns internal with only method/path when validation is enabled', async () => {
    process.env.VESSEL_VALIDATE_RESULTS = '1';
    const violations: Array<{ method: string; path: string }> = [];
    const dispatcher = testDispatcher((violation) => violations.push(violation));

    const good = await dispatcher.dispatch({ v: 1, id: 'good', method: 'test.good' });
    expect(good.ok).toBe(true);

    const bad = await dispatcher.dispatch({ v: 1, id: 'bad', method: 'test.bad' });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('expected failure');
    expect(bad.error.code).toBe('internal');
    expect(bad.error.details).toEqual({ method: 'test.bad', path: 'result.value' });
    expect(violations).toEqual([{ method: 'test.bad', path: 'result.value' }]);

    const serialized = JSON.stringify(bad);
    expect(serialized).not.toContain('payload-must-not-leak');
    expect(serialized).not.toContain('42');
  });

  it('does not validate results by default', async () => {
    delete process.env.VESSEL_VALIDATE_RESULTS;
    const violations: Array<{ method: string; path: string }> = [];
    const dispatcher = testDispatcher((violation) => violations.push(violation));

    const bad = await dispatcher.dispatch({ v: 1, id: 'bad', method: 'test.bad' });
    expect(bad.ok).toBe(true);
    expect(violations).toEqual([]);
  });

  it('accepts sessions.list results with branch null or missing', async () => {
    process.env.VESSEL_VALIDATE_RESULTS = '1';
    const session = new MemorySessionBackend();
    await session.save({
      run_id: 'run-null',
      session_id: 'session-null',
      messages: [{ role: 'user', content: 'hi' }] as never,
      started_at: 1,
      status: 'completed',
      // 真实 session 文件可能出现显式 null。
      branch: null as unknown as string,
    });
    await session.save({
      run_id: 'run-missing',
      session_id: 'session-missing',
      messages: [{ role: 'user', content: 'hi' }] as never,
      started_at: 2,
      status: 'completed',
    });
    const gw = createGateway({ events: new MemoryEventStream(), session });
    gateways.push(gw);

    const response = await gw.rpc({ v: 1, id: 'sessions', method: 'sessions.list' });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const result = response.result as {
      sessions: Array<{ session_id: string; branch?: unknown }>;
    };
    expect(result.sessions.map((item) => item.session_id).sort()).toEqual([
      'session-missing',
      'session-null',
    ]);
    expect(result.sessions.find((item) => item.session_id === 'session-null')?.branch).toBeNull();
  });

  it('gateway emits rpc.result_invalid with method/path only', async () => {
    process.env.VESSEL_VALIDATE_RESULTS = '1';
    const events = new MemoryEventStream();
    const seen: RunEvent[] = [];
    events.subscribe((event) => {
      seen.push(event);
    });
    const gw = createGateway({
      events,
      config: {
        snapshot: () => ({ schema_version: 1, config: 'not-an-object', sources: {} }),
      } as never,
    });
    gateways.push(gw);

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const response = await gw.rpc({ v: 1, id: 'config', method: 'config.get' });
    const warnCalls = warn.mock.calls;
    warn.mockRestore();
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected failure');
    expect(response.error.code).toBe('internal');
    expect(response.error.details).toEqual({ method: 'config.get', path: 'result.config' });
    expect(warnCalls).toEqual([
      ['[vessel] rpc.result_invalid', { method: 'config.get', path: 'result.config' }],
    ]);

    const invalid = seen.find((event) => event.type === 'rpc.result_invalid');
    expect(invalid).toBeDefined();
    expect(invalid?.data).toEqual({ method: 'config.get', path: 'result.config' });
    expect(JSON.stringify(invalid?.data)).not.toContain('not-an-object');
  });
});
