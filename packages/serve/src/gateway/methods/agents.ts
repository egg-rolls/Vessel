/**
 * agents.* / tasks.* 方法（0.14 P0；0.15 E5）。
 *
 * 数据源优先级：
 *   1. active / queued run 记录（补齐根 agent 与队列位置）；
 *   2. `subagent.*` 事件派生条目（保留 parent/depth/task/session/usage）。
 *
 * `tasks.*` 只读派生，不持久化；未知 id 返回 `not_found`。
 *
 * @module @vessel-agent/serve
 */

import type { AgentRegistry, AgentRegistryEntry, AgentTaskEntry } from '../../agents-registry.js';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import type { RunRecord } from '../../run-engine.js';
import { stringParam } from './common.js';
import { agentCardSchema, agentInfoSchema, taskEntrySchema } from './schemas.js';

export interface AgentMethodsDeps {
  registry: AgentRegistry;
  runs: ReadonlyMap<string, RunRecord>;
  /** FIFO 队列（按入队顺序）；用于根 agent 的 queue_position。 */
  queue?: () => readonly RunRecord[];
  defaultTenantId: string;
}

function isDefaultTenant(tenantId: string, defaultTenantId: string): boolean {
  return tenantId === defaultTenantId;
}

/** 事件派生条目按 tenant 过滤；无 tenant 的历史事件只归 default。 */
function derivedVisible(entry: AgentRegistryEntry, tenantId: string, isDefault: boolean): boolean {
  if (isDefault) {
    return entry.tenant_id === undefined || entry.tenant_id === tenantId;
  }
  return entry.tenant_id === tenantId;
}

function collectAgents(deps: AgentMethodsDeps, tenantId: string): Map<string, AgentRegistryEntry> {
  const isDefault = isDefaultTenant(tenantId, deps.defaultTenantId);
  const merged = new Map<string, AgentRegistryEntry>();

  // 1. 事件派生（最完整：parent/depth/task/session/usage）。
  for (const entry of deps.registry.list()) {
    if (!derivedVisible(entry, tenantId, isDefault)) continue;
    merged.set(entry.id, { ...entry });
  }

  // 2. active / queued run：补齐根 agent 与队列位置。
  const queue = deps.queue?.() ?? [];
  for (const record of deps.runs.values()) {
    if (record.tenant_id !== tenantId) continue;
    if (record.status !== 'queued' && record.status !== 'running') continue;
    const id = record.core_run_id ?? record.run_id;
    if (merged.has(id)) continue;
    const position = record.status === 'queued' ? queue.indexOf(record) : -1;
    merged.set(id, {
      id,
      role: 'main',
      depth: 0,
      state: record.status,
      session_id: record.session_id,
      ...(record.started_at !== undefined ? { started_at: record.started_at } : {}),
      ...(position >= 0 ? { queue_position: position + 1 } : {}),
    });
  }

  return merged;
}

/** `agents.list` / `agents.get`：保持 0.14 的公开形状（不含 task / tenant）。 */
function publicAgent(entry: AgentRegistryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    depth: entry.depth,
    state: entry.state,
    ...(entry.role !== undefined ? { role: entry.role } : {}),
    ...(entry.parent_id !== undefined ? { parent_id: entry.parent_id } : {}),
    ...(entry.current_tool !== undefined ? { current_tool: entry.current_tool } : {}),
    ...(entry.session_id !== undefined ? { session_id: entry.session_id } : {}),
    ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
  };
}

/** `agents.tree`：AgentCard + children_ids（0.15 E5）。 */
function publicAgentCard(
  entry: AgentRegistryEntry,
  childrenIds: string[],
): Record<string, unknown> {
  return {
    ...publicAgent(entry),
    children_ids: childrenIds,
    children_count: childrenIds.length,
    ...(entry.task !== undefined ? { task: entry.task } : {}),
    ...(entry.node_id !== undefined ? { node_id: entry.node_id } : {}),
    ...(entry.queue_position !== undefined && entry.queue_position >= 1
      ? { queue_position: entry.queue_position }
      : {}),
    ...(entry.wait_reason !== undefined ? { wait_reason: entry.wait_reason } : {}),
    ...(entry.context_used !== undefined ? { context_used: entry.context_used } : {}),
    ...(entry.context_max !== undefined ? { context_max: entry.context_max } : {}),
    ...(entry.last_seen !== undefined ? { last_seen: entry.last_seen } : {}),
    ...(entry.artifact_refs !== undefined ? { artifact_refs: entry.artifact_refs } : {}),
  };
}

