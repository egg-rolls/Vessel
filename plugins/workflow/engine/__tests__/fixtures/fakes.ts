/**
 * Workflow 测试夹具：fake Host / fake Agent / 临时目录 / 工具注册。
 * 全部离线，不使用真实 provider。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentHandle,
  Guardrail,
  Hook,
  MemoryEventStream,
  PluginHost,
  RunHandle,
  RunnableAgent,
  RuntimeHost,
  Scheduler,
  ToolDefinition,
  ToolHandler,
} from '@vessel/core';
import {
  MemoryEventStream as EventStreamImpl,
  GuardrailStage,
  HookType,
  MemoryPluginHost,
} from '@vessel/core';
import type { ResolvedWorkflowConfig } from '../../src/types.js';

export type AgentBehavior = (prompt: string, signal: AbortSignal | undefined) => Promise<string>;

export interface RunRecord {
  agentId: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface FakeHostResult {
  host: RuntimeHost;
  events: MemoryEventStream;
  runs: RunRecord[];
  readonly peak: number;
  setAgent(id: string, behavior: AgentBehavior): void;
}

export function createFakeHost(): FakeHostResult {
  const events = new EventStreamImpl();
  const behaviors = new Map<string, AgentBehavior>();
  const handles = new Map<string, AgentHandle>();
  const runs: RunRecord[] = [];
  let active = 0;
  let peak = 0;
  let counter = 0;

  const handleFor = (id: string): AgentHandle =>
    ({
      id,
      name: id,
      status: () => ({ id, state: 'idle', toolNames: [] }),
      run: async (input: string | { content: string }, opts?: { signal?: AbortSignal }) => {
        const prompt = typeof input === 'string' ? input : input.content;
        runs.push({
          agentId: id,
          prompt,
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        });
        const runId = `run_${++counter}`;
        const result = (async () => {
          active += 1;
          peak = Math.max(peak, active);
          try {
            const behavior = behaviors.get(id);
            if (!behavior) throw new Error(`no behavior for agent ${id}`);
            return await behavior(prompt, opts?.signal);
          } finally {
            active -= 1;
          }
        })();
        return {
          id: runId,
          agentId: id,
          sessionId: 'default',
          status: () => 'running',
          result,
          usage: () => undefined,
          cancel: () => undefined,
        } as unknown as RunHandle;
      },
      send: async () => undefined,
      inbox: async () => ({ messages: [], cursor: '' }),
      cancel: () => undefined,
      close: async () => undefined,
    }) as unknown as AgentHandle;

  const host = {
    events,
    scheduler: {} as Scheduler,
    get: (id: string) => {
      if (!behaviors.has(id)) return undefined;
      let handle = handles.get(id);
      if (!handle) {
        handle = handleFor(id);
        handles.set(id, handle);
      }
      return handle;
    },
    spawn: async () => {
      throw new Error('spawn is not used in workflow tests');
    },
    list: () => [],
    send: async () => undefined,
    inbox: async () => ({ messages: [], cursor: '' }),
    cancel: () => undefined,
    close: async () => undefined,
  } as unknown as RuntimeHost;

  return {
    host,
    events,
    runs,
    get peak() {
      return peak;
    },
    setAgent(id, behavior) {
      behaviors.set(id, behavior);
    },
  };
}

export interface FakeAgentResult {
  agent: RunnableAgent;
  calls: Array<{ input: string; sessionId?: string }>;
  readonly peak: number;
}

export function createFakeAgent(
  behavior: (input: string, signal: AbortSignal | undefined) => Promise<string> = async (input) =>
    `out:${input}`,
): FakeAgentResult {
  const calls: Array<{ input: string; sessionId?: string }> = [];
  let active = 0;
  let peak = 0;

  const agent: RunnableAgent = {
    events: new EventStreamImpl(),
    pluginHost: new MemoryPluginHost(),
    async run(input, sessionId, opts) {
      const text = typeof input === 'string' ? input : input.content;
      calls.push({ input: text, ...(sessionId !== undefined ? { sessionId } : {}) });
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await behavior(text, opts?.signal);
      } finally {
        active -= 1;
      }
    },
    dispose() {
      // no-op
    },
  };

  return {
    agent,
    calls,
    get peak() {
      return peak;
    },
  };
}

export function createPluginHost(): MemoryPluginHost {
  return new MemoryPluginHost();
}

export function registerTool(
  host: PluginHost,
  name: string,
  handler: ToolHandler,
  extra: Partial<ToolDefinition> = {},
): void {
  host.registerTool({
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler,
    ...extra,
  });
}

export interface CountingGuardrail {
  guardrail: Guardrail;
  readonly calls: number;
}

export function createCountingGuardrail(): CountingGuardrail {
  let calls = 0;
  return {
    guardrail: {
      name: 'counting',
      stage: GuardrailStage.ToolCall,
      async check() {
        calls += 1;
        return { allowed: true };
      },
    },
    get calls() {
      return calls;
    },
  };
}

export interface CountingHook {
  hook: Hook;
  readonly calls: number;
}

export function createCountingHook(): CountingHook {
  let calls = 0;
  return {
    hook: {
      name: 'counting',
      type: HookType.BeforeTool,
      async run() {
        calls += 1;
      },
    },
    get calls() {
      return calls;
    },
  };
}

export interface TempWorkspace {
  root: string;
  dir: string;
  runs: string;
  cleanup(): Promise<void>;
}

export async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vessel-workflow-'));
  const dir = path.join(root, 'workflows');
  const runs = path.join(root, 'runs');
  await fs.mkdir(dir, { recursive: true });
  return {
    root,
    dir,
    runs,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function writeWorkflow(
  dir: string,
  name: string,
  source: string,
  extension: 'yaml' | 'yml' | 'json' = 'yaml',
): Promise<string> {
  const target = path.join(dir, `${name}.${extension}`);
  await fs.writeFile(target, source, 'utf8');
  return target;
}

export function makeConfig(
  dir: string,
  runs: string,
  overrides: Partial<ResolvedWorkflowConfig> = {},
): ResolvedWorkflowConfig {
  return {
    enabled: true,
    dir,
    path: runs,
    maxParallel: 2,
    stepTimeoutMs: 5000,
    ...overrides,
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
