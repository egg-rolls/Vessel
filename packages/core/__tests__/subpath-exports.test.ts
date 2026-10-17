import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  createRuntime,
  InProcessRuntimeHost,
  InProcessScheduler,
  InProcessTransport,
} from '@vessel/core';
import { MemoryContextManager } from '@vessel/core/context';
import type { AgentSpec } from '@vessel/core/kernel';
import {
  createCancellationScope,
  InProcessScheduler as KernelScheduler,
  MemoryEventBus,
  SerialScheduler,
} from '@vessel/core/kernel';
import { FileEventStore, MemoryEventStream, replayRun } from '@vessel/core/observability';
import {
  GuardrailRunner,
  GuardrailStage,
  HookRunner,
  HookType,
  PermissionPolicy,
} from '@vessel/core/policy';
import {
  AnthropicProvider,
  MemoryLLMProvider,
  OpenAICompatibleProvider,
} from '@vessel/core/provider';
import {
  FileSessionBackend,
  MemorySessionBackend,
  SQLiteSessionBackend,
} from '@vessel/core/session';
import { InProcessTransport as SubpathTransport } from '@vessel/core/transport';
import type { Message } from '@vessel/core/types';
import pkg from '../package.json';

describe('subpath exports (R6a/R6b)', () => {
  it('模块入口可导入并暴露关键符号', async () => {
    expect(typeof MemoryContextManager).toBe('function');

    expect(typeof MemoryLLMProvider).toBe('function');
    expect(typeof OpenAICompatibleProvider).toBe('function');
    expect(typeof AnthropicProvider).toBe('function');

    expect(typeof FileSessionBackend).toBe('function');
    expect(typeof MemorySessionBackend).toBe('function');
    expect(typeof SQLiteSessionBackend).toBe('function');

    expect(typeof FileEventStore).toBe('function');
    expect(typeof MemoryEventStream).toBe('function');
    expect(typeof replayRun).toBe('function');

    expect(typeof PermissionPolicy).toBe('function');
    expect(typeof GuardrailRunner).toBe('function');
    expect(typeof HookRunner).toBe('function');
    expect(String(GuardrailStage.Input)).toBe('input');
    expect(String(HookType.BeforeLlm)).toBe('before_llm');

    // kernel subpath
    expect(typeof createCancellationScope).toBe('function');
    expect(typeof MemoryEventBus).toBe('function');
    expect(typeof KernelScheduler).toBe('function');
    expect(KernelScheduler).toBe(InProcessScheduler);
    expect(SerialScheduler).toBe(InProcessScheduler);

    // transport subpath
    expect(typeof SubpathTransport).toBe('function');
    expect(SubpathTransport).toBe(InProcessTransport);
    const transport = new SubpathTransport();
    expect(transport.kind).toBe('in-process');
    await transport.close();

    const message: Message = { role: 'user', content: 'hi' };
    expect(message.role).toBe('user');

    const partialSpec: Partial<AgentSpec> = { name: 'subpath-check' };
    expect(partialSpec.name).toBe('subpath-check');
  });

  it('根入口导出面保持可用', () => {
    expect(typeof AgentRuntime).toBe('function');
    expect(typeof InProcessRuntimeHost).toBe('function');
    expect(typeof InProcessScheduler).toBe('function');
    expect(typeof InProcessTransport).toBe('function');
    expect(typeof createRuntime).toBe('function');
  });

  it('package.json 覆盖所有模块 subpath', () => {
    const exportsMap = pkg.exports as Record<string, string>;
    for (const key of [
      '.',
      './context',
      './kernel',
      './observability',
      './policy',
      './provider',
      './session',
      './transport',
      './types',
    ]) {
      expect(exportsMap[key]).toBeDefined();
    }
  });
});
