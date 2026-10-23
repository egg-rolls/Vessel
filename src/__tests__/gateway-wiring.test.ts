import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import type { EvalReport, FeishuChannelLike, MetricsControlLike } from '../control-plane-types';
import { buildGatewayControlPlane } from '../gateway-wiring';
import type { PluginLoader } from '../plugin-loader';

function fakeMetrics(): MetricsControlLike {
  return {
    snapshot: () => ({
      runs: { started: 1, completed: 0, failed: 0, cancelled: 0 },
      tool_calls: { total: 0, failed: 0 },
      llm: { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      duration_ms: { total: 0, max: 0, avg: 0 },
      updated_at: 1,
    }),
    dispose: () => {},
  };
}

function fakeFeishu(): FeishuChannelLike {
  return {
    start: async () => {},
    stop: async () => {},
    status: () => ({
      connected: true,
      appIdMasked: 'cli_***',
      active_chats: 2,
      queued_messages: 0,
    }),
  };
}

function report(): EvalReport {
  return {
    suite: 'smoke',
    network: false,
    started_at: 1,
    finished_at: 2,
    duration_ms: 1,
    total: 1,
    passed: 1,
    failed: 0,
    errors: 0,
    skipped: 0,
    cases: [],
  };
}

describe('buildGatewayControlPlane', () => {
  it('returns an empty object when nothing is enabled', () => {
    expect(buildGatewayControlPlane({ config: {} })).toEqual({});
  });

  it('injects metrics / feishu with frozen shapes', () => {
    const metrics = fakeMetrics();
    const feishu = fakeFeishu();
    const controlPlane = buildGatewayControlPlane({
      config: {},
      metrics,
      feishu,
    });

    // web MetricsProvider 是函数
    expect(typeof controlPlane.metrics).toBe('function');
    const metricsInjected = controlPlane.metrics as () => unknown;
    expect(metricsInjected()).toEqual(metrics.snapshot());

    const feishuInjected = controlPlane.feishu as { status(): unknown };
    expect(feishuInjected.status()).toEqual(feishu.status());
  });

  it('passes per-tenant feishu accessor through', () => {
    const feishu = fakeFeishu();
    const controlPlane = buildGatewayControlPlane({
      config: {},
      feishuFor: (tenantId) => (tenantId === 'acme' ? feishu : undefined),
    });

    const feishuFor = controlPlane.feishuFor as (tenantId: string) => unknown;
    expect(feishuFor('acme')).toBe(feishu);
    expect(feishuFor('work')).toBeUndefined();
  });

  it('injects evals.latest only when enabled', async () => {
    const disabled = buildGatewayControlPlane({ config: {} });
    expect(disabled.evals).toBeUndefined();

    const mod = {
      createEvalsPlugin: () => ({
        name: 'evals',
        version: '0.3.0',
        install() {},
        runSuite: async () => report(),
        getLatest: async () => report(),
      }),
    };
    const loader = {
      loadModule: async () => mod,
    } as unknown as PluginLoader;

    const config: VesselConfig = { evals: { enabled: true } };
    const controlPlane = buildGatewayControlPlane({ config, loader });
    const evals = controlPlane.evals as {
      latest(suite: string): Promise<EvalReport | null>;
    };

    await expect(evals.latest('smoke')).resolves.toEqual(report());
    await expect(evals.latest('../smoke')).resolves.toBeNull();
  });
});
