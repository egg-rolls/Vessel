/**
 * REPL 命令测试用的 mock ReplContext 工具
 */
import {
  MemoryContextManager,
  MemoryEventStream,
  MemorySessionBackend,
  MemoryToolRegistry,
} from '@vessel/core';
import type { ToolDefinition } from '@vessel/core';
import type { ReplState } from '../src/commands/commands.js';
import type { ReplContext } from '../src/repl-context.js';

export function makeCtx(overrides: Partial<ReplContext> = {}): ReplContext {
  const tools = new MemoryToolRegistry();
  const session = new MemorySessionBackend();
  const context = new MemoryContextManager();
  const events = new MemoryEventStream();
  return {
    runtime: {} as ReplContext['runtime'],
    tools,
    session,
    events,
    context,
    currentSessionId: '20260101_120000_abc123',
    onSessionChange: () => undefined,
    provider: { name: 'mock', model: 'mock-model', baseUrl: 'memory' },
    plugins: [],
    config: {} as ReplContext['config'],
    newSessionId: () => '20260101_120001_def456',
    onExit: () => undefined,
    ...overrides,
  };
}

export function makeState(sessionId: string): ReplState {
  return { currentSessionId: sessionId, pendingResume: false, running: true };
}

export function registerSampleTool(ctx: ReplContext, def: ToolDefinition): void {
  ctx.tools.register(def);
}

/** 捕获 console.log / console.error 输出，返回还原函数与累计行 */
export function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  return {
    logs,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}