function taskVisible(task: AgentTaskEntry, tenantId: string, isDefault: boolean): boolean {
  if (isDefault) return task.tenant_id === undefined || task.tenant_id === tenantId;
  return task.tenant_id === tenantId;
}

function publicTask(task: AgentTaskEntry): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    assignee: task.assignee,
    status: task.status,
    artifact_refs: task.artifact_refs,
    since: task.since,
    ...(task.parent_task !== undefined ? { parent_task: task.parent_task } : {}),
  };
}

export function createAgentMethods(deps: AgentMethodsDeps): RpcMethodDefinition[] {
  return [
    {
      name: 'agents.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          state: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['agents'],
        properties: {
          agents: { type: 'array', items: agentInfoSchema },
        },
      },
      handler: (params, ctx) => {
        const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
        const state = typeof params.state === 'string' ? params.state : undefined;
        const agents = [...collectAgents(deps, ctx.tenantId).values()]
          .filter((entry) => sessionId === undefined || entry.session_id === sessionId)
          .filter((entry) => state === undefined || entry.state === state)
          .map(publicAgent);
        return { agents };
      },
    },
    {
      name: 'agents.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['agent_id'],
        properties: { agent_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['agent'],
        properties: { agent: agentInfoSchema },
      },
      handler: (params, ctx) => {
        const agentId = stringParam(params, 'agent_id');
        const agent = collectAgents(deps, ctx.tenantId).get(agentId);
        if (!agent) {
          throw new RpcError('not_found', `agent not found: ${agentId}`, { agent_id: agentId });
        }
        return { agent: publicAgent(agent) };
      },
    },
    {
      name: 'agents.tree',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          state: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['nodes', 'as_of'],
        properties: {
          nodes: { type: 'array', items: agentCardSchema },
          as_of: { type: 'number' },
        },
      },
      handler: (params, ctx) => {
        const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
        const state = typeof params.state === 'string' ? params.state : undefined;
        const entries = [...collectAgents(deps, ctx.tenantId).values()].filter(
          (entry) =>
            (sessionId === undefined || entry.session_id === sessionId) &&
            (state === undefined || entry.state === state),
        );
        const ids = new Set(entries.map((entry) => entry.id));
        const children = new Map<string, string[]>();
        for (const entry of entries) {
          if (entry.parent_id === undefined || !ids.has(entry.parent_id)) continue;
          if (entry.parent_id === entry.id) continue;
          const list = children.get(entry.parent_id);
          if (list) list.push(entry.id);
          else children.set(entry.parent_id, [entry.id]);
        }
        const nodes = entries
          .sort(
            (a, b) =>
              a.depth - b.depth ||
              (a.started_at ?? 0) - (b.started_at ?? 0) ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )
          .map((entry) => publicAgentCard(entry, (children.get(entry.id) ?? []).sort()));
        return { nodes, as_of: Date.now() };
      },
    },
    {
      name: 'tasks.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          assignee: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['tasks'],
        properties: {
          tasks: { type: 'array', items: taskEntrySchema },
        },
      },
      handler: (params, ctx) => {
        const isDefault = isDefaultTenant(ctx.tenantId, deps.defaultTenantId);
        const status = typeof params.status === 'string' ? params.status : undefined;
        const assignee = typeof params.assignee === 'string' ? params.assignee : undefined;
        const tasks = deps.registry
          .listTasks()
          .filter((task) => taskVisible(task, ctx.tenantId, isDefault))
          .filter((task) => status === undefined || task.status === status)
          .filter((task) => assignee === undefined || task.assignee === assignee)
          .map(publicTask);
        return { tasks };
      },
    },
    {
      name: 'tasks.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['task_id'],
        properties: { task_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['task'],
        properties: { task: taskEntrySchema },
      },
      handler: (params, ctx) => {
        const taskId = stringParam(params, 'task_id');
        const isDefault = isDefaultTenant(ctx.tenantId, deps.defaultTenantId);
        const task = deps.registry.getTask(taskId);
        if (!task || !taskVisible(task, ctx.tenantId, isDefault)) {
          throw new RpcError('not_found', `task not found: ${taskId}`, { task_id: taskId });
        }
        return { task: publicTask(task) };
      },
    },
  ];
}
