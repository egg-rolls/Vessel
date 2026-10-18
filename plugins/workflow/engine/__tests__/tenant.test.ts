import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost, type RunEvent } from '@vessel/core';
import { createWorkflowEngine } from '../src/engine.js';
import { WorkflowError } from '../src/errors.js';
import { WorkflowStore } from '../src/store.js';
import type { WorkflowRunFile } from '../src/types.js';
import {
  createFakeHost,
  makeConfig,
  makeTempWorkspace,
  type TempWorkspace,
  writeWorkflow,
} from './fixtures/fakes.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const SOURCE = `
name: tenant-flow
defaults:
  agent: owner
steps:
  - id: a
    type: agent
    prompt: hi
`;

async function setup(): Promise<{ workspace: TempWorkspace; file: string }> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  const file = await writeWorkflow(workspace.dir, 'flow', SOURCE);
  return { workspace, file };
}

function makeEngine(
  workspace: TempWorkspace,
  events: MemoryEventStream,
  tenantId?: string,
): ReturnType<typeof createWorkflowEngine> {
  const host = createFakeHost();
  host.setAgent('owner', async (prompt) => `out:${prompt}`);
  return createWorkflowEngine({
    host: host.host,
    pluginHost: new MemoryPluginHost(),
    config: makeConfig(workspace.dir, workspace.runs),
    events,
    ...(tenantId !== undefined ? { tenantId } : {}),
  });
}

function legacyRun(id: string): WorkflowRunFile {
  return {
    schema_version: 1,
    workflow_run_id: id,
    workflow_name: 'legacy',
    definition_path: '/tmp/legacy.yaml',
    definition: { name: 'legacy', steps: [] },
    inputs: {},
    status: 'completed',
    steps: [],
    started_at: 1,
    updated_at: 2,
  };
}

describe('workflow tenant scope', () => {
  it('stamps tenant_id on events and the run record', async () => {
    const { workspace, file } = await setup();
    const events = new MemoryEventStream();
    const collected: RunEvent[] = [];
    events.subscribe((event) => {
      collected.push(event);
    });

    const engine = makeEngine(workspace, events, 'acme');
    const started = await engine.start(file);
    await started.done;

    expect(collected.length).toBeGreaterThan(0);
    for (const event of collected) expect(event.tenant_id).toBe('acme');

    const detail = await engine.getRun(started.workflowRunId);
    expect(detail?.tenant_id).toBe('acme');
    const stored = await new WorkflowStore(workspace.runs).load(started.workflowRunId);
    expect(stored?.tenant_id).toBe('acme');
  });

  it('does not expose a run to another tenant', async () => {
    const { workspace, file } = await setup();
    const tenantA = makeEngine(workspace, new MemoryEventStream(), 'acme');
    const tenantB = makeEngine(workspace, new MemoryEventStream(), 'other');
    const started = await tenantA.start(file);
    await started.done;

    expect(await tenantB.getRun(started.workflowRunId)).toBeNull();
    expect(await tenantB.listRuns()).toEqual([]);
    await expect(tenantB.resume(started.workflowRunId)).rejects.toMatchObject({
      code: 'workflow_not_found',
    });
    await expect(tenantB.cancel(started.workflowRunId)).rejects.toMatchObject({
      code: 'workflow_not_found',
    });
  });

  it('lets only default read legacy records without tenant_id', async () => {
    const { workspace } = await setup();
    await new WorkflowStore(workspace.runs).save(legacyRun('wf_legacy'));

    const defaultEngine = makeEngine(workspace, new MemoryEventStream(), 'default');
    const otherEngine = makeEngine(workspace, new MemoryEventStream(), 'acme');
    const unscopedEngine = makeEngine(workspace, new MemoryEventStream());

    expect((await defaultEngine.getRun('wf_legacy'))?.workflow_name).toBe('legacy');
    expect(await otherEngine.getRun('wf_legacy')).toBeNull();
    expect((await unscopedEngine.getRun('wf_legacy'))?.workflow_name).toBe('legacy');
  });

  it('keeps 0.4 behavior when tenantId is omitted', async () => {
    const { workspace, file } = await setup();
    const events = new MemoryEventStream();
    const collected: RunEvent[] = [];
    events.subscribe((event) => {
      collected.push(event);
    });

    const engine = makeEngine(workspace, events);
    const started = await engine.start(file);
    await started.done;

    for (const event of collected) expect('tenant_id' in event).toBe(false);
    const detail = await engine.getRun(started.workflowRunId);
    expect(detail !== null && 'tenant_id' in detail).toBe(false);
    const stored = await new WorkflowStore(workspace.runs).load(started.workflowRunId);
    expect(stored !== null && 'tenant_id' in stored).toBe(false);
  });

  it('rejects an invalid tenant id at construction', async () => {
    const { workspace } = await setup();
    expect(() => makeEngine(workspace, new MemoryEventStream(), 'Bad Tenant')).toThrow(
      WorkflowError,
    );
    try {
      makeEngine(workspace, new MemoryEventStream(), 'Bad Tenant');
    } catch (error) {
      expect((error as WorkflowError).code).toBe('workflow_invalid');
    }
  });
});
