import { describe, expect, it } from 'bun:test';
import { DEFAULT_CONFIG, DEFAULT_SCHEDULER_OPTIONS } from '../../packages/config/src/index';
import type {
  AgentHandle,
  AgentSpec,
  AgentStatus,
  ContextManager,
  EventBus,
  InboxPage,
  LLMProvider,
  PluginHost,
  RunHandle,
  RuntimeHost,
  RuntimeOptions,
  SessionBackend,
  Transport,
} from '../../packages/core/src/index';
import { MemoryRunStore } from '../../packages/core/src/index';
import { MemoryEventBus } from '../../packages/core/src/kernel/index';
import {
  buildOwnerSpec,
  type HostModule,
  isHostEnabled,
  type OwnerRuntimeSpec,
  tryCreateHostRuntime,
} from '../runtime-factory';

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

function fakeHandle(id: string): AgentHandle {
  return {
    id,
    status: (): AgentStatus => ({ id, state: 'idle', toolNames: [] }),
    run: async (): Promise<RunHandle> => ({
      id: 'run',
      agentId: id,
      sessionId: 's',
      status: () => 'completed' as const,
      result: Promise.resolve('ok'),
      usage: () => undefined,
      cancel: () => {},
    }),
    send: async () => {},
    inbox: async (): Promise<InboxPage> => ({ messages: [], cursor: '' }),
    cancel: () => {},
    close: async () => {},
  };
}

interface FakeHost extends RuntimeHost {
  readonly spawns: AgentSpec[];
  readonly closed: number[];
  failSpawn?: boolean;
}

function fakeHost(): FakeHost {
  const spawns: AgentSpec[] = [];
  const closed: number[] = [];
  const host: FakeHost = {
    events: fakeEvents(),
    scheduler: {
      submit: async () => {
        throw new Error('not used');
      },
      cancel: () => false,
      stats: () => ({ queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }),
      close: async () => {},
    },
    spawn: async (spec: AgentSpec) => {
      if (host.failSpawn) throw new Error('spawn failed');
      spawns.push(spec);
      return fakeHandle(spec.id ?? 'generated');
    },
    get: () => undefined,
    list: () => [],
    send: async () => {},
    inbox: async () => ({ messages: [], cursor: '' }),
    cancel: () => {},
    close: async () => {
      closed.push(Date.now());
    },
    spawns,
    closed,
  };
  return host;
}

const provider = {} as LLMProvider;
const pluginHost = { listTools: () => [] } as unknown as PluginHost;
const context = {} as ContextManager;
const session = {} as SessionBackend;

const owner: OwnerRuntimeSpec = {
  id: 'owner',
  provider,
  model: 'mock-model',
  pluginHost,
  context,
  session,
  systemPrompt: 'be nice',
  limits: { requestLimit: 5, toolCallsLimit: 2 },
  termination: { maxIterations: 3 },
};

function loaderFor(host: RuntimeHost, captured?: { options?: RuntimeOptions }): HostModule {
  return {
    createRuntime: async (options?: RuntimeOptions) => {
      if (captured) captured.options = options;
      return host;
    },
  };
}

