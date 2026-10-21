/**
 * @vessel-agent/delegate-task - 子 agent 分派工具插件
 * @module @vessel-agent/delegate-task
 *
 * 注册 delegate_task 工具：一次调用 = core Host 上的一个**临时成员**（ephemeral），
 * 只回收最终文本，不污染父上下文；完成后立即 close。
 *
 * 递归防护：
 * - 深度来自 `AgentSpec.metadata.depth` + 子 run 的 `run.started` 映射（不再用 ALS）；
 * - 子 agent 工具白名单（默认排除 delegate_task 自身）。
 *
 * 安全继承：
 * - 子 host 复制父 host 的 guardrail / hook；
 * - 权限默认 `bridge`：子 agent 的权限请求经 Host 聚合流转发到父事件流，
 *   父级应答回灌 Host 聚合流后由 core 路由回成员；
 *   `allow` 仅 headless 显式使用，`deny` 只保留只读工具。
 *
 * 取消：父 run 的 `ToolContext.signal` 直接传给临时成员 `RunHandle`（F10）。
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentHandle,
  RuntimeHost as CoreRuntimeHost,
  EventStream,
  LLMProvider,
  Plugin,
  PluginHost,
  RunEvent,
  RunOptions,
  RuntimePermissionConfig,
  TerminationPolicy,
  ToolContext,
  ToolDefinition,
  Usage,
  UsageLimits,
} from '@vessel-agent/core';
import {
  InProcessRuntimeHost as CoreInProcessRuntimeHost,
  MemoryPluginHost,
} from '@vessel-agent/core';

/** 子 agent 工具白名单：默认排除 delegate_task 自身，阻断递归 */
const DEFAULT_DISALLOWED = ['delegate_task'];

/** 专用 Host 的默认成员上限 */
const DEFAULT_MAX_CONCURRENT_DELEGATES = 8;

/** 空 usage（保持 completed 事件字段稳定） */
function zeroUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/** 0.5 tenant id 校验（与 DECISION-010 §2.1 一致）。 */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function normalizeTenantId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!TENANT_ID_RE.test(value)) throw new Error(`invalid tenant id "${value}"`);
  return value;
}

/** 子 agent 权限模式 */
export type DelegatePermissionMode = 'bridge' | 'allow' | 'deny';

/** delegate 结果引用（0.15 E8）：至少指回 child run */
export interface DelegateResultRef {
  kind: 'run' | 'message' | 'file';
  id?: string;
  path?: string;
}

/** 单个 delegate 根树的后代计数（嵌套实例共享同一对象） */
interface DelegateTree {
  rootId: string;
  descendants: number;
}

/** 嵌套 delegate 实例的注入上下文（不得复用父闭包） */
interface DelegateNesting {
  /** 当前 agent（子/孙）的 depth */
  baseDepth: number;
  /** 根 → 当前 delegate 的路径 */
  basePath: string[];
  tree: DelegateTree;
  /** 根会话，用于 parent_session_id */
  rootSessionId?: string;
}

/** delegate 事件共用的关联字段 */
interface DelegateFields {
  delegateId: string;
  delegatePath: string[];
  toolCallId?: string;
  parentSessionId?: string;
  parentDelegateId?: string;
}

/** 插件配置（上层 bootstrap/插件构造时注入 provider 工厂 + model） */
export interface DelegateTaskOptions {
  /** 子 provider 工厂：每次 spawn 临时成员时调用 */
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
  /** 注入的 core Host（asm A5）；缺省时插件实例内懒创建一个专用 Host 并复用 */
  runtimeHost?: CoreRuntimeHost;
  /** 专用 Host 的成员上限（默认 8）；注入 runtimeHost 时忽略 */
  maxConcurrentDelegates?: number;
  /** 0.5：tenant 作用域（可选）；缺失不写 tenant_id。 */
  tenantId?: string;
  /**
   * 0.8.2 Wave 2B1：子 agent 继承的默认权限策略。
   * 缺省保持旧行为 `{ default: 'allow' }`；显式传入时以父配置为准
   * （例如 `{ default: 'ask' }` 不再静默放行无 checkPermission 的工具）。
   */
  permission?: RuntimePermissionConfig;
  /** 0.15 E8：允许子 agent 继续 delegate（默认 false） */
  allowNested?: boolean;
  /** 0.15 E8：每个根 delegate 树的后代上限（默认 16，仅 allowNested 生效） */
  maxDescendants?: number;
}

