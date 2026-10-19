import { describe, expect, it } from 'bun:test';
import {
  buildConfigDetailView,
  buildConfigSourcesTableView,
  configDetailActions,
  runConfigCommand,
  runConfigViewAction,
} from '../src/commands/config-command.js';
import {
  buildTenantDetailView,
  buildTenantListView,
  runTenantCommand,
  runTenantViewAction,
  tenantListActions,
} from '../src/commands/tenant-command.js';
import {
  buildTraceView,
  decodeTraceViewKey,
  encodeTraceViewKey,
  runTraceCommand,
  runTraceViewAction,
  type TraceOptions,
} from '../src/commands/trace-command.js';
import type { RpcClientLike, TenantSummaryLike } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const NOW = 1_700_000_000_000;

const CONFIG_SNAPSHOT = {
  schema_version: 1,
  config: {
    provider: { name: 'openai', model: 'gpt-4', baseUrl: 'https://api.openai.com' },
    dataDir: '~/.vessel/data',
    session: { backend: 'file' },
    trace: { enabled: true, level: 'full', retentionDays: 30 },
    tenant: { default: 'default' },
  },
  sources: { 'provider.name': 'user', 'session.backend': 'default' },
  paths: { user: '/home/u/.vessel/config.yaml', project: './vessel.yaml' },
  tenant_id: 'default',
  tenant_overlay_keys: ['session.backend'],
  validation: { errors: [], warnings: [] },
};

const TENANTS: TenantSummaryLike[] = [
  {
    tenant_id: 'acme',
    name: 'Acme',
    created_at: NOW - 60_000,
    status: 'disabled',
    quota: { max_sessions: 10, max_runs_per_day: 5 },
  },
  { tenant_id: 'default', name: 'Default', created_at: NOW - 3_600_000, status: 'active' },
];

const TRACE_EVENTS = [
  { type: 'run.started', run_id: 'r1', seq: 1, ts: NOW - 3000, data: {} },
  {
    type: 'tool.call.started',
    run_id: 'r1',
    seq: 2,
    ts: NOW - 1000,
    data: { tool_name: 'bash', args: { token: 'secret-token' } },
  },
];

function makeRpc(handler: (method: string, params?: unknown) => unknown): RpcClientLike {
  return {
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      return (await handler(method, params)) as T;
    },
    subscribe: () => () => undefined,
  };
}

describe('/config view mapping', () => {
  it('详情分区 provider/session/trace/paths，s 切 sources', () => {
    const view = buildConfigDetailView(CONFIG_SNAPSHOT, 'show');
    expect(view.kind).toBe('detail');
    expect(view.key).toBe('detail');
    expect(view.sections.map((section) => section.title)).toEqual([
      'Provider',
      'Session',
      'Trace',
      'Paths',
    ]);
    expect(view.sections[0]?.fields?.find((field) => field.label === 'name')?.value).toBe('openai');
    expect(configDetailActions('show').map((action) => action.key)).toEqual(['s', 'r']);
    expect(configDetailActions('path').map((action) => action.key)).toEqual(['r']);
    expect(buildConfigDetailView(CONFIG_SNAPSHOT, 'path').key).toBe('paths');
  });

  it('sources 表格逐叶子键 + 来源 + tenant overlay', () => {
    const view = buildConfigSourcesTableView(CONFIG_SNAPSHOT);
    expect(view.kind).toBe('table');
    expect(view.key).toBe('sources');
    const backend = view.rows.find((row) => row.key === 'session.backend');
    expect(backend?.cells.source).toBe('default');
    expect(backend?.cells.overlay).toBe('+tenant');
    expect(view.actions?.map((action) => action.key)).toEqual(['s', 'r']);
  });

  it('命令返回详情；--json 不返回 view；path 返回 paths 详情', async () => {
    const ctx = makeCtx({
      rpc: makeRpc((method) => {
        if (method === 'config.get') return CONFIG_SNAPSHOT;
        if (method === 'config.sources') return { sources: { 'provider.model': 'project' } };
        throw new Error(`unexpected ${method}`);
      }),
    });
    expect((await runConfigCommand([], ctx)).view?.view.kind).toBe('detail');
    expect((await runConfigCommand(['path'], ctx)).view?.view).toMatchObject({ key: 'paths' });
    expect((await runConfigCommand(['--json'], ctx)).view).toBeUndefined();
  });

  it('viewAction s 在详情与 sources 表格间切换', async () => {
    const ctx = makeCtx({
      rpc: makeRpc((method) => {
        if (method === 'config.get') return CONFIG_SNAPSHOT;
        if (method === 'config.sources') return {};
        throw new Error(`unexpected ${method}`);
      }),
    });
    const toSources = await runConfigViewAction(
      { actionId: 'sources', selectionKey: '', viewKind: 'detail', viewKey: 'detail' },
      ctx,
    );
    expect(toSources.view?.view.kind).toBe('table');

    const toDetail = await runConfigViewAction(
      { actionId: 'sources', selectionKey: '', viewKind: 'table', viewKey: 'sources' },
      ctx,
    );
    expect(toDetail.view?.view.kind).toBe('detail');
  });
});

