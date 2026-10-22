import { describe, expect, test } from 'bun:test';
import { SESSION_NEGATIVE_TTL_MS, SessionResolver } from '../src/gateway/session-resolver';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SessionResolver layering', () => {
  test('L1 hit answers without consulting events or RPC', async () => {
    let eventCalls = 0;
    let rpcCalls = 0;
    const resolver = new SessionResolver({
      sessionForRun: () => {
        eventCalls += 1;
        return 'session-from-events';
      },
      lookupRun: async () => {
        rpcCalls += 1;
        return { session_id: 'session-from-rpc' };
      },
    });

    resolver.observe('run-1', 'session-1');

    await expect(resolver.lookup('run-1')).resolves.toBe('session-1');
    expect(eventCalls).toBe(0);
    expect(rpcCalls).toBe(0);
  });

  test('L1 miss with an event hit avoids the RPC', async () => {
    let rpcCalls = 0;
    const resolver = new SessionResolver({
      sessionForRun: (runId) => (runId === 'run-1' ? 'session-1' : undefined),
      lookupRun: async () => {
        rpcCalls += 1;
        return null;
      },
    });

    await expect(resolver.lookup('run-1')).resolves.toBe('session-1');
    expect(rpcCalls).toBe(0);
    // L2 命中写回 L1：后续事件卡片直接命中，不再扫描事件。
    expect(resolver.sync('run-1')).toBe('session-1');
  });

  test('concurrent lookups for one run issue a single runs.get', async () => {
    const gate = deferred<{ session_id?: string } | null>();
    let calls = 0;
    const resolver = new SessionResolver({
      lookupRun: () => {
        calls += 1;
        return gate.promise;
      },
    });

    const first = resolver.lookup('run-1');
    const second = resolver.lookup('run-1');
    expect(calls).toBe(1);

    gate.resolve({ session_id: 'session-1' });
    expect(await first).toBe('session-1');
    expect(await second).toBe('session-1');

    // 结果已写 L1：再次查询不再打 RPC。
    await expect(resolver.lookup('run-1')).resolves.toBe('session-1');
    expect(calls).toBe(1);
  });

  test('negative cache prevents retrying an unresolved run', async () => {
    let now = 1_000;
    let calls = 0;
    const resolver = new SessionResolver({
      lookupRun: async () => {
        calls += 1;
        return null;
      },
      now: () => now,
    });

    await expect(resolver.lookup('run-1')).resolves.toBeUndefined();
    await expect(resolver.lookup('run-1')).resolves.toBeUndefined();
    expect(calls).toBe(1);

    // 30s 内不重试；超过 TTL 后允许再查一次。
    now += SESSION_NEGATIVE_TTL_MS + 1;
    await expect(resolver.lookup('run-1')).resolves.toBeUndefined();
    expect(calls).toBe(2);

    // run.started 到达：清负缓存并覆盖 L1。
    resolver.observe('run-1', 'session-1');
    await expect(resolver.lookup('run-1')).resolves.toBe('session-1');
    expect(resolver.sync('run-1')).toBe('session-1');
    expect(calls).toBe(2);
  });

  test('tenant reset drops cached and in-flight results', async () => {
    const gate = deferred<{ session_id?: string } | null>();
    const resolved: Array<[string, string]> = [];
    let calls = 0;
    const resolver = new SessionResolver({
      lookupRun: () => {
        calls += 1;
        return gate.promise;
      },
      onResolved: (runId, sessionId) => resolved.push([runId, sessionId]),
    });

    resolver.observe('cached-run', 'session-old');
    const pending = resolver.lookup('in-flight-run');
    resolver.reset();

    expect(resolver.sync('cached-run')).toBeUndefined();
    gate.resolve({ session_id: 'session-new' });
    await expect(pending).resolves.toBeUndefined();
    // 旧世代响应不得写 L1，也不得回调 UI。
    expect(resolver.sync('in-flight-run')).toBeUndefined();
    expect(resolved).toEqual([['cached-run', 'session-old']]);

    // 新世代重新查询走 L3（in-flight 已清空）。
    await expect(resolver.lookup('in-flight-run')).resolves.toBe('session-new');
    expect(calls).toBe(2);
    expect(resolved).toEqual([
      ['cached-run', 'session-old'],
      ['in-flight-run', 'session-new'],
    ]);
  });

  test('LRU evicts the least recently used run', () => {
    const resolver = new SessionResolver({ capacity: 2 });
    resolver.observe('a', 'session-a');
    resolver.observe('b', 'session-b');
    resolver.observe('c', 'session-c');

    expect(resolver.sync('a')).toBeUndefined();
    expect(resolver.sync('b')).toBe('session-b');
    expect(resolver.sync('c')).toBe('session-c');
  });

  test('prewarm clears the negative cache for a newly mapped run', async () => {
    let calls = 0;
    const resolver = new SessionResolver({
      jobForRun: () => undefined,
      lookupRun: async () => {
        calls += 1;
        return { session_id: 'session-1' };
      },
    });

    // 有 job 来源但尚未观测到映射：负缓存，不拿 core id 试错。
    await expect(resolver.lookup('core-1')).resolves.toBeUndefined();
    expect(calls).toBe(0);

    // hydration 预热补上 core → job：负缓存必须失效，后续可走 L3。
    resolver.prewarm([{ run_id: 'job-1', core_run_id: 'core-1' }]);
    await expect(resolver.lookup('core-1')).resolves.toBe('session-1');
    expect(calls).toBe(1);
  });

  test('lookup uses the gateway job id for runs.get', async () => {
    const lookedUp: string[] = [];
    const resolver = new SessionResolver({
      lookupRun: async (jobId) => {
        lookedUp.push(jobId);
        return { session_id: 'session-1' };
      },
    });

    // prewarm 只给 core→job 映射（缺 session_id），L1 仍是 miss。
    resolver.prewarm([{ run_id: 'job-1', core_run_id: 'core-1' }]);
    expect(resolver.sync('core-1')).toBeUndefined();

    await expect(resolver.lookup('core-1')).resolves.toBe('session-1');
    expect(lookedUp).toEqual(['job-1']);
  });
});