/** 解析后的插件配置（内部使用） */
interface ResolvedConfig {
  providerFactory: () => LLMProvider;
  model: string;
  maxDepth: number;
  disallowed: string[];
  limits: UsageLimits;
  termination: TerminationPolicy;
  permissionMode: DelegatePermissionMode;
  readOnlyTools: string[];
  runtimeHost?: CoreRuntimeHost;
  maxConcurrentDelegates: number;
  /** 懒创建的专用 Host（插件实例内复用） */
  host?: CoreRuntimeHost;
  /** 0.5：tenant 作用域（可选）。 */
  tenantId?: string;
  /** 0.8.2 Wave 2B1：子 agent 默认权限策略（未注入时沿用 `{default:'allow'}`）。 */
  permission?: RuntimePermissionConfig;
  /** 0.15 E8：child 是否可再 delegate（deny 模式与显式 disallowed 下强制关闭）。 */
  nestedEnabled: boolean;
  /** 0.15 E8：每个根树的后代上限。 */
  maxDescendants: number;
  /** run_id → 递归深度；实例级（避免模块级可变状态跨 tenant 共享）。 */
  depthByRunId: Map<string, number>;
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
 *
 * 0.15 E8：allow_nested 开启时为 child 新建 delegate 工具实例（含独立
 * baseDepth/rootId/descendants），不复用父工具闭包。
 */
function buildChildHost(
  host: PluginHost,
  config: ResolvedConfig,
  nesting: DelegateNesting,
): MemoryPluginHost {
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

  // 父 host 的 delegate_task 被白名单排除；嵌套开启时换成 child 专用实例。
  if (config.nestedEnabled) childHost.registerTool(makeDelegateTool(childHost, config, nesting));

  return childHost;
}

/** 给事件补 delegate 关联字段；已有字段不覆盖（嵌套事件自带正确的 path）。 */
function withDelegationContext(data: unknown, fields: DelegateFields): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(data) ? { ...data } : { value: data };
  merged.delegateId = fields.delegateId;
  if (fields.toolCallId !== undefined && merged.tool_call_id === undefined) {
    merged.tool_call_id = fields.toolCallId;
  }
  if (fields.parentSessionId !== undefined && merged.parent_session_id === undefined) {
    merged.parent_session_id = fields.parentSessionId;
  }
  if (fields.parentDelegateId !== undefined && merged.parent_delegate_id === undefined) {
    merged.parent_delegate_id = fields.parentDelegateId;
  }
  if (merged.delegate_path === undefined) merged.delegate_path = fields.delegatePath;
  return merged;
}

/** 重发事件时保留 seq/tenant_id；只补缺失的 tenant_id。 */
function withTenant(event: RunEvent, tenantId: string | undefined): RunEvent {
  if (tenantId === undefined || event.tenant_id !== undefined) return event;
  return { ...event, tenant_id: tenantId };
}

/** 取插件实例的 Host：注入优先，否则懒创建专用 Host 并复用 */
function resolveHost(config: ResolvedConfig): CoreRuntimeHost {
  if (config.runtimeHost) return config.runtimeHost;
  config.host ??= new CoreInProcessRuntimeHost({
    maxMembers: config.maxConcurrentDelegates,
  });
  return config.host;
}

interface ChildTaskConfig {
  host: CoreRuntimeHost;
  providerFactory: () => LLMProvider;
  model: string;
  task: string;
  context: string;
  pluginHost: PluginHost;
  parentEvents: EventStream;
  limits: UsageLimits;
  termination: TerminationPolicy;
  permissionMode: DelegatePermissionMode;
  /** 0.8.2：子 agent 默认权限策略；缺省沿用 `{default:'allow'}`。 */
  permission?: RuntimePermissionConfig;
  fields: DelegateFields;
  depth: number;
  signal?: AbortSignal;
  tenantId?: string;
  depthByRunId: Map<string, number>;
  /** child run id 由本函数回填，失败路径也要拿到 result_ref。 */
  childRun: { runId?: string };
  /** 嵌套实例自建 Host（父 run 正占用注入 Host 的调度槽，复用会死锁）。 */
  closeHost: boolean;
}

