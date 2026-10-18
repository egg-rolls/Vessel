import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { MemoryEventStream, MemoryLLMProvider } from '../../packages/core/src/index';
import type {
  EvalReport,
  EvalRunnerLike,
  EvalRunOptionsLike,
  EvalsModuleLike,
} from '../control-plane-types';
import {
  createEvalsRunner,
  evalError,
  executeEvalSuite,
  isNetworkAllowed,
  latestEvalReport,
  resolveEvalsOptions,
} from '../eval-wiring';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-04-eval-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function report(overrides: Partial<EvalReport> = {}): EvalReport {
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
    ...overrides,
  };
}

function fakeRunner(overrides: Partial<EvalRunnerLike> = {}) {
  const calls: Array<{ suitePath: string; options?: EvalRunOptionsLike }> = [];
  const runner: EvalRunnerLike = {
    runSuite: async (suitePath, options) => {
      calls.push({ suitePath, ...(options ? { options } : {}) });
      return report();
    },
    getLatest: async () => report(),
    ...overrides,
  };
  const mod: EvalsModuleLike = {
    createEvalsPlugin: () => ({
      name: 'evals',
      version: '0.3.0',
      install() {},
      runSuite: runner.runSuite,
      getLatest: runner.getLatest,
    }),
  };
  return { calls, runner, mod };
}

function setupSuite(): { base: string; suiteDir: string; suitePath: string } {
  const base = tmpDir();
  const suiteDir = path.join(base, 'suites');
  fs.mkdirSync(suiteDir);
  const suitePath = path.join(suiteDir, 'smoke.yaml');
  fs.writeFileSync(suitePath, 'name: smoke\ncases: []\n');
  return { base, suiteDir, suitePath };
}

