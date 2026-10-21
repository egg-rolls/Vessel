/**
 * 0.15 E9：delegate child 的 Self Card options。
 *
 * 故障形状：spawn 规格缺 selfCard → 子 agent 的 systemPrompt 里没有角色/深度/预算，
 * 与根 agent 一样行动（重复分派、不知道自己能调什么工具、不知道如何求助）。
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
} from '@vessel-agent/core';
import { createDelegateTaskPlugin, type DelegateTaskOptions } from '../src/index';

const provider: LLMProvider = {
  async chat() {
    return { content: '', finish_reason: 'stop' };
  },
};

/** 假 Host：记录 spawn 规格，返回立即完成的 child run。 */
function createCaptureHost(): {
  host: RuntimeHost;
  specs: Array<AgentSpec & Record<string, unknown>>;
} {
  const events = new MemoryEventStream();
  const specs: Array<AgentSpec & Record<string, unknown>> = [];
  const host = {
    events,
    scheduler: {},
    spawn: async (spec: AgentSpec) => {
      specs.push(spec as AgentSpec & Record<string, unknown>);
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
  return { host, specs };
}

async function runDelegate(options: Partial<DelegateTaskOptions> = {}): Promise<{
  result: string;
  spec: AgentSpec & Record<string, unknown>;
}> {
  const capture = createCaptureHost();
  const parentHost = new MemoryPluginHost();
  parentHost.registerTool({
    name: 'gated',
    description: 'child tool',
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
  const spec = capture.specs[0];
  if (!spec) throw new Error('child was not spawned');
  return { result, spec };
}

describe('delegate child Self Card（E9）', () => {
  it('spawn 规格缺 selfCard 时子 agent 看不到角色、工具与预算', async () => {
    const { result, spec } = await runDelegate();
    expect(result).toBe('child result');

    const selfCard = spec.selfCard as Record<string, unknown> | undefined;
    if (!selfCard) throw new Error('selfCard missing from spawn spec');
    expect(selfCard.role).toBe('delegate');
    expect(selfCard.depth).toBe(1);
    expect(selfCard.model).toBe('test-model');
    expect(selfCard.tools).toEqual(['gated']);
    expect(selfCard.parent_id).toBeUndefined();
    expect(selfCard.limits).toEqual({ maxIterations: 10, maxRuntimeSeconds: 60 });
    expect(selfCard.context).toEqual({ max: 1_000_000 });
    expect(String(selfCard.how_to_ask)).toContain('non-interactive');
  });

  it('context.max 用注入的 contextMaxTokens，而不是固定默认值', async () => {
    const { spec } = await runDelegate({ contextMaxTokens: 12_345 });
    const selfCard = spec.selfCard as Record<string, unknown>;
    expect(selfCard.context).toEqual({ max: 12_345 });
  });
});
