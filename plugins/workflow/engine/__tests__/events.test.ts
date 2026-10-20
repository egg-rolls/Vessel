import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost, type RunEvent } from '@vessel/core';
import { createWorkflowEngine } from '../src/engine.js';
import { createFakeHost, makeConfig, makeTempWorkspace, writeWorkflow } from './fixtures/fakes.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function run(
  source: string,
  behavior: (prompt: string) => Promise<string>,
): Promise<{ events: RunEvent[]; workflowRunId: string; status: string }> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  const file = await writeWorkflow(workspace.dir, 'flow', source);
  const host = createFakeHost();
  host.setAgent('owner', behavior);
  const events = new MemoryEventStream();
  const collected: RunEvent[] = [];
  events.subscribe((event) => {
    collected.push(event);
  });

  const engine = createWorkflowEngine({
    host: host.host,
    pluginHost: new MemoryPluginHost(),
    config: makeConfig(workspace.dir, workspace.runs),
    events,
  });
  const started = await engine.start(file);
  const outcome = await started.done;
  return { events: collected, workflowRunId: started.workflowRunId, status: outcome.status };
}

describe('workflow events', () => {
  it('publishes the expected sequence with workflow_run_id', async () => {
    const { events, workflowRunId, status } = await run(
      `
name: events
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
`,
      async (prompt) => `out:${prompt}`,
    );

    expect(status).toBe('completed');
    expect(events.map((event) => event.type)).toEqual([
      'workflow.started',
      'workflow.step.started',
      'workflow.step.completed',
      'workflow.step.started',
      'workflow.step.completed',
      'workflow.completed',
    ]);
    for (const event of events) {
      expect(event.run_id).toBe(workflowRunId);
      expect((event.data as Record<string, unknown>).workflow_run_id).toBe(workflowRunId);
    }
  });

  it('truncates output_preview to 200 characters', async () => {
    const { events } = await run(
      `
name: preview
defaults:
  agent: owner
steps:
  - id: a
    type: agent
    prompt: a
`,
      async () => 'x'.repeat(300),
    );
    const completed = events.find((event) => event.type === 'workflow.step.completed');
    if (!completed) throw new Error('missing workflow.step.completed');
    expect(String((completed.data as Record<string, unknown>).output_preview)).toHaveLength(200);
  });

  it('publishes workflow.failed with the step error', async () => {
    const { events, status } = await run(
      `
name: fail
defaults:
  agent: owner
steps:
  - id: a
    type: agent
    prompt: a
`,
      async () => {
        throw new Error('boom');
      },
    );
    expect(status).toBe('failed');
    const failed = events.find((event) => event.type === 'workflow.step.failed');
    if (!failed) throw new Error('missing workflow.step.failed');
    expect((failed.data as Record<string, unknown>).error).toBe('boom');
    const workflowFailed = events.find((event) => event.type === 'workflow.failed');
    if (!workflowFailed) throw new Error('missing workflow.failed');
    expect((workflowFailed.data as Record<string, unknown>).error).toBe('boom');
  });
});
