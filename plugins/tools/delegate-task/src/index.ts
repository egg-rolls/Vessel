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
 *
 * 安全继承：
 * - 子 host 复制父 host 的 guardrail / hook（否则子 agent 绕过 tool-policy、脱敏与审计）；
 * - 权限默认 `bridge`：子 agent 的权限请求转发到父事件流等用户应答；
 *   `allow` 仅 headless 显式使用，`deny` 只保留只读工具。
 *
 * 已知限制（0.1.0）：父 run 取消不会中断子 agent——`ToolContext` 还没有 signal，
 * 等 core 0.1.1 加法引入 `ToolContext.signal` 后再透传。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  EventStream,
  LLMProvider,
  Plugin,
  PluginHost,
  RunEvent,
  TerminationPolicy,
  ToolContext,
  ToolDefinition,
  Usage,
  UsageLimits,
} from '@vessel/core';
import {
  AgentRuntime,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
} from '@vessel/core';

/** delegate 深度（每 spawn 一层 +1），AsyncLocalStorage 隔离并行分派，防无限递归 */
const delegateDepth = new AsyncLocalStorage<number>();

/** 子 agent 工具白名单：默认排除 delegate_task 自身，阻断递归 */
const DEFAULT_DISALLOWED = ['delegate_task'];

/** bridge 模式下等待父级用户应答的上限（与 PermissionPolicy 一致） */
const PERMISSION_BRIDGE_TIMEOUT_MS = 120_000;

/** 子 agent 权限模式 */
export type DelegatePermissionMode = 'bridge' | 'allow' | 'deny';

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
  /** 子 agent 权限模式（默认 bridge） */
  permissionMode?: DelegatePermissionMode;
  /** deny 模式下保留的只读工具（默认 ['read']） */
  readOnlyTools?: string[];
}

/** 解析后的插件配置（内部使用，全字段定值） */
interface ResolvedConfig {
  providerFactory: () => LLMProvider;
  model: string;
  maxDepth: number;
  disallowed: string[];
  limits: UsageLimits;
  termination: TerminationPolicy;
  permissionMode: DelegatePermissionMode;
  readOnlyTools: string[];
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

/** 包一层自动放行（仅 allow 模式使用） */
function withAutoAllow(tool: ToolDefinition): ToolDefinition {
  return { ...tool, checkPermission: async () => 'allow' };
}

/**
 * 构建子 agent 的插件宿主：复制父 host 的工具 + guardrail + hook，
 * 按权限模式过滤/改写工具。
 */
function buildChildHost(host: PluginHost, config: ResolvedConfig): MemoryPluginHost {
  const childHost = new MemoryPluginHost();

  // 安全机制随工具一起继承，否则子 agent 成为绕过通道
  for (const guardrail of host.getGuardrails()) childHost.registerGuardrail(guardrail);
  for (const hook of host.getHooks()) childHost.registerHook(hook);

  for (const tool of host.listTools()) {
    if (config.disallowed.includes(tool.name)) continue;
    if (config.permissionMode === 'deny' && !config.readOnlyTools.includes(tool.name)) continue;
    if (config.permissionMode === 'allow') {
      childHost.registerTool(withAutoAllow(tool));
      continue;
    }
    childHost.registerTool(tool);
  }

  return childHost;
}

/** 给转发事件补 delegateId，便于 TUI 在并发展示中区分不同子 agent */
function withDelegateId(delegateId: string, data: unknown): Record<string, unknown> {
  if (isRecord(data)) return { ...data, delegateId };
  return { value: data, delegateId };
}

/** 订阅子 runtime 事件，转发到父 ctx.events（subagent.* 前缀）；返回退订函数 */
function forwardEvents(parent: EventStream, child: EventStream, delegateId: string): () => void {
  return child.subscribe((event) => {
    parent.publish({
      type: `subagent.${event.type}`,
      run_id: event.run_id,
      data: withDelegateId(delegateId, event.data),
      ts: event.ts,
    });
  });
}

/**
 * 权限桥：把子 agent 的 permission request 用原事件名转发到父事件流，
 * 再把父级应答回灌子事件流。父级（TUI）不需要知道子 runtime 的存在。
 */
function bridgePermissions(childEvents: EventStream, parentEvents: EventStream): () => void {
  return childEvents.subscribe((event) => {
    if (event.type !== 'tool.permission.request') return;
    if (!isRecord(event.data)) return;
    const requestId = event.data.requestId;
    if (typeof requestId !== 'string') return;

    parentEvents.publish({
      type: 'tool.permission.request',
      run_id: event.run_id,
      data: event.data,
      ts: event.ts,
    });

    parentEvents
      .waitFor('tool.permission.response', {
        requestId,
        timeout: PERMISSION_BRIDGE_TIMEOUT_MS,
      })
      .then((response) => {
        childEvents.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: isRecord(response) ? response : { value: response },
          ts: Date.now(),
        });
      })
      .catch(() => {
        // 父级无人应答：保持子 runtime 自己的超时/拒绝路径
      });
  });
}

