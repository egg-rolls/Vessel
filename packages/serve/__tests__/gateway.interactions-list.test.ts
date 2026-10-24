import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStream, MemoryPluginHost } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';
import {
  createGateway,
  createRuntime,
  startTestGateway as startGateway,
  TestWs,
  ToolCallingProvider,
  waitUntil,
} from './helpers';

interface ListedInteraction {
  kind: string;
  request_id: string;
  run_id: string;
  session_id?: string;
  parent_session_id?: string;
  tool_call_id?: string;
  tool?: string;
  input?: unknown;
  questions?: unknown;
  created_at: number;
  status: string;
  answer?: { decision: string; scope: string; answered_at: number };
}

const LISTED_KEYS = new Set([
  'kind',
  'request_id',
  'run_id',
  'session_id',
  'parent_session_id',
  'tool_call_id',
  'tool',
  'input',
  'questions',
  'created_at',
  'status',
  'answer',
]);

/** 断言结果只含契约字段（不泄漏 tenant_id / 内部字段）。 */
function expectContracted(item: ListedInteraction): void {
  for (const key of Object.keys(item)) expect(LISTED_KEYS.has(key)).toBe(true);
}

function seedRecords(dir: string, tenant: string, records: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(dir, `interactions-${tenant}.json`),
    `${JSON.stringify({ version: 1, interactions: records }, null, 2)}\n`,
  );
}

function seedRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    tenant_id: 'default',
    run_id: 'run-seed',
    tool: 'bash',
    input: { command: 'ls' },
    created_at: 1000,
    status: 'pending',
    ...overrides,
  };
}

/** 构造带 danger_tool 的 gateway；工具无 checkPermission，走 runtime 默认 'ask' */
async function makePermissionGateway(interactionsDir?: string) {
  const events = new MemoryEventStream();
  const pluginHost = new MemoryPluginHost();
  pluginHost.registerTool({
    name: 'danger_tool',
    description: 'A tool that requires confirmation',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'executed',
  });
  const runtime = await createRuntime({
    events,
    pluginHost,
    provider: new ToolCallingProvider('danger_tool'),
    permission: { default: 'ask' },
  });
  const gw = createGateway({
    events,
    runtime,
    pluginHost,
    ...(interactionsDir !== undefined ? { interactionsDir } : {}),
  });
  return { events, gw };
}

