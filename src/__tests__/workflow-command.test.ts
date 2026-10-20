import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkflowEngineLike, WorkflowOutcome } from '../control-plane-types';
import { runWorkflowCommand } from '../workflow-command';
import { canonicalPath } from './path-helpers';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-04-wfcmd-'));
  dirs.push(dir);
  return dir;
}

function yamlPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function setup(overrides: { enabled?: boolean } = {}): {
  base: string;
  configPath: string;
  userConfigPath: string;
  defs: string;
} {
  const base = tmpDir();
  const defs = path.join(base, 'defs');
  fs.mkdirSync(defs);
  fs.writeFileSync(path.join(defs, 'demo.yaml'), 'name: demo\nsteps: []\n');
  const configPath = path.join(base, 'vessel.yaml');
  const enabled = overrides.enabled ?? true;
  fs.writeFileSync(
    configPath,
    [
      'provider:',
      '  name: openai',
      '  model: gpt-4',
      'workflow:',
      `  enabled: ${enabled}`,
      `  dir: ${yamlPath(defs)}`,
      `  path: ${yamlPath(path.join(base, 'runs'))}`,
    ].join('\n'),
  );
  return {
    base,
    configPath,
    userConfigPath: path.join(base, 'missing-user.yaml'),
    defs,
  };
}

function makeEngine(overrides: Partial<WorkflowEngineLike> = {}): WorkflowEngineLike {
  return {
    name: 'workflow',
    version: '0.3.0',
    description: 'fake',
    install() {},
    listRuns: async () => [
      {
        workflow_run_id: 'wf_1',
        workflow_name: 'demo',
        status: 'completed',
        step_count: 1,
        completed_steps: 1,
        started_at: 1,
        updated_at: 2,
      },
    ],
    getRun: async () => null,
    start: async () => ({
      workflowRunId: 'wf_1',
      done: Promise.resolve({
        workflow_run_id: 'wf_1',
        status: 'completed',
      }) as Promise<WorkflowOutcome>,
    }),
    resume: async (id: string) => ({
      workflowRunId: id,
      done: Promise.resolve({
        workflow_run_id: id,
        status: 'completed',
      }) as Promise<WorkflowOutcome>,
    }),
    cancel: async () => {},
    close: async () => {},
    interruptAll: async () => {},
    ...overrides,
  } as unknown as WorkflowEngineLike;
}

function moduleFor(engine: WorkflowEngineLike) {
  return async () => ({ createWorkflowEngine: () => engine });
}

describe('workflow command - controls only', () => {
  it('disabled -> exit 2', async () => {
    const { configPath, userConfigPath } = setup({ enabled: false });
    const code = await runWorkflowCommand(
      { kind: 'list' },
      { configPath, userConfigPath, loadWorkflowModule: moduleFor(makeEngine()) },
    );
    expect(code).toBe(2);
  });

  it('list works without API key and prints runs', async () => {
    const { configPath, userConfigPath } = setup();
    const code = await runWorkflowCommand(
      { kind: 'list', status: 'completed', limit: 10 },
      { configPath, userConfigPath, loadWorkflowModule: moduleFor(makeEngine()) },
    );
    expect(code).toBe(0);
  });

  it('show missing -> exit 1', async () => {
    const { configPath, userConfigPath } = setup();
    const code = await runWorkflowCommand(
      { kind: 'show', workflowRunId: 'missing' },
      { configPath, userConfigPath, loadWorkflowModule: moduleFor(makeEngine()) },
    );
    expect(code).toBe(1);
  });

  it('show found -> exit 0', async () => {
    const { configPath, userConfigPath } = setup();
    const engine = makeEngine({
      getRun: async () => ({
        workflow_run_id: 'wf_1',
        workflow_name: 'demo',
        status: 'completed',
        step_count: 1,
        completed_steps: 1,
        started_at: 1,
        updated_at: 2,
        definition_path: '/tmp/demo.yaml',
        inputs: {},
        steps: [],
      }),
    });
    const code = await runWorkflowCommand(
      { kind: 'show', workflowRunId: 'wf_1' },
      { configPath, userConfigPath, loadWorkflowModule: moduleFor(engine) },
    );
    expect(code).toBe(0);
  });

  it('cancel success -> 0; cancel not found -> 1', async () => {
    const { configPath, userConfigPath } = setup();
    const ok = await runWorkflowCommand(
      { kind: 'cancel', workflowRunId: 'wf_1' },
      { configPath, userConfigPath, loadWorkflowModule: moduleFor(makeEngine()) },
    );
    expect(ok).toBe(0);

    const notFound = makeEngine({
      cancel: async () => {
        throw Object.assign(new Error('workflow_not_found'), { code: 'workflow_not_found' });
      },
    });
    const code = await runWorkflowCommand(
      { kind: 'cancel', workflowRunId: 'missing' },
      { configPath, userConfigPath, loadWorkflowModule: moduleFor(notFound) },
    );
    expect(code).toBe(1);
  });

  it('module missing -> exit 2', async () => {
    const { configPath, userConfigPath } = setup();
    const code = await runWorkflowCommand(
      { kind: 'list' },
      { configPath, userConfigPath, loadWorkflowModule: async () => null },
    );
    expect(code).toBe(2);
  });
});

