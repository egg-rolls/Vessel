import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import {
  GuardrailStage,
  MemoryEventStream,
  MemoryPluginHost,
  type RunnableAgent,
  type RuntimeHost,
} from '../../packages/core/src/index';
import type {
  WorkflowEngineLike,
  WorkflowEngineOptionsLike,
  WorkflowModuleLike,
} from '../control-plane-types';
import {
  adaptWorkflowsControl,
  checkWorkflowDir,
  createWorkflowControlsAdapter,
  createWorkflowControlsOnly,
  createWorkflowFromConfig,
  WorkflowPluginUnavailableError,
  workflowError,
} from '../workflow-wiring';
import { canonicalPath } from './path-helpers';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-04-wf-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeEngine() {
  const calls = {
    start: [] as Array<{ definitionPath: string; inputs?: Record<string, string> }>,
    resume: [] as string[],
    cancel: [] as string[],
    close: 0,
    interruptAll: 0,
  };

  const engine = {
    name: 'workflow',
    version: '0.3.0',
    description: 'fake',
    install() {},
    listRuns: async () => [],
    getRun: async () => null,
    start: async (definitionPath: string, opts?: { inputs?: Record<string, string> }) => {
      calls.start.push({ definitionPath, ...(opts ? { inputs: opts.inputs } : {}) });
      return {
        workflowRunId: 'wf_1',
        done: Promise.resolve({ workflow_run_id: 'wf_1', status: 'completed' as const }),
      };
    },
    resume: async (id: string) => {
      calls.resume.push(id);
      return {
        workflowRunId: id,
        done: Promise.resolve({ workflow_run_id: id, status: 'completed' as const }),
      };
    },
    cancel: async (id: string) => {
      calls.cancel.push(id);
    },
    close: async () => {
      calls.close++;
    },
    interruptAll: async () => {
      calls.interruptAll++;
    },
  };

  return { engine: engine as unknown as WorkflowEngineLike, calls };
}

