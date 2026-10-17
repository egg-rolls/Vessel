import { describe, expect, it } from 'bun:test';
import type {
  AgentHandle,
  AgentSpec,
  AgentStatus,
  EventBus,
  InboxPage,
  PluginHost,
  RunHandle,
  RunOptions,
  RuntimeHost,
} from '../../packages/core/src/index';
import { OwnerRuntimeFacade } from '../owner-runtime-facade';

/** 最小 EventBus 假实现 */
function fakeEvents(): EventBus {
  const noop = () => {};
  const unsubscribe = () => {};
  return {
    subscribe: () => unsubscribe,
    publish: noop,
    clear: noop,
    getHistory: () => [],
    waitFor: async () => undefined,
    subscribeFiltered: () => unsubscribe,
  } as unknown as EventBus;
}

interface FakeHandle extends AgentHandle {
  readonly calls: { runs: string[]; closed: number };
}

function fakeHandle(id: string, sessionId: string, gate?: Promise<void>): FakeHandle {
  const calls = { runs: [] as string[], closed: 0 };
  return {
    id,
    status: (): AgentStatus => ({ id, state: 'idle', toolNames: [] }),
    run: async (input: string | { content: string }, _opts?: RunOptions): Promise<RunHandle> => {
      const text = typeof input === 'string' ? input : input.content;
      calls.runs.push(text);
      const result = (async () => {
        if (gate) await gate;
        return `echo:${text}`;
      })();
      return {
        id: `run-${calls.runs.length}`,
        agentId: id,
        sessionId,
        status: () => 'completed' as const,
        result,
        usage: () => undefined,
        cancel: () => {},
      };
    },
    send: async () => {},
    inbox: async (): Promise<InboxPage> => ({ messages: [], cursor: '' }),
    cancel: () => {},
    close: async () => {
      calls.closed++;
    },
    calls,
  };
}

function fakeHost(events: EventBus): RuntimeHost & { readonly closed: number[] } {
  const closed: number[] = [];
  return {
    events,
    scheduler: {
      submit: async () => {
        throw new Error('not used');
      },
      cancel: () => false,
      stats: () => ({ queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }),
      close: async () => {},
    },
    spawn: async (_spec: AgentSpec) => fakeHandle('unused', 'unused'),
    get: () => undefined,
    list: () => [],
    send: async () => {},
    inbox: async () => ({ messages: [], cursor: '' }),
    cancel: () => {},
    close: async () => {
      closed.push(Date.now());
    },
    closed,
  } as unknown as RuntimeHost & { readonly closed: number[] };
}

const pluginHost = { listTools: () => [] } as unknown as PluginHost;

