import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost } from '@vessel/core';
import { createWorkflowEngine } from '../src/engine.js';
import { WorkflowError } from '../src/errors.js';
import {
  createFakeHost,
  delay,
  makeConfig,
  makeTempWorkspace,
  writeWorkflow,
} from './fixtures/fakes.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const SOURCE = `
name: cancel
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
    depends_on: [a]
`;

function slowBehavior(ms = 1000): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt, signal) =>
    await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve(prompt), ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
}

async function createEngine(): Promise<{
  engine: ReturnType<typeof createWorkflowEngine>;
  file: string;
  host: ReturnType<typeof createFakeHost>;
}> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  const file = await writeWorkflow(workspace.dir, 'flow', SOURCE);
  const host = createFakeHost();
  const engine = createWorkflowEngine({
    host: host.host,
    pluginHost: new MemoryPluginHost(),
    config: makeConfig(workspace.dir, workspace.runs, { maxParallel: 2 }),
    events: new MemoryEventStream(),
  });
  return { engine, file, host };
}

describe('workflow cancel', () => {
  it('cancels running steps and skips pending steps', async () => {
    const { engine, file, host } = await createEngine();
    host.setAgent('owner', slowBehavior());

    const started = await engine.start(file);
    await delay(15);
    await engine.cancel(started.workflowRunId);
    const outcome = await started.done;

    expect(outcome.status).toBe('cancelled');
    const detail = await engine.getRun(started.workflowRunId);
    const statuses = Object.fromEntries(detail?.steps.map((step) => [step.id, step.status]) ?? []);
    expect(statuses.a).toBe('cancelled');
    expect(statuses.b).toBe('cancelled');
    expect(statuses.c).toBe('skipped');
  });

  it('is idempotent for an already cancelled run', async () => {
    const { engine, file, host } = await createEngine();
    host.setAgent('owner', slowBehavior());
    const started = await engine.start(file);
    await delay(10);
    await engine.cancel(started.workflowRunId);
    await started.done;
    await engine.cancel(started.workflowRunId);
    expect((await engine.getRun(started.workflowRunId))?.status).toBe('cancelled');
  });

  it('rejects cancel for a completed run', async () => {
    const { engine, file, host } = await createEngine();
    host.setAgent('owner', async (prompt) => prompt);
    const started = await engine.start(file);
    await started.done;

    try {
      await engine.cancel(started.workflowRunId);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe('workflow_invalid');
    }
  });

  it('marks active runs interrupted and allows resume', async () => {
    const { engine, file, host } = await createEngine();
    let slow = true;
    host.setAgent('owner', async (prompt, signal) => {
      if (!slow) return `out:${prompt}`;
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(prompt), 1000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    });

    const started = await engine.start(file);
    await delay(15);
    await engine.interruptAll('SIGINT');
    const outcome = await started.done;
    expect(outcome.status).toBe('interrupted');

    const interrupted = await engine.getRun(started.workflowRunId);
    expect(interrupted?.steps.find((step) => step.id === 'a')?.status).toBe('running');

    slow = false;
    const resumed = await engine.resume(started.workflowRunId);
    expect((await resumed.done).status).toBe('completed');
  });

  it('can cancel an interrupted run from disk', async () => {
    const { engine, file, host } = await createEngine();
    host.setAgent('owner', slowBehavior());
    const started = await engine.start(file);
    await delay(15);
    await engine.interruptAll();
    await started.done;

    await engine.cancel(started.workflowRunId);
    expect((await engine.getRun(started.workflowRunId))?.status).toBe('cancelled');
  });
});
