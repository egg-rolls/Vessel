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

function fakeHandle(id: string, sessionId: string): FakeHandle {
  const calls = { runs: [] as string[], closed: 0 };
  return {
    id,
    status: (): AgentStatus => ({ id, state: 'idle', toolNames: [] }),
    run: async (input: string | { content: string }, _opts?: RunOptions): Promise<RunHandle> => {
      const text = typeof input === 'string' ? input : input.content;
      calls.runs.push(text);
      return {
        id: `run-${calls.runs.length}`,
        agentId: id,
        sessionId,
        status: () => 'completed' as const,
        result: Promise.resolve(`echo:${text}`),
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
