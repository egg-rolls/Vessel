/**
 * AgentService → canonical `agents.*` 控制面适配（0.25）。
 *
 * 只做形状映射：生命周期逻辑全部在 `@vessel-agent/agent`。批量语义直接复用
 * `AgentService.new/update/close`，因此与 owner 端点完全一致（并行、失败隔离、
 * 结果保持输入顺序）。owner 端点的后续收口应复用同一适配器，而不是另写一套。
 *
 * @module vessel/agent-control
 */

import type { AgentService, BatchItemResult, MemberStatus } from '@vessel-agent/agent';
import type {
  AgentCloseBatchResultLike,
  AgentControlLike,
  AgentCreateLikeInput,
  AgentLifecycleBatchResultLike,
  AgentLifecycleFailLike,
  AgentLifecycleItemLike,
  AgentStatusLike,
  AgentUpdateLikeInput,
} from '../packages/serve/src/index';

function statusOf(status: MemberStatus): AgentStatusLike {
  return status as unknown as AgentStatusLike;
}

function failureOf(item: { error: string; code?: string }): AgentLifecycleFailLike {
  return { ok: false, code: item.code ?? 'internal', error: item.error };
}

function mapLifecycle<T>(
  results: ReadonlyArray<BatchItemResult<T>>,
  success: (status: T) => AgentLifecycleItemLike,
): AgentLifecycleBatchResultLike {
  return {
    results: results.map((item) => (item.ok ? success(item.status) : failureOf(item))),
  };
}

/** 用 app 侧的 AgentService 构造注入给 gateway 的稳定控制面。 */
export function createAgentControl(service: AgentService, tenantId: string): AgentControlLike {
  return {
    tenantId,
    async create(inputs: AgentCreateLikeInput[]): Promise<AgentLifecycleBatchResultLike> {
      const batch = await service.new({
        members: inputs.map((input) => ({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.system_prompt !== undefined ? { systemPrompt: input.system_prompt } : {}),
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        })),
      });
      return mapLifecycle(batch.results, (status) => ({
        ok: true,
        agent: statusOf(status),
      }));
    },
    async update(inputs: AgentUpdateLikeInput[]): Promise<AgentLifecycleBatchResultLike> {
      const batch = await service.update({
        updates: inputs.map((input) => ({
          id: input.agent_id,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.system_prompt !== undefined ? { systemPrompt: input.system_prompt } : {}),
        })),
      });
      return mapLifecycle(batch.results, (result) => ({
        ok: true,
        agent: statusOf(result.agent),
        changed: result.changed,
        ...(result.applies_to !== undefined ? { applies_to: result.applies_to } : {}),
      }));
    },
    async close(agentIds: string[]): Promise<AgentCloseBatchResultLike> {
      const batch = await service.close({ members: agentIds });
      return {
        results: await Promise.all(
          batch.results.map(async (item, index) => {
            if (!item.ok) return failureOf(item);
            const agentId = agentIds[index] ?? '';
            // close 后记录仍在注册表里（membership=left / state=closed），
            // 统一契约的 `agent` 因此仍然可读。
            const status = statusOf(
              (await service.identify(agentId)) ?? {
                id: agentId,
                session_id: agentId,
                owner: '',
                visibility: 'private',
                state: 'closed',
              },
            );
            return { ok: true as const, agent: status, agent_id: agentId, closed: true as const };
          }),
        ),
      };
    },
    async get(agentId: string): Promise<AgentStatusLike | undefined> {
      const status = await service.identify(agentId);
      return status === undefined ? undefined : statusOf(status);
    },
  };
}
