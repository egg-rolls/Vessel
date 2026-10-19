import { describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '../src/events/event-stream';
import { GuardrailRunner } from '../src/runtime/guardrail-runner';
import { HookRunner } from '../src/runtime/hook-runner';
import { PermissionPolicy } from '../src/runtime/permission-policy';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { createToolPipeline, type ToolPipeline } from '../src/runtime/tool-pipeline';
import { GuardrailStage } from '../src/types/guardrail';
import { HookType } from '../src/types/hook';
import type { ToolCall, ToolDefinition } from '../src/types/tool';

function call(name: string, args = '{}'): ToolCall {
  return { id: 'call-1', type: 'function', function: { name, arguments: args } };
}

function makeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: overrides.name,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'ok',
    ...overrides,
  };
}

function createPipeline(host: MemoryPluginHost): ToolPipeline {
  const events = new MemoryEventStream();
  return createToolPipeline({
    pluginHost: host,
    events,
    permission: new PermissionPolicy(events),
    guardrails: new GuardrailRunner(host, events),
    hooks: new HookRunner(host, events),
  });
}

function execute(pipeline: ToolPipeline, toolCall: ToolCall, args: unknown = {}) {
  return pipeline.execute({
    runId: 'run-1',
    sessionId: 'session-1',
    toolCall,
    args,
  });
}

