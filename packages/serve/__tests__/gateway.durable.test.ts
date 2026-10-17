import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import type { DurableCheckpointLike, DurableRunStatus, DurableStoreLike } from '../src/durable';
import type { Gateway } from '../src/gateway';
import { createGateway, sleep } from './helpers';

interface ListCall {
  status?: DurableRunStatus;
  session_id?: string;
  limit?: number;
}

interface FakeStore extends DurableStoreLike {
  calls: ListCall[];
  checkpoints: Map<string, DurableCheckpointLike>;
  listOverride?: () => Promise<DurableCheckpointLike[]>;
  loadError?: Error & { code?: string };
}

function makeStore(checkpoints: DurableCheckpointLike[] = []): FakeStore {
  const store: FakeStore = {
    calls: [],
    checkpoints: new Map(checkpoints.map((checkpoint) => [checkpoint.run_id, checkpoint])),
    async load(runId: string) {
      if (store.loadError) throw store.loadError;
      return store.checkpoints.get(runId) ?? null;
    },
    async list(opts) {
      store.calls.push({ ...opts });
      if (store.listOverride) return store.listOverride();
      return [...store.checkpoints.values()];
    },
  };
  return store;
}

function checkpoint(
  runId: string,
  overrides: Partial<DurableCheckpointLike> = {},
): DurableCheckpointLike {
  return {
    run_id: runId,
    session_id: 's1',
    status: 'interrupted',
    updated_at: 1000,
    messages: [{ role: 'user', content: `input-${runId}` }],
    ...overrides,
  };
}

