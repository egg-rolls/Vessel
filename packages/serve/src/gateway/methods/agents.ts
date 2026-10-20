/**
 * agents.* 方法（0.14 P0，DECISION-025 §1.4）。
 *
 * 数据源优先级：
 *   1. Host / RuntimeHost 成员（仅 default tenant，Host 是进程级、无 tenant 维度）；
 *   2. active / queued run 记录（补齐无 Host 时的根 agent）；
 *   3. `subagent.*` 事件派生条目（保留 parent/depth/task/session/usage）。
 *
 * 结果 schema additive；未知 id 返回 `not_found`。不新增错误码。
 *
 * @module @vessel-agent/serve
 */

import type { AgentRegistry, AgentRegistryEntry } from '../../agents-registry.js';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import type { RunRecord } from '../../run-engine.js';
import type { TeamHostLike } from '../../team.js';
import { stringParam } from './common.js';
import { agentInfoSchema } from './schemas.js';

export interface AgentMethodsDeps {
  registry: AgentRegistry;
  /** team host；未启用 team / 未注入时为 undefined。 */
  host?: () => TeamHostLike | undefined;
  runs: ReadonlyMap<string, RunRecord>;
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

  // 2. Host 成员：状态权威；保留派生条目的 parent/depth/task/session。
  if (isDefault) {
    const host = deps.host?.();
    for (const status of host?.list() ?? []) {
      const existing = merged.get(status.id);
      merged.set(status.id, {
        ...(existing ?? {}),
        id: status.id,
        depth: existing?.depth ?? 0,
        role: status.name ?? existing?.role ?? 'agent',
        state: status.state,
      });
    }
  }

  // 3. active / queued run：无 Host 成员覆盖时补根 agent。
  const hostMembers = isDefault ? (deps.host?.()?.list() ?? []) : [];
  const hostRunIds = new Set(
    hostMembers
      .map((status) => status.currentRunId)
      .filter((runId): runId is string => typeof runId === 'string'),
  );
  for (const record of deps.runs.values()) {
    if (record.tenant_id !== tenantId) continue;
    if (record.status !== 'queued' && record.status !== 'running') continue;
    const id = record.core_run_id ?? record.run_id;
    if (merged.has(id)) continue;
    if (hostRunIds.has(record.run_id)) continue;
    if (record.core_run_id !== undefined && hostRunIds.has(record.core_run_id)) continue;
    merged.set(id, {
      id,
      role: 'main',
      depth: 0,
      state: record.status,
      session_id: record.session_id,
      ...(record.started_at !== undefined ? { started_at: record.started_at } : {}),
    });
  }

  return merged;
}

/** 裁剪为冻结的公开形状（不泄漏 task / last_error / tenant_id）。 */
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
  ];
}
