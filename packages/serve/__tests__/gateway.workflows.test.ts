import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import type {
  WorkflowGatewayOptions,
  WorkflowOutcome,
  WorkflowRunDetail,
  WorkflowRunStatus,
} from '../src/workflow';
import { createGateway, sleep } from './helpers';

interface ListCall {
  status?: WorkflowRunStatus;
  limit?: number;
}

interface StartCall {
  path: string;
  inputs?: Record<string, string>;
}

interface FakeControls extends WorkflowGatewayOptions {
  runs: Map<string, WorkflowRunDetail>;
  calls: {
    list: ListCall[];
    get: string[];
    start: StartCall[];
    resume: string[];
    cancel: string[];
    resolve: string[];
  };
  resolve: (name: string) => string | undefined;
  startError?: Error & { code?: string };
  cancelError?: Error & { code?: string };
  resumeOutcome: Promise<WorkflowOutcome>;
  resolveResume: (outcome: WorkflowOutcome) => void;
}

function detail(
  id: string,
  status: WorkflowRunStatus,
  overrides: Partial<WorkflowRunDetail> = {},
): WorkflowRunDetail {
  return {
    workflow_run_id: id,
    workflow_name: 'release-check',
    status,
    step_count: 2,
    completed_steps: status === 'completed' ? 2 : 1,
    started_at: 1000,
    updated_at: 2000,
    definition_path: `./workflows/${id}.yaml`,
    inputs: { env: 'prod' },
    steps: [
      { id: 'plan', type: 'agent', status: 'completed', attempts: 1, output_preview: 'ok' },
      { id: 'check', type: 'tool', status: 'pending', attempts: 0 },
    ],
    ...overrides,
  };
}

function makeControls(initial: WorkflowRunDetail[] = []): FakeControls {
  const runs = new Map(initial.map((run) => [run.workflow_run_id, run]));
  let resumeDone: (outcome: WorkflowOutcome) => void = () => {};
  const resumeOutcome = new Promise<WorkflowOutcome>((resolve) => {
    resumeDone = resolve;
  });
  const controls: FakeControls = {
    runs,
    resumeOutcome,
    resolveResume: (outcome) => resumeDone(outcome),
    calls: { list: [], get: [], start: [], resume: [], cancel: [], resolve: [] },
    resolve: (name) => (name === 'missing' ? undefined : `./workflows/${name}.yaml`),
    async listRuns(opts) {
      controls.calls.list.push({ ...opts });
      return [...runs.values()];
    },
    async getRun(id) {
      controls.calls.get.push(id);
      return runs.get(id) ?? null;
    },
    async start(path, opts) {
      controls.calls.start.push({ path, ...(opts?.inputs ? { inputs: opts.inputs } : {}) });
      if (controls.startError) throw controls.startError;
      const id = `wf_started_${controls.calls.start.length}`;
      runs.set(id, detail(id, 'running'));
      return {
        workflowRunId: id,
        done: Promise.resolve({ workflow_run_id: id, status: 'completed' }),
      };
    },
    async resume(id) {
      controls.calls.resume.push(id);
      return { workflowRunId: id, done: resumeOutcome };
    },
    async cancel(id) {
      controls.calls.cancel.push(id);
      if (controls.cancelError) throw controls.cancelError;
      const run = runs.get(id);
      if (run) runs.set(id, { ...run, status: 'cancelled' });
    },
    resolveDefinition(name) {
      controls.calls.resolve.push(name);
      return controls.resolve(name);
    },
  };
  return controls;
}

