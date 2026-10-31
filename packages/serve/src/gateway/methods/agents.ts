/**
 * agents.* 方法（0.14 P0；0.15 E5）。
 *
 * 数据源优先级：
 *   1. live run 快照（`RunControlLike.snapshot()` 的 queued + running，补齐根 agent
 *      与队列位置）；
 *   2. `subagent.*` 事件派生条目（保留 parent/depth/task/session/usage）。
 *
 * @module @vessel-agent/serve
 */

import type {
  AgentControlLike,
  AgentCreateLikeInput,
  AgentDispatchLikeInput,
  AgentLifecycleFailLike,
  AgentRoleLike,
  AgentRotateLikeInput,
  AgentSendLikeInput,
  AgentStateLike,
  AgentStatusLike,
  AgentUpdateLikeInput,
  AgentVisibilityLike,
} from '../../agent-control.js';
import type { AgentRegistry, AgentRegistryEntry } from '../../agents-registry.js';
import {
  isTeamScopedPrincipal,
  RpcError,
  type RpcMethodContext,
  type RpcMethodDefinition,
} from '../../rpc.js';
import type { LiveRunSnapshotLike } from '../../run-control.js';
import type { TeamControlLike } from '../../team-control.js';
import { stringParam } from './common.js';
import {
  agentCardSchema,
  agentInfoSchema,
  agentStatusSchema,
  stringListSchema,
} from './schemas.js';

