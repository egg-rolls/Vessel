import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EvalCommand } from '../cli-args';
import type {
  EvalReport,
  EvalRunnerLike,
  EvalRunOptionsLike,
  EvalsModuleLike,
} from '../control-plane-types';
import { runEvalCommand } from '../eval-command';

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VESSEL_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-04-evalcmd-'));
  dirs.push(dir);
  return dir;
}

function yamlPath(value: string): string {
  return value.replaceAll('\\', '/');
}

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

function setup(overrides: { enabled?: boolean; allowNetwork?: boolean } = {}): {
  base: string;
  configPath: string;
  userConfigPath: string;
  suiteDir: string;
  outDir: string;
} {
  const base = tmpDir();
  const suiteDir = path.join(base, 'evals');
  fs.mkdirSync(suiteDir);
  fs.writeFileSync(path.join(suiteDir, 'smoke.yaml'), 'name: smoke\ncases: []\n');
  const outDir = path.join(base, 'reports');
  const configPath = path.join(base, 'vessel.yaml');
  fs.writeFileSync(
    configPath,
    [
      'provider:',
      '  name: openai',
      '  model: gpt-4',
      'evals:',
      `  enabled: ${overrides.enabled ?? true}`,
      `  dir: ${yamlPath(suiteDir)}`,
      `  out_dir: ${yamlPath(outDir)}`,
      `  allow_network: ${overrides.allowNetwork ?? false}`,
    ].join('\n'),
  );
  return {
    base,
    configPath,
    userConfigPath: path.join(base, 'missing-user.yaml'),
    suiteDir,
    outDir,
  };
}

function fakeModule(runner: Partial<EvalRunnerLike> = {}) {
  const calls: EvalRunOptionsLike[] = [];
  const fullRunner: EvalRunnerLike = {
    runSuite: async (options) => {
      calls.push(options);
      return report();
    },
    getLatest: async () => report(),
    ...runner,
  };
  const mod: EvalsModuleLike = {
    createEvalsPlugin: () => ({
      plugin: { name: 'evals', version: '0.3.0', install() {} },
      runner: fullRunner,
    }),
  };
  return { calls, mod, loadModule: async () => mod };
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = original;
  }
}

const baseCommand: EvalCommand = {
  target: 'smoke',
  json: false,
  filters: [],
  allowNetwork: false,
};

describe('eval command', () => {
  it('disabled -> exit 2', async () => {
    const { configPath, userConfigPath } = setup({ enabled: false });
    const code = await runEvalCommand(baseCommand, {
      configPath,
      userConfigPath,
      loadEvalsModule: fakeModule().loadModule,
    });
    expect(code).toBe(2);
  });

  it('offline run passes outDir/filters/out to the runner', async () => {
    const { base, configPath, userConfigPath, outDir } = setup();
    const { calls, loadModule } = fakeModule();
    const out = path.join(base, 'custom.json');

    const code = await runEvalCommand(
      { ...baseCommand, filters: ['smoke', 'fast'], out },
      { configPath, userConfigPath, loadEvalsModule: loadModule },
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.outDir).toBe(outDir);
    expect(calls[0]?.out).toBe(out);
    expect(calls[0]?.filters).toEqual(['smoke', 'fast']);
    expect(calls[0]?.network).toBe(false);
  });

  it('CLI flag without config allow_network -> exit 2', async () => {
    const { configPath, userConfigPath } = setup({ allowNetwork: false });
    const { calls, loadModule } = fakeModule();

    const code = await runEvalCommand(
      { ...baseCommand, allowNetwork: true },
      { useMock: true, configPath, userConfigPath, loadEvalsModule: loadModule },
    );

    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('both gates -> network run with a provider', async () => {
    const { configPath, userConfigPath } = setup({ allowNetwork: true });
    const { calls, loadModule } = fakeModule();

    const code = await runEvalCommand(
      { ...baseCommand, allowNetwork: true },
      { useMock: true, configPath, userConfigPath, loadEvalsModule: loadModule },
    );

    expect(code).toBe(0);
    expect(calls[0]?.network).toBe(true);
    expect(calls[0]?.provider).toBeDefined();
  });

  it('failed cases -> exit 1', async () => {
    const { configPath, userConfigPath } = setup();
    const { loadModule } = fakeModule({
      runSuite: async () => report({ failed: 1, passed: 0 }),
    });

    const code = await runEvalCommand(baseCommand, {
      configPath,
      userConfigPath,
      loadEvalsModule: loadModule,
    });
    expect(code).toBe(1);
  });

  it('missing suite -> exit 2', async () => {
    const { configPath, userConfigPath } = setup();
    const code = await runEvalCommand(
      { ...baseCommand, target: 'missing' },
      { configPath, userConfigPath, loadEvalsModule: fakeModule().loadModule },
    );
    expect(code).toBe(2);
  });

  it('--json prints only the report JSON', async () => {
    const { configPath, userConfigPath } = setup();
    const { result: code, logs } = await captureLogs(() =>
      runEvalCommand(
        { ...baseCommand, json: true },
        { configPath, userConfigPath, loadEvalsModule: fakeModule().loadModule },
      ),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as EvalReport;
    expect(parsed.suite).toBe('smoke');
    expect(parsed.total).toBe(1);
  });

  it('invalid config -> exit 2', async () => {
    const base = tmpDir();
    const configPath = path.join(base, 'vessel.yaml');
    fs.writeFileSync(configPath, 'evals:\n  enabled: true\n  max_members: 4\n');
    const code = await runEvalCommand(baseCommand, {
      configPath,
      userConfigPath: path.join(base, 'missing-user.yaml'),
      loadEvalsModule: fakeModule().loadModule,
    });
    expect(code).toBe(2);
  });
});
