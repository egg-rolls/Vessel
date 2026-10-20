import { afterEach, describe, expect, it } from 'bun:test';
import type { PluginHost, ToolContext } from '@vessel-agent/core';
import { MemoryEventStream } from '@vessel-agent/core';
import { createWorkflowEngine } from '../src/engine.js';
import { WorkflowError } from '../src/errors.js';
import type { WorkflowEngine } from '../src/types.js';
import {
  createFakeAgent,
  createFakeHost,
  createPluginHost,
  delay,
  type FakeAgentResult,
  type FakeHostResult,
  makeConfig,
  makeTempWorkspace,
  registerTool,
  writeWorkflow,
} from './fixtures/fakes.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface SetupOptions {
  host?: boolean;
  runtime?: boolean;
  pluginHost?: PluginHost;
  config?: Parameters<typeof makeConfig>[2];
}

interface Setup {
  engine: WorkflowEngine;
  file: string;
  host?: FakeHostResult;
  agent?: FakeAgentResult;
  pluginHost: PluginHost;
  events: MemoryEventStream;
}

async function setup(source: string, options: SetupOptions = {}): Promise<Setup> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  const file = await writeWorkflow(workspace.dir, 'flow', source);
  const host = options.host === false ? undefined : createFakeHost();
  const agent = options.runtime ? createFakeAgent() : undefined;
  const pluginHost = options.pluginHost ?? createPluginHost();
  const events = new MemoryEventStream();
  const engine = createWorkflowEngine({
    ...(host ? { host: host.host } : {}),
    ...(agent ? { runtime: agent.agent } : {}),
    pluginHost,
    config: makeConfig(workspace.dir, workspace.runs, options.config),
    events,
  });
  return {
    engine,
    file,
    ...(host ? { host } : {}),
    ...(agent ? { agent } : {}),
    pluginHost,
    events,
  };
}

const LINEAR = `
name: linear
defaults:
  agent: owner
steps:
  - id: a
    type: agent
    prompt: one
  - id: b
    type: agent
    prompt: "two {{steps.a.output}}"
    depends_on: [a]
`;