describe('/tenant view mapping', () => {
  it('列表表格标记当前 tenant 并带 quota', () => {
    const view = buildTenantListView(TENANTS, 'default', NOW);
    expect(view.kind).toBe('table');
    expect(view.rows.map((row) => row.key)).toEqual(['acme', 'default']);
    expect(view.rows[0]?.cells.quota).toContain('runs/day<=5');
    expect(view.rows[1]?.current).toBe(true);
    expect(view.rows[1]?.cells.tenant).toContain('(active)');
    expect(tenantListActions().map((action) => action.key)).toEqual(['enter', 'r']);
  });

  it('详情字段包含 data_dir / status / quota', () => {
    const view = buildTenantDetailView('acme', '/data/acme', TENANTS[0], NOW);
    expect(view.key).toBe('acme');
    expect(view.badge?.text).toBe('disabled');
    const fields = view.sections[0]?.fields ?? [];
    expect(fields.find((field) => field.label === 'data_dir')?.value).toBe('/data/acme');
    expect(fields.find((field) => field.label === 'quota')?.value).toContain('sessions<=10');
  });

  it('命令返回 current 详情与 list 表格；use 仍为纯文本', async () => {
    const ctx = makeCtx({
      tenant: { tenant_id: 'acme' },
      rpc: makeRpc((method) => {
        if (method === 'tenants.get') return { tenant: TENANTS[0] };
        if (method === 'tenants.list') return { tenants: TENANTS };
        throw new Error(`unexpected ${method}`);
      }),
    });
    expect((await runTenantCommand([], ctx)).view?.view.kind).toBe('detail');
    expect((await runTenantCommand(['list'], ctx)).view?.view.kind).toBe('table');
    expect((await runTenantCommand(['use', 'default'], ctx)).view).toBeUndefined();
  });

  it('viewAction Enter 打开租户详情、r 刷新表格', async () => {
    const ctx = makeCtx({
      rpc: makeRpc((method) => {
        if (method === 'tenants.get') return { tenant: TENANTS[0] };
        if (method === 'tenants.list') return { tenants: TENANTS };
        throw new Error(`unexpected ${method}`);
      }),
    });
    const detail = await runTenantViewAction(
      { actionId: 'inspect', selectionKey: 'acme', viewKind: 'table' },
      ctx,
    );
    expect(detail.view?.view).toMatchObject({ kind: 'detail', key: 'acme' });

    const refreshed = await runTenantViewAction(
      { actionId: 'refresh', selectionKey: '', viewKind: 'table' },
      ctx,
    );
    expect(refreshed.view?.view.kind).toBe('table');
  });
});

describe('/trace view mapping', () => {
  const options: TraceOptions = { runId: 'r1', limit: 50, json: false };

  it('表格包含 seq/time/type/data 与刷新动作；key 可往返', () => {
    const view = buildTraceView(TRACE_EVENTS, options, NOW);
    expect(view.kind).toBe('table');
    expect(view.rows.map((row) => row.cells.seq)).toEqual(['#1', '#2']);
    expect(view.rows[1]?.cells.type).toBe('tool.call.started');
    expect(view.rows[1]?.cells.data).toContain('***');
    expect(view.rows[1]?.cells.data).not.toContain('secret-token');
    expect(view.actions?.map((action) => action.key)).toEqual(['r']);

    const decoded = decodeTraceViewKey(encodeTraceViewKey(options));
    expect(decoded).toEqual({ runId: 'r1', limit: 50, json: false });
    expect(decodeTraceViewKey('not-json')).toBeNull();
    expect(decodeTraceViewKey(undefined)).toBeNull();
  });

  it('保留 since-seq / types / type 前缀', () => {
    const decoded = decodeTraceViewKey(
      encodeTraceViewKey({
        runId: 'r1',
        limit: 10,
        sinceSeq: 5,
        types: ['run.started'],
        json: true,
      }),
    );
    expect(decoded).toMatchObject({ runId: 'r1', limit: 10, sinceSeq: 5, types: ['run.started'] });
    expect(decoded?.json).toBe(false);
  });

  it('命令返回表格；空结果也有视图；--json 无视图', async () => {
    const ctx = makeCtx({
      rpc: makeRpc(() => TRACE_EVENTS),
    });
    expect((await runTraceCommand(['show', 'r1'], ctx)).view?.view.kind).toBe('table');
    expect((await runTraceCommand(['show', 'r1', '--json'], ctx)).view).toBeUndefined();

    const emptyCtx = makeCtx({ rpc: makeRpc(() => []) });
    expect((await runTraceCommand(['show', 'r1'], emptyCtx)).view?.view.kind).toBe('table');
  });

  it('viewAction r 用同一组参数刷新', async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const ctx = makeCtx({
      rpc: makeRpc((method, params) => {
        calls.push({ method, params });
        return TRACE_EVENTS;
      }),
    });
    const key = encodeTraceViewKey({ runId: 'r1', limit: 10, sinceSeq: 5, json: false });
    const result = await runTraceViewAction(
      { actionId: 'refresh', selectionKey: '', viewKind: 'table', viewKey: key },
      ctx,
    );
    expect(result.view?.view.kind).toBe('table');
    expect(calls[0]).toEqual({
      method: 'events.list',
      params: { run_id: 'r1', limit: 10, since_seq: 5 },
    });
  });
});
