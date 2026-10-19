/**
 * 0.8.2 Wave 2B1：delegate 子 agent 继承父权限配置。
 *
 * 用假 RuntimeHost 捕获 spawn 参数，只断言外部行为：
 * - 未注入 permission 时仍是 { default: 'allow' }（旧行为）；
 * - 注入时原样传给 host.spawn；
 * - permissionMode: 'allow' 仍显式给子工具包自动放行。
 */

import { describe, expect, it } from 'bun:test';
import {
  type AgentHandle,
  type AgentSpec,
  type LLMProvider,
  MemoryEventStream,
  MemoryPluginHost,
  type RuntimeHost,
  type ToolContext,
} from '@vessel/core';
import { createDelegateTaskPlugin, type DelegateTaskOptions } from '../src/index';

const provider: LLMProvider = {
  async chat() {
    return { content: '', finish_reason: 'stop' };
  },
};

/** 假 Host：记录 spawn 参数，返回一个立即完成的子 run。 */
function createCaptureHost(): {
  host: RuntimeHost;
  spawns: AgentSpec[];
} {
  const events = new MemoryEventStream();
  const spawns: AgentSpec[] = [];

  const host = {
    events,
    scheduler: {},
    spawn: async (spec: AgentSpec) => {
      spawns.push(spec);
      const id = spec.id ?? 'child';
      return {
        id,
        name: spec.name,
        status: () => ({ id, state: 'idle', toolNames: [] }),
        run: async () => ({
          id: 'child-run',
          agentId: id,
          sessionId: 'default',
          status: () => 'completed',
          result: Promise.resolve('child result'),
          usage: () => undefined,
          cancel: () => undefined,
        }),
        send: async () => undefined,
        inbox: async () => ({ messages: [], cursor: '' }),
        cancel: () => undefined,
        close: async () => undefined,
      } as unknown as AgentHandle;
    },
    get: () => undefined,
    list: () => [],
    send: async () => undefined,
    inbox: async () => ({ messages: [], cursor: '' }),
    cancel: () => undefined,
    close: async () => undefined,
  } as unknown as RuntimeHost;

  return { host, spawns };
}

async function runDelegate(options: Partial<DelegateTaskOptions> = {}): Promise<{
  result: string;
  spawns: AgentSpec[];
}> {
  const capture = createCaptureHost();
  const parentHost = new MemoryPluginHost();
  parentHost.registerTool({
    name: 'gated',
    description: 'tool without checkPermission',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'gated-result',
  });

  const plugin = createDelegateTaskPlugin({
    providerFactory: () => provider,
    model: 'test-model',
    runtimeHost: capture.host,
    ...options,
  });
  plugin.install(parentHost);

  const tool = parentHost.getTool('delegate_task');
  if (!tool) throw new Error('delegate_task not registered');
  const ctx: ToolContext = {
    run_id: 'parent-run',
    session_id: 'parent-session',
    messages: [],
    events: new MemoryEventStream(),
  };
  const result = await tool.handler({ task: 'subtask' }, ctx);
  return { result, spawns: capture.spawns };
}

describe('delegate-task permission inheritance', () => {
  it('keeps { default: allow } when no permission is configured', async () => {
    const { result, spawns } = await runDelegate();
    expect(result).toBe('child result');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.permission).toEqual({ default: 'allow' });
  });

  it('passes the configured permission to host.spawn', async () => {
    const permission = { default: 'ask' as const, autoApprove: ['read'] };
    const { spawns } = await runDelegate({ permission });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.permission).toEqual(permission);
  });

  it('permissionMode: allow still auto-allows child tools explicitly', async () => {
    const { spawns } = await runDelegate({ permissionMode: 'allow' });
    const childHost = spawns[0]?.pluginHost;
    expect(childHost).toBeDefined();
    const tool = childHost?.getTool('gated');
    expect(tool?.checkPermission).toBeDefined();
    const decision = await tool?.checkPermission?.(
      {},
      {
        run_id: 'child-run',
        session_id: 'default',
        messages: [],
        events: new MemoryEventStream(),
      },
    );
    expect(decision).toBe('allow');
  });
});