describe('workflow engine', () => {
  it('runs a linear agent workflow and records details', async () => {
    const { engine, host, file } = await setup(LINEAR);
    host?.setAgent('owner', async (prompt) => `out:${prompt}`);

    const { workflowRunId, done } = await engine.start(file);
    const outcome = await done;
    expect(outcome.status).toBe('completed');

    const detail = await engine.getRun(workflowRunId);
    expect(detail?.status).toBe('completed');
    expect(detail?.step_count).toBe(2);
    expect(detail?.completed_steps).toBe(2);
    expect(detail?.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
    expect(detail?.steps[1]?.output_preview).toBe('out:two out:one');
    expect(host?.runs.map((run) => run.prompt)).toEqual(['one', 'two out:one']);
  });

  it('caps parallel steps and honors max_parallel', async () => {
    const source = `
name: parallel
defaults:
  agent: owner
  max_parallel: 2
steps:
  - id: a
    type: agent
    prompt: a
  - id: b
    type: agent
    prompt: b
  - id: c
    type: agent
    prompt: c
`;
    const { engine, host, file } = await setup(source, { config: { maxParallel: 2 } });
    host?.setAgent('owner', async (prompt) => {
      await delay(25);
      return prompt;
    });

    const outcome = await (await engine.start(file)).done;
    expect(outcome.status).toBe('completed');
    expect(host?.peak).toBe(2);
  });

  it('evaluates when.status and when.contains', async () => {
    const source = `
name: conditions
defaults:
  agent: owner
steps:
  - id: a
    type: agent
    prompt: a
  - id: b
    type: agent
    prompt: b
    depends_on: [a]
    when:
      step: a
      contains: ok
  - id: c
    type: agent
    prompt: c
    depends_on: [a]
    when:
      step: a
      contains: nope
`;
    const { engine, host, file } = await setup(source);
    host?.setAgent('owner', async () => 'ok');

    const outcome = await (await engine.start(file)).done;
    expect(outcome.status).toBe('completed');
    const detail = await engine.getRun(outcome.workflow_run_id);
    expect(detail?.steps.map((step) => step.status)).toEqual(['completed', 'completed', 'skipped']);
  });

  it('skips dependents without when when a dependency fails (on_error continue)', async () => {
    const source = `
name: continue
defaults:
  agent: owner
on_error: continue
steps:
  - id: a
    type: agent
    prompt: a
  - id: b
    type: agent
    prompt: b
    depends_on: [a]
  - id: c
    type: agent
    prompt: c
    depends_on: [a]
    when:
      step: a
      status: failed
`;
    const { engine, host, file } = await setup(source);
    host?.setAgent('owner', async (prompt) => {
      if (prompt === 'a') throw new Error('boom');
      return prompt;
    });

    const outcome = await (await engine.start(file)).done;
    expect(outcome.status).toBe('failed');
    const detail = await engine.getRun(outcome.workflow_run_id);
    expect(detail?.steps.map((step) => step.status)).toEqual(['failed', 'skipped', 'completed']);
  });

  it('fails fast and cancels running steps on on_error fail', async () => {
    const source = `
name: failfast
defaults:
  agent: owner
  max_parallel: 2
steps:
  - id: a
    type: agent
    prompt: fail
  - id: b
    type: agent
    prompt: slow
  - id: c
    type: agent
    prompt: pending
    depends_on: [a]
`;
    const { engine, host, file } = await setup(source, { config: { maxParallel: 2 } });
    host?.setAgent('owner', async (prompt, signal) => {
      if (prompt === 'fail') {
        await delay(10);
        throw new Error('boom');
      }
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve('late'), 1000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    });

    const outcome = await (await engine.start(file)).done;
    expect(outcome.status).toBe('failed');
    const detail = await engine.getRun(outcome.workflow_run_id);
    expect(detail?.steps.find((step) => step.id === 'a')?.status).toBe('failed');
    expect(detail?.steps.find((step) => step.id === 'b')?.status).toBe('cancelled');
    expect(detail?.steps.find((step) => step.id === 'c')?.status).toBe('skipped');
  });

  it('retries failed steps up to max_attempts', async () => {
    const source = `
name: retry
defaults:
  agent: owner
steps:
  - id: a
    type: agent
    prompt: a
    retry:
      max_attempts: 3
      backoff_ms: 0
`;
    const { engine, host, file } = await setup(source);
    let attempts = 0;
    host?.setAgent('owner', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`fail-${attempts}`);
      return 'ok';
    });

    const outcome = await (await engine.start(file)).done;
    expect(outcome.status).toBe('completed');
    const detail = await engine.getRun(outcome.workflow_run_id);
    expect(detail?.steps[0]?.status).toBe('completed');
    expect(detail?.steps[0]?.attempts).toBe(3);
  });

  it('times out a slow step', async () => {
    const source = `
name: timeout
defaults:
  agent: owner
  step_timeout_ms: 20
steps:
  - id: a
    type: agent
    prompt: slow
`;
    const { engine, host, file } = await setup(source);
    host?.setAgent('owner', async (_prompt, signal) => {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve('late'), 1000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    });

    const outcome = await (await engine.start(file)).done;
    expect(outcome.status).toBe('failed');
    const detail = await engine.getRun(outcome.workflow_run_id);
    expect(detail?.steps[0]?.status).toBe('failed');
    expect(detail?.steps[0]?.error).toContain('timed out');
  });

  it('runs tool steps with interpolated args and a synthetic ToolContext', async () => {
    const pluginHost = createPluginHost();
    let seen: { args: unknown; ctx: ToolContext } | undefined;
    registerTool(pluginHost, 'echo', async (args, ctx) => {
      seen = { args, ctx };
      return JSON.stringify(args);
    });

    const source = `
name: tool
steps:
  - id: echo
    type: tool
    tool: echo
    args:
      path: "{{inputs.repo}}"
      nested:
        value: "{{workflow.name}}"
`;
    const { engine, file } = await setup(source, { pluginHost });
    const started = await engine.start(file, { inputs: { repo: 'vessel' } });
    const outcome = await started.done;

    expect(outcome.status).toBe('completed');
    expect(seen?.args).toEqual({ path: 'vessel', nested: { value: 'tool' } });
    expect(seen?.ctx.run_id).toBe(started.workflowRunId);
    expect(seen?.ctx.session_id).toBe(started.workflowRunId);
    expect(seen?.ctx.messages).toEqual([]);
    expect(seen?.ctx.signal).toBeDefined();
  });

  it('rejects a start when a tool step references an unregistered tool', async () => {
    const source = `
name: missing-tool
steps:
  - id: a
    type: tool
    tool: nope
`;
    const { engine, file } = await setup(source);
    try {
      await engine.start(file);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe('workflow_invalid');
    }
    expect(await engine.listRuns()).toEqual([]);
  });

  it('rejects missing inputs before creating a run', async () => {
    const source = `
name: inputs
defaults:
  agent: owner
steps:
  - id: a
    type: agent
    prompt: "{{inputs.repo}}"
`;
    const { engine, host, file } = await setup(source);
    host?.setAgent('owner', async () => 'ok');
    try {
      await engine.start(file);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe('workflow_invalid');
    }
    expect(await engine.listRuns()).toEqual([]);
  });

  it('uses the single-agent fallback with workflow:<run_id> and serial execution', async () => {
    const source = `
name: fallback
defaults:
  agent: owner
  max_parallel: 4
steps:
  - id: a
    type: agent
    prompt: a
  - id: b
    type: agent
    prompt: b
`;
    const { engine, agent, file } = await setup(source, {
      host: false,
      runtime: true,
      config: { maxParallel: 4 },
    });

    const started = await engine.start(file);
    const outcome = await started.done;
    expect(outcome.status).toBe('completed');
    expect(agent?.calls.map((call) => call.sessionId)).toEqual([
      `workflow:${started.workflowRunId}`,
      `workflow:${started.workflowRunId}`,
    ]);
    expect(agent?.peak).toBe(1);
  });

  it('fails the step when the host member does not exist', async () => {
    const { engine, file } = await setup(LINEAR);
    const outcome = await (await engine.start(file)).done;
    expect(outcome.status).toBe('failed');
    const detail = await engine.getRun(outcome.workflow_run_id);
    expect(detail?.steps[0]?.error).toContain('not found');
  });

  it('honors workflow_disabled', async () => {
    const { engine, file } = await setup(LINEAR, { config: { enabled: false } });
    try {
      await engine.start(file);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe('workflow_disabled');
    }
  });

  it('lists runs sorted by updated_at and returns null for unknown ids', async () => {
    const { engine, host, file } = await setup(LINEAR);
    host?.setAgent('owner', async () => 'ok');
    const first = await engine.start(file);
    await first.done;
    await delay(2);
    const second = await engine.start(file);
    await second.done;

    const runs = await engine.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.workflow_run_id).toBe(second.workflowRunId);
    expect(await engine.getRun('wf_missing')).toBeNull();
  });
});