describe('workflow command - run / resume', () => {
  it('run completed -> 0 and resolves name under workflow.dir', async () => {
    const { configPath, userConfigPath, defs } = setup();
    const started: string[] = [];
    const engine = makeEngine({
      start: async (definitionPath: string) => {
        started.push(definitionPath);
        return {
          workflowRunId: 'wf_1',
          done: Promise.resolve({
            workflow_run_id: 'wf_1',
            status: 'completed' as const,
          }),
        };
      },
    });

    const code = await runWorkflowCommand(
      { kind: 'run', target: 'demo', inputs: { a: '1' } },
      { useMock: true, configPath, userConfigPath, loadWorkflowModule: moduleFor(engine) },
    );

    expect(code).toBe(0);
    expect(started).toEqual([canonicalPath(path.join(defs, 'demo.yaml'))]);
  });

  it('run missing definition -> 2', async () => {
    const { configPath, userConfigPath } = setup();
    const code = await runWorkflowCommand(
      { kind: 'run', target: 'missing', inputs: {} },
      {
        useMock: true,
        configPath,
        userConfigPath,
        loadWorkflowModule: moduleFor(makeEngine()),
      },
    );
    expect(code).toBe(2);
  });

  it('run failed -> 1', async () => {
    const { configPath, userConfigPath } = setup();
    const engine = makeEngine({
      start: async () => ({
        workflowRunId: 'wf_1',
        done: Promise.resolve({
          workflow_run_id: 'wf_1',
          status: 'failed' as const,
          error: 'boom',
        }),
      }),
    });
    const code = await runWorkflowCommand(
      { kind: 'run', target: 'demo', inputs: {} },
      { useMock: true, configPath, userConfigPath, loadWorkflowModule: moduleFor(engine) },
    );
    expect(code).toBe(1);
  });

  it('run interrupted -> 130', async () => {
    const { configPath, userConfigPath } = setup();
    const engine = makeEngine({
      start: async () => ({
        workflowRunId: 'wf_1',
        done: Promise.resolve({
          workflow_run_id: 'wf_1',
          status: 'interrupted' as const,
        }),
      }),
    });
    const code = await runWorkflowCommand(
      { kind: 'run', target: 'demo', inputs: {} },
      { useMock: true, configPath, userConfigPath, loadWorkflowModule: moduleFor(engine) },
    );
    expect(code).toBe(130);
  });

  it('resume delegates to engine and maps completed -> 0', async () => {
    const { configPath, userConfigPath } = setup();
    const resumed: string[] = [];
    const engine = makeEngine({
      resume: async (id: string) => {
        resumed.push(id);
        return {
          workflowRunId: id,
          done: Promise.resolve({
            workflow_run_id: id,
            status: 'completed' as const,
          }),
        };
      },
    });
    const code = await runWorkflowCommand(
      { kind: 'resume', workflowRunId: 'wf_2' },
      { useMock: true, configPath, userConfigPath, loadWorkflowModule: moduleFor(engine) },
    );
    expect(code).toBe(0);
    expect(resumed).toEqual(['wf_2']);
  });

  it('resume not resumable -> 1', async () => {
    const { configPath, userConfigPath } = setup();
    const engine = makeEngine({
      resume: async () => {
        throw Object.assign(new Error('workflow_not_resumable'), {
          code: 'workflow_not_resumable',
        });
      },
    });
    const code = await runWorkflowCommand(
      { kind: 'resume', workflowRunId: 'wf_2' },
      { useMock: true, configPath, userConfigPath, loadWorkflowModule: moduleFor(engine) },
    );
    expect(code).toBe(1);
  });
});

describe('workflow command - usage', () => {});
