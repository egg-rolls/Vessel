/**
 * 0.8.2 Wave 2B1：workflow `type: tool` 接入统一工具管道。
 *
 * 覆盖：
 * - ToolCall guardrail 阻断时 handler 不执行；
 * - BeforeTool hook 的 updatedInput 传给 handler；
 * - tool.call.started / completed / failed 事件；
 * - pipeline 权限 ask 路径可用。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  createToolPipeline,
  GuardrailStage,
  HookType,
  MemoryEventStream,
  MemoryPluginHost,
  type RuntimePermissionConfig,
} from '@vessel-agent/core';
import { GuardrailRunner, HookRunner, PermissionPolicy } from '@vessel-agent/core/policy';
import { createWorkflowEngine } from '../src/engine.js';
import type { WorkflowOutcome } from '../src/types.js';
import {
  createFakeAgent,
  makeConfig,
  makeTempWorkspace,
  registerTool,
  writeWorkflow,
} from './fixtures/fakes.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface HarnessOptions {
  workflow: string;
  setup?: (host: MemoryPluginHost) => void;
  permission?: RuntimePermissionConfig;
}

interface Harness {
  engine: ReturnType<typeof createWorkflowEngine>;
  events: MemoryEventStream;
  file: string;
  run(): Promise<WorkflowOutcome>;
}

async function createHarness(options: HarnessOptions): Promise<Harness> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  const file = await writeWorkflow(workspace.dir, 'flow', options.workflow);

  const events = new MemoryEventStream();
  const pluginHost = new MemoryPluginHost();
  options.setup?.(pluginHost);

  const pipeline = createToolPipeline({
    pluginHost,
    events,
    permission: new PermissionPolicy(events, options.permission),
    guardrails: new GuardrailRunner(pluginHost, events),
    hooks: new HookRunner(pluginHost, events),
  });

  const engine = createWorkflowEngine({
    pluginHost,
    toolPipeline: pipeline,
    // 仅 tool step；注入 runtime 只为满足 start 的执行后端守卫。
    runtime: createFakeAgent().agent,
    config: makeConfig(workspace.dir, workspace.runs),
    events,
  });

  return {
    engine,
    events,
    file,
    async run() {
      const started = await engine.start(file);
      return started.done;
    },
  };
}

function dataOf(event: { data: unknown } | undefined): Record<string, unknown> {
  return (event?.data ?? {}) as Record<string, unknown>;
}

describe('workflow tool step → tool pipeline', () => {
  it('blocks a tool step when a ToolCall guardrail denies (handler not executed)', async () => {
    let handlerCalls = 0;
    const harness = await createHarness({
      workflow: `
name: guard
steps:
  - id: a
    type: tool
    tool: blocked
`,
      setup(host) {
        registerTool(host, 'blocked', async () => {
          handlerCalls += 1;
          return 'should not run';
        });
        host.registerGuardrail({
          name: 'deny-blocked',
          stage: GuardrailStage.ToolCall,
          check: async () => ({ allowed: false, reason: 'policy says no' }),
        });
      },
    });

    const outcome = await harness.run();
    expect(outcome.status).toBe('failed');
    const detail = await harness.engine.getRun(outcome.workflow_run_id);
    expect(detail?.steps[0]?.error).toContain('blocked by guardrail');
    expect(handlerCalls).toBe(0);

    const history = harness.events.getHistory();
    const types = history.map((event) => event.type);
    expect(types).toContain('tool.call.started');
    expect(types).toContain('tool.call.failed');
    expect(types).not.toContain('tool.call.completed');

    const failed = history.find((event) => event.type === 'tool.call.failed');
    expect(failed?.run_id).toBe(outcome.workflow_run_id);
    const data = dataOf(failed);
    expect(data.tool_call_id).toBe(`${outcome.workflow_run_id}:a`);
    expect(data.tool_name).toBe('blocked');
    expect(typeof data.error).toBe('string');
  });

  it('lets a BeforeTool hook rewrite the args seen by the handler', async () => {
    const seen: unknown[] = [];
    const harness = await createHarness({
      workflow: `
name: hook
steps:
  - id: a
    type: tool
    tool: echo
    args:
      value: original
`,
      setup(host) {
        registerTool(host, 'echo', async (args) => {
          seen.push(args);
          return 'rewritten-ok';
        });
        host.registerHook({
          name: 'rewrite',
          type: HookType.BeforeTool,
          run: async () => ({ updatedInput: { value: 'rewritten' } }),
        });
      },
    });

    const outcome = await harness.run();
    expect(outcome.status).toBe('completed');
    expect(seen).toEqual([{ value: 'rewritten' }]);
    const detail = await harness.engine.getRun(outcome.workflow_run_id);
    expect(detail?.steps[0]?.output_preview).toBe('rewritten-ok');
  });

  it('publishes tool.call.started/completed with run_id and tool_call_id', async () => {
    const harness = await createHarness({
      workflow: `
name: events
steps:
  - id: step-1
    type: tool
    tool: echo
`,
      setup(host) {
        registerTool(host, 'echo', async () => 'done');
      },
    });

    const outcome = await harness.run();
    expect(outcome.status).toBe('completed');

    const history = harness.events.getHistory();
    const started = history.find((event) => event.type === 'tool.call.started');
    const completed = history.find((event) => event.type === 'tool.call.completed');
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect(started?.run_id).toBe(outcome.workflow_run_id);
    expect(completed?.run_id).toBe(outcome.workflow_run_id);

    const startedData = dataOf(started);
    expect(startedData.tool_call_id).toBe(`${outcome.workflow_run_id}:step-1`);
    expect(startedData.tool_name).toBe('echo');
    expect(startedData.arguments).toEqual({});

    const completedData = dataOf(completed);
    expect(completedData.tool_call_id).toBe(`${outcome.workflow_run_id}:step-1`);
    expect(completedData.result).toBe('done');
    expect(typeof completedData.duration_ms).toBe('number');
  });

  it('uses pipeline permission: default ask waits for tool.permission.response', async () => {
    let handlerCalls = 0;
    const harness = await createHarness({
      workflow: `
name: ask
steps:
  - id: a
    type: tool
    tool: asky
`,
      permission: { default: 'ask' },
      setup(host) {
        registerTool(host, 'asky', async () => {
          handlerCalls += 1;
          return 'allowed-by-user';
        });
      },
    });

    let permissionData: Record<string, unknown> | undefined;
    harness.events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      const data = dataOf(event);
      permissionData = data;
      harness.events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: { requestId: data.requestId, decision: 'allow' },
        ts: Date.now(),
      });
    });

    const outcome = await harness.run();
    expect(outcome.status).toBe('completed');
    expect(handlerCalls).toBe(1);
    // workflow 没有真实 session，沿用既有语义把 session_id 填成 workflow_run_id。
    expect(permissionData?.session_id).toBe(outcome.workflow_run_id);
  });
});