function config(overrides: Partial<VesselConfig> = {}): VesselConfig {
  return { evals: { enabled: true }, ...overrides };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('resolveEvalsOptions', () => {
  it('applies defaults and resolves paths', () => {
    const options = resolveEvalsOptions({});
    expect(options.enabled).toBe(false);
    expect(options.allowNetwork).toBe(false);
    expect(options.dir).toBe(path.resolve('./evals'));
    expect(options.outDir).toBe(path.join(os.homedir(), '.vessel/evals'));
  });
});

describe('createEvalsRunner', () => {
  it('rejects when disabled', async () => {
    let loaded = 0;
    const error = await codeOf(
      createEvalsRunner({
        config: {},
        loadModule: async () => {
          loaded++;
          return null;
        },
      }),
    );
    expect(error).toBe('eval_invalid');
    expect(loaded).toBe(0);
  });

  it('rejects when the module is missing', async () => {
    const error = await codeOf(
      createEvalsRunner({ config: config(), loadModule: async () => null }),
    );
    expect(error).toBe('eval_invalid');
  });

  it('passes tenantId, events, and the tenant outDir', async () => {
    const tenantDir = path.join(tmpDir(), 'tenants', 'acme');
    const events = new MemoryEventStream();
    let pluginOptions: Parameters<EvalsModuleLike['createEvalsPlugin']>[0] | undefined;
    const mod: EvalsModuleLike = {
      createEvalsPlugin: (options) => {
        pluginOptions = options;
        return {
          name: 'evals',
          version: '0.3.0',
          install() {},
          runSuite: async () => report(),
          getLatest: async () => null,
        };
      },
    };

    await createEvalsRunner({
      config: config(),
      tenantId: 'acme',
      tenantDir,
      events,
      loadModule: async () => mod,
    });

    expect(pluginOptions?.outDir).toBe(path.join(tenantDir, 'evals'));
    expect(pluginOptions?.tenantId).toBe('acme');
    expect(pluginOptions?.events).toBe(events);
  });
});

describe('isNetworkAllowed (double gate)', () => {
  it('requires both config and CLI', () => {
    expect(isNetworkAllowed({ evals: { allowNetwork: true } }, true)).toBe(true);
    expect(isNetworkAllowed({ evals: { allowNetwork: true } }, false)).toBe(false);
    expect(isNetworkAllowed({ evals: { allowNetwork: false } }, true)).toBe(false);
    expect(isNetworkAllowed({}, true)).toBe(false);
  });
});

describe('executeEvalSuite', () => {
  it('runs offline by default and passes report options', async () => {
    const { base, suiteDir, suitePath } = setupSuite();
    const { calls, mod } = fakeRunner();
    const outDir = path.join(base, 'reports');

    const result = await executeEvalSuite({
      config: config({ evals: { enabled: true, dir: suiteDir, outDir } }),
      target: 'smoke',
      filters: ['smoke', 'fast'],
      out: path.join(base, 'custom.json'),
      allowNetwork: false,
      loadModule: async () => mod,
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.suitePath).toBe(fs.realpathSync(suitePath));
    expect(calls[0]?.options).toEqual({
      outDir,
      outPath: path.join(base, 'custom.json'),
      filterTags: ['smoke', 'fast'],
      allowNetwork: false,
    });
  });

  it('defaults the report outDir to <tenant>/evals', async () => {
    const { suiteDir } = setupSuite();
    const { calls, mod } = fakeRunner();
    const tenantDir = path.join(tmpDir(), 'tenants', 'acme');

    await executeEvalSuite({
      config: config({ evals: { enabled: true, dir: suiteDir } }),
      target: 'smoke',
      filters: [],
      allowNetwork: false,
      tenantId: 'acme',
      tenantDir,
      loadModule: async () => mod,
    });

    expect(calls[0]?.options?.outDir).toBe(path.join(tenantDir, 'evals'));
  });

  it('config true + CLI flag false stays offline', async () => {
    const { suiteDir } = setupSuite();
    const { calls, mod } = fakeRunner();

    const result = await executeEvalSuite({
      config: config({ evals: { enabled: true, dir: suiteDir, allowNetwork: true } }),
      target: 'smoke',
      allowNetwork: false,
      loadModule: async () => mod,
    });

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.options?.allowNetwork).toBe(false);
  });

  it('CLI flag true + config false -> eval_network_required', async () => {
    const { suiteDir } = setupSuite();
    const { calls, mod } = fakeRunner();

    const error = await codeOf(
      executeEvalSuite({
        config: config({ evals: { enabled: true, dir: suiteDir } }),
        target: 'smoke',
        allowNetwork: true,
        provider: new MemoryLLMProvider(),
        loadModule: async () => mod,
      }),
    );
    expect(error).toBe('eval_network_required');
    expect(calls).toHaveLength(0);
  });

  it('both gates true + provider -> network run', async () => {
    const { suiteDir } = setupSuite();
    const { calls, mod } = fakeRunner();
    const provider = new MemoryLLMProvider();

    const result = await executeEvalSuite({
      config: config({ evals: { enabled: true, dir: suiteDir, allowNetwork: true } }),
      target: 'smoke',
      allowNetwork: true,
      provider,
      loadModule: async () => mod,
    });

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.options?.allowNetwork).toBe(true);
    expect(calls[0]?.options?.providerFactory?.()).toBe(provider);
  });

  it('both gates true without provider -> eval_network_required', async () => {
    const { suiteDir } = setupSuite();
    const { mod } = fakeRunner();
    const error = await codeOf(
      executeEvalSuite({
        config: config({ evals: { enabled: true, dir: suiteDir, allowNetwork: true } }),
        target: 'smoke',
        allowNetwork: true,
        loadModule: async () => mod,
      }),
    );
    expect(error).toBe('eval_network_required');
  });

  it('missing suite -> eval_not_found', async () => {
    const { suiteDir } = setupSuite();
    const { mod } = fakeRunner();
    const error = await codeOf(
      executeEvalSuite({
        config: config({ evals: { enabled: true, dir: suiteDir } }),
        target: 'missing',
        allowNetwork: false,
        loadModule: async () => mod,
      }),
    );
    expect(error).toBe('eval_not_found');
  });

  it('exit code is 1 when any case failed or errored', async () => {
    const { suiteDir } = setupSuite();
    const failed = fakeRunner({ runSuite: async () => report({ failed: 1 }) });
    const errored = fakeRunner({ runSuite: async () => report({ errors: 1 }) });

    const failedResult = await executeEvalSuite({
      config: config({ evals: { enabled: true, dir: suiteDir } }),
      target: 'smoke',
      allowNetwork: false,
      loadModule: async () => failed.mod,
    });
    const erroredResult = await executeEvalSuite({
      config: config({ evals: { enabled: true, dir: suiteDir } }),
      target: 'smoke',
      allowNetwork: false,
      loadModule: async () => errored.mod,
    });

    expect(failedResult.exitCode).toBe(1);
    expect(erroredResult.exitCode).toBe(1);
  });

  it('does not write report files itself (ext owns report.ts)', async () => {
    const { base, suiteDir } = setupSuite();
    const outDir = path.join(base, 'reports');
    const { mod } = fakeRunner();

    await executeEvalSuite({
      config: config({ evals: { enabled: true, dir: suiteDir, outDir } }),
      target: 'smoke',
      allowNetwork: false,
      loadModule: async () => mod,
    });

    expect(fs.existsSync(outDir)).toBe(false);
  });
});

describe('latestEvalReport', () => {
  it('uses getLatest for a safe suite', async () => {
    const { mod } = fakeRunner();
    await expect(
      latestEvalReport({ config: config(), loadModule: async () => mod }, 'smoke'),
    ).resolves.toEqual(report());

    const getLatestOnly: EvalsModuleLike = {
      createEvalsPlugin: () => ({
        name: 'evals',
        version: '0.3.0',
        install() {},
        runSuite: async () => report(),
        getLatest: async () => report({ total: 2 }),
      }),
    };
    await expect(
      latestEvalReport({ config: config(), loadModule: async () => getLatestOnly }, 'smoke'),
    ).resolves.toEqual(report({ total: 2 }));
  });

  it('returns null for disabled / unsafe suite / missing module', async () => {
    const { mod } = fakeRunner();
    await expect(
      latestEvalReport({ config: {}, loadModule: async () => mod }, 'smoke'),
    ).resolves.toBeNull();
    await expect(
      latestEvalReport({ config: config(), loadModule: async () => mod }, '../smoke'),
    ).resolves.toBeNull();
    await expect(
      latestEvalReport({ config: config(), loadModule: async () => null }, 'smoke'),
    ).resolves.toBeNull();
  });
});

describe('evalError', () => {
  it('carries a stable code', () => {
    const error = evalError('eval_invalid', 'bad');
    expect(error.code).toBe('eval_invalid');
  });
});
