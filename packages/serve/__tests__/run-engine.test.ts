import { describe, expect, test } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost, type RunnableAgent } from '@vessel-agent/core';
import { createRunEngine } from '../src/run-engine';

interface GatedAgent {
  agent: RunnableAgent;
  release: () => void;
  waiting: () => number;
}

/** run 在 gate 释放前保持 running，便于在 run 生命周期中注入 core 事件。 */
function gatedAgent(events: MemoryEventStream): GatedAgent {
  const gates: Array<() => void> = [];
  const agent: RunnableAgent = {
    events,
    pluginHost: new MemoryPluginHost(),
    run: () =>
      new Promise<string>((resolve) => {
        gates.push(() => resolve('done'));
      }),
    dispose: () => {},
  };
  return {
    agent,
    release: () => {
      const gate = gates.shift();
      if (!gate) throw new Error('no pending run');
      gate();
    },
    waiting: () => gates.length,
  };
}

function started(coreRunId: string): {
  type: string;
  run_id: string;
  data: Record<string, unknown>;
  ts: number;
} {
  return { type: 'run.started', run_id: coreRunId, data: {}, ts: 1 };
}

describe('run engine coreToJob lifecycle', () => {
  test('maps core run ids while running and drops the mapping at terminal state', async () => {
    const events = new MemoryEventStream();
    const { agent, release } = gatedAgent(events);
    const engine = createRunEngine({
      tenantEventsFor: () => events,
      runtime: agent,
      defaultTenantId: 'default',
    });

    const { run_id } = engine.submitRun({ input: 'hello' });
    engine.handleEvent(started('core-1'));
    expect(engine.coreToJob.get('core-1')).toBe(run_id);

    release();
    await engine.get(run_id)?.done;

    expect(engine.coreToJob.has('core-1')).toBe(false);
    expect(engine.coreToJob.size).toBe(0);
  });

  test('does not accumulate mappings across sequential runs', async () => {
    const events = new MemoryEventStream();
    const { agent, release } = gatedAgent(events);
    const engine = createRunEngine({
      tenantEventsFor: () => events,
      runtime: agent,
      defaultTenantId: 'default',
    });

    for (let index = 0; index < 5; index += 1) {
      const { run_id } = engine.submitRun({ input: `run-${index}` });
      engine.handleEvent(started(`core-${index}`));
      expect(engine.coreToJob.size).toBe(1);
      release();
      await engine.get(run_id)?.done;
    }

    expect(engine.coreToJob.size).toBe(0);
  });

  test('drops the mapping of runs evicted by trimRuns', async () => {
    const events = new MemoryEventStream();
    const { agent, release } = gatedAgent(events);
    const engine = createRunEngine({
      tenantEventsFor: () => events,
      runtime: agent,
      defaultTenantId: 'default',
      maxRuns: 1,
    });

    const first = engine.submitRun({ input: 'first' });
    engine.handleEvent(started('core-first'));
    release();
    await engine.get(first.run_id)?.done;

    // 模拟一条在终态清理后仍残留的映射（例如旧版本升级前写入）。
    engine.coreToJob.set('core-first', first.run_id);
    expect(engine.runs.has(first.run_id)).toBe(true);

    const second = engine.submitRun({ input: 'second' });
    engine.handleEvent(started('core-second'));
    release();
    await engine.get(second.run_id)?.done;

    expect(engine.runs.has(first.run_id)).toBe(false);
    expect(engine.runs.size).toBe(1);
    expect(engine.coreToJob.has('core-first')).toBe(false);
    expect(engine.coreToJob.has('core-second')).toBe(false);
  });
});