function auth(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    reader: { tenant_id: 'default', role: 'read' },
    'b-reader': { tenant_id: 'b', role: 'read' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

describe('interactions.list', () => {
  const gateways: Gateway[] = [];
  const clients: TestWs[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const gw of gateways.splice(0)) void gw.stop();
    // 让 stop 里的异步持久化落盘后再删临时目录。
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'vessel-interactions-list-'));
    dirs.push(dir);
    return dir;
  };

  const connect = async (gw: Gateway, token?: string): Promise<TestWs> => {
    const client = await TestWs.connect(gw, token === undefined ? {} : { token });
    clients.push(client);
    await client.next((frame) => frame.kind === 'hello');
    return client;
  };

  const submit = async (gw: Gateway, input: string): Promise<{ run_id: string }> => {
    const res = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    expect(res.status).toBe(202);
    return (await res.json()) as { run_id: string };
  };

  it('lists a live pending permission and exposes the answer after responding', async () => {
    const dir = tempDir();
    const { gw } = await makePermissionGateway(dir);
    gateways.push(gw);
    const client = await connect(gw);

    await submit(gw, 'please run');
    const request = await client.nextEvent('tool.permission.request');
    const requestId = request.requestId as string;

    const pending = (await client.request('interactions.list', { status: 'pending' })) as {
      interactions: ListedInteraction[];
    };
    expect(pending.interactions).toHaveLength(1);
    const [item] = pending.interactions;
    if (!item) throw new Error('expected one pending interaction');
    expectContracted(item);
    expect(item).toMatchObject({
      kind: 'permission',
      request_id: requestId,
      tool: 'danger_tool',
      status: 'pending',
    });
    expect(typeof item.run_id).toBe('string');
    expect(item.run_id.length).toBeGreaterThan(0);
    expect(typeof item.created_at).toBe('number');
    // 0.13 关联字段：事件带 session_id 时必须透出，Web 才能按会话归类。
    expect(item.session_id).toBe(request.session_id as string);

    const first = (await client.request('permission.respond', {
      request_id: requestId,
      decision: 'allow',
      scope: 'session',
    })) as Record<string, unknown>;
    expect(first).toMatchObject({ ok: true, decision: 'allow', scope: 'session' });
    await client.nextEvent('run.completed');

    const answered = (await client.request('interactions.list', {})) as {
      interactions: ListedInteraction[];
    };
    expect(answered.interactions).toHaveLength(1);
    expect(answered.interactions[0]).toMatchObject({
      request_id: requestId,
      status: 'answered',
      answer: { decision: 'allow', scope: 'session' },
    });
    expect(typeof answered.interactions[0]?.answer?.answered_at).toBe('number');

    // 幂等：重复应答沿用第一次结果，记录保持 answered。
    const repeat = (await client.request('permission.respond', {
      request_id: requestId,
      decision: 'allow',
    })) as Record<string, unknown>;
    expect(repeat).toMatchObject({ ok: true, duplicate: true, scope: 'session' });
    const afterRepeat = (await client.request('interactions.list', {
      status: 'answered',
    })) as { interactions: ListedInteraction[] };
    expect(afterRepeat.interactions).toHaveLength(1);
  });

  it('keeps pending visible as orphaned after a restart on the same store', async () => {
    const dir = tempDir();
    const first = await makePermissionGateway(dir);
    gateways.push(first.gw);
    // 只用 REST 提交，不建 WS：Bun 的 server.stop(true) 在有过 WS 连接时不 settle。
    await submit(first.gw, 'please run');

    const path = join(dir, 'interactions-default.json');
    await waitUntil(
      () => existsSync(path) && readFileSync(path, 'utf8').includes('"status": "pending"'),
    );
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
      interactions: Array<{ requestId: string }>;
    };
    const requestId = persisted.interactions[0]?.requestId;
    if (requestId === undefined) throw new Error('expected a persisted pending interaction');

    await first.gw.stop();
    gateways.splice(gateways.indexOf(first.gw), 1);

    // 新 engine + 同一 store：pending 没有对应 run，必须转 orphaned 且仍可列出。
    const second = await makePermissionGateway(dir);
    gateways.push(second.gw);
    const secondClient = await connect(second.gw);

    const listed = (await secondClient.request('interactions.list', {})) as {
      interactions: ListedInteraction[];
    };
    expect(listed.interactions).toHaveLength(1);
    expect(listed.interactions[0]).toMatchObject({
      request_id: requestId,
      status: 'orphaned',
    });

    // UI 需要看到“已失效”：迟到的应答明确返回 run_ended，而不是 not_found。
    let message = '';
    try {
      await secondClient.request('permission.respond', {
        request_id: requestId,
        decision: 'allow',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('run_ended');
  });

  it('scopes results to the connection tenant and supports filters', async () => {
    const dir = tempDir();
    seedRecords(dir, 'default', [
      seedRecord({ requestId: 'req-d', run_id: 'run-1', session_id: 's-1' }),
    ]);
    seedRecords(dir, 'b', [
      seedRecord({ requestId: 'req-b', run_id: 'run-b', tenant_id: 'b', session_id: 's-b' }),
    ]);

    const events = new MemoryEventStream();
    const gw = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: auth(),
      interactionsDir: dir,
    });
    gateways.push(gw);

    const defaultClient = await connect(gw, 'reader');
    const defaultList = (await defaultClient.request('interactions.list', {})) as {
      interactions: ListedInteraction[];
    };
    expect(defaultList.interactions.map((item) => item.request_id)).toEqual(['req-d']);
    // 启动时无 run 的 pending 一律 orphaned，且不过滤掉。
    expect(defaultList.interactions[0]?.status).toBe('orphaned');

    const tenantB = await connect(gw, 'b-reader');
    const bList = (await tenantB.request('interactions.list', {})) as {
      interactions: ListedInteraction[];
    };
    expect(bList.interactions.map((item) => item.request_id)).toEqual(['req-b']);
    expect(bList.interactions[0]?.session_id).toBe('s-b');

    let crossTenant = '';
    try {
      await tenantB.request('interactions.list', { tenant_id: 'default' });
    } catch (error) {
      crossTenant = error instanceof Error ? error.message : String(error);
    }
    expect(crossTenant).toContain('forbidden');
  });

  it('filters by session_id, run_id and status, and honors limit', async () => {
    const dir = tempDir();
    seedRecords(dir, 'default', [
      seedRecord({ requestId: 'req-1', run_id: 'run-1', session_id: 's-1', created_at: 1000 }),
      seedRecord({
        requestId: 'req-2',
        run_id: 'run-2',
        session_id: 's-2',
        created_at: 2000,
        status: 'answered',
        answer: { decision: 'deny', scope: 'once', answered_at: 2500 },
      }),
      seedRecord({
        requestId: 'req-3',
        run_id: 'run-1',
        session_id: 's-1',
        created_at: 3000,
        status: 'orphaned',
      }),
    ]);

    const events = new MemoryEventStream();
    const gw = startGateway({ events, port: 0, interactionsDir: dir });
    gateways.push(gw);
    const client = await connect(gw);

    const list = async (params: Record<string, unknown>) =>
      (
        (await client.request('interactions.list', params)) as {
          interactions: ListedInteraction[];
        }
      ).interactions;

    expect((await list({})).map((item) => item.request_id)).toEqual(['req-3', 'req-2', 'req-1']);
    expect((await list({ session_id: 's-1' })).map((item) => item.request_id)).toEqual([
      'req-3',
      'req-1',
    ]);
    expect((await list({ run_id: 'run-2' })).map((item) => item.request_id)).toEqual(['req-2']);
    const answered = await list({ status: 'answered' });
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      request_id: 'req-2',
      status: 'answered',
      answer: { decision: 'deny', scope: 'once', answered_at: 2500 },
    });
    expect(await list({ status: 'pending' })).toEqual([]);
    expect((await list({ limit: 1 })).map((item) => item.request_id)).toEqual(['req-3']);

    let invalid = '';
    try {
      await client.request('interactions.list', { limit: 0 });
    } catch (error) {
      invalid = error instanceof Error ? error.message : String(error);
    }
    expect(invalid).toContain('limit');
  });

  it('exposes parent_session_id from persisted records and omits it for legacy records', async () => {
    const dir = tempDir();
    seedRecords(dir, 'default', [
      seedRecord({
        requestId: 'req-child',
        session_id: 'member-session',
        parent_session_id: 'parent-session',
      }),
      seedRecord({ requestId: 'req-legacy', session_id: 'legacy-session' }),
    ]);

    const gw = startGateway({ events: new MemoryEventStream(), port: 0, interactionsDir: dir });
    gateways.push(gw);
    const client = await connect(gw);

    const listed = (await client.request('interactions.list', {})) as {
      interactions: ListedInteraction[];
    };
    expect(listed.interactions).toHaveLength(2);

    const child = listed.interactions.find((item) => item.request_id === 'req-child');
    if (!child) throw new Error('expected req-child');
    expectContracted(child);
    expect(child.parent_session_id).toBe('parent-session');
    expect(child.session_id).toBe('member-session');

    // 旧文件没有该字段：不得凭空补 null / undefined。
    const legacy = listed.interactions.find((item) => item.request_id === 'req-legacy');
    if (!legacy) throw new Error('expected req-legacy');
    expectContracted(legacy);
    expect(legacy).not.toHaveProperty('parent_session_id');

    // session_id 过滤仍只匹配 item.session_id，不匹配 parent。
    const byParent = (await client.request('interactions.list', {
      session_id: 'parent-session',
    })) as { interactions: ListedInteraction[] };
    expect(byParent.interactions).toEqual([]);
  });

  it('exposes parent_session_id from a live permission request event', async () => {
    const events = new MemoryEventStream();
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'bridge_tool',
      description: 'Publishes a bridged permission request',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const requestId = crypto.randomUUID();
        ctx.events.publish({
          type: 'tool.permission.request',
          run_id: ctx.run_id,
          data: {
            requestId,
            tool: 'bridge_tool',
            input: {},
            session_id: 'member-session',
            parent_session_id: 'parent-session',
          },
          ts: Date.now(),
        });
        await ctx.events.waitFor('tool.permission.response', { requestId, timeout: 5000 });
        return 'answered';
      },
    });
    const runtime = await createRuntime({
      events,
      pluginHost,
      provider: new ToolCallingProvider('bridge_tool'),
      permission: { default: 'allow' },
    });
    const gw = createGateway({ events, runtime, pluginHost });
    gateways.push(gw);
    const client = await connect(gw);

    await submit(gw, 'bridge please');
    const request = await client.nextEvent('tool.permission.request');

    const pending = (await client.request('interactions.list', { status: 'pending' })) as {
      interactions: ListedInteraction[];
    };
    const item = pending.interactions.find(
      (entry) => entry.request_id === (request.requestId as string),
    );
    if (!item) throw new Error('expected a pending bridged permission');
    expectContracted(item);
    expect(item.session_id).toBe('member-session');
    expect(item.parent_session_id).toBe('parent-session');
    expect(item.status).toBe('pending');

    await client.request('permission.respond', {
      request_id: request.requestId,
      decision: 'allow',
    });
    await client.nextEvent('run.completed');

    const answered = (await client.request('interactions.list', {})) as {
      interactions: ListedInteraction[];
    };
    expect(answered.interactions[0]).toMatchObject({
      request_id: request.requestId as string,
      parent_session_id: 'parent-session',
      status: 'answered',
    });
  });

  it('lists pending asks and keeps answered asks with their answers', async () => {
    const events = new MemoryEventStream();
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'ask_tool',
      description: 'Ask the user',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const requestId = crypto.randomUUID();
        ctx.events.publish({
          type: 'ask.user.requested',
          run_id: ctx.run_id,
          data: {
            requestId,
            questions: [{ header: 'Q', question: 'value?' }],
          },
          ts: Date.now(),
        });
        await ctx.events.waitFor('ask.user.answered', { requestId, timeout: 5000 });
        return 'answered';
      },
    });
    const runtime = await createRuntime({
      events,
      pluginHost,
      provider: new ToolCallingProvider('ask_tool'),
      permission: { default: 'allow' },
    });
    const gw = createGateway({ events, runtime, pluginHost });
    gateways.push(gw);
    const client = await connect(gw);

    await submit(gw, 'ask me');
    const request = await client.nextEvent('ask.user.requested');

    const listed = (await client.request('interactions.list', { status: 'pending' })) as {
      interactions: ListedInteraction[];
    };
    const ask = listed.interactions.find((item) => item.kind === 'ask');
    if (!ask) throw new Error('expected a pending ask');
    expect(ask).toMatchObject({
      request_id: request.requestId as string,
      status: 'pending',
    });
    expect(typeof ask.run_id).toBe('string');
    expect(ask.questions).toEqual([{ header: 'Q', question: 'value?' }]);
    expectContracted(ask);

    await client.request('ask.respond', {
      request_id: request.requestId,
      answers: [{ header: 'Q', question: 'value?', answer: '42' }],
    });
    await client.nextEvent('run.completed');

    // 0.19 S4：ask 与权限共享持久化生命周期；应答后保留 answered 与回答。
    const after = (await client.request('interactions.list', {})) as {
      interactions: ListedInteraction[];
    };
    const answered = after.interactions.filter((item) => item.kind === 'ask');
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      request_id: request.requestId as string,
      status: 'answered',
      answer: {
        answered_by: 'human',
        answered_via: 'rpc',
        answers: [{ header: 'Q', question: 'value?', answer: '42' }],
      },
    });
  });

  it('cursor paging drops or duplicates rows when created_at ties', async () => {
    const dir = tempDir();
    seedRecords(dir, 'default', [
      seedRecord({ requestId: 'req-a', created_at: 1000 }),
      seedRecord({ requestId: 'req-b', created_at: 2000 }),
      seedRecord({ requestId: 'req-c', created_at: 2000 }),
      seedRecord({ requestId: 'req-f', created_at: 2000 }),
      seedRecord({ requestId: 'req-d', created_at: 3000 }),
      seedRecord({ requestId: 'req-e', created_at: 3000 }),
    ]);

    const gw = startGateway({ events: new MemoryEventStream(), port: 0, interactionsDir: dir });
    gateways.push(gw);
    const client = await connect(gw);

    const walk = async (order: 'oldest' | 'newest') => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = (await client.request('interactions.list', {
          order,
          limit: 2,
          ...(cursor !== undefined ? { cursor } : {}),
        })) as {
          interactions: ListedInteraction[];
          total: number;
          next_cursor?: string;
        };
        expect(result.total).toBe(6);
        seen.push(...result.interactions.map((item) => item.request_id));
        if (result.next_cursor === undefined) return seen;
        expect(result.interactions).toHaveLength(2);
        cursor = result.next_cursor;
      }
      throw new Error('pagination did not terminate');
    };

    // 同 created_at 的条目按 request_id 升序，翻页边界不得重复或跳过。
    expect(await walk('newest')).toEqual(['req-d', 'req-e', 'req-b', 'req-c', 'req-f', 'req-a']);
    expect(await walk('oldest')).toEqual(['req-a', 'req-b', 'req-c', 'req-f', 'req-d', 'req-e']);
  });

  it('total shrinks to the page size when limit or cursor is applied', async () => {
    const dir = tempDir();
    seedRecords(dir, 'default', [
      seedRecord({ requestId: 'req-1', created_at: 1000 }),
      seedRecord({ requestId: 'req-2', created_at: 2000 }),
      seedRecord({
        requestId: 'req-3',
        created_at: 3000,
        status: 'answered',
        answer: { decision: 'deny', scope: 'once', answered_at: 3500 },
      }),
    ]);

    const gw = startGateway({ events: new MemoryEventStream(), port: 0, interactionsDir: dir });
    gateways.push(gw);
    const client = await connect(gw);

    const first = (await client.request('interactions.list', {
      status: 'orphaned',
      limit: 1,
    })) as { interactions: ListedInteraction[]; total: number; next_cursor?: string };
    // total 是过滤后的总数（两条 pending 启动时转 orphaned），不随 limit 缩小。
    expect(first.total).toBe(2);
    expect(first.interactions).toHaveLength(1);
    if (first.next_cursor === undefined) throw new Error('expected a next_cursor');

    const second = (await client.request('interactions.list', {
      status: 'orphaned',
      limit: 1,
      cursor: first.next_cursor,
    })) as { interactions: ListedInteraction[]; total: number; next_cursor?: string };
    expect(second.total).toBe(2);
    expect(second.interactions).toHaveLength(1);
    expect(second.next_cursor).toBeUndefined();

    const answered = (await client.request('interactions.list', {
      status: 'answered',
      limit: 1,
    })) as { interactions: ListedInteraction[]; total: number; next_cursor?: string };
    expect(answered.total).toBe(1);
    expect(answered.next_cursor).toBeUndefined();
  });

  it('a cursor from another order or a malformed cursor is rejected', async () => {
    const dir = tempDir();
    seedRecords(dir, 'default', [
      seedRecord({ requestId: 'req-1', created_at: 1000 }),
      seedRecord({ requestId: 'req-2', created_at: 2000 }),
    ]);

    const gw = startGateway({ events: new MemoryEventStream(), port: 0, interactionsDir: dir });
    gateways.push(gw);
    const client = await connect(gw);

    const newest = (await client.request('interactions.list', {
      order: 'newest',
      limit: 1,
    })) as { next_cursor?: string };
    if (newest.next_cursor === undefined) throw new Error('expected a next_cursor');

    const errorFor = async (params: Record<string, unknown>): Promise<string> => {
      try {
        await client.request('interactions.list', params);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return '';
    };

    // 换序后沿用旧 cursor 必须报错，不能静默返回另一页。
    const switched = await errorFor({ order: 'oldest', cursor: newest.next_cursor });
    expect(switched).toContain('invalid_params');
    expect(switched).toContain('invalid cursor');

    const garbage = await errorFor({ cursor: 'not-a-cursor' });
    expect(garbage).toContain('invalid_params');
    expect(garbage).toContain('invalid cursor');

    const wrongShape = await errorFor({
      cursor: Buffer.from(JSON.stringify({ o: 'newest', t: 'x', r: 'req-1' }), 'utf8').toString(
        'base64url',
      ),
    });
    expect(wrongShape).toContain('invalid_params');
    expect(wrongShape).toContain('invalid cursor');
  });

  it('a cli attribution persisted on disk is dropped after restart', async () => {
    const dir = tempDir();
    seedRecords(dir, 'default', [
      seedRecord({
        requestId: 'req-cli',
        status: 'answered',
        answer: {
          decision: 'allow',
          scope: 'once',
          answered_at: 1500,
          answered_by: 'human',
          answered_via: 'cli',
        },
      }),
    ]);

    const gw = startGateway({ events: new MemoryEventStream(), port: 0, interactionsDir: dir });
    gateways.push(gw);
    const client = await connect(gw);

    const listed = (await client.request('interactions.list', {})) as {
      interactions: ListedInteraction[];
    };
    expect(listed.interactions[0]?.answer).toMatchObject({ answered_via: 'cli' });
  });

  it('cli answers are written back as rpc when answered_via is dropped', async () => {
    const dir = tempDir();
    const { gw } = await makePermissionGateway(dir);
    gateways.push(gw);
    const client = await connect(gw);

    await submit(gw, 'please run');
    const cliRequest = await client.nextEvent('tool.permission.request');
    const cliId = cliRequest.requestId as string;
    const cliResult = (await client.request('permission.respond', {
      request_id: cliId,
      decision: 'allow',
      answered_via: 'cli',
    })) as Record<string, unknown>;
    expect(cliResult).toMatchObject({ answered_by: 'human', answered_via: 'cli' });
    await client.nextEvent('run.completed');

    await submit(gw, 'please run again');
    const rpcRequest = await client.nextEvent('tool.permission.request');
    const rpcId = rpcRequest.requestId as string;
    const rpcResult = (await client.request('permission.respond', {
      request_id: rpcId,
      decision: 'deny',
    })) as Record<string, unknown>;
    expect(rpcResult).toMatchObject({ answered_by: 'human', answered_via: 'rpc' });
    await client.nextEvent('run.completed');

    const listed = (await client.request('interactions.list', {})) as {
      interactions: ListedInteraction[];
    };
    const listedById = new Map(listed.interactions.map((item) => [item.request_id, item]));
    expect(listedById.get(cliId)?.answer).toMatchObject({ answered_via: 'cli' });
    expect(listedById.get(rpcId)?.answer).toMatchObject({ answered_via: 'rpc' });

    const path = join(dir, 'interactions-default.json');
    await waitUntil(() => {
      if (!existsSync(path)) return false;
      const raw = readFileSync(path, 'utf8');
      return raw.includes('"answered_via": "cli"') && raw.includes('"answered_via": "rpc"');
    });
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
      interactions: Array<{ requestId: string; answer?: { answered_via?: string } }>;
    };
    const persistedById = new Map(persisted.interactions.map((item) => [item.requestId, item]));
    expect(persistedById.get(cliId)?.answer?.answered_via).toBe('cli');
    expect(persistedById.get(rpcId)?.answer?.answered_via).toBe('rpc');
  });
});
