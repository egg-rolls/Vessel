import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
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
name: resume
defaults:
  agent: owner
on_error: fail
steps:
  - id: a
    type: agent
    prompt: a
  - id: b
    type: agent
    prompt: "b after {{steps.a.output}}"
    depends_on: [a]
`;

describe('workflow resume', () => {
  it('keeps completed steps and reruns failed ones', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeWorkflow(workspace.dir, 'flow', SOURCE);

    const host = createFakeHost();
    let bAttempts = 0;
    host.setAgent('owner', async (prompt) => {
      if (prompt.startsWith('b ')) {
        bAttempts += 1;
        if (bAttempts === 1) throw new Error('boom');
      }
      return `out:${prompt}`;
    });

    const engine = createWorkflowEngine({
      host: host.host,
      pluginHost: new MemoryPluginHost(),
      config: makeConfig(workspace.dir, workspace.runs),
      events: new MemoryEventStream(),
    });

    const first = await engine.start(file);
    const firstOutcome = await first.done;
    expect(firstOutcome.status).toBe('failed');

    const resumed = await engine.resume(first.workflowRunId);
    const secondOutcome = await resumed.done;
    expect(secondOutcome.status).toBe('completed');

    const detail = await engine.getRun(first.workflowRunId);
    expect(detail?.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
    expect(host.runs.filter((run) => run.prompt === 'a')).toHaveLength(1);
    expect(bAttempts).toBe(2);
  });

  it('resumes from the definition snapshot after the file is deleted', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeWorkflow(workspace.dir, 'flow', SOURCE);

    const host = createFakeHost();
    let bAttempts = 0;
    host.setAgent('owner', async (prompt) => {
      if (prompt.startsWith('b ')) {
        bAttempts += 1;
        if (bAttempts === 1) throw new Error('boom');
      }
      return `out:${prompt}`;
    });

    const engine = createWorkflowEngine({
      host: host.host,
      pluginHost: new MemoryPluginHost(),
      config: makeConfig(workspace.dir, workspace.runs),
      events: new MemoryEventStream(),
    });

    const first = await engine.start(file);
    await first.done;
    await fs.unlink(file);

    const resumed = await engine.resume(first.workflowRunId);
    expect((await resumed.done).status).toBe('completed');
  });

  it('rejects resume for completed and cancelled runs', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeWorkflow(workspace.dir, 'flow', SOURCE);

    const host = createFakeHost();
    host.setAgent('owner', async (prompt) => `out:${prompt}`);
    const engine = createWorkflowEngine({
      host: host.host,
      pluginHost: new MemoryPluginHost(),
      config: makeConfig(workspace.dir, workspace.runs),
      events: new MemoryEventStream(),
    });

    const completed = await engine.start(file);
    await completed.done;

    try {
      await engine.resume(completed.workflowRunId);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe('workflow_not_resumable');
    }
  });

  it('rejects concurrent resume of an active run', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeWorkflow(workspace.dir, 'flow', SOURCE);

    const host = createFakeHost();
    host.setAgent('owner', async (prompt) => {
      await delay(50);
      return `out:${prompt}`;
    });
    const engine = createWorkflowEngine({
      host: host.host,
      pluginHost: new MemoryPluginHost(),
      config: makeConfig(workspace.dir, workspace.runs),
      events: new MemoryEventStream(),
    });

    const started = await engine.start(file);
    try {
      await engine.resume(started.workflowRunId);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe('workflow_already_running');
    }
    await started.done;
  });
});
