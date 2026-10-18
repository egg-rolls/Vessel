import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type {
  EvalReport,
  FeishuChannelLike,
  MetricsControlLike,
  WorkflowEngineLike,
} from '../control-plane-types';
import { buildGatewayControlPlane } from '../gateway-wiring';
import type { PluginLoader } from '../plugin-loader';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-04-gw-'));
  dirs.push(dir);
  return dir;
}

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

function fakeEngine(): WorkflowEngineLike {
  return {
    name: 'workflow',
    version: '0.3.0',
    install() {},
    listRuns: async () => [],
    getRun: async () => null,
    start: async () => {
      throw new Error('not used');
    },
    resume: async () => {
      throw new Error('not used');
    },
    cancel: async () => {},
    close: async () => {},
    interruptAll: async () => {},
  } as unknown as WorkflowEngineLike;
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

    const metricsInjected = controlPlane.metrics as { snapshot(): unknown };
    expect(metricsInjected.snapshot()).toEqual(metrics.snapshot());

    const feishuInjected = controlPlane.feishu as { status(): unknown };
    expect(feishuInjected.status()).toEqual(feishu.status());
  });

  it('injects engine controls and a synchronous resolveDefinition', () => {
    const base = tmpDir();
    const defs = path.join(base, 'defs');
    fs.mkdirSync(defs);
    const demo = path.join(defs, 'demo.yaml');
    fs.writeFileSync(demo, 'name: demo\nsteps: []\n');

    const config: VesselConfig = {
      workflow: { enabled: true, dir: defs, path: path.join(base, 'runs') },
    };
    const engine = fakeEngine();
    const controlPlane = buildGatewayControlPlane({ config, workflows: engine });

    const workflows = controlPlane.workflows as {
      controls: WorkflowEngineLike;
      resolveDefinition(name: string): string | undefined;
    };
    expect(workflows.controls).toBe(engine);
    expect(workflows.resolveDefinition('demo')).toBe(fs.realpathSync(demo));
    expect(workflows.resolveDefinition('missing')).toBeUndefined();
    expect(workflows.resolveDefinition('../demo')).toBeUndefined();
    expect(workflows.resolveDefinition('a/b')).toBeUndefined();
  });

  it('injects evals.latest only when enabled', async () => {
    const disabled = buildGatewayControlPlane({ config: {} });
    expect(disabled.evals).toBeUndefined();

    const mod = {
      createEvalsPlugin: () => ({
        plugin: { name: 'evals', version: '0.3.0', install() {} },
        runner: {
          runSuite: async () => report(),
          getLatest: async () => report(),
        },
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
