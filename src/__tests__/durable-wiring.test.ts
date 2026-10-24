import { describe, expect, it } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileRunStore,
  MemoryRunStore,
  type RunCheckpoint,
  type RunStore,
} from '../../packages/core/src/index';
import {
  createDurableFor,
  listRunSummaries,
  loadResumableCheckpoint,
  previewOf,
  routeResume,
} from '../durable-wiring';
import { createRunStore, resolveDurableOptions, resolveRunStorePath } from '../run-store-factory';
import type { TenantRuntimeBundle, TenantRuntimeFactory } from '../tenant-runtime-factory';

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    run_id: 'run-1',
    session_id: 'session-1',
    status: 'interrupted',
    messages: [{ role: 'user', content: 'hello' }],
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

async function storeWith(...checkpoints: RunCheckpoint[]): Promise<MemoryRunStore> {
  const store = new MemoryRunStore();
  for (const item of checkpoints) await store.save(item);
  return store;
}

describe('durable options', () => {
  it('默认开启，默认值来自 DEFAULT_DURABLE_OPTIONS', () => {
    expect(resolveDurableOptions({})).toEqual({
      enabled: true,
      backend: 'file',
      path: '~/.vessel/runs',
      checkpointEvery: 'iteration',
    });
    expect(resolveDurableOptions({ durable: { enabled: false } }).enabled).toBe(false);
  });

  it('enabled / backend / path 覆盖', () => {
    expect(
      resolveDurableOptions({
        durable: { enabled: true, backend: 'memory', path: '/tmp/runs' },
      }),
    ).toEqual({
      enabled: true,
      backend: 'memory',
      path: '/tmp/runs',
      checkpointEvery: 'iteration',
    });
  });

  it('路径：~ 展开、相对路径按 cwd 解析、绝对路径原样', () => {
    expect(resolveRunStorePath('~')).toBe(os.homedir());
    expect(resolveRunStorePath('~/runs')).toBe(path.join(os.homedir(), 'runs'));
    expect(resolveRunStorePath('relative/runs')).toBe(path.resolve('relative/runs'));
    expect(resolveRunStorePath('/abs/runs')).toBe('/abs/runs');
  });

  it('显式 durable 关闭不创建 store；memory/file 选择正确', () => {
    expect(createRunStore({ durable: { enabled: false } })).toBeUndefined();
    expect(createRunStore({ durable: { enabled: false, backend: 'memory' } })).toBeUndefined();

    // 缺省开启：用 memory 后端验证，避免测试写用户 home。
    expect(createRunStore({ durable: { backend: 'memory' } })).toBeInstanceOf(MemoryRunStore);

    expect(createRunStore({ durable: { enabled: true, backend: 'memory' } })).toBeInstanceOf(
      MemoryRunStore,
    );

    expect(
      createRunStore({ durable: { enabled: true, backend: 'file', path: '~/.vessel/test-runs' } }),
    ).toBeInstanceOf(FileRunStore);
  });
});

describe('listRunSummaries', () => {
  it('只返回 running/interrupted，并按 store 的顺序映射', async () => {
    const store = await storeWith(
      checkpoint({ run_id: 'a', status: 'running', updated_at: 3000 }),
      checkpoint({ run_id: 'b', status: 'interrupted', updated_at: 2000, iteration: 4 }),
      checkpoint({ run_id: 'c', status: 'completed', updated_at: 4000 }),
    );

    const runs = await listRunSummaries(store);
    expect(runs.map((run) => run.run_id)).toEqual(['a', 'b']);
    expect(runs[1]).toMatchObject({
      run_id: 'b',
      status: 'interrupted',
      iteration: 4,
      preview: 'hello',
    });
  });

  it('status / session_id / limit 透传', async () => {
    const store = await storeWith(
      checkpoint({ run_id: 'a', session_id: 's1', updated_at: 3000 }),
      checkpoint({ run_id: 'b', session_id: 's2', updated_at: 2000 }),
      checkpoint({ run_id: 'c', session_id: 's1', updated_at: 1000 }),
    );

    expect((await listRunSummaries(store, { status: 'interrupted' })).length).toBe(3);
    expect((await listRunSummaries(store, { session_id: 's1' })).map((run) => run.run_id)).toEqual([
      'a',
      'c',
    ]);
    expect((await listRunSummaries(store, { limit: 1 })).map((run) => run.run_id)).toEqual(['a']);
  });
});