describe('gateway durable endpoints', () => {
  const gateways: Gateway[] = [];

  const start = (
    store: DurableStoreLike,
    resume?: (runId: string) => void | Promise<void>,
  ): Gateway => {
    const gw = createGateway({
      events: new MemoryEventStream(),
      durable: { store, ...(resume ? { resume } : {}) },
    });
    gateways.push(gw);
    return gw;
  };

  const auth = (gw: Gateway): Record<string, string> => ({
    Authorization: `Bearer ${gw.token}`,
  });

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('returns durable_disabled when no durable options are injected', async () => {
    const gw = createGateway({ events: new MemoryEventStream() });
    gateways.push(gw);

    const list = await fetch(`${gw.url}/v1/durable/runs`, { headers: auth(gw) });
    expect(list.status).toBe(503);
    expect(((await list.json()) as { error: { code: string } }).error.code).toBe(
      'durable_disabled',
    );

    const resume = await fetch(`${gw.url}/v1/durable/runs/run-1/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(resume.status).toBe(503);
    expect(((await resume.json()) as { error: { code: string } }).error.code).toBe(
      'durable_disabled',
    );
  });

  it('maps checkpoints to frozen summary fields', async () => {
    const store = makeStore([
      checkpoint('run-a', {
        agent_id: 'agent-1',
        iteration: 3,
        updated_at: 2000,
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'last answer' },
        ],
      }),
    ]);
    const gw = start(store);

    const res = await fetch(`${gw.url}/v1/durable/runs`, { headers: auth(gw) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<Record<string, unknown>> };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toEqual({
      run_id: 'run-a',
      session_id: 's1',
      agent_id: 'agent-1',
      status: 'interrupted',
      iteration: 3,
      updated_at: 2000,
      preview: 'last answer',
    });
  });

  it('truncates preview to 120 characters and omits empty previews', async () => {
    const long = 'x'.repeat(200);
    const store = makeStore([
      checkpoint('run-long', { messages: [{ role: 'assistant', content: long }] }),
      checkpoint('run-empty', { messages: [{ role: 'assistant', content: '' }] }),
    ]);
    const gw = start(store);

    const body = (await (
      await fetch(`${gw.url}/v1/durable/runs`, { headers: auth(gw) })
    ).json()) as {
      runs: Array<{ run_id: string; preview?: string }>;
    };
    const longRun = body.runs.find((run) => run.run_id === 'run-long');
    expect(longRun?.preview).toHaveLength(120);
    const emptyRun = body.runs.find((run) => run.run_id === 'run-empty');
    expect(emptyRun?.preview).toBeUndefined();
  });

  it('forwards status/session_id/limit and supports comma-separated status', async () => {
    const store = makeStore([checkpoint('run-a'), checkpoint('run-b', { status: 'failed' })]);
    const gw = start(store);

    await fetch(`${gw.url}/v1/durable/runs?status=interrupted&session_id=s1&limit=10`, {
      headers: auth(gw),
    });
    expect(store.calls[0]).toEqual({ status: 'interrupted', session_id: 's1', limit: 10 });

    store.calls.length = 0;
    await fetch(`${gw.url}/v1/durable/runs?status=interrupted,failed`, { headers: auth(gw) });
    expect(store.calls).toHaveLength(2);
    expect(store.calls.map((call) => call.status).sort()).toEqual(['failed', 'interrupted']);
    expect(store.calls.every((call) => call.session_id === undefined)).toBe(true);
  });

  it('dedupes multi-status results and sorts by updated_at desc then run_id asc', async () => {
    const store = makeStore([
      checkpoint('run-b', { updated_at: 2000 }),
      checkpoint('run-a', { updated_at: 2000 }),
      checkpoint('run-c', { updated_at: 3000 }),
      checkpoint('run-d', { updated_at: 1000 }),
    ]);
    const gw = start(store);

    const body = (await (
      await fetch(`${gw.url}/v1/durable/runs?status=interrupted,failed`, { headers: auth(gw) })
    ).json()) as { runs: Array<{ run_id: string }> };
    expect(body.runs.map((run) => run.run_id)).toEqual(['run-c', 'run-a', 'run-b', 'run-d']);
  });

  it('applies default limit 50 and rejects invalid limits', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      checkpoint(`run-${String(index).padStart(2, '0')}`, { updated_at: 1000 + index }),
    );
    const store = makeStore(many);
    const gw = start(store);

    const body = (await (
      await fetch(`${gw.url}/v1/durable/runs`, { headers: auth(gw) })
    ).json()) as {
      runs: unknown[];
    };
    expect(body.runs).toHaveLength(50);

    for (const limit of ['0', '-1', 'abc', '201', '1.5']) {
      const res = await fetch(`${gw.url}/v1/durable/runs?limit=${limit}`, { headers: auth(gw) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_request',
      );
    }
  });

  it('rejects invalid status filters', async () => {
    const gw = start(makeStore());
    for (const status of ['bogus', '', 'interrupted,', ',failed']) {
      const res = await fetch(`${gw.url}/v1/durable/runs?status=${status}`, { headers: auth(gw) });
      expect(res.status).toBe(400);
    }
  });

  it('resumes interrupted/running runs with 202', async () => {
    const store = makeStore([checkpoint('run-a'), checkpoint('run-b', { status: 'running' })]);
    const resumed: string[] = [];
    const gw = start(store, (runId) => {
      resumed.push(runId);
    });

    for (const runId of ['run-a', 'run-b']) {
      const res = await fetch(`${gw.url}/v1/durable/runs/${runId}/resume`, {
        method: 'POST',
        headers: auth(gw),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ run_id: runId, status: 'queued' });
    }
    expect(resumed).toEqual(['run-a', 'run-b']);
  });

  it('returns run_not_found for unknown ids and run_not_resumable for terminal runs', async () => {
    const store = makeStore([
      checkpoint('done', { status: 'completed' }),
      checkpoint('failed', { status: 'failed' }),
      checkpoint('cancelled', { status: 'cancelled' }),
    ]);
    const gw = start(store, () => {});

    const missing = await fetch(`${gw.url}/v1/durable/runs/missing/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'run_not_found',
    );

    for (const runId of ['done', 'failed', 'cancelled']) {
      const res = await fetch(`${gw.url}/v1/durable/runs/${runId}/resume`, {
        method: 'POST',
        headers: auth(gw),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'run_not_resumable',
      );
    }
  });

  it('returns run_already_running on duplicate resume and calls the adapter once', async () => {
    const store = makeStore([checkpoint('run-a')]);
    const resumed: string[] = [];
    const gw = start(store, (runId) => {
      resumed.push(runId);
    });

    const first = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(first.status).toBe(202);

    const second = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'run_already_running',
    );
    expect(resumed).toEqual(['run-a']);
  });

  it('reserves the run before awaiting store.load (concurrent race)', async () => {
    const store = makeStore([checkpoint('run-a')]);
    const originalLoad = store.load.bind(store);
    let releaseLoad: () => void = () => {};
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    store.load = async (runId) => {
      await loadGate;
      return originalLoad(runId);
    };

    let adapterCalls = 0;
    const gw = start(store, () => {
      adapterCalls += 1;
    });

    const first = fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    // 第一个请求已占位、正在 await store.load；此时第二个请求必须被拒绝。
    await sleep(20);
    const second = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'run_already_running',
    );

    releaseLoad();
    expect((await first).status).toBe(202);
    expect(adapterCalls).toBe(1);
  });

  it('releases the reservation when the run is unknown so a retry can succeed', async () => {
    const store = makeStore();
    let adapterCalls = 0;
    const gw = start(store, () => {
      adapterCalls += 1;
    });

    const missing = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(missing.status).toBe(404);

    store.checkpoints.set('run-a', checkpoint('run-a'));
    const retry = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(retry.status).toBe(202);
    expect(adapterCalls).toBe(1);
  });

  it('releases the reservation when the adapter fails so a retry can succeed', async () => {
    const store = makeStore([checkpoint('run-a')]);
    let fail = true;
    let adapterCalls = 0;
    const gw = start(store, () => {
      if (fail) {
        throw Object.assign(new Error('run is busy'), { code: 'run_already_running' });
      }
      adapterCalls += 1;
    });

    const first = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(first.status).toBe(409);
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe(
      'run_already_running',
    );

    fail = false;
    const retry = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(retry.status).toBe(202);
    expect(adapterCalls).toBe(1);
  });

  it('maps core RunResumeError codes', async () => {
    const cases: Array<[string, number, string]> = [
      ['run_not_found', 404, 'run_not_found'],
      ['run_not_resumable', 409, 'run_not_resumable'],
      ['run_already_running', 409, 'run_already_running'],
      ['run_store_required', 503, 'durable_disabled'],
      ['agent_not_found', 404, 'agent_not_found'],
    ];

    for (const [coreCode, status, wireCode] of cases) {
      const store = makeStore([checkpoint(`run-${coreCode}`)]);
      const gw = start(store, () => {
        throw Object.assign(new Error(`core ${coreCode}`), { code: coreCode });
      });
      const res = await fetch(`${gw.url}/v1/durable/runs/run-${coreCode}/resume`, {
        method: 'POST',
        headers: auth(gw),
      });
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(wireCode);
    }
  });

  it('returns 500 for unknown adapter/store failures without leaking details', async () => {
    const store = makeStore([checkpoint('run-a')]);
    store.loadError = Object.assign(new Error('database exploded'), { code: 'weird' });
    const gw = start(store, () => {
      throw new Error('secret path /tmp/x');
    });

    const loadFailure = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(loadFailure.status).toBe(500);
    const loadBody = (await loadFailure.json()) as { error: { code: string; message: string } };
    expect(loadBody.error.code).toBe('internal');
    expect(loadBody.error.message).not.toContain('database exploded');

    store.loadError = undefined;
    const resumeFailure = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(resumeFailure.status).toBe(500);
    const resumeBody = (await resumeFailure.json()) as {
      error: { code: string; message: string };
    };
    expect(resumeBody.error.code).toBe('internal');
    expect(resumeBody.error.message).not.toContain('/tmp/x');
  });

  it('supports list-only mode when resume is not injected', async () => {
    const gw = start(makeStore([checkpoint('run-a')]));

    const list = await fetch(`${gw.url}/v1/durable/runs`, { headers: auth(gw) });
    expect(list.status).toBe(200);

    const resume = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(resume.status).toBe(503);
    expect(((await resume.json()) as { error: { code: string } }).error.code).toBe(
      'durable_disabled',
    );
  });

  it('advertises durable-resume only when store and resume are present', async () => {
    const withResume = start(makeStore(), () => {});
    const withResumeBody = (await (await fetch(`${withResume.url}/v1/health`)).json()) as {
      protocol: { features: string[] };
    };
    expect(withResumeBody.protocol.features).toContain('durable-resume');

    const listOnly = start(makeStore());
    const listOnlyBody = (await (await fetch(`${listOnly.url}/v1/health`)).json()) as {
      protocol: { features: string[] };
    };
    expect(listOnlyBody.protocol.features).not.toContain('durable-resume');
  });

  it('requires auth and rejects wrong methods', async () => {
    const gw = start(makeStore(), () => {});

    const unauthorized = await fetch(`${gw.url}/v1/durable/runs`);
    expect(unauthorized.status).toBe(401);

    const postList = await fetch(`${gw.url}/v1/durable/runs`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(postList.status).toBe(405);

    const getResume = await fetch(`${gw.url}/v1/durable/runs/run-a/resume`, {
      headers: auth(gw),
    });
    expect(getResume.status).toBe(405);
  });
});
