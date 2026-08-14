/**
 * @vessel/delegate-task - 子 agent 分派工具插件
 * @module @vessel/delegate-task
 *
 * 注册 delegate_task 工具：主 agent 在 handler 内 spawn 子 runtime 处理子任务，
 * 只回收最终文本，不污染父上下文。多 agent = 工具 handler 内 spawn 子 runtime（ADR-015），
 * 零 core 改动。
 *
 * 递归防护双保险：
 * - AsyncLocalStorage 深度计数（每 spawn 一层 +1，超 maxDepth 直接返回错误）；
 * - 子 agent 工具白名单（默认排除 delegate_task 自身，子 agent 无法再分派）。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  EventStream,
  LLMProvider,
  Plugin,
  PluginHost,
  TerminationPolicy,
  ToolContext,
  ToolDefinition,
  UsageLimits,
} from '@vessel/core';
import {
  AgentRuntime,
  MemoryContextManager,
  MemoryEventStream,
  MemoryToolRegistry,
} from '@vessel/core';

/** delegate 深度（每 spawn 一层 +1），AsyncLocalStorage 隔离并行分派，防无限递归 */
const delegateDepth = new AsyncLocalStorage<number>();

/** 子 agent 工具白名单：默认排除 delegate_task 自身，阻断递归 */
const DEFAULT_DISALLOWED = ['delegate_task'];

/** 插件配置（上层 bootstrap/插件构造时注入 provider 工厂 + model） */
export interface DelegateTaskOptions {
  /** 子 provider 工厂：每次 spawn 子 runtime 时调用（复用父 provider 或新建） */
  providerFactory: () => LLMProvider;
  /** 子 agent 使用的模型名 */
  model: string;
  /** 最大 delegate 深度（默认 3），超限直接返回错误 */
  maxDepth?: number;
  /** 子 agent 禁用的工具名（默认 ['delegate_task']） */
  disallowed?: string[];
  /** 子 agent 使用量限制（默认空） */
  limits?: UsageLimits;
  /** 子 agent 终止策略（默认 maxIterations: 10, maxRuntimeSeconds: 60） */
  termination?: TerminationPolicy;
}

/** 解析后的插件配置（内部使用，全字段定值） */
interface ResolvedConfig {
  providerFactory: () => LLMProvider;
  model: string;
  maxDepth: number;
  disallowed: string[];
  limits: UsageLimits;
  termination: TerminationPolicy;
}

/** 类型守卫：值是否为对象记录 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从记录安全读取字符串字段（非字符串返回空串） */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** 构建子 agent 工具注册表：复制父 host 的「安全工具」，排除 disallowed 名单 */
function buildChildTools(host: PluginHost, disallowed: string[]): MemoryToolRegistry {
  const registry = new MemoryToolRegistry();
  for (const tool of host.listTools()) {
    if (disallowed.includes(tool.name) || registry.has(tool.name)) continue;
    registry.register(tool);
  }
  return registry;
}

/** 订阅子 runtime 事件，转发到父 ctx.events（带 subagent.* 前缀，便于观测）；返回退订函数 */
function forwardEvents(parent: EventStream, child: EventStream): () => void {
  return child.subscribe((event) => {
    parent.publish({
      type: `subagent.${event.type}`,
      run_id: event.run_id,
      data: event.data,
      ts: event.ts,
    });
  });
}

/** spawn 子 runtime 并回收最终文本（只回传文本，不污染父上下文） */
async function runChildTask(config: {
  providerFactory: () => LLMProvider;
  model: string;
  task: string;
  context: string;
  tools: MemoryToolRegistry;
  parentEvents: EventStream;
  limits: UsageLimits;
  termination: TerminationPolicy;
}): Promise<string> {
  const childEvents = new MemoryEventStream();
  const unsubscribe = forwardEvents(config.parentEvents, childEvents);
  const input = config.context ? `${config.task}\n\n附加背景：\n${config.context}` : config.task;
  const runtime = await AgentRuntime.create({
    provider: config.providerFactory(),
    model: config.model,
    tools: config.tools,
    context: new MemoryContextManager(),
    events: childEvents,
    limits: config.limits,
    termination: config.termination,
  });
  try {
    return await runtime.run(input);
  } finally {
    unsubscribe();
    runtime.dispose();
  }
}

/** 构造 delegate_task 工具定义（闭包持有 host，运行时从 host 取安全工具） */
function makeDelegateTool(host: PluginHost, config: ResolvedConfig): ToolDefinition {
  return {
    name: 'delegate_task',
    description:
      'Delegate a subtask to an in-process child agent and return only its final text. ' +
      'Use for isolated or parallelizable sub-work; the child runs with a safe tool ' +
      'whitelist (no recursive delegate_task).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The subtask description' },
        context: { type: 'string', description: 'Optional additional background for the subtask' },
      },
      required: ['task'],
    },
    handler: async (args: unknown, ctx: ToolContext) => {
      const depth = delegateDepth.getStore() ?? 0;
      if (depth >= config.maxDepth) {
        return `Error: delegate depth exceeded (max ${config.maxDepth})`;
      }
      if (!isRecord(args)) {
        return 'Error: delegate_task requires { task: string }';
      }
      const task = readString(args, 'task');
      if (!task) {
        return 'Error: delegate_task requires a non-empty task';
      }
      const context = readString(args, 'context');
      ctx.events.publish({
        type: 'subagent.delegate.started',
        run_id: ctx.run_id,
        data: { depth, task, hasContext: context.length > 0 },
        ts: Date.now(),
      });
      const childTools = buildChildTools(host, config.disallowed);
      return delegateDepth.run(depth + 1, () =>
        runChildTask({
          providerFactory: config.providerFactory,
          model: config.model,
          task,
          context,
          tools: childTools,
          parentEvents: ctx.events,
          limits: config.limits,
          termination: config.termination,
        }),
      );
    },
  };
}

/** 创建 delegate-task 插件（provider 工厂 + model 注入，上层构造时传入） */
export function createDelegateTaskPlugin(options: DelegateTaskOptions): Plugin {
  const config: ResolvedConfig = {
    providerFactory: options.providerFactory,
    model: options.model,
    maxDepth: options.maxDepth ?? 3,
    disallowed: options.disallowed ?? DEFAULT_DISALLOWED,
    limits: options.limits ?? {},
    termination: options.termination ?? { maxIterations: 10, maxRuntimeSeconds: 60 },
  };
  return {
    name: 'delegate-task',
    version: '0.1.0',
    description: 'delegate_task tool: spawn an in-process child agent for a subtask',
    install(host: PluginHost) {
      host.registerTool(makeDelegateTool(host, config));
    },
  };
}

export default createDelegateTaskPlugin;
