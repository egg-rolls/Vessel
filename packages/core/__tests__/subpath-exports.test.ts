import { describe, expect, it } from 'bun:test';
import { AgentRuntime, createRuntime, InProcessRuntimeHost } from '@vessel/core';
import { MemoryContextManager } from '@vessel/core/context';
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
import type { Message } from '@vessel/core/types';
import pkg from '../package.json';

describe('subpath exports (R6a)', () => {
  it('模块入口可导入并暴露关键符号', () => {
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

    const message: Message = { role: 'user', content: 'hi' };
    expect(message.role).toBe('user');
  });

  it('根入口导出面保持可用', () => {
    expect(typeof AgentRuntime).toBe('function');
    expect(typeof InProcessRuntimeHost).toBe('function');
    expect(typeof createRuntime).toBe('function');
  });

  it('package.json 覆盖所有模块 subpath', () => {
    const exportsMap = pkg.exports as Record<string, string>;
    for (const key of [
      '.',
      './context',
      './observability',
      './policy',
      './provider',
      './session',
      './types',
    ]) {
      expect(exportsMap[key]).toBeDefined();
    }
  });
});
