import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { nodeWorkflowFs } from '../src/schema.js';
import { WorkflowStore } from '../src/store.js';
import type { WorkflowFs, WorkflowRunFile } from '../src/types.js';
import { delay, makeTempWorkspace, type TempWorkspace } from './fixtures/fakes.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function runFile(id: string, name: string, updatedAt: number): WorkflowRunFile {
  return {
    schema_version: 1,
    workflow_run_id: id,
    workflow_name: name,
    definition_path: path.join('/tmp', `${name}.yaml`),
    definition: { name, steps: [] },
    inputs: {},
    status: 'completed',
    steps: [],
    started_at: updatedAt,
    updated_at: updatedAt,
  };
}

async function makeStore(): Promise<{ workspace: TempWorkspace; store: WorkflowStore }> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  return { workspace, store: new WorkflowStore(workspace.runs) };
}

describe('workflow persistence', () => {
  it('writes atomically and leaves no temp files', async () => {
    const { workspace, store } = await makeStore();
    await store.save(runFile('wf_one', 'one', 1));
    const files = await fs.readdir(workspace.runs);
    expect(files).toEqual(['wf_one.json']);
  });

  it('falls back to a direct write after three rename failures', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());

    let renames = 0;
    const fsOps: WorkflowFs = {
      ...nodeWorkflowFs,
      async rename() {
        renames += 1;
        throw new Error('EPERM');
      },
    };
    const store = new WorkflowStore(workspace.runs, fsOps);
    await store.save(runFile('wf_one', 'one', 1));

    expect(renames).toBe(3);
    const loaded = await store.load('wf_one');
    expect(loaded?.workflow_name).toBe('one');
    const files = await fs.readdir(workspace.runs);
    expect(files).toEqual(['wf_one.json']);
  });

  it('serializes writes for the same run', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());

    let active = 0;
    let peak = 0;
    const fsOps: WorkflowFs = {
      ...nodeWorkflowFs,
      async writeFile(target, data, encoding) {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await delay(10);
          await nodeWorkflowFs.writeFile(target, data, encoding);
        } finally {
          active -= 1;
        }
      },
    };
    const store = new WorkflowStore(workspace.runs, fsOps);
    await Promise.all([
      store.save(runFile('wf_one', 'first', 1)),
      store.save(runFile('wf_one', 'second', 2)),
    ]);

    expect(peak).toBe(1);
    expect((await store.load('wf_one'))?.workflow_name).toBe('second');
  });

  it('lists only wf_*.json, skips corrupt files and sorts by updated_at', async () => {
    const { workspace, store } = await makeStore();
    await store.save(runFile('wf_old', 'old', 100));
    await store.save(runFile('wf_new', 'new', 200));
    await fs.writeFile(path.join(workspace.runs, 'notes.json'), '{}', 'utf8');
    await fs.writeFile(path.join(workspace.runs, 'wf_bad.json'), '{not json', 'utf8');

    const runs = await store.list();
    expect(runs.map((run) => run.workflow_run_id)).toEqual(['wf_new', 'wf_old']);
    expect(await store.load('wf_bad')).toBeNull();
  });

  it('clamps the list limit', async () => {
    const { store } = await makeStore();
    for (let i = 0; i < 3; i += 1) {
      await store.save(runFile(`wf_${i}`, `run-${i}`, i));
    }
    const runs = await store.list({ limit: 1 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.workflow_run_id).toBe('wf_2');
  });

  it('filters by status', async () => {
    const { store } = await makeStore();
    await store.save(runFile('wf_one', 'one', 1));
    const failed = runFile('wf_two', 'two', 2);
    failed.status = 'failed';
    await store.save(failed);

    const runs = await store.list({ status: 'failed' });
    expect(runs.map((run) => run.workflow_run_id)).toEqual(['wf_two']);
  });
});