describe('tryCreateHostRuntime', () => {
  it('创建 Host、spawn owner，并返回 facade', async () => {
    const host = fakeHost();
    const captured: { options?: RuntimeOptions } = {};
    const result = await tryCreateHostRuntime({
      config: {},
      owner,
      sessionId: 's1',
      loadHostModule: async () => loaderFor(host, captured),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.host).toBe(host);
    expect(result.runtime.pluginHost).toBe(pluginHost);
    expect(host.spawns).toHaveLength(1);
    expect(host.spawns[0]).toMatchObject({
      id: 'owner',
      provider,
      model: 'mock-model',
      pluginHost,
      context,
      session,
      sessionId: 's1',
      systemPrompt: 'be nice',
      termination: { maxIterations: 3 },
    });
    expect(host.spawns[0]?.limits).toEqual({
      run: owner.limits,
      agent: owner.limits,
      termination: owner.termination,
    });

    await expect(result.runtime.run('hi')).resolves.toBe('ok');
  });

  it('默认 scheduler 与 0.1 串行行为一致，config 可覆盖', async () => {
    const host = fakeHost();
    const captured: { options?: RuntimeOptions } = {};
    await tryCreateHostRuntime({
      config: {},
      owner,
      sessionId: 's1',
      loadHostModule: async () => loaderFor(host, captured),
    });
    expect(captured.options?.scheduler).toEqual(DEFAULT_SCHEDULER_OPTIONS);

    const host2 = fakeHost();
    const captured2: { options?: RuntimeOptions } = {};
    await tryCreateHostRuntime({
      config: { scheduler: { maxConcurrency: 3, perAgentSerial: false } },
      owner,
      sessionId: 's1',
      loadHostModule: async () => loaderFor(host2, captured2),
    });
    expect(captured2.options?.scheduler).toEqual({
      maxConcurrency: 3,
      maxQueueSize: DEFAULT_SCHEDULER_OPTIONS.maxQueueSize,
      perAgentSerial: false,
    });
  });

  it('durable：runStore 透传给 createRuntime；未提供时不出现', async () => {
    const store = new MemoryRunStore();
    const host = fakeHost();
    const captured: { options?: RuntimeOptions } = {};
    await tryCreateHostRuntime({
      config: {},
      owner,
      sessionId: 's1',
      runStore: store,
      loadHostModule: async () => loaderFor(host, captured),
    });
    expect(captured.options?.runStore).toBe(store);

    const host2 = fakeHost();
    const captured2: { options?: RuntimeOptions } = {};
    await tryCreateHostRuntime({
      config: {},
      owner,
      sessionId: 's1',
      loadHostModule: async () => loaderFor(host2, captured2),
    });
    expect(captured2.options?.runStore).toBeUndefined();
  });

  it('observability：events 透传给 createRuntime；未提供时不出现', async () => {
    const bus = new MemoryEventBus({ maxHistory: 5 });
    const host = fakeHost();
    const captured: { options?: RuntimeOptions } = {};
    await tryCreateHostRuntime({
      config: {},
      owner,
      sessionId: 's1',
      events: bus,
      loadHostModule: async () => loaderFor(host, captured),
    });
    expect(captured.options?.events).toBe(bus);

    const host2 = fakeHost();
    const captured2: { options?: RuntimeOptions } = {};
    await tryCreateHostRuntime({
      config: {},
      owner,
      sessionId: 's1',
      loadHostModule: async () => loaderFor(host2, captured2),
    });
    expect(captured2.options?.events).toBeUndefined();
  });

  it('limits：run/agent 同源，host.limits 缺省关闭', async () => {
    const host = fakeHost();
    const captured: { options?: RuntimeOptions } = {};
    await tryCreateHostRuntime({
      config: {},
      owner,
      sessionId: 's1',
      loadHostModule: async () => loaderFor(host, captured),
    });
    expect(captured.options?.limits?.run).toBe(captured.options?.limits?.agent);
    expect(captured.options?.limits?.run).toEqual(DEFAULT_CONFIG.limits);
    expect(captured.options?.limits?.host).toBeUndefined();

    const host2 = fakeHost();
    const captured2: { options?: RuntimeOptions } = {};
    await tryCreateHostRuntime({
      config: { host: { limits: { requestLimit: 9 } } },
      owner,
      sessionId: 's1',
      loadHostModule: async () => loaderFor(host2, captured2),
    });
    expect(captured2.options?.limits?.host).toEqual({ requestLimit: 9 });
  });

  it('透传 contextFactory / transport / permission', async () => {
    const host = fakeHost();
    const captured: { options?: RuntimeOptions } = {};
    const contextFactory = () => context;
    const transport = { kind: 'in-process' } as Transport;
    const permission = { default: 'allow' as const };
    await tryCreateHostRuntime({
      config: {},
      owner: { ...owner, permission },
      sessionId: 's1',
      contextFactory,
      transport,
      loadHostModule: async () => loaderFor(host, captured),
    });
    expect(captured.options?.contextFactory).toBe(contextFactory);
    expect(captured.options?.transport).toBe(transport);
    expect(captured.options?.permission).toEqual(permission);
    expect(captured.options?.defaults?.permission).toEqual(permission);
    expect(captured.options?.defaults?.context).toBeUndefined();
  });

  it('createRuntime 抛错时返回 ok:false，不抛出', async () => {
    const result = await tryCreateHostRuntime({
      config: {},
      owner,
      sessionId: 's1',
      loadHostModule: async () => ({
        createRuntime: async () => {
          throw new Error('kernel unavailable');
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('kernel unavailable');
  });

  it('spawn 抛错时返回 ok:false', async () => {
    const host = fakeHost();
    host.failSpawn = true;
    const result = await tryCreateHostRuntime({
      config: {},
      owner,
      sessionId: 's1',
      loadHostModule: async () => loaderFor(host),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('spawn failed');
  });
});

describe('配置开关与 owner spec', () => {
  it('isHostEnabled 只认显式 true', () => {
    expect(isHostEnabled({})).toBe(false);
    expect(isHostEnabled({ host: {} })).toBe(false);
    expect(isHostEnabled({ host: { enabled: false } })).toBe(false);
    expect(isHostEnabled({ host: { enabled: true } })).toBe(true);
  });

  it('buildOwnerSpec 带上 sessionId 与层级 limits', () => {
    const spec = buildOwnerSpec(owner, 'session-x');
    expect(spec.sessionId).toBe('session-x');
    expect(spec.context).toBe(context);
    expect(spec.limits).toEqual({
      run: owner.limits,
      agent: owner.limits,
      termination: owner.termination,
    });
    expect(spec.id).toBe('owner');
  });
});
