import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import { createWorkflowEngine } from '../src/engine.js';
import {
  createCountingGuardrail,
  createCountingHook,
  createFakeAgent,
  createPluginHost,
  makeConfig,
  makeTempWorkspace,
  registerTool,
  writeWorkflow,
} from './fixtures/fakes.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function runToolStep(toolExtra: Parameters<typeof registerTool>[3]): Promise<{
  status: string | undefined;
  error: string | undefined;
  handlerCalls: () => number;
  guardrailCalls: () => number;
  hookCalls: () => number;
}> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  const file = await writeWorkflow(
    workspace.dir,
    'flow',
    `
name: permission
steps:
  - id: a
    type: tool
    tool: gated
`,
  );

  const pluginHost = createPluginHost();
  const guardrail = createCountingGuardrail();
  const hook = createCountingHook();
  pluginHost.registerGuardrail(guardrail.guardrail);
  pluginHost.registerHook(hook.hook);

  let handlerCalls = 0;
  registerTool(
    pluginHost,
    'gated',
    async () => {
      handlerCalls += 1;
      return 'ok';
    },
    toolExtra,
  );

  const engine = createWorkflowEngine({
    pluginHost,
    // 仅 tool step；注入 runtime 只为满足 start 的执行后端守卫。
    runtime: createFakeAgent().agent,
    config: makeConfig(workspace.dir, workspace.runs),
    events: new MemoryEventStream(),
  });
  const outcome = await (await engine.start(file)).done;
  const detail = await engine.getRun(outcome.workflow_run_id);
  const step = detail?.steps[0];
  return {
    status: step?.status,
    error: step?.error,
    handlerCalls: () => handlerCalls,
    guardrailCalls: () => guardrail.calls,
    hookCalls: () => hook.calls,
  };
}

describe('workflow tool permission', () => {
  it('denies a step when checkPermission returns deny', async () => {
    const result = await runToolStep({ checkPermission: async () => 'deny' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('permission_denied');
    expect(result.handlerCalls()).toBe(0);
  });

  it('denies a step when checkPermission returns ask (non-interactive)', async () => {
    const result = await runToolStep({ checkPermission: async () => 'ask' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('permission_denied');
    expect(result.handlerCalls()).toBe(0);
  });

  it('allows tools without checkPermission and bypasses guardrail/hook', async () => {
    const result = await runToolStep({});
    expect(result.status).toBe('completed');
    expect(result.handlerCalls()).toBe(1);
    expect(result.guardrailCalls()).toBe(0);
    expect(result.hookCalls()).toBe(0);
  });
});