describe('tool pipeline (0.8.2 Wave 2B1)', () => {
  it('runs stages in order: permission → before hook → call guardrail → handler → result guardrail → after hook', async () => {
    const order: string[] = [];
    const host = new MemoryPluginHost();
    host.registerTool(
      makeTool({
        name: 'ordered',
        checkPermission: async () => {
          order.push('permission');
          return 'allow';
        },
        handler: async () => {
          order.push('handler');
          return 'result';
        },
      }),
    );
    host.registerHook({
      name: 'before',
      type: HookType.BeforeTool,
      run: async () => {
        order.push('before');
      },
    });
    host.registerGuardrail({
      name: 'call-guard',
      stage: GuardrailStage.ToolCall,
      check: async () => {
        order.push('call_guardrail');
        return { allowed: true };
      },
    });
    host.registerGuardrail({
      name: 'result-guard',
      stage: GuardrailStage.ToolResult,
      check: async () => {
        order.push('result_guardrail');
        return { allowed: true };
      },
    });
    host.registerHook({
      name: 'after',
      type: HookType.AfterTool,
      run: async () => {
        order.push('after');
      },
    });

    const result = await execute(createPipeline(host), call('ordered'));

    expect(result).toEqual({ ok: true, input: {}, content: 'result' });
    expect(order).toEqual([
      'permission',
      'before',
      'call_guardrail',
      'handler',
      'result_guardrail',
      'after',
    ]);
  });

  it('folds a BeforeTool block back as a failure and skips the handler', async () => {
    let called = false;
    const host = new MemoryPluginHost();
    host.registerTool(
      makeTool({
        name: 'noop',
        handler: async () => {
          called = true;
          return 'ok';
        },
      }),
    );
    host.registerHook({
      name: 'deny',
      type: HookType.BeforeTool,
      run: async () => ({ block: true, reason: 'not allowed' }),
    });

    const result = await execute(createPipeline(host), call('noop'));

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Tool call blocked by hook: not allowed');
    expect(called).toBe(false);
  });

  it('applies BeforeTool updatedInput to the handler', async () => {
    let received: unknown;
    const host = new MemoryPluginHost();
    host.registerTool(
      makeTool({
        name: 'noop',
        handler: async (args) => {
          received = args;
          return 'ok';
        },
      }),
    );
    host.registerHook({
      name: 'rewrite',
      type: HookType.BeforeTool,
      run: async () => ({ updatedInput: { x: 'rewritten' } }),
    });

    const result = await execute(createPipeline(host), call('noop', '{"x":"original"}'), {
      x: 'original',
    });

    expect(result.ok).toBe(true);
    expect(result.input).toEqual({ x: 'rewritten' });
    expect(received).toEqual({ x: 'rewritten' });
  });

  it('uses a ToolCall guardrail replacement for the handler name and args', async () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    const host = new MemoryPluginHost();
    host.registerTool(
      makeTool({
        name: 'original',
        handler: async () => 'original',
      }),
    );
    host.registerTool(
      makeTool({
        name: 'replacement',
        handler: async (args) => {
          seen.push({ tool: 'replacement', args });
          return 'replaced';
        },
      }),
    );
    host.registerGuardrail({
      name: 'replace',
      stage: GuardrailStage.ToolCall,
      check: async () => ({
        allowed: true,
        replacement: {
          id: 'call-1',
          type: 'function',
          function: { name: 'replacement', arguments: '{"n":2}' },
        },
      }),
    });

    const result = await execute(createPipeline(host), call('original'), {});

    expect(result.ok).toBe(true);
    expect(result.content).toBe('replaced');
    expect(result.input).toEqual({ n: 2 });
    expect(seen).toEqual([{ tool: 'replacement', args: { n: 2 } }]);
  });

  it('folds a blocked ToolResult guardrail back as a failure', async () => {
    const host = new MemoryPluginHost();
    host.registerTool(
      makeTool({
        name: 'secret',
        handler: async () => 'secret result',
      }),
    );
    host.registerGuardrail({
      name: 'deny-result',
      stage: GuardrailStage.ToolResult,
      check: async () => ({ allowed: false, reason: 'pii detected' }),
    });

    const result = await execute(createPipeline(host), call('secret'));

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Tool result blocked by guardrail: pii detected');
    expect(result.content).not.toContain('secret result');
  });

  it('enforces tool.timeout', async () => {
    const host = new MemoryPluginHost();
    host.registerTool(
      makeTool({
        name: 'slow',
        timeout: 5,
        handler: () => new Promise((resolve) => setTimeout(() => resolve('late'), 50)),
      }),
    );

    const result = await execute(createPipeline(host), call('slow'));

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Tool "slow" timed out after 5ms');
  });

  it('runs AfterTool only after a successful handler', async () => {
    const after: string[] = [];
    const host = new MemoryPluginHost();
    host.registerTool(
      makeTool({
        name: 'ok',
        handler: async () => 'fine',
      }),
    );
    host.registerTool(
      makeTool({
        name: 'failing',
        handler: async () => {
          throw new Error('boom');
        },
      }),
    );
    host.registerHook({
      name: 'after',
      type: HookType.AfterTool,
      run: async (ctx) => {
        after.push(String(ctx.tool));
      },
    });
    const pipeline = createPipeline(host);

    const failed = await execute(pipeline, call('failing'));
    const succeeded = await execute(pipeline, call('ok'), {});

    expect(failed.ok).toBe(false);
    expect(failed.error).toBe('boom');
    expect(succeeded.ok).toBe(true);
    expect(after).toEqual(['ok']);
  });

  it('honors disabled stages and passes signal/messages to the handler', async () => {
    const calls: string[] = [];
    let seenSignal: AbortSignal | undefined;
    let seenMessages: unknown;
    const host = new MemoryPluginHost();
    host.registerTool(
      makeTool({
        name: 'noop',
        checkPermission: async () => {
          calls.push('permission');
          return 'allow';
        },
        handler: async (_args, ctx) => {
          calls.push('handler');
          seenSignal = ctx.signal;
          seenMessages = ctx.messages;
          return 'ok';
        },
      }),
    );
    host.registerHook({
      name: 'before',
      type: HookType.BeforeTool,
      run: async () => {
        calls.push('before');
      },
    });
    host.registerGuardrail({
      name: 'call-guard',
      stage: GuardrailStage.ToolCall,
      check: async () => {
        calls.push('call_guardrail');
        return { allowed: true };
      },
    });
    host.registerGuardrail({
      name: 'result-guard',
      stage: GuardrailStage.ToolResult,
      check: async () => {
        calls.push('result_guardrail');
        return { allowed: true };
      },
    });
    host.registerHook({
      name: 'after',
      type: HookType.AfterTool,
      run: async () => {
        calls.push('after');
      },
    });

    const controller = new AbortController();
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const result = await createPipeline(host).execute({
      runId: 'run-1',
      sessionId: 'session-1',
      toolCall: call('noop'),
      args: {},
      signal: controller.signal,
      messages,
      stages: {
        beforeToolHook: false,
        toolCallGuardrail: false,
        afterToolHook: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['permission', 'handler', 'result_guardrail']);
    expect(seenSignal).toBe(controller.signal);
    expect(seenMessages).toBe(messages);
  });

  it('reports unknown tools', async () => {
    const result = await execute(createPipeline(new MemoryPluginHost()), call('missing'));

    expect(result).toEqual({
      ok: false,
      input: {},
      content: 'Tool "missing" not found',
      error: 'Tool "missing" not found',
    });
  });
});