/** 轮询等待条件成立（用于断言「第一个 run 已开始、第二个仍在排队」） */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('OwnerRuntimeFacade', () => {
  it('透传 run 到 owner handle，并暴露 host 的 events/pluginHost', async () => {
    const events = fakeEvents();
    const host = fakeHost(events);
    const handle = fakeHandle('owner', 's1');
    const facade = new OwnerRuntimeFacade({
      host,
      handle,
      pluginHost,
      initialSessionId: 's1',
      spawnOwner: async () => handle,
    });

    expect(facade.events).toBe(events);
    expect(facade.pluginHost).toBe(pluginHost);
    await expect(facade.run('hi')).resolves.toBe('echo:hi');
    expect(handle.calls.runs).toEqual(['hi']);
    expect(handle.calls.closed).toBe(0);
  });

  it('sessionId 变化时关闭旧 owner 并按新 session spawn', async () => {
    const events = fakeEvents();
    const host = fakeHost(events);
    const first = fakeHandle('owner', 's1');
    const second = fakeHandle('owner', 's2');
    const spawned: string[] = [];

    const facade = new OwnerRuntimeFacade({
      host,
      handle: first,
      pluginHost,
      initialSessionId: 's1',
      spawnOwner: async (sessionId) => {
        spawned.push(sessionId);
        return second;
      },
    });

    await expect(facade.run('next', 's2')).resolves.toBe('echo:next');
    expect(first.calls.closed).toBe(1);
    expect(spawned).toEqual(['s2']);
    expect(second.calls.runs).toEqual(['next']);
    expect(facade.sessionId).toBe('s2');
  });

  it('新 session spawn 失败时恢复旧 owner 并抛错', async () => {
    const events = fakeEvents();
    const host = fakeHost(events);
    const first = fakeHandle('owner', 's1');
    const restored = fakeHandle('owner', 's1');
    const calls: string[] = [];

    const facade = new OwnerRuntimeFacade({
      host,
      handle: first,
      pluginHost,
      initialSessionId: 's1',
      spawnOwner: async (sessionId) => {
        calls.push(sessionId);
        if (sessionId === 's2') throw new Error('spawn failed');
        return restored;
      },
    });

    await expect(facade.run('x', 's2')).rejects.toThrow('spawn failed');
    expect(calls).toEqual(['s2', 's1']);
    expect(facade.sessionId).toBe('s1');
    await expect(facade.run('y')).resolves.toBe('echo:y');
  });

  it('并发 run 请求不同 session 时各自使用请求的 session', async () => {
    const events = fakeEvents();
    const host = fakeHost(events);
    const initial = fakeHandle('owner', 's0');
    const bySession = new Map<string, FakeHandle>();

    const facade = new OwnerRuntimeFacade({
      host,
      handle: initial,
      pluginHost,
      initialSessionId: 's0',
      spawnOwner: async (sessionId) => {
        const handle = fakeHandle('owner', sessionId);
        bySession.set(sessionId, handle);
        return handle;
      },
    });

    // Promise.all 按顺序启动：A→s1 先注册切换，B→s2 等待后必须再切到 s2
    const [a, b] = await Promise.all([facade.run('a', 's1'), facade.run('b', 's2')]);

    expect(a).toBe('echo:a');
    expect(b).toBe('echo:b');
    expect(bySession.get('s1')?.calls.runs).toEqual(['a']);
    expect(bySession.get('s2')?.calls.runs).toEqual(['b']);
    expect(facade.sessionId).toBe('s2');
  });

  it('整个 run 串行化：慢 run 期间第二个不同 session 不会跑错或触碰 closed handle', async () => {
    const events = fakeEvents();
    const host = fakeHost(events);
    const initial = fakeHandle('owner', 's0');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const s1 = fakeHandle('owner', 's1', firstGate);
    const s2 = fakeHandle('owner', 's2');
    const spawnOrder: string[] = [];

    const facade = new OwnerRuntimeFacade({
      host,
      handle: initial,
      pluginHost,
      initialSessionId: 's0',
      spawnOwner: async (sessionId) => {
        spawnOrder.push(sessionId);
        return sessionId === 's1' ? s1 : s2;
      },
    });

    const first = facade.run('a', 's1');
    await waitFor(() => s1.calls.runs.length === 1);

    // 第二个 run 必须排在第一个之后：此时不应 spawn s2，也不应在 s2 上运行
    const second = facade.run('b', 's2');
    expect(spawnOrder).toEqual(['s1']);
    expect(s2.calls.runs).toHaveLength(0);

    releaseFirst();
    await expect(first).resolves.toBe('echo:a');
    await expect(second).resolves.toBe('echo:b');

    expect(s1.calls.runs).toEqual(['a']);
    expect(s2.calls.runs).toEqual(['b']);
    expect(s1.calls.closed).toBe(1);
    expect(spawnOrder).toEqual(['s1', 's2']);
    expect(facade.sessionId).toBe('s2');
  });

  it('dispose 后排队中的 run 直接抛 disposed', async () => {
    const events = fakeEvents();
    const host = fakeHost(events);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const s1 = fakeHandle('owner', 's1', firstGate);
    const s2 = fakeHandle('owner', 's2');

    const facade = new OwnerRuntimeFacade({
      host,
      handle: fakeHandle('owner', 's0'),
      pluginHost,
      initialSessionId: 's0',
      spawnOwner: async (sessionId) => (sessionId === 's1' ? s1 : s2),
    });

    const first = facade.run('a', 's1');
    await waitFor(() => s1.calls.runs.length === 1);
    const queued = facade.run('b', 's2');

    facade.dispose();
    releaseFirst();

    await expect(first).resolves.toBe('echo:a');
    await expect(queued).rejects.toThrow('disposed');
  });

  it('dispose 只关闭 host 一次，之后 run 拒绝', async () => {
    const events = fakeEvents();
    const host = fakeHost(events);
    const handle = fakeHandle('owner', 's1');
    const facade = new OwnerRuntimeFacade({
      host,
      handle,
      pluginHost,
      initialSessionId: 's1',
      spawnOwner: async () => handle,
    });

    facade.dispose();
    facade.dispose();
    expect(host.closed).toHaveLength(1);
    await expect(facade.run('after')).rejects.toThrow('disposed');
  });
});
