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

import type {
  AgentControlLike,
  AgentCreateLikeInput,
  AgentDispatchLikeInput,
  AgentLifecycleFailLike,
  AgentRotateLikeInput,
  AgentSendLikeInput,
  AgentStateLike,
  AgentStatusLike,
  AgentUpdateLikeInput,
  AgentVisibilityLike,
} from '../../agent-control.js';
import type { AgentRegistry, AgentRegistryEntry, AgentTaskEntry } from '../../agents-registry.js';
import {
  isTeamScopedPrincipal,
  RpcError,
  type RpcMethodContext,
  type RpcMethodDefinition,
} from '../../rpc.js';
import type { RunRecord } from '../../run-engine.js';
import type { TeamControlLike } from '../../team-control.js';
import { stringParam } from './common.js';
import {
  agentCardSchema,
  agentInfoSchema,
  agentStatusSchema,
  stringListSchema,
  taskEntrySchema,
} from './schemas.js';

export interface AgentMethodsDeps {
  registry: AgentRegistry;
  runs: ReadonlyMap<string, RunRecord>;
  /** FIFO 队列（按入队顺序）；用于根 agent 的 queue_position。 */
  queue?: () => readonly RunRecord[];
  defaultTenantId: string;
  /**
   * 0.25：agent 生命周期控制面（app 注入 AgentService 适配器）。
   * 缺省 = `agents.create|update|close` 仍进 manifest，但 handler 返回 `not_found`。
   */
  agent?: AgentControlLike;
  /** 0.25：`agents.create` 用 team_id 解析 workspace；未注入时按 not_found 处理。 */
  teams?: TeamControlLike;
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

/**
 * owner viewer 的 `agents.list` 条目：agentInfoSchema 的超集（additive）。
 * `depth` 是注册表字段，成员没有嵌套深度，统一为 0。
 */
function publicMember(entry: AgentStatusLike): Record<string, unknown> {
  return {
    id: entry.id,
    depth: 0,
    state: entry.state,
    session_id: entry.session_id,
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(entry.parent_id !== undefined ? { parent_id: entry.parent_id } : {}),
    ...(entry.current_tool !== undefined ? { current_tool: entry.current_tool } : {}),
    ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
    ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
    ...(entry.visibility !== undefined ? { visibility: entry.visibility } : {}),
    ...(entry.presence !== undefined ? { presence: entry.presence } : {}),
    ...(entry.membership !== undefined ? { membership: entry.membership } : {}),
    ...(entry.team_id !== undefined ? { team_id: entry.team_id } : {}),
    ...(entry.epoch !== undefined ? { epoch: entry.epoch } : {}),
    ...(entry.last_seen !== undefined ? { last_seen: entry.last_seen } : {}),
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

// ── 0.25：canonical agent 生命周期（批量契约） ──

/** 未注入 / tenant 不匹配都按 `not_found` 处理（不泄漏跨 tenant 存在性）。 */
function requireAgentControl(
  agent: AgentControlLike | undefined,
  ctx: RpcMethodContext,
): AgentControlLike {
  if (!agent || agent.tenantId !== ctx.tenantId) {
    throw new RpcError('not_found', 'Agent control is not available');
  }
  return agent;
}

/** team-scoped control token 的 team 作用域；非 team-scoped 返回 undefined。 */
function teamScopeOf(ctx: RpcMethodContext): string | undefined {
  return isTeamScopedPrincipal(ctx.principal) ? ctx.principal.team_id : undefined;
}

function fail(code: string, error: string): AgentLifecycleFailLike {
  return { ok: false, code, error };
}

/** 批量数组必须是对象数组；结构错误整体拒绝（类型错误不是业务失败）。 */
function requireObjectEntries(
  params: Record<string, unknown>,
  key: string,
  method: string,
): Array<Record<string, unknown>> {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new RpcError('invalid_params', `${method}: ${key} must be a non-empty array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new RpcError('invalid_params', `${method}: ${key}[${index}] must be an object`);
    }
    return entry as Record<string, unknown>;
  });
}

/** `agents` 数组必须是对象数组；结构错误整体拒绝（类型错误不是业务失败）。 */
function requireAgentEntries(
  params: Record<string, unknown>,
  method: string,
): Array<Record<string, unknown>> {
  return requireObjectEntries(params, 'agents', method);
}

/**
 * 发送者 / viewer 身份：合成 owner principal 用 owner agent id；gateway / team
 * token 没有 agent_id，按人类 `human` 处理（与 canonical Web 行为一致）。
 */
function actorOf(ctx: RpcMethodContext): string {
  return ctx.principal.agent_id ?? 'human';
}

/**
 * team-scoped control token 的目标作用域校验：只允许操作 `team_id` 相同的成员。
 * 非 scoped token 不做额外解析（沿用服务自身的寻址与错误语义）。
 * `byName` 打开时按 dispatch 的寻址规则解析（dispatch / rotate 接受唯一名字）。
 */
async function targetInTeamScope(
  control: AgentControlLike,
  scope: string | undefined,
  target: string,
  byName: boolean,
): Promise<boolean> {
  if (scope === undefined) return true;
  const status = byName ? await control.resolve(target) : await control.get(target);
  return status !== undefined && status.team_id === scope;
}

/** 可选非空字符串；缺省 undefined，存在但非法 → invalid_params。 */
function optionalEntryString(
  entry: Record<string, unknown>,
  key: string,
  method: string,
): string | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('invalid_params', `${method}: ${key} must be a non-empty string`);
  }
  return value;
}

function optionalVisibility(
  entry: Record<string, unknown>,
  method: string,
): AgentVisibilityLike | undefined {
  const value = entry.visibility;
  if (value === undefined) return undefined;
  if (value !== 'private' && value !== 'team' && value !== 'tenant') {
    throw new RpcError('invalid_params', `${method}: visibility must be private, team or tenant`);
  }
  return value;
}

type Prepared<T> = { input: T } | { failure: AgentLifecycleFailLike };

/**
 * 把成功条目与批量结果按原索引合并；结构失败（如跨 team 作用域）不调用服务。
 * `cursor` 只前进到实际提交给服务的条目，保证结果与输入同序。
 */
function mergeBatchResults<T>(
  prepared: Prepared<T>[],
  results: ReadonlyArray<unknown>,
): { results: unknown[] } {
  const merged: unknown[] = [];
  let cursor = 0;
  for (const entry of prepared) {
    if ('failure' in entry) {
      merged.push(entry.failure);
      continue;
    }
    const result = results[cursor];
    cursor += 1;
    merged.push(result ?? fail('internal', 'agent control returned no result for this entry'));
  }
  return { results: merged };
}

const agentLifecycleItemSchema = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    // create / update 成功条目
    agent: agentStatusSchema,
    changed: stringListSchema,
    applies_to: { type: 'string', enum: ['next_body'] },
    // close 成功条目
    agent_id: { type: 'string' },
    closed: { type: 'boolean' },
    // 失败条目
    code: { type: 'string' },
    error: { type: 'string' },
  },
};

const agentLifecycleResultSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: { type: 'array', items: agentLifecycleItemSchema },
  },
};

const agentStateEnum = [
  'created',
  'idle',
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
  'closed',
  'stale',
];

const agentActionFailProperties = {
  code: { type: 'string' },
  error: { type: 'string' },
};

const agentSendResultSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          queued: { type: 'boolean' },
          message_id: { type: 'string' },
          state: { type: 'string', enum: agentStateEnum },
          ...agentActionFailProperties,
        },
      },
    },
  },
};

const agentDispatchResultSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string', enum: ['queued'] },
          message_id: { type: 'string' },
          resolved_to: { type: 'string' },
          resolution: { type: 'string', enum: ['live', 'resumed', 'rotating', 'forked'] },
          conversation_id: { type: 'string' },
          ...agentActionFailProperties,
        },
      },
    },
  },
};

const agentRotateResultSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string', enum: ['rotated'] },
          agent_id: { type: 'string' },
          from_session_id: { type: 'string' },
          to_session_id: { type: 'string' },
          epoch: { type: 'integer', minimum: 0 },
          ...agentActionFailProperties,
        },
      },
    },
  },
};

const agentSendEntrySchema = {
  type: 'object',
  required: ['to', 'content'],
  properties: {
    to: { type: 'string', minLength: 1 },
    content: { type: 'string', minLength: 1 },
    conversation_id: { type: 'string', minLength: 1 },
  },
};

const agentDispatchEntrySchema = {
  type: 'object',
  required: ['to', 'content'],
  properties: {
    ...agentSendEntrySchema.properties,
    allow_fork: { type: 'boolean' },
  },
};

const agentRotateEntrySchema = {
  type: 'object',
  required: ['to', 'startup_prompt'],
  properties: {
    to: { type: 'string', minLength: 1 },
    startup_prompt: { type: 'string', minLength: 1 },
    handoff_path: { type: 'string', minLength: 1 },
    from_session_id: { type: 'string', minLength: 1 },
  },
};

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
          // 0.26：owner 传输用 viewer 列出成员时可按可见性过滤。
          visibility: { type: 'string', enum: ['private', 'team', 'tenant'] },
        },
      },
      result_schema: {
        type: 'object',
        required: ['agents'],
        properties: {
          agents: { type: 'array', items: agentInfoSchema },
        },
      },
      handler: async (params, ctx) => {
        const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
        const state = typeof params.state === 'string' ? params.state : undefined;
        const visibility =
          params.visibility === 'private' ||
          params.visibility === 'team' ||
          params.visibility === 'tenant'
            ? params.visibility
            : undefined;
        // 合成 owner principal 携带 agent id：按 viewer 从 AgentService 列出成员，
        // private 可见性与 CLI `vessel agent list` 的语义保持不变。
        const viewer = ctx.principal.agent_id;
        if (
          viewer !== undefined &&
          deps.agent !== undefined &&
          deps.agent.tenantId === ctx.tenantId
        ) {
          const members = await deps.agent.list({
            viewer,
            ...(state !== undefined ? { state: state as AgentStateLike } : {}),
            ...(visibility !== undefined ? { visibility } : {}),
          });
          const agents = members
            .filter((entry) => sessionId === undefined || entry.session_id === sessionId)
            .map(publicMember);
          return { agents };
        }
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
    {
      /**
       * `agents.create`（0.25，write）：批量创建成员。
       *
       * - team-scoped control token 不能创建 agent（逐条 `forbidden`，与 `teams.create` 一致）；
       * - `team_id` 经注入的 `TeamControlLike.get` 解析 workspace 后传给 AgentService，
       *   只绑定**已存在**的 Team，不隐式创建；绑定需要 `name`；
       * - 缺省 `team_id` 时走 AgentService 的默认 workspace 规则。
       *
       * 结果与输入同序；单条失败不影响其它条目。
       */
      name: 'agents.create',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['agents'],
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 1 },
                model: { type: 'string', minLength: 1 },
                system_prompt: { type: 'string' },
                team_id: { type: 'string', minLength: 1 },
                // 只有合成 owner principal（CLI）能直接传 workspace；
                // gateway / Web 走 team_id（只绑定已存在的 Team）。
                workspace: { type: 'string', minLength: 1 },
                visibility: {
                  type: 'string',
                  enum: ['private', 'team', 'tenant'],
                },
              },
            },
          },
        },
      },
      result_schema: agentLifecycleResultSchema,
      handler: async (params, ctx) => {
        const control = requireAgentControl(deps.agent, ctx);
        const entries = requireAgentEntries(params, 'agents.create');
        const scope = teamScopeOf(ctx);
        // 合成 owner principal：新成员归属 / 父子关系沿用 owner 语义。
        const ownerId = ctx.principal.agent_id;
        const identity = ownerId !== undefined ? { owner: ownerId, parent_id: ownerId } : {};
        if (scope !== undefined) {
          return {
            results: entries.map(() => fail('forbidden', 'team-scoped token cannot create agents')),
          };
        }

        // 同一请求内同一个 team_id 只解析一次；workspace 缺失按 not_found（不泄漏）。
        const teamWorkspaces = new Map<string, Promise<string | undefined>>();
        const resolveWorkspace = (
          teamId: string,
          teamControl: TeamControlLike | undefined,
        ): Promise<string | undefined> => {
          if (!teamControl || teamControl.tenantId !== ctx.tenantId) {
            return Promise.resolve(undefined);
          }
          const cached = teamWorkspaces.get(teamId);
          if (cached !== undefined) return cached;
          const pending = teamControl
            .get(teamId)
            .then((detail) => detail?.team.workspace)
            .catch(() => undefined);
          teamWorkspaces.set(teamId, pending);
          return pending;
        };

        const prepared = await Promise.all(
          entries.map(async (entry): Promise<Prepared<AgentCreateLikeInput>> => {
            // CLI 的 `--workspace` 是 owner 传输特权：保留显式 workspace 绑定的语义，
            // 但 gateway / Web 不能伪造主机路径（逐条拒绝）。
            const rawWorkspace = optionalEntryString(entry, 'workspace', 'agents.create');
            if (rawWorkspace !== undefined) {
              if (ownerId === undefined) {
                return {
                  failure: fail(
                    'invalid_params',
                    'workspace is only allowed for the owner transport',
                  ),
                };
              }
              const name = optionalEntryString(entry, 'name', 'agents.create');
              const model = optionalEntryString(entry, 'model', 'agents.create');
              const systemPrompt = optionalEntryString(entry, 'system_prompt', 'agents.create');
              const visibility = optionalVisibility(entry, 'agents.create');
              return {
                input: {
                  ...(name !== undefined ? { name } : {}),
                  workspace: rawWorkspace,
                  ...(model !== undefined ? { model } : {}),
                  ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
                  ...(visibility !== undefined ? { visibility } : {}),
                  ...identity,
                },
              };
            }
            const teamId = optionalEntryString(entry, 'team_id', 'agents.create');
            if (teamId !== undefined) {
              const workspace = await resolveWorkspace(teamId, deps.teams);
              if (workspace === undefined) {
                return { failure: fail('not_found', `Team not found: ${teamId}`) };
              }
              const name = optionalEntryString(entry, 'name', 'agents.create');
              if (name === undefined) {
                return {
                  failure: fail('invalid_input', 'team_id requires name to bind a member'),
                };
              }
              const model = optionalEntryString(entry, 'model', 'agents.create');
              const systemPrompt = optionalEntryString(entry, 'system_prompt', 'agents.create');
              const visibility = optionalVisibility(entry, 'agents.create');
              return {
                input: {
                  name,
                  workspace,
                  ...(model !== undefined ? { model } : {}),
                  ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
                  ...(visibility !== undefined ? { visibility } : {}),
                  ...identity,
                },
              };
            }
            const name = optionalEntryString(entry, 'name', 'agents.create');
            const model = optionalEntryString(entry, 'model', 'agents.create');
            const systemPrompt = optionalEntryString(entry, 'system_prompt', 'agents.create');
            const visibility = optionalVisibility(entry, 'agents.create');
            return {
              input: {
                ...(name !== undefined ? { name } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
                ...(visibility !== undefined ? { visibility } : {}),
                ...identity,
              },
            };
          }),
        );

        const inputs = prepared
          .filter((entry): entry is { input: AgentCreateLikeInput } => 'input' in entry)
          .map((entry) => entry.input);
        if (inputs.length === 0) return mergeBatchResults(prepared, []);
        const batch = await control.create(inputs);
        return mergeBatchResults(prepared, batch.results);
      },
    },
    {
      /**
       * `agents.update`（0.25，write）：批量更新 name / model / system_prompt。
       *
       * - 每个条目至少给一个字段；条目并行，结果与输入同序；
       * - team-scoped token 只能更新 `team_id` 与自身作用域相同的 agent（否则 `not_found`）；
       * - 改名立即生效，唯一性与创建一致（同 Team present 唯一；unbound 为 tenant 唯一），
       *   冲突返回稳定 `invalid_input`；
       * - model / system_prompt 只写入成员记录，**下一次 spawn 的 Body** 才使用；
       *   实际变化时成功条目带 `applies_to: 'next_body'`；
       * - 服务发布 `agent.updated`，只带变化字段名，不带 prompt 正文。
       */
      name: 'agents.update',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['agents'],
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              required: ['agent_id'],
              properties: {
                agent_id: { type: 'string', minLength: 1 },
                name: { type: 'string', minLength: 1 },
                model: { type: 'string', minLength: 1 },
                system_prompt: { type: 'string' },
              },
            },
          },
        },
      },
      result_schema: agentLifecycleResultSchema,
      handler: async (params, ctx) => {
        const control = requireAgentControl(deps.agent, ctx);
        const entries = requireAgentEntries(params, 'agents.update');
        const scope = teamScopeOf(ctx);

        const prepared = await Promise.all(
          entries.map(async (entry): Promise<Prepared<AgentUpdateLikeInput>> => {
            const agentId = optionalEntryString(entry, 'agent_id', 'agents.update');
            if (agentId === undefined) {
              return { failure: fail('invalid_params', 'agent_id must be a non-empty string') };
            }
            const name = optionalEntryString(entry, 'name', 'agents.update');
            const model = optionalEntryString(entry, 'model', 'agents.update');
            const systemPrompt = optionalEntryString(entry, 'system_prompt', 'agents.update');
            if (name === undefined && model === undefined && systemPrompt === undefined) {
              return {
                failure: fail(
                  'invalid_params',
                  'at least one of name, model or system_prompt is required',
                ),
              };
            }
            if (scope !== undefined) {
              const target = await control.get(agentId);
              if (!target || target.team_id !== scope) {
                return { failure: fail('not_found', `agent not found: ${agentId}`) };
              }
            }
            return {
              input: {
                agent_id: agentId,
                ...(name !== undefined ? { name } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
              },
            };
          }),
        );

        const inputs = prepared
          .filter((entry): entry is { input: AgentUpdateLikeInput } => 'input' in entry)
          .map((entry) => entry.input);
        if (inputs.length === 0) return mergeBatchResults(prepared, []);
        const batch = await control.update(inputs);
        return mergeBatchResults(prepared, batch.results);
      },
    },
    {
      /**
       * `agents.close`（0.25，write）：批量关闭成员。
       *
       * - team-scoped token 只能关闭 `team_id` 与自身作用域相同的 agent（否则 `not_found`）；
       * - 成功条目 `{ ok: true, agent_id, closed: true }`，与输入同序；
       * - 与 AgentService.close 批量语义一致：重复 close 幂等，单条失败不影响其它条目。
       */
      name: 'agents.close',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['agents'],
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              required: ['agent_id'],
              properties: {
                agent_id: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
      result_schema: agentLifecycleResultSchema,
      handler: async (params, ctx) => {
        const control = requireAgentControl(deps.agent, ctx);
        const entries = requireAgentEntries(params, 'agents.close');
        const scope = teamScopeOf(ctx);

        const prepared = await Promise.all(
          entries.map(async (entry): Promise<Prepared<string>> => {
            const agentId = optionalEntryString(entry, 'agent_id', 'agents.close');
            if (agentId === undefined) {
              return { failure: fail('invalid_params', 'agent_id must be a non-empty string') };
            }
            if (scope !== undefined) {
              const target = await control.get(agentId);
              if (!target || target.team_id !== scope) {
                return { failure: fail('not_found', `agent not found: ${agentId}`) };
              }
            }
            return { input: agentId };
          }),
        );

        const ids = prepared
          .filter((entry): entry is { input: string } => 'input' in entry)
          .map((entry) => entry.input);
        if (ids.length === 0) return mergeBatchResults(prepared, []);
        const batch = await control.close(ids);
        return mergeBatchResults(prepared, batch.results);
      },
    },
    {
      /**
       * `agents.send`（0.26，write）：批量 strict send（不 resume）。
       *
       * 发送者来自 principal：合成 owner principal 用 owner agent id，
       * gateway / team token 用 `human`。team-scoped token 只能发送给同 team 成员。
       */
      name: 'agents.send',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['messages'],
        properties: {
          messages: { type: 'array', items: agentSendEntrySchema },
        },
      },
      result_schema: agentSendResultSchema,
      handler: async (params, ctx) => {
        const control = requireAgentControl(deps.agent, ctx);
        const entries = requireObjectEntries(params, 'messages', 'agents.send');
        const scope = teamScopeOf(ctx);
        const from = actorOf(ctx);

        const prepared = await Promise.all(
          entries.map(async (entry): Promise<Prepared<AgentSendLikeInput>> => {
            const to = optionalEntryString(entry, 'to', 'agents.send');
            const content = optionalEntryString(entry, 'content', 'agents.send');
            if (to === undefined || content === undefined) {
              return {
                failure: fail('invalid_params', 'to and content must be non-empty strings'),
              };
            }
            if (!(await targetInTeamScope(control, scope, to, false))) {
              return { failure: fail('not_found', `agent not found: ${to}`) };
            }
            const conversationId = optionalEntryString(entry, 'conversation_id', 'agents.send');
            return {
              input: {
                to,
                content,
                from,
                ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
              },
            };
          }),
        );

        const inputs = prepared
          .filter((entry): entry is { input: AgentSendLikeInput } => 'input' in entry)
          .map((entry) => entry.input);
        if (inputs.length === 0) return mergeBatchResults(prepared, []);
        const batch = await control.send(inputs);
        return mergeBatchResults(prepared, batch.results);
      },
    },
    {
      /**
       * `agents.dispatch`（0.26，write）：批量统一投递（gone 先 resume，可 fork）。
       *
       * 业务拒绝（agent_left / resume_failed / not_visible / budget_* …）是逐条
       * `{ ok: false, code, error }`，不拖垮同批其它条目。
       */
      name: 'agents.dispatch',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['messages'],
        properties: {
          messages: { type: 'array', items: agentDispatchEntrySchema },
        },
      },
      result_schema: agentDispatchResultSchema,
      handler: async (params, ctx) => {
        const control = requireAgentControl(deps.agent, ctx);
        const entries = requireObjectEntries(params, 'messages', 'agents.dispatch');
        const scope = teamScopeOf(ctx);
        const from = actorOf(ctx);

        const prepared = await Promise.all(
          entries.map(async (entry): Promise<Prepared<AgentDispatchLikeInput>> => {
            const to = optionalEntryString(entry, 'to', 'agents.dispatch');
            const content = optionalEntryString(entry, 'content', 'agents.dispatch');
            if (to === undefined || content === undefined) {
              return {
                failure: fail('invalid_params', 'to and content must be non-empty strings'),
              };
            }
            if (entry.allow_fork !== undefined && typeof entry.allow_fork !== 'boolean') {
              return { failure: fail('invalid_params', 'allow_fork must be a boolean') };
            }
            if (!(await targetInTeamScope(control, scope, to, true))) {
              return { failure: fail('not_found', `agent not found: ${to}`) };
            }
            const conversationId = optionalEntryString(entry, 'conversation_id', 'agents.dispatch');
            return {
              input: {
                to,
                content,
                from,
                ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
                ...(entry.allow_fork !== undefined ? { allow_fork: entry.allow_fork } : {}),
              },
            };
          }),
        );

        const inputs = prepared
          .filter((entry): entry is { input: AgentDispatchLikeInput } => 'input' in entry)
          .map((entry) => entry.input);
        if (inputs.length === 0) return mergeBatchResults(prepared, []);
        const batch = await control.dispatch(inputs);
        return mergeBatchResults(prepared, batch.results);
      },
    },
    {
      /**
       * `agents.rotate`（0.26，write）：批量换 Body。
       *
       * 人类路径（owner / gateway）不传 `from_session_id`，可 rotate 任意可见成员；
       * 成员工具路径仍由 AgentService 以 `from_session_id` 收紧为只能 rotate 自己。
       */
      name: 'agents.rotate',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['agents'],
        properties: {
          agents: { type: 'array', items: agentRotateEntrySchema },
        },
      },
      result_schema: agentRotateResultSchema,
      handler: async (params, ctx) => {
        const control = requireAgentControl(deps.agent, ctx);
        const entries = requireObjectEntries(params, 'agents', 'agents.rotate');
        const scope = teamScopeOf(ctx);
        const from = actorOf(ctx);

        const prepared = await Promise.all(
          entries.map(async (entry): Promise<Prepared<AgentRotateLikeInput>> => {
            const to = optionalEntryString(entry, 'to', 'agents.rotate');
            const startupPrompt = optionalEntryString(entry, 'startup_prompt', 'agents.rotate');
            if (to === undefined || startupPrompt === undefined) {
              return {
                failure: fail('invalid_params', 'to and startup_prompt must be non-empty strings'),
              };
            }
            if (!(await targetInTeamScope(control, scope, to, true))) {
              return { failure: fail('not_found', `agent not found: ${to}`) };
            }
            const handoffPath = optionalEntryString(entry, 'handoff_path', 'agents.rotate');
            const fromSessionId = optionalEntryString(entry, 'from_session_id', 'agents.rotate');
            return {
              input: {
                to,
                startup_prompt: startupPrompt,
                from,
                ...(handoffPath !== undefined ? { handoff_path: handoffPath } : {}),
                ...(fromSessionId !== undefined ? { from_session_id: fromSessionId } : {}),
              },
            };
          }),
        );

        const inputs = prepared
          .filter((entry): entry is { input: AgentRotateLikeInput } => 'input' in entry)
          .map((entry) => entry.input);
        if (inputs.length === 0) return mergeBatchResults(prepared, []);
        const batch = await control.rotate(inputs);
        return mergeBatchResults(prepared, batch.results);
      },
    },
  ];
}
