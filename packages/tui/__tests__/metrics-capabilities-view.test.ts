import { describe, expect, it } from 'bun:test';
import {
  buildCapabilitiesDetailView,
  nextCapabilityTab,
  runCapabilitiesCommand,
  runCapabilitiesViewAction,
  unavailableCapabilitiesView,
} from '../src/commands/capabilities-command.js';
import {
  buildMetricsDetailView,
  metricsActions,
  runMetricsCommand,
  runMetricsViewAction,
} from '../src/commands/metrics-command.js';
import type {
  CapabilityManifestLike,
  MetricsSnapshotLike,
  RpcClientLike,
} from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const NOW = 1_700_000_000_000;

const SNAPSHOT: MetricsSnapshotLike = {
  runs: { started: 13, completed: 10, failed: 1, cancelled: 2 },
  tool_calls: { total: 34, failed: 2 },
  llm: { requests: 5, prompt_tokens: 800, completion_tokens: 434, total_tokens: 1234 },
  duration_ms: { total: 6400, avg: 3200, max: 5000 },
  updated_at: NOW - 30_000,
};

const MANIFEST: CapabilityManifestLike = {
  version: '0.6.0',
  config_schema_version: 1,
  methods: [
    { name: 'runs.list', permission: 'read' },
    { name: 'runs.resume', permission: 'write' },
    { name: 'tenants.create', permission: 'admin' },
  ],
  tools: [{ name: 'bash', description: 'Run a shell command' }],
  plugins: [
    { name: 'demo', enabled: true },
    { name: 'feishu', enabled: false },
  ],
};

function makeRpc(handler: (method: string, params?: unknown) => unknown): RpcClientLike {
  return {
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      return (await handler(method, params)) as T;
    },
    subscribe: () => () => undefined,
  };
}

describe('/metrics view mapping', () => {
  it('详情按 runs/tools/llm/duration 分区，r 刷新始终可用', () => {
    const view = buildMetricsDetailView(SNAPSHOT, 'live', { now: NOW });
    expect(view.kind).toBe('detail');
    expect(view.badge?.text).toBe('live');
    expect(view.key).toBe('live');
    const titles = view.sections.map((section) => section.title);
    expect(titles).toEqual(['Overview', 'Runs', 'Tools', 'LLM', 'Duration']);
    const runs = view.sections[1]?.fields ?? [];
    expect(runs.find((field) => field.label === 'Started')?.value).toBe('13');
    expect(runs.find((field) => field.label === 'Cancelled')?.tone).toBe('warn');
    expect(view.sections[4]?.fields?.find((field) => field.label === 'Avg')?.value).toBe('3200ms');
    expect(view.sections[0]?.fields?.find((field) => field.label === 'Updated')?.value).toBe(
      '30s ago',
    );
    expect(metricsActions(false).map((action) => action.key)).toEqual(['r']);
    expect(metricsActions(true).map((action) => action.key)).toEqual(['r', 't']);
  });

  it('命令返回详情视图；--json 不返回 view', async () => {
    const ctx = makeCtx();
    ctx.metrics = () => SNAPSHOT;
    const result = await runMetricsCommand([], ctx);
    expect(result.view?.source).toBe('metrics');
    expect(result.view?.view.kind).toBe('detail');

    const json = await runMetricsCommand(['--json'], ctx);
    expect(json.view).toBeUndefined();
    expect(JSON.parse((json.output ?? '').trim()).runs.started).toBe(13);
  });

  it('r 刷新走同一数据源；t 在 RPC 下切换 live/trace', async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const ctx = makeCtx({
      rpc: makeRpc((method, params) => {
        calls.push({ method, params });
        return params && (params as { source?: string }).source === 'trace'
          ? { ...SNAPSHOT, runs: { ...SNAPSHOT.runs, started: 99 } }
          : SNAPSHOT;
      }),
    });

    const refreshed = await runMetricsViewAction(
      { actionId: 'refresh', selectionKey: '', viewKind: 'detail', viewKey: 'live' },
      ctx,
    );
    expect(refreshed.view?.view.kind).toBe('detail');
    expect(calls.at(-1)).toEqual({ method: 'metrics.get', params: { source: 'live' } });

    const toggled = await runMetricsViewAction(
      { actionId: 'source', selectionKey: '', viewKind: 'detail', viewKey: 'live' },
      ctx,
    );
    const toggledView = toggled.view?.view;
    expect(toggledView?.kind).toBe('detail');
    if (toggledView?.kind === 'detail') expect(toggledView.badge?.text).toBe('trace');
    expect(calls.at(-1)).toEqual({ method: 'metrics.get', params: { source: 'trace' } });
  });
});

describe('/capabilities view mapping', () => {
  it('summary 包含三节预览与计数；t 按固定顺序循环', () => {
    const view = buildCapabilitiesDetailView(MANIFEST, 'summary');
    expect(view.kind).toBe('detail');
    expect(view.badge?.text).toContain('0.6.0');
    expect(view.key).toBe('summary');
    expect(view.sections.map((section) => section.title)).toEqual([
      'Overview',
      'Methods',
      'Tools',
      'Plugins',
    ]);
    const overview = view.sections[0]?.fields ?? [];
    expect(overview.find((field) => field.label === 'Methods')?.value).toContain(
      'read 1 / write 1 / admin 1',
    );
    expect(overview.find((field) => field.label === 'Plugins')?.value).toContain('enabled 1');
    expect(nextCapabilityTab('summary')).toBe('methods');
    expect(nextCapabilityTab('plugins')).toBe('summary');
  });

  it('单节视图只渲染对应 section', () => {
    const methods = buildCapabilitiesDetailView(MANIFEST, 'methods');
    expect(methods.key).toBe('methods');
    expect(methods.sections.some((section) => section.title === 'Methods')).toBe(true);
    expect(methods.sections.some((section) => section.title === 'Tools')).toBe(false);
    expect(methods.sections[1]?.lines?.join('\n')).toContain('runs.resume [write]');
  });

  it('命令返回详情；无 RPC 时返回不可用详情', async () => {
    const loaded = await runCapabilitiesCommand([], makeCtx({ rpc: makeRpc(() => MANIFEST) }));
    expect(loaded.view?.view.kind).toBe('detail');

    const unavailable = await runCapabilitiesCommand([], makeCtx());
    expect(unavailable.view?.view).toEqual(unavailableCapabilitiesView());
    expect(unavailable.output).toContain('RPC control plane is not available');
  });

  it('viewAction t 切节、r 刷新', async () => {
    const ctx = makeCtx({ rpc: makeRpc(() => MANIFEST) });
    const cycled = await runCapabilitiesViewAction(
      { actionId: 'cycle', selectionKey: '', viewKind: 'detail', viewKey: 'summary' },
      ctx,
    );
    expect(cycled.view?.view).toMatchObject({ kind: 'detail', key: 'methods' });

    const refreshed = await runCapabilitiesViewAction(
      { actionId: 'refresh', selectionKey: '', viewKind: 'detail', viewKey: 'tools' },
      ctx,
    );
    expect(refreshed.view?.view).toMatchObject({ kind: 'detail', key: 'tools' });
  });
});
