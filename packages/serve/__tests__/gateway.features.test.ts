import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import type { EvalReport } from '../src/evals';
import type { FeishuStatus } from '../src/feishu';
import type { Gateway } from '../src/gateway';
import type { MetricsSnapshot } from '../src/metrics';
import type { WorkflowGatewayOptions } from '../src/workflow';
import { createGateway, startTestGateway as startGateway } from './helpers';

const BASE_FEATURES = ['events.replay', 'permissions', 'tools', 'static', 'runs.async'];

function workflows(): WorkflowGatewayOptions {
  return {
    async listRuns() {
      return [];
    },
    async getRun() {
      return null;
    },
    async start() {
      return {
        workflowRunId: 'wf_1',
        done: Promise.resolve({ workflow_run_id: 'wf_1', status: 'completed' as const }),
      };
    },
    async resume() {
      return {
        workflowRunId: 'wf_1',
        done: Promise.resolve({ workflow_run_id: 'wf_1', status: 'completed' as const }),
      };
    },
    async cancel() {},
    resolveDefinition() {
      return undefined;
    },
  };
}

const metrics = (): MetricsSnapshot => ({
  runs: { started: 0, completed: 0, failed: 0, cancelled: 0 },
  tool_calls: { total: 0, failed: 0 },
  llm: { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  duration_ms: { total: 0, max: 0, avg: 0 },
  updated_at: 0,
});

const feishu = {
  status: (): FeishuStatus => ({
    connected: false,
    appIdMasked: '',
    active_chats: 0,
    queued_messages: 0,
  }),
};

const evals = {
  latest: async (_suite: string): Promise<EvalReport | null> => null,
};

describe('gateway feature advertisement', () => {
  const gateways: Gateway[] = [];

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('keeps the 0.3 feature list when nothing new is injected', () => {
    const gw = createGateway({ events: new MemoryEventStream() });
    gateways.push(gw);
    expect(gw.protocol.features).toEqual(BASE_FEATURES);
  });

  it('adds workflow, evals, feishu and metrics in a stable order', () => {
    const gw = createGateway({
      events: new MemoryEventStream(),
      workflows: workflows(),
      evals,
      feishu,
      metrics,
    });
    gateways.push(gw);
    expect(gw.protocol.features).toEqual([
      ...BASE_FEATURES,
      'workflow',
      'evals',
      'feishu',
      'metrics',
    ]);
  });

  it('advertises only injected capabilities individually', () => {
    const gw = createGateway({ events: new MemoryEventStream(), metrics });
    gateways.push(gw);
    expect(gw.protocol.features).toEqual([...BASE_FEATURES, 'metrics']);
  });

  it('uses the same features in /v1/health', async () => {
    const gw = createGateway({ events: new MemoryEventStream(), feishu });
    gateways.push(gw);
    const res = await fetch(`${gw.url}/v1/health`, {
      headers: { Authorization: `Bearer ${gw.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { protocol: { features: string[] } };
    expect(body.protocol.features).toEqual(gw.protocol.features);
  });

  it('treats maxHistory=0 as the bounded default and rejects negatives', () => {
    const gw = createGateway({ events: new MemoryEventStream(), maxHistory: 0 });
    gateways.push(gw);
    expect(gw.port).toBeGreaterThan(0);

    expect(() =>
      startGateway({ events: new MemoryEventStream(), port: 0, maxHistory: -1 }),
    ).toThrow();
  });
});
