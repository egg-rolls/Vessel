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
  AgentDispatchBatchResultLike,
  AgentDispatchItemLike,
  AgentDispatchLikeInput,
  AgentLifecycleBatchResultLike,
  AgentLifecycleFailLike,
  AgentLifecycleItemLike,
  AgentListLikeInput,
  AgentRotateBatchResultLike,
  AgentRotateItemLike,
  AgentRotateLikeInput,
  AgentSendBatchResultLike,
  AgentSendLikeInput,
  AgentStatusLike,
  AgentUpdateLikeInput,
} from '../packages/serve/src/index';

function statusOf(status: MemberStatus): AgentStatusLike {
  return status as unknown as AgentStatusLike;
}

function failureOf(item: { error: string; code?: string }): AgentLifecycleFailLike {
  return { ok: false, code: item.code ?? 'internal', error: item.error };
}

/** 服务抛出的异常 → 逐条失败；保留稳定 code（如 team_metadata_corrupt）。 */
function failureFrom(error: unknown): AgentLifecycleFailLike {
  const code =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'internal';
  return {
    ok: false,
    code,
    error: error instanceof Error ? error.message : String(error),
  };
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
      const batch = await service.create({
        members: inputs.map((input) => ({
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.team_id !== undefined ? { teamId: input.team_id } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.system_prompt !== undefined ? { systemPrompt: input.system_prompt } : {}),
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
          ...(input.spawnedBy !== undefined ? { spawnedBy: input.spawnedBy } : {}),
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
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          ...(input.from !== undefined ? { from: input.from } : {}),
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
                role: 'member',
                owner: agentId,
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
    async list(input: AgentListLikeInput = {}): Promise<AgentStatusLike[]> {
      const statuses = await service.list({
        ...(input.viewer !== undefined ? { viewer: input.viewer } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
      });
      return statuses.map(statusOf);
    },
    async resolve(target: string): Promise<AgentStatusLike | undefined> {
      const direct = await service.identify(target);
      if (direct !== undefined) return statusOf(direct);
      // dispatch 的寻址规则：唯一 present name（visibility 沿用无 viewer 的 canonical 视图）。
      const matches = (await service.list({})).filter(
        (status) => status.membership === 'present' && status.name === target,
      );
      return matches.length === 1 && matches[0] !== undefined ? statusOf(matches[0]) : undefined;
    },
    async send(inputs: AgentSendLikeInput[]): Promise<AgentSendBatchResultLike> {
      const batch = await service.send({
        messages: inputs.map((input) => ({
          to: input.to,
          content: input.content,
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.conversation_id !== undefined
            ? { conversation_id: input.conversation_id }
            : {}),
          ...(input.interrupt !== undefined ? { interrupt: input.interrupt } : {}),
          ...(input.message_id !== undefined ? { message_id: input.message_id } : {}),
          ...(input.important !== undefined ? { important: input.important } : {}),
        })),
      });
      return {
        results: batch.results.map((item) =>
          item.ok
            ? {
                ok: true as const,
                queued: true as const,
                message_id: item.status.message_id,
                state: item.status.state,
              }
            : failureOf(item),
        ),
      };
    },
    async dispatch(inputs: AgentDispatchLikeInput[]): Promise<AgentDispatchBatchResultLike> {
      const settledResults = await Promise.allSettled(
        inputs.map((input) =>
          service.dispatch({
            to: input.to,
            content: input.content,
            ...(input.from !== undefined ? { from: input.from } : {}),
            ...(input.conversation_id !== undefined
              ? { conversation_id: input.conversation_id }
              : {}),
            ...(input.allow_fork !== undefined ? { allow_fork: input.allow_fork } : {}),
          }),
        ),
      );
      const results: AgentDispatchItemLike[] = settledResults.map((settledResult) => {
        if (settledResult.status === 'rejected') return failureFrom(settledResult.reason);
        const result = settledResult.value;
        if (result.status !== 'queued') {
          return { ok: false, code: result.code, error: result.reason };
        }
        return {
          ok: true,
          status: 'queued',
          message_id: result.message_id,
          resolved_to: result.resolved_to,
          resolution: result.resolution,
          ...(result.conversation_id !== undefined
            ? { conversation_id: result.conversation_id }
            : {}),
        };
      });
      return { results };
    },
    async rotate(inputs: AgentRotateLikeInput[]): Promise<AgentRotateBatchResultLike> {
      const settledResults = await Promise.allSettled(
        inputs.map((input) =>
          service.rotate({
            to: input.to,
            startup_prompt: input.startup_prompt,
            ...(input.from !== undefined ? { from: input.from } : {}),
            ...(input.from_session_id !== undefined
              ? { from_session_id: input.from_session_id }
              : {}),
          }),
        ),
      );
      const results: AgentRotateItemLike[] = settledResults.map((settledResult) => {
        if (settledResult.status === 'rejected') return failureFrom(settledResult.reason);
        const result = settledResult.value;
        if (result.status !== 'rotated') {
          return { ok: false, code: result.code, error: result.reason };
        }
        return {
          ok: true,
          status: 'rotated',
          agent_id: result.agent_id,
          from_session_id: result.from_session_id,
          to_session_id: result.to_session_id,
          epoch: result.epoch,
        };
      });
      return { results };
    },
  };
}