/**
 * 在 Host 上 spawn 一个临时成员并跑完一次任务。
 * 事件转发 / 权限桥 / 深度映射都通过 Host 聚合流完成。
 */
async function runChildTask(
  config: ChildTaskConfig,
): Promise<{ text: string; usage: Usage; runId?: string }> {
  const sameStream = config.parentEvents === config.host.events;
  const unsubscribers: Array<() => void> = [];
  // sameStream 时自己转发的事件会回到本订阅；按对象身份防回环（嵌套事件必须继续上送）
  const forwardedEvents = new WeakSet<object>();
  let childRunId: string | undefined;

  // Host 聚合流：转发运行事件、生命周期事件、交互请求；同时记录嵌套深度
  unsubscribers.push(
    config.host.events.subscribe((event) => {
      if (forwardedEvents.has(event)) return;

      const data = isRecord(event.data) ? event.data : {};
      if (data.agentId !== config.fields.delegateId) return;

      // 嵌套 delegate 已转发出的事件：保持单层 subagent. 前缀原样上送
      if (event.type.startsWith('subagent.')) {
        // 本实例自己发布的 delegate.started/completed/failed 不再二次转发
        if (data.delegateId === config.fields.delegateId) return;
        const forwarded: RunEvent = { ...event };
        forwardedEvents.add(forwarded);
        config.parentEvents.publish(withTenant(forwarded, config.tenantId));
        return;
      }

      if (event.type === 'run.started' && typeof data.run_id === 'string') {
        childRunId = data.run_id;
        config.childRun.runId ??= data.run_id;
        config.depthByRunId.set(data.run_id, config.depth + 1);
      }

      // P12：dedicated Host 时把生命周期事件原样转发；sameStream 时已存在
      if (event.type === 'agent.spawned' || event.type === 'agent.closed') {
        if (!sameStream) {
          // 保留 seq/tenant_id，只补缺失的 tenant（A-4 §11.1）。
          config.parentEvents.publish(withTenant(event, config.tenantId));
        }
        return;
      }
      // Host 自身的 agent.* 事件不重复转发；成员 runtime 事件走 subagent.*
      if (event.type.startsWith('agent.')) return;

      // A6：无论是否同一个流，都保证父流能看到 subagent.* + delegateId。
      // 保留原 envelope 的 seq/tenant_id（A-4 §11.1）。
      const forwarded: RunEvent = {
        ...event,
        type: `subagent.${event.type}`,
        data: withDelegationContext(event.data, config.fields),
      };
      forwardedEvents.add(forwarded);
      config.parentEvents.publish(withTenant(forwarded, config.tenantId));

      // 交互桥：dedicated Host 时用原名再送一份；sameStream 时原名已在流里。
      // 0.15 E8：bridge 事件补 delegate_path，UI 才能挂到正确的子 agent 节点。
      if (sameStream || config.permissionMode !== 'bridge') return;
      if (event.type === 'tool.permission.request' || event.type === 'ask.user.requested') {
        config.parentEvents.publish(
          withTenant(
            { ...event, data: withDelegationContext(event.data, config.fields) },
            config.tenantId,
          ),
        );
      }
    }),
  );

  // 交互桥：父级应答回灌 Host 聚合流，由 core 路由到发起请求的成员。
  // sameStream 时应答本来就在同一条流上，不需要订阅。
  if (!sameStream && config.permissionMode === 'bridge') {
    unsubscribers.push(
      config.parentEvents.subscribe((event) => {
        if (event.type !== 'tool.permission.response' && event.type !== 'ask.user.answered') {
          return;
        }
        config.host.events.publish(event);
      }),
    );
  }

  const input = config.context ? `${config.task}\n\n附加背景：\n${config.context}` : config.task;
  let handle: AgentHandle | undefined;
  try {
    handle = await config.host.spawn({
      id: config.fields.delegateId,
      name: `delegate-${config.depth + 1}`,
      provider: config.providerFactory(),
      model: config.model,
      pluginHost: config.pluginHost,
      limits: { run: config.limits },
      termination: config.termination,
      // deny 模式已过滤工具；bridge 由 Host 转发权限请求。
      // 0.8.2：继承父配置的默认权限策略；未注入时保持旧行为。
      permission: config.permission ?? { default: 'allow' },
      metadata: { ephemeral: true, depth: config.depth + 1 },
    });

    const runOptions: RunOptions | undefined =
      config.signal !== undefined ? { signal: config.signal } : undefined;
    const run = await handle.run(input, runOptions);
    config.childRun.runId ??= run.id;
    const text = await run.result;
    return {
      text,
      usage: run.usage() ?? zeroUsage(),
      ...(config.childRun.runId !== undefined ? { runId: config.childRun.runId } : {}),
    };
  } finally {
    await handle?.close().catch(() => {});
    for (const unsubscribe of unsubscribers) unsubscribe();
    // 只清理本次 run 的深度映射，避免并发 delegate 互删
    if (childRunId !== undefined) config.depthByRunId.delete(childRunId);
    if (config.closeHost) await config.host.close().catch(() => {});
  }
}

