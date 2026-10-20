import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost } from '@vessel-agent/core';
import { createWorkflowEngine } from '../src/engine.js';
import { WorkflowError } from '../src/errors.js';
import { WorkflowStore } from '../src/store.js';
import type { WorkflowRunFile } from '../src/types.js';
import { makeConfig, makeTempWorkspace, writeWorkflow } from './fixtures/fakes.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const SOURCE = `
name: guard
steps:
  - id: a
    type: agent
    agent: owner
    prompt: hi
`;

async function setup(): Promise<{
  engine: ReturnType<typeof createWorkflowEngine>;
  file: string;
  run: WorkflowRunFile;
}> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  const file = await writeWorkflow(workspace.dir, 'flow', SOURCE);

  const run: WorkflowRunFile = {
    schema_version: 1,
    workflow_run_id: 'wf_guard',
    workflow_name: 'guard',
    definition_path: file,
    definition: {
      name: 'guard',
      steps: [{ id: 'a', type: 'agent', agent: 'owner', prompt: 'hi' }],
    },
    inputs: {},
    status: 'interrupted',
    steps: [{ id: 'a', type: 'agent', status: 'running', attempts: 1, output: '' }],
    started_at: 1,
    updated_at: 2,
  };
  const store = new WorkflowStore(workspace.runs);
  await store.save(run);

  // controls-only：不注入 host / runtime。
  const engine = createWorkflowEngine({
    pluginHost: new MemoryPluginHost(),
    config: makeConfig(workspace.dir, workspace.runs),
    events: new MemoryEventStream(),
  });

  return { engine, file, run };
}

describe('controls-only workflow engine', () => {
  it('requires a host or runtime for start and resume', async () => {
    const { engine, file, run } = await setup();

    for (const action of [() => engine.start(file), () => engine.resume(run.workflow_run_id)]) {
      try {
        await action();
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowError);
        expect((error as WorkflowError).code).toBe('workflow_disabled');
        expect((error as WorkflowError).message).toContain('requires a host or runtime');
      }
    }
  });

  it('dispose drains the store once and is idempotent (0.9)', async () => {
    const { engine } = await setup();
    const store = (engine as unknown as { store: WorkflowStore }).store;
    const close = spyOn(store, 'close');

    expect(typeof engine.dispose).toBe('function');
    await engine.dispose?.();
    await engine.dispose?.();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps list/get/cancel available without a backend', async () => {
    const { engine, run } = await setup();

    const runs = await engine.listRuns();
    expect(runs.map((item) => item.workflow_run_id)).toEqual([run.workflow_run_id]);

    const detail = await engine.getRun(run.workflow_run_id);
    expect(detail?.status).toBe('interrupted');

    await engine.cancel(run.workflow_run_id);
    expect((await engine.getRun(run.workflow_run_id))?.status).toBe('cancelled');
  });
});