export interface AgentMethodsDeps {
  registry: AgentRegistry;
  /**
   * 0.27：某 tenant 的 live run 快照（唯一来源 = `RunControlLike.snapshot()`
   * 的 queued + running）；serve 不再持有 run 记录或队列。
   *
   * 需要 tenant 参数：`LiveRunSnapshotLike` 不带 tenant_id（snapshot 本身按
   * tenant 取），返回合并列表会把别的 tenant 的 agent 泄漏给当前调用方。
   */
  liveRuns: (tenantId: string) => readonly LiveRunSnapshotLike[];
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

/**
 * 管理面 viewer：与 `MemberRegistry` 的 ADMIN_VIEWER 同值（serve 不依赖
 * `@vessel-agent/agent`，因此在此本地定义）。
 * 0.28 起它不再放行任何 private 记录（`single` 已删），只表达「管理面口径」。
 */
const ADMIN_VIEWER = '*';

/**
 * 人类管理面 principal：静态 gateway token / admin token。合成 owner 传输带
 * `agent_id`，属于 agent 身份，不算人类管理面。
 */
function isHumanAdmin(ctx: RpcMethodContext): boolean {
  return ctx.principal.role === 'admin' && ctx.principal.agent_id === undefined;
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

  // 2. live run 快照：补齐根 agent 与队列位置。
  // 0.27：id 用 `agent_id`（不再借用 core run id），状态 / 队列位 / session
  // 全部来自 scheduler snapshot。
  for (const run of deps.liveRuns(tenantId)) {
    if (merged.has(run.agent_id)) continue;
    merged.set(run.agent_id, {
      id: run.agent_id,
      role: 'main',
      depth: 0,
      state: run.status,
      session_id: run.session_id,
      ...(run.started_at !== undefined ? { started_at: run.started_at } : {}),
      ...(run.queue_position !== undefined && run.queue_position >= 1
        ? { queue_position: run.queue_position }
        : {}),
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
    ...(entry.role !== undefined ? { role: entry.role } : {}),
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

/** 可选角色；缺省 undefined，存在但非法 → invalid_params（结构错误整体拒绝）。 */
function optionalRole(entry: Record<string, unknown>, method: string): AgentRoleLike | undefined {
  const value = entry.role;
  if (value === undefined) return undefined;
  if (value !== 'member' && value !== 'temporary') {
    throw new RpcError('invalid_params', `${method}: role must be member or temporary`);
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
  required: ['to'],
  properties: {
    to: { type: 'string', minLength: 1 },
    content: { type: 'string', minLength: 1 },
    conversation_id: { type: 'string', minLength: 1 },
    // 0.32-D：打断 + 指定 inbox 消息 / 重要标记（additive，不新增方法）。
    interrupt: { type: 'boolean' },
    message_id: { type: 'string', minLength: 1 },
    important: { type: 'boolean' },
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
    from_session_id: { type: 'string', minLength: 1 },
  },
};

/**
 * viewer 作用域下的可见成员：`deps` 是事件派生视图 + live 快照。
 *
 * 可见性口径只有这一处，`agents.list` / `agents.get` 共用：
 * - 合成 owner principal（带 `agent_id`）→ 以该 agent 为 viewer 查 AgentService；
 * - 人类管理面 → 事件派生视图 + 成员记录（private 仍按 owner 判定，管理面不例外）；
 * - 其它（team-scoped token 等）→ 只有事件派生视图。
 *
 * `agents.tree` **不**走这里：它仍直读事件派生视图（见 ADR-091 已知限制），
 * 因此看不到成员记录里的 private 条目，也不认 viewer 口径。
 *
 * `filters.sessionId` 是**逐条**过滤（不是取到结果后整条抹）：同一 id 在注册表与
 * 成员表里的 session 可能不同（rotate 后旧 Body、stale 快照），整条抹会连带丢掉
 * 原本可见的注册表条目。
 */
async function visibleAgents(
  deps: AgentMethodsDeps,
  ctx: RpcMethodContext,
  filters: { sessionId?: string; state?: string; visibility?: AgentVisibilityLike } = {},
): Promise<Record<string, unknown>[]> {
  const sessionId = filters.sessionId;
  const stateArg = filters.state as AgentStateLike | undefined;
  const visibilityArg = filters.visibility;
  const agentServiceAvailable = deps.agent !== undefined && deps.agent.tenantId === ctx.tenantId;

  // 合成 owner principal 携带 agent id：按 viewer 从 AgentService 列出成员，
  // private 可见性与 CLI `vessel agent list` 的语义保持不变。
  const viewer = ctx.principal.agent_id;
  if (viewer !== undefined && agentServiceAvailable) {
    const members = await (deps.agent as AgentControlLike).list({
      viewer,
      ...(stateArg !== undefined ? { state: stateArg } : {}),
      ...(visibilityArg !== undefined ? { visibility: visibilityArg } : {}),
    });
    return members
      .filter((entry) => sessionId === undefined || entry.session_id === sessionId)
      .map(publicMember);
  }

  const agents = [...collectAgents(deps, ctx.tenantId).values()]
    .filter((entry) => sessionId === undefined || entry.session_id === sessionId)
    .filter((entry) => filters.state === undefined || entry.state === filters.state)
    .map(publicAgent);

  // 人类管理面在事件派生视图之外合并成员记录：
  // 从未跑过 run 的成员不会出现在事件派生视图里（例如刚启动的 `main`），
  // 管理面列表必须看得到它们，否则 Web 连「默认会话」都解析不出来。
  // 可见性仍按 ADMIN_VIEWER 判定（0.28 起 private 不再因管理面身份放开）。
  if (isHumanAdmin(ctx) && agentServiceAvailable) {
    const members = await (deps.agent as AgentControlLike).list({
      viewer: ADMIN_VIEWER,
      ...(stateArg !== undefined ? { state: stateArg } : {}),
      ...(visibilityArg !== undefined ? { visibility: visibilityArg } : {}),
    });
    for (const member of members) {
      if (sessionId !== undefined && member.session_id !== sessionId) continue;
      const entry = publicMember(member);
      const index = agents.findIndex((agent) => agent.id === member.id);
      if (index >= 0) agents[index] = entry;
      else agents.push(entry);
    }
  }
  return agents;
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
        const agents = await visibleAgents(deps, ctx, {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(visibility !== undefined ? { visibility } : {}),
        });
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
      handler: async (params, ctx) => {
        const agentId = stringParam(params, 'agent_id');
        // 与 `agents.list` 同一可见性口径：人类管理面额外合并成员记录，
        // 合成 owner principal 按自身 viewer 判定，team-scoped token 只看事件派生。
        const agents = await visibleAgents(deps, ctx);
        const agent = agents.find((entry) => entry.id === agentId);
        if (!agent) {
          throw new RpcError('not_found', `agent not found: ${agentId}`, { agent_id: agentId });
        }
        return { agent };
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
                // 输入判别（不落盘）：peer = 无 owner 且必须绑定 team；
                // contractor = 归属调用者；缺省保持 0.25 行为。
                kind: { type: 'string', enum: ['peer', 'contractor'] },
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

        // kind 路径只校验 Team 存在（不解析 workspace）；同一请求内去重。
        const teamChecks = new Map<string, Promise<boolean>>();
        const teamExists = (teamId: string): Promise<boolean> => {
          const cached = teamChecks.get(teamId);
          if (cached !== undefined) return cached;
          const teamControl = deps.teams;
          const pending =
            !teamControl || teamControl.tenantId !== ctx.tenantId
              ? Promise.resolve(false)
              : teamControl
                  .get(teamId)
                  .then((detail) => detail !== undefined)
                  .catch(() => false);
          teamChecks.set(teamId, pending);
          return pending;
        };

        const prepared = await Promise.all(
          entries.map(async (entry): Promise<Prepared<AgentCreateLikeInput>> => {
            const rawKind = entry.kind;
            if (rawKind !== undefined && rawKind !== 'peer' && rawKind !== 'contractor') {
              return { failure: fail('invalid_params', 'kind must be peer or contractor') };
            }
            // CLI 的 `--workspace` 是 owner 传输特权：保留显式 workspace 绑定的语义，
            // 但 gateway / Web 不能伪造主机路径（逐条拒绝）。
            const rawWorkspace = optionalEntryString(entry, 'workspace', 'agents.create');
            // peer / contractor 不允许 workspace（Team 绑定走 team_id）。
            if (rawKind !== undefined && rawWorkspace !== undefined) {
              return {
                failure: fail('invalid_params', `workspace is not allowed for kind=${rawKind}`),
              };
            }
            if (rawKind !== undefined) {
              const name = optionalEntryString(entry, 'name', 'agents.create');
              const model = optionalEntryString(entry, 'model', 'agents.create');
              const systemPrompt = optionalEntryString(entry, 'system_prompt', 'agents.create');
              const visibility = optionalVisibility(entry, 'agents.create');
              const teamId = optionalEntryString(entry, 'team_id', 'agents.create');
              if (teamId !== undefined && !(await teamExists(teamId))) {
                return { failure: fail('not_found', `Team not found: ${teamId}`) };
              }
              if (rawKind === 'peer') {
                if (teamId === undefined) {
                  return { failure: fail('invalid_params', 'peer requires team_id') };
                }
                return {
                  input: {
                    kind: 'peer',
                    team_id: teamId,
                    ...(name !== undefined ? { name } : {}),
                    ...(model !== undefined ? { model } : {}),
                    ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
                    ...(visibility !== undefined ? { visibility } : {}),
                    spawnedBy: ownerId ?? 'human',
                  },
                };
              }
              // contractor：owner/parent 缺省由 service 用 DEFAULT_OWNER 补齐。
              return {
                input: {
                  kind: 'contractor',
                  ...(teamId !== undefined ? { team_id: teamId } : {}),
                  ...(name !== undefined ? { name } : {}),
                  ...(model !== undefined ? { model } : {}),
                  ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
                  ...(visibility !== undefined ? { visibility } : {}),
                  ...identity,
                  spawnedBy: ownerId ?? 'human',
                },
              };
            }
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
       * `agents.update`（0.25，write；0.28 增加 role / team_id 转换）。
       *
       * - 每个条目至少给一个字段（含 role / team_id）；条目并行，结果与输入同序；
       * - team-scoped token 只能更新 `team_id` 与自身作用域相同的 agent（否则 `not_found`）；
       *   角色转换只能在 member / temporary 之间且不能换 team（`forbidden`）；
       * - 转换时 handler 传 `role`、`team_id → teamId`、`from = principal.agent_id ?? 'human'`；
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
                // 0.28：角色转换（member / temporary）与目标 Team。
                role: { type: 'string', enum: ['member', 'temporary'] },
                team_id: { type: 'string', minLength: 1 },
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
            const role = optionalRole(entry, 'agents.update');
            const teamId = optionalEntryString(entry, 'team_id', 'agents.update');
            if (
              name === undefined &&
              model === undefined &&
              systemPrompt === undefined &&
              role === undefined &&
              teamId === undefined
            ) {
              return {
                failure: fail(
                  'invalid_params',
                  'at least one of name, model, system_prompt, role or team_id is required',
                ),
              };
            }
            if (scope !== undefined) {
              const target = await control.get(agentId);
              if (!target || target.team_id !== scope) {
                return { failure: fail('not_found', `agent not found: ${agentId}`) };
              }
              if (teamId !== undefined && teamId !== scope) {
                return {
                  failure: fail(
                    'forbidden',
                    'team-scoped token cannot move members to another team',
                  ),
                };
              }
            }
            const conversion = role !== undefined || teamId !== undefined;
            return {
              input: {
                agent_id: agentId,
                ...(name !== undefined ? { name } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
                ...(role !== undefined ? { role } : {}),
                ...(teamId !== undefined ? { teamId } : {}),
                ...(conversion ? { from: actorOf(ctx) } : {}),
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
            const messageId = optionalEntryString(entry, 'message_id', 'agents.send');
            if (entry.interrupt !== undefined && typeof entry.interrupt !== 'boolean') {
              return { failure: fail('invalid_params', 'interrupt must be a boolean') };
            }
            if (entry.important !== undefined && typeof entry.important !== 'boolean') {
              return { failure: fail('invalid_params', 'important must be a boolean') };
            }
            const interrupt = entry.interrupt === true;
            if (to === undefined) {
              return { failure: fail('invalid_params', 'to must be a non-empty string') };
            }
            if (messageId !== undefined && !interrupt) {
              return {
                failure: fail('invalid_params', 'message_id requires interrupt: true'),
              };
            }
            if (interrupt) {
              if (content === undefined && messageId === undefined) {
                return {
                  failure: fail('invalid_params', 'interrupt requires content or message_id'),
                };
              }
              if (content !== undefined && messageId !== undefined) {
                return {
                  failure: fail('invalid_params', 'pass either content or message_id, not both'),
                };
              }
            } else if (content === undefined) {
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
                content: content ?? '',
                from,
                ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
                ...(interrupt ? { interrupt: true } : {}),
                ...(messageId !== undefined ? { message_id: messageId } : {}),
                ...(entry.important === true ? { important: true } : {}),
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
            const fromSessionId = optionalEntryString(entry, 'from_session_id', 'agents.rotate');
            return {
              input: {
                to,
                startup_prompt: startupPrompt,
                from,
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