/**
 * 构造 delegate_task 工具定义（闭包持有父 host，运行时取安全工具）。
 * `nesting` 存在时是 child 专用实例：深度/路径/后代计数由此注入，不复用父闭包。
 */
function makeDelegateTool(
  host: PluginHost,
  config: ResolvedConfig,
  nesting?: DelegateNesting,
): ToolDefinition {
  return {
    name: 'delegate_task',
    description:
      'Delegate a subtask to an ephemeral child agent on the runtime host and return only ' +
      'its final text. The child runs with a safe tool whitelist and inherits ' +
      'guardrails/hooks.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The subtask description' },
        context: { type: 'string', description: 'Optional additional background for the subtask' },
      },
      required: ['task'],
    },
    handler: async (args: unknown, ctx: ToolContext) => {
      const baseDepth = nesting?.baseDepth ?? 0;
      const depth = config.depthByRunId.get(ctx.run_id) ?? baseDepth;
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
      const basePath = nesting?.basePath ?? [];
      const parentDelegateId = basePath.at(-1);
      const rootSessionId = nesting?.rootSessionId ?? ctx.session_id;
      const delegatePath = [...basePath, delegateId];

      // 后代上限按根树计数；根 delegate 本身不计入 descendants。
      const tree: DelegateTree = nesting?.tree ?? { rootId: delegateId, descendants: 0 };
      if (nesting !== undefined) {
        if (tree.descendants >= config.maxDescendants) {
          return `Error: delegate descendants exceeded (max ${config.maxDescendants})`;
        }
        tree.descendants += 1;
      }

      const fields: DelegateFields = {
        delegateId,
        delegatePath,
        ...(ctx.tool_call_id !== undefined ? { toolCallId: ctx.tool_call_id } : {}),
        ...(rootSessionId !== undefined ? { parentSessionId: rootSessionId } : {}),
        ...(parentDelegateId !== undefined ? { parentDelegateId } : {}),
      };

      ctx.events.publish({
        type: 'subagent.delegate.started',
        run_id: ctx.run_id,
        data: withDelegationContext({ depth, task, hasContext: context.length > 0 }, fields),
        ts: startedAt,
        ...(config.tenantId !== undefined ? { tenant_id: config.tenantId } : {}),
      });

      const childHost = buildChildHost(host, config, {
        baseDepth: depth + 1,
        basePath: delegatePath,
        tree,
        ...(rootSessionId !== undefined ? { rootSessionId } : {}),
      });
      const childRun: { runId?: string } = {};
      // 嵌套实例不能复用注入 Host：父 run 占着调度槽，子 run 会永远排队。
      const childRuntimeHost =
        nesting !== undefined
          ? new CoreInProcessRuntimeHost({ maxMembers: config.maxConcurrentDelegates })
          : resolveHost(config);
      try {
        const outcome = await runChildTask({
          host: childRuntimeHost,
          providerFactory: config.providerFactory,
          model: config.model,
          task,
          context,
          pluginHost: childHost,
          parentEvents: ctx.events,
          limits: config.limits,
          termination: config.termination,
          permissionMode: config.permissionMode,
          ...(config.permission !== undefined ? { permission: config.permission } : {}),
          fields,
          depth,
          signal: ctx.signal,
          ...(config.tenantId !== undefined ? { tenantId: config.tenantId } : {}),
          depthByRunId: config.depthByRunId,
          childRun,
          closeHost: nesting !== undefined,
        });
        ctx.events.publish({
          type: 'subagent.delegate.completed',
          run_id: ctx.run_id,
          data: withDelegationContext(
            {
              depth,
              duration_ms: Date.now() - startedAt,
              usage: outcome.usage,
              ...(outcome.runId !== undefined
                ? { result_ref: { kind: 'run', id: outcome.runId } satisfies DelegateResultRef }
                : {}),
            },
            fields,
          ),
          ts: Date.now(),
          ...(config.tenantId !== undefined ? { tenant_id: config.tenantId } : {}),
        });
        return outcome.text;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.events.publish({
          type: 'subagent.delegate.failed',
          run_id: ctx.run_id,
          data: withDelegationContext(
            {
              depth,
              duration_ms: Date.now() - startedAt,
              error: message,
              ...(childRun.runId !== undefined
                ? { result_ref: { kind: 'run', id: childRun.runId } satisfies DelegateResultRef }
                : {}),
            },
            fields,
          ),
          ts: Date.now(),
          ...(config.tenantId !== undefined ? { tenant_id: config.tenantId } : {}),
        });
        throw error;
      }
    },
  };
}