describe('gateway workflow endpoints', () => {
  const gateways: Gateway[] = [];

  const start = (controls?: WorkflowGatewayOptions): Gateway => {
    const gw = createGateway({
      events: new MemoryEventStream(),
      ...(controls ? { workflows: controls } : {}),
    });
    gateways.push(gw);
    return gw;
  };

  const auth = (gw: Gateway): Record<string, string> => ({
    Authorization: `Bearer ${gw.token}`,
  });

  const post = (gw: Gateway, path: string, body?: unknown): Promise<Response> =>
    fetch(`${gw.url}${path}`, {
      method: 'POST',
      headers: { ...auth(gw), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('returns workflow_disabled for every workflow endpoint when not injected', async () => {
    const gw = start();
    const list = await fetch(`${gw.url}/v1/workflows`, { headers: auth(gw) });
    expect(list.status).toBe(503);
    expect(((await list.json()) as { error: { code: string } }).error.code).toBe(
      'workflow_disabled',
    );

    const detailRes = await fetch(`${gw.url}/v1/workflows/wf_1`, { headers: auth(gw) });
    expect(detailRes.status).toBe(503);

    const runRes = await post(gw, '/v1/workflows/run', { name: 'release-check' });
    expect(runRes.status).toBe(503);

    const resumeRes = await post(gw, '/v1/workflows/wf_1/resume');
    expect(resumeRes.status).toBe(503);

    const cancelRes = await post(gw, '/v1/workflows/wf_1/cancel');
    expect(cancelRes.status).toBe(503);
  });

  it('lists workflows sorted, deduped and limited', async () => {
    const controls = makeControls([
      detail('wf_b', 'running', { updated_at: 10 }),
      detail('wf_a', 'completed', { updated_at: 20 }),
      detail('wf_c', 'failed', { updated_at: 10 }),
    ]);
    const gw = start(controls);

    const res = await fetch(`${gw.url}/v1/workflows?limit=2`, { headers: auth(gw) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Array<{ workflow_run_id: string }> };
    expect(body.workflows.map((run) => run.workflow_run_id)).toEqual(['wf_a', 'wf_b']);
    expect(controls.calls.list).toEqual([{ limit: 2 }]);
  });

  it('passes status filter and rejects invalid query values', async () => {
    const controls = makeControls([detail('wf_a', 'running')]);
    const gw = start(controls);

    const ok = await fetch(`${gw.url}/v1/workflows?status=running&limit=5`, {
      headers: auth(gw),
    });
    expect(ok.status).toBe(200);
    expect(controls.calls.list[0]).toEqual({ status: 'running', limit: 5 });

    const badStatus = await fetch(`${gw.url}/v1/workflows?status=bogus`, { headers: auth(gw) });
    expect(badStatus.status).toBe(400);
    expect(((await badStatus.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_request',
    );

    const badLimit = await fetch(`${gw.url}/v1/workflows?limit=201`, { headers: auth(gw) });
    expect(badLimit.status).toBe(400);

    const wrongMethod = await fetch(`${gw.url}/v1/workflows`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(wrongMethod.status).toBe(405);
  });

  it('returns detail and maps unknown or invalid ids', async () => {
    const controls = makeControls([detail('wf_1', 'interrupted')]);
    const gw = start(controls);

    const res = await fetch(`${gw.url}/v1/workflows/wf_1`, { headers: auth(gw) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflow: WorkflowRunDetail };
    expect(body.workflow.workflow_run_id).toBe('wf_1');
    expect(body.workflow.steps).toHaveLength(2);

    const missing = await fetch(`${gw.url}/v1/workflows/wf_missing`, { headers: auth(gw) });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'workflow_not_found',
    );

    const invalid = await fetch(`${gw.url}/v1/workflows/${'x'.repeat(257)}`, {
      headers: auth(gw),
    });
    expect(invalid.status).toBe(400);
  });

  it('starts a workflow by name via resolveDefinition', async () => {
    const controls = makeControls();
    const gw = start(controls);

    const res = await post(gw, '/v1/workflows/run', {
      name: 'release-check',
      inputs: { env: 'prod' },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { workflow_run_id: string; status: string };
    expect(body.status).toBe('queued');
    expect(body.workflow_run_id).toBe('wf_started_1');
    expect(controls.calls.resolve).toEqual(['release-check']);
    expect(controls.calls.start).toEqual([
      { path: './workflows/release-check.yaml', inputs: { env: 'prod' } },
    ]);
  });

  it('rejects unsafe names and malformed inputs before calling the control plane', async () => {
    const controls = makeControls();
    const gw = start(controls);

    for (const name of ['../x', 'a/b', 'a\\b', '.hidden', 'a..b']) {
      const res = await post(gw, '/v1/workflows/run', { name });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'workflow_invalid',
      );
    }
    expect(controls.calls.start).toHaveLength(0);

    const badInputs = await post(gw, '/v1/workflows/run', {
      name: 'release-check',
      inputs: { env: 1 },
    });
    expect(badInputs.status).toBe(400);
    expect(controls.calls.start).toHaveLength(0);
  });

  it('maps unresolved names and control-plane definition errors', async () => {
    const controls = makeControls();
    const gw = start(controls);

    const missing = await post(gw, '/v1/workflows/run', { name: 'missing' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'workflow_not_found',
    );

    controls.startError = Object.assign(new Error('bad definition'), {
      code: 'workflow_invalid',
    });
    const invalid = await post(gw, '/v1/workflows/run', { name: 'release-check' });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe(
      'workflow_invalid',
    );
  });

  it('resumes interrupted runs and guards concurrent resumes', async () => {
    const controls = makeControls([detail('wf_1', 'interrupted')]);
    const gw = start(controls);

    const first = await post(gw, '/v1/workflows/wf_1/resume');
    expect(first.status).toBe(202);
    expect(((await first.json()) as { status: string }).status).toBe('queued');

    const second = await post(gw, '/v1/workflows/wf_1/resume');
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'workflow_already_running',
    );
  });

  it('rejects non-resumable and running workflow states', async () => {
    const controls = makeControls([
      detail('wf_done', 'completed'),
      detail('wf_cancel', 'cancelled'),
      detail('wf_live', 'running'),
    ]);
    const gw = start(controls);

    const done = await post(gw, '/v1/workflows/wf_done/resume');
    expect(done.status).toBe(409);
    expect(((await done.json()) as { error: { code: string } }).error.code).toBe(
      'workflow_not_resumable',
    );

    const cancelled = await post(gw, '/v1/workflows/wf_cancel/resume');
    expect(cancelled.status).toBe(409);

    const live = await post(gw, '/v1/workflows/wf_live/resume');
    expect(live.status).toBe(409);
    expect(((await live.json()) as { error: { code: string } }).error.code).toBe(
      'workflow_already_running',
    );

    const missing = await post(gw, '/v1/workflows/wf_missing/resume');
    expect(missing.status).toBe(404);
  });

  it('releases the resume reservation after done resolves', async () => {
    const controls = makeControls([detail('wf_1', 'interrupted')]);
    const gw = start(controls);

    const first = await post(gw, '/v1/workflows/wf_1/resume');
    expect(first.status).toBe(202);

    // done 尚未 resolve，第二次仍被占位拦截。
    const blocked = await post(gw, '/v1/workflows/wf_1/resume');
    expect(blocked.status).toBe(409);

    controls.resolveResume({ workflow_run_id: 'wf_1', status: 'completed' });
    await sleep(5);

    const after = await post(gw, '/v1/workflows/wf_1/resume');
    expect(after.status).toBe(202);
  });

  it('cancels active runs and treats already-cancelled as idempotent', async () => {
    const controls = makeControls([
      detail('wf_live', 'running'),
      detail('wf_done', 'completed'),
      detail('wf_cancel', 'cancelled'),
    ]);
    const gw = start(controls);

    const live = await post(gw, '/v1/workflows/wf_live/cancel');
    expect(live.status).toBe(202);
    expect(((await live.json()) as { status: string }).status).toBe('cancelled');
    expect(controls.calls.cancel).toEqual(['wf_live']);
    expect(controls.runs.get('wf_live')?.status).toBe('cancelled');

    const again = await post(gw, '/v1/workflows/wf_cancel/cancel');
    expect(again.status).toBe(202);
    expect(controls.calls.cancel).toEqual(['wf_live']);

    const done = await post(gw, '/v1/workflows/wf_done/cancel');
    expect(done.status).toBe(409);
    expect(((await done.json()) as { error: { code: string } }).error.code).toBe(
      'workflow_invalid',
    );

    const missing = await post(gw, '/v1/workflows/wf_missing/cancel');
    expect(missing.status).toBe(404);
  });

  it('maps workflow_cancelled from the control plane to 409 workflow_invalid', async () => {
    const controls = makeControls([detail('wf_live', 'running')]);
    controls.cancelError = Object.assign(new Error('already cancelled'), {
      code: 'workflow_cancelled',
    });
    const gw = start(controls);

    const res = await post(gw, '/v1/workflows/wf_live/cancel');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workflow_invalid');
  });

  it('requires a token', async () => {
    const gw = start(makeControls());
    const res = await fetch(`${gw.url}/v1/workflows`);
    expect(res.status).toBe(401);
  });
});
