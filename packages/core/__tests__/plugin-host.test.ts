import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { Guardrail } from '../src/types/guardrail';
import { GuardrailStage } from '../src/types/guardrail';
import type { Hook } from '../src/types/hook';
import { HookType } from '../src/types/hook';
import type { ProviderFactory } from '../src/types/provider';
import type { ToolDefinition } from '../src/types/tool';

describe('MemoryPluginHost', () => {
  let host: MemoryPluginHost;

  beforeEach(() => {
    host = new MemoryPluginHost();
  });

  it('should register tools', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'Test tool',
      inputSchema: {},
      handler: async () => 'result',
    };

    host.registerTool(tool);

    expect(host.getTool('test-tool')).toEqual(tool);
    expect(host.listTools()).toHaveLength(1);
    expect(host.toolCount).toBe(1);
  });

  it('should register providers', () => {
    const factory: ProviderFactory = () => ({
      chat: async () => ({
        content: 'test',
        finish_reason: 'stop',
      }),
    });

    host.registerProvider('test-provider', factory);

    expect(host.getProvider('test-provider')).toBe(factory);
    expect(host.listProviders()).toContain('test-provider');
    expect(host.providerCount).toBe(1);
  });

  it('should register guardrails', () => {
    const guardrail: Guardrail = {
      name: 'test-guardrail',
      stage: GuardrailStage.Input,
      check: async () => ({ allowed: true }),
    };

    host.registerGuardrail(guardrail);

    expect(host.getGuardrails()).toContain(guardrail);
    expect(host.guardrailCount).toBe(1);
  });

  it('should register hooks', () => {
    const hook: Hook = {
      name: 'test-hook',
      type: HookType.BeforeLlm,
      run: async () => null,
    };

    host.registerHook(hook);

    expect(host.getHooks()).toContain(hook);
    expect(host.hookCount).toBe(1);
  });

  it('should throw on duplicate tool registration', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'Test tool',
      inputSchema: {},
      handler: async () => 'result',
    };

    host.registerTool(tool);

    expect(() => host.registerTool(tool)).toThrow('Tool "test-tool" is already registered');
  });

  it('should throw on duplicate provider registration', () => {
    const factory: ProviderFactory = () => ({
      chat: async () => ({
        content: 'test',
        finish_reason: 'stop',
      }),
    });

    host.registerProvider('test-provider', factory);

    expect(() => host.registerProvider('test-provider', factory)).toThrow(
      'Provider "test-provider" is already registered',
    );
  });

  it('should sort guardrails by priority', () => {
    const guardrail1: Guardrail = {
      name: 'low-priority',
      stage: GuardrailStage.Input,
      priority: 100,
      check: async () => ({ allowed: true }),
    };

    const guardrail2: Guardrail = {
      name: 'high-priority',
      stage: GuardrailStage.Input,
      priority: 10,
      check: async () => ({ allowed: true }),
    };

    host.registerGuardrail(guardrail1);
    host.registerGuardrail(guardrail2);

    const guardrails = host.getGuardrails();
    expect(guardrails[0]?.name).toBe('high-priority');
    expect(guardrails[1]?.name).toBe('low-priority');
  });

  it('should sort hooks by priority', () => {
    const hook1: Hook = {
      name: 'low-priority',
      type: HookType.BeforeLlm,
      priority: 100,
      run: async () => null,
    };

    const hook2: Hook = {
      name: 'high-priority',
      type: HookType.BeforeLlm,
      priority: 10,
      run: async () => null,
    };

    host.registerHook(hook1);
    host.registerHook(hook2);

    const hooks = host.getHooks();
    expect(hooks[0]?.name).toBe('high-priority');
    expect(hooks[1]?.name).toBe('low-priority');
  });
});