function fakeModule(engine: WorkflowEngineLike) {
  const created: WorkflowEngineOptionsLike[] = [];
  const mod: WorkflowModuleLike = {
    createWorkflowEngine(options) {
      created.push(options);
      return engine;
    },
  };
  return { created, mod };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('createWorkflowFromConfig', () => {
  it('disabled: does not load or construct', async () => {
    let loaded = 0;
    const result = await createWorkflowFromConfig({
      config: {},
      events: new MemoryEventStream(),
      pluginHost: new MemoryPluginHost(),
      loadModule: async () => {
        loaded++;
        return null;
      },
    });
    expect(result).toBeUndefined();
    expect(loaded).toBe(0);
  });

  it('enabled: passes frozen options and creates store dir', async () => {
    const base = tmpDir();
    const dir = path.join(base, 'defs');
    fs.mkdirSync(dir);
    const store = path.join(base, 'runs');
    const { engine } = makeEngine();
    const { created, mod } = fakeModule(engine);

    const config: VesselConfig = {
      workflow: {
        enabled: true,
        dir,
        path: store,
        maxParallel: 3,
        stepTimeoutMs: 1234,
      },
    };
    const events = new MemoryEventStream();
    const pluginHost = new MemoryPluginHost();
    const host = { get: () => undefined } as unknown as RuntimeHost;
    const runtime = { run: async () => '' } as unknown as RunnableAgent;

    const result = await createWorkflowFromConfig({
      config,
      events,
      pluginHost,
      host,
      runtime,
      loadModule: async () => mod,
    });

    expect(result).toBe(engine);
    expect(created).toHaveLength(1);
    const { toolPipeline, ...engineOptions } = created[0] as WorkflowEngineOptionsLike;
    expect(engineOptions).toEqual({
      host,
      runtime,
      pluginHost,
      config: {
        enabled: true,
        dir: path.resolve(dir),
        path: path.resolve(store),
        maxParallel: 3,
        stepTimeoutMs: 1234,
      },
      events,
    });
    expect(toolPipeline).toBeDefined();
    expect(fs.statSync(store).isDirectory()).toBe(true);
  });

  it('injects an executable pipeline that enforces guardrails and permission', async () => {
    const base = tmpDir();
    const dir = path.join(base, 'defs');
    fs.mkdirSync(dir);
    const events = new MemoryEventStream();
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args) => `ok:${JSON.stringify(args)}`,
    });
    pluginHost.registerTool({
      name: 'denied',
      description: 'denied by permission',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'should not run',
      checkPermission: async () => 'deny',
    });
    pluginHost.registerGuardrail({
      name: 'block-echo',
      stage: GuardrailStage.ToolCall,
      check: async (value) => {
        const call = value as { function?: { name?: string } };
        return call.function?.name === 'echo'
          ? { allowed: false, reason: 'echo blocked' }
          : { allowed: true };
      },
    });

    const { engine } = makeEngine();
    const { created, mod } = fakeModule(engine);
    await createWorkflowFromConfig({
      config: { workflow: { enabled: true, dir, path: path.join(base, 'runs') } },
      events,
      pluginHost,
      permission: { default: 'allow' },
      loadModule: async () => mod,
    });

    const pipeline = created[0]?.toolPipeline;
    expect(pipeline).toBeDefined();
    if (!pipeline) return;

    const blocked = await pipeline.execute({
      runId: 'run-1',
      sessionId: 'session-1',
      toolCall: { id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } },
      args: {},
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.content).toContain('guardrail');

    const denied = await pipeline.execute({
      runId: 'run-1',
      sessionId: 'session-1',
      toolCall: { id: 'call-2', type: 'function', function: { name: 'denied', arguments: '{}' } },
      args: {},
    });
    expect(denied.ok).toBe(false);
    expect(denied.content).toContain('denied by permission policy');
  });

  it('passes tenantId and defaults the store to <tenant>/workflows', async () => {
    const base = tmpDir();
    const dir = path.join(base, 'defs');
    fs.mkdirSync(dir);
    const tenantDir = path.join(base, 'tenants', 'acme');
    const { engine } = makeEngine();
    const { created, mod } = fakeModule(engine);

    await createWorkflowFromConfig({
      config: { workflow: { enabled: true, dir } },
      events: new MemoryEventStream(),
      pluginHost: new MemoryPluginHost(),
      tenantId: 'acme',
      tenantDir,
      loadModule: async () => mod,
    });

    expect(created[0]?.tenantId).toBe('acme');
    expect(created[0]?.config.path).toBe(path.join(tenantDir, 'workflows'));
    expect(fs.statSync(path.join(tenantDir, 'workflows')).isDirectory()).toBe(true);
  });

  it('missing workflow.dir -> workflow_invalid', async () => {
    const base = tmpDir();
    const { engine } = makeEngine();
    const { mod } = fakeModule(engine);

    const error = await codeOf(
      createWorkflowFromConfig({
        config: { workflow: { enabled: true, dir: path.join(base, 'missing') } },
        events: new MemoryEventStream(),
        pluginHost: new MemoryPluginHost(),
        loadModule: async () => mod,
      }),
    );
    expect(error).toBe('workflow_invalid');
  });

  it('missing module -> WorkflowPluginUnavailableError', async () => {
    const base = tmpDir();
    const dir = path.join(base, 'defs');
    fs.mkdirSync(dir);

    await expect(
      createWorkflowFromConfig({
        config: { workflow: { enabled: true, dir, path: path.join(base, 'runs') } },
        events: new MemoryEventStream(),
        pluginHost: new MemoryPluginHost(),
        loadModule: async () => null,
      }),
    ).rejects.toBeInstanceOf(WorkflowPluginUnavailableError);
  });
});