/** 从 llm.response 事件累计子 agent 用量 */
function accumulateUsage(event: RunEvent, usage: Usage): void {
  if (event.type !== 'llm.response' || !isRecord(event.data)) return;
  const raw = event.data.usage;
  if (!isRecord(raw)) return;
  const prompt = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0;
  const completion = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0;
  const total = typeof raw.total_tokens === 'number' ? raw.total_tokens : prompt + completion;
  usage.prompt_tokens = (usage.prompt_tokens ?? 0) + prompt;
  usage.completion_tokens = (usage.completion_tokens ?? 0) + completion;
  usage.total_tokens = (usage.total_tokens ?? 0) + total;
}

/** spawn 子 runtime 并回收最终文本 + 用量 */
async function runChildTask(config: {
  providerFactory: () => LLMProvider;
  model: string;
  task: string;
  context: string;
  pluginHost: MemoryPluginHost;
  parentEvents: EventStream;
  limits: UsageLimits;
  termination: TerminationPolicy;
  permissionMode: DelegatePermissionMode;
  delegateId: string;
}): Promise<{ text: string; usage: Usage }> {
  const childEvents = new MemoryEventStream();
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const unsubscribers = [
    forwardEvents(config.parentEvents, childEvents, config.delegateId),
    childEvents.subscribe((event) => accumulateUsage(event, usage)),
  ];
  if (config.permissionMode === 'bridge') {
    unsubscribers.push(bridgePermissions(childEvents, config.parentEvents));
  }

  const input = config.context ? `${config.task}\n\n附加背景：\n${config.context}` : config.task;
  const runtime = await AgentRuntime.create({
    provider: config.providerFactory(),
    model: config.model,
    pluginHost: config.pluginHost,
    context: new MemoryContextManager(),
    events: childEvents,
    limits: config.limits,
    termination: config.termination,
    // deny 模式已在 buildChildHost 里过滤掉非只读工具；这里统一 allow 避免无应答挂起
    permission: { default: 'allow' },
  });
  try {
    const text = await runtime.run(input);
    return { text, usage };
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
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
      'whitelist (no recursive delegate_task) and inherits guardrails/hooks.',
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
      const delegateId = randomUUID();
      const startedAt = Date.now();

      ctx.events.publish({
        type: 'subagent.delegate.started',
        run_id: ctx.run_id,
        data: { depth, delegateId, task, hasContext: context.length > 0 },
        ts: startedAt,
      });

      const childHost = buildChildHost(host, config);
      try {
        const outcome = await delegateDepth.run(depth + 1, () =>
          runChildTask({
            providerFactory: config.providerFactory,
            model: config.model,
            task,
            context,
            pluginHost: childHost,
            parentEvents: ctx.events,
            limits: config.limits,
            termination: config.termination,
            permissionMode: config.permissionMode,
            delegateId,
          }),
        );
        ctx.events.publish({
          type: 'subagent.delegate.completed',
          run_id: ctx.run_id,
          data: {
            depth,
            delegateId,
            duration_ms: Date.now() - startedAt,
            usage: outcome.usage,
          },
          ts: Date.now(),
        });
        return outcome.text;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.events.publish({
          type: 'subagent.delegate.failed',
          run_id: ctx.run_id,
          data: {
            depth,
            delegateId,
            duration_ms: Date.now() - startedAt,
            error: message,
          },
          ts: Date.now(),
        });
        throw error;
      }
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
    permissionMode: options.permissionMode ?? 'bridge',
    readOnlyTools: options.readOnlyTools ?? ['read'],
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