describe('loadResumableCheckpoint', () => {
  it('未知 id → run_not_found', async () => {
    const store = await storeWith();
    await expect(loadResumableCheckpoint(store, 'nope')).rejects.toMatchObject({
      code: 'run_not_found',
      runId: 'nope',
    });
  });

  it('terminal 状态 → run_not_resumable', async () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const store = await storeWith(checkpoint({ status }));
      await expect(loadResumableCheckpoint(store, 'run-1')).rejects.toMatchObject({
        code: 'run_not_resumable',
        runId: 'run-1',
      });
    }
  });

  it('空 messages 允许通过：历史由 runtime 从 session + 事件日志重建（0.18）', async () => {
    const store = await storeWith(checkpoint({ messages: [] }));
    expect(await loadResumableCheckpoint(store, 'run-1')).toMatchObject({
      run_id: 'run-1',
      messages: [],
    });
  });

  it('running / interrupted 可恢复', async () => {
    for (const status of ['running', 'interrupted'] as const) {
      const store = await storeWith(checkpoint({ status }));
      expect(await loadResumableCheckpoint(store, 'run-1')).toMatchObject({ status });
    }
  });
});

describe('routeResume', () => {
  const host = {
    get: (id: string) => (id === 'member' ? {} : undefined),
    resume: async () => ({}),
  };

  it('无 host / host 不支持 resume → single-agent', () => {
    expect(routeResume(checkpoint(), undefined, 'owner')).toBe('single-agent');
    expect(routeResume(checkpoint(), { get: () => undefined }, 'owner')).toBe('single-agent');
  });

  it('agent_id 缺失 / owner / 宿主成员 → host', () => {
    expect(routeResume(checkpoint(), host, 'owner')).toBe('host');
    expect(routeResume(checkpoint({ agent_id: 'owner' }), host, 'owner')).toBe('host');
    expect(routeResume(checkpoint({ agent_id: 'member' }), host, 'owner')).toBe('host');
  });

  it('agent_id 不是宿主成员 → single-agent', () => {
    expect(routeResume(checkpoint({ agent_id: 'other' }), host, 'owner')).toBe('single-agent');
  });
});

describe('previewOf', () => {
  it('优先 metadata.preview', () => {
    expect(previewOf(checkpoint({ metadata: { preview: 'from meta' } }))).toBe('from meta');
  });

  it('最后一条 user 消息、压缩空白并截断', () => {
    expect(
      previewOf(
        checkpoint({
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'answer' },
            { role: 'user', content: `  long${'x'.repeat(80)}\nnext  ` },
          ],
        }),
      ),
    ).toBe(`long${'x'.repeat(56)}...`);
  });

  it('没有 user 消息返回 undefined', () => {
    expect(
      previewOf(checkpoint({ messages: [{ role: 'assistant', content: 'hi' }] })),
    ).toBeUndefined();
  });
});

// 确保 RunStore 结构仍与 asm 的调用面一致（类型层兜底）
const _typeOnly: RunStore = new MemoryRunStore();
void _typeOnly;

describe('createDurableFor（0.6.1 P0-2 per-tenant）', () => {
  const store = new MemoryRunStore();

  function factory(bundles: Record<string, Partial<TenantRuntimeBundle>>): TenantRuntimeFactory {
    return {
      bundleFor: (tenantId: string) => bundles[tenantId] as TenantRuntimeBundle | undefined,
    } as TenantRuntimeFactory;
  }

  it('default tenant 返回 undefined（由 gateway 的 durable 提供）', () => {
    const durableFor = createDurableFor(factory({ default: { runStore: store } }), 'default');
    expect(durableFor('default')).toBeUndefined();
  });

  it('非 default tenant 无 runStore → undefined（gateway 403）', () => {
    const durableFor = createDurableFor(factory({ acme: {} }), 'default');
    expect(durableFor('acme')).toBeUndefined();
    expect(durableFor('missing')).toBeUndefined();
  });

  it('host.resume：只等待受理，不等待 run 完成', async () => {
    let resumed = '';
    const host = {
      resume: async (runId: string) => {
        resumed = runId;
        return { result: new Promise<string>(() => {}) };
      },
    };
    const durableFor = createDurableFor(
      factory({ acme: { runStore: store, host: host as never } }),
      'default',
    );
    const options = durableFor('acme');
    expect(options?.store).toBe(store);
    await options?.resume?.('run-1');
    expect(resumed).toBe('run-1');
  });

  it('runtime.resume：返回 void 且调用后不阻塞', () => {
    let resumed = '';
    const runtime = {
      resume: (runId: string) => {
        resumed = runId;
        return new Promise<string>(() => {});
      },
    };
    const durableFor = createDurableFor(
      factory({ acme: { runStore: store, runtime: runtime as never } }),
      'default',
    );
    const options = durableFor('acme');
    expect(options?.resume?.('run-2')).toBeUndefined();
    expect(resumed).toBe('run-2');
  });

  it('无 host/runtime resume 时只提供列表 store', () => {
    const durableFor = createDurableFor(
      factory({ acme: { runStore: store, runtime: { resume: undefined } as never } }),
      'default',
    );
    const options = durableFor('acme');
    expect(options?.store).toBe(store);
    expect(options?.resume).toBeUndefined();
  });
});