describe('controls-only', () => {
  it('constructs without host/runtime and guards start/resume', async () => {
    const base = tmpDir();
    const dir = path.join(base, 'defs');
    fs.mkdirSync(dir);
    const { engine, calls } = makeEngine();
    const { created, mod } = fakeModule(engine);

    const controls = await createWorkflowControlsOnly({
      config: { workflow: { enabled: true, dir, path: path.join(base, 'runs') } },
      events: new MemoryEventStream(),
      pluginHost: new MemoryPluginHost(),
      loadModule: async () => mod,
    });

    expect(controls).toBe(engine);
    expect(created[0]).not.toHaveProperty('host');
    expect(created[0]).not.toHaveProperty('runtime');

    const adapter = createWorkflowControlsAdapter(engine, { hasExecution: false });
    await expect(adapter.listRuns()).resolves.toEqual([]);
    await adapter.cancel('wf_1');
    expect(calls.cancel).toEqual(['wf_1']);

    expect(await codeOf(adapter.start('/tmp/x.yaml'))).toBe('workflow_disabled');
    expect(await codeOf(adapter.resume('wf_1'))).toBe('workflow_disabled');
  });

  it('hasExecution=true delegates start/resume', async () => {
    const { engine, calls } = makeEngine();
    const adapter = createWorkflowControlsAdapter(engine, { hasExecution: true });
    const started = await adapter.start('/tmp/x.yaml', { inputs: { a: '1' } });
    expect(started.workflowRunId).toBe('wf_1');
    expect(calls.start).toEqual([{ definitionPath: '/tmp/x.yaml', inputs: { a: '1' } }]);
    await adapter.resume('wf_1');
    expect(calls.resume).toEqual(['wf_1']);
  });
});

describe('adaptWorkflowsControl (TUI name version)', () => {
  it('resolves names under workflow.dir before calling engine.start', async () => {
    const base = tmpDir();
    const dir = path.join(base, 'defs');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'demo.yaml'), 'name: demo\nsteps: []\n');
    const { engine, calls } = makeEngine();
    const cfg: VesselConfig = { workflow: { enabled: true, dir, path: path.join(base, 'runs') } };

    const control = adaptWorkflowsControl(engine, cfg);
    await control.start('demo', { inputs: { x: 'y' } });

    expect(calls.start).toHaveLength(1);
    expect(calls.start[0]?.definitionPath).toBe(canonicalPath(path.join(dir, 'demo.yaml')));
    expect(calls.start[0]?.inputs).toEqual({ x: 'y' });
  });

  it('maps missing / unsafe names to stable codes', async () => {
    const base = tmpDir();
    const dir = path.join(base, 'defs');
    fs.mkdirSync(dir);
    const { engine } = makeEngine();
    const cfg: VesselConfig = { workflow: { enabled: true, dir, path: path.join(base, 'runs') } };
    const control = adaptWorkflowsControl(engine, cfg);

    expect(await codeOf(control.start('missing'))).toBe('workflow_not_found');
    expect(await codeOf(control.start('../evil'))).toBe('workflow_invalid');
    expect(await codeOf(control.start('a.b'))).toBe('workflow_invalid');
  });
});

describe('checkWorkflowDir', () => {
  it('reports missing and non-directory paths', async () => {
    const base = tmpDir();
    expect((await checkWorkflowDir({ workflow: { dir: path.join(base, 'missing') } })).ok).toBe(
      false,
    );

    const file = path.join(base, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect((await checkWorkflowDir({ workflow: { dir: file } })).ok).toBe(false);
  });

  it('accepts an existing directory', async () => {
    const dir = tmpDir();
    const result = await checkWorkflowDir({ workflow: { dir } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dir).toBe(path.resolve(dir));
  });
});

describe('workflowError', () => {
  it('carries a stable code', () => {
    const error = workflowError('workflow_invalid', 'bad');
    expect(error.code).toBe('workflow_invalid');
    expect(error.message).toContain('workflow_invalid');
  });
});