/** 创建 delegate-task 插件（provider 工厂 + model 注入，上层构造时传入） */
export function createDelegateTaskPlugin(options: DelegateTaskOptions): Plugin {
  const tenantId = normalizeTenantId(options.tenantId);
  const permissionMode = options.permissionMode ?? 'bridge';
  const disallowed = options.disallowed ?? DEFAULT_DISALLOWED;
  const allowNested = options.allowNested === true;
  // 默认白名单排除 delegate_task，是“默认关闭”的实现手段；allow_nested 显式开启时
  // 只有用户显式把 delegate_task 写进 disallowed 才继续禁止。
  const explicitNestedBan = options.disallowed?.includes('delegate_task') === true;
  const configuredMaxDescendants = options.maxDescendants ?? 16;
  const config: ResolvedConfig = {
    depthByRunId: new Map<string, number>(),
    providerFactory: options.providerFactory,
    model: options.model,
    maxDepth: options.maxDepth ?? 3,
    disallowed,
    limits: options.limits ?? {},
    termination: options.termination ?? { maxIterations: 10, maxRuntimeSeconds: 60 },
    permissionMode,
    readOnlyTools: options.readOnlyTools ?? ['read'],
    maxConcurrentDelegates: options.maxConcurrentDelegates ?? DEFAULT_MAX_CONCURRENT_DELEGATES,
    // 默认禁止孙 agent；deny 模式与显式 disallowed 下即使 allow_nested 也不放开。
    nestedEnabled: allowNested && permissionMode !== 'deny' && !explicitNestedBan,
    maxDescendants: Number.isFinite(configuredMaxDescendants)
      ? Math.max(0, Math.floor(configuredMaxDescendants))
      : 16,
    ...(options.permission !== undefined ? { permission: options.permission } : {}),
    ...(options.runtimeHost !== undefined ? { runtimeHost: options.runtimeHost } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
  };
  return {
    name: 'delegate-task',
    version: '0.2.0',
    description: 'delegate_task tool: spawn an ephemeral child agent on the runtime host',
    install(host: PluginHost) {
      host.registerTool(makeDelegateTool(host, config));
    },
  };
}

export default createDelegateTaskPlugin;
