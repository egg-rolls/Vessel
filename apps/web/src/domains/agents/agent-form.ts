/** Agent create / edit 表单（纯函数）：裁剪、空值省略、至少一个有效变更。 */
import type { AgentCreateInput, AgentRole, AgentUpdateInput } from '../../gateway/types';

/** 创建判别；服务端映射：peer → member，contractor → temporary。 */
export type AgentKind = 'peer' | 'contractor';

/** CONTRACT-role-model §3：创建 kind 与 v3 role 的映射（只用于提示）。 */
export function roleFromKind(kind: AgentKind | undefined): AgentRole {
  return (kind ?? 'peer') === 'peer' ? 'member' : 'temporary';
}

export interface AgentDraft {
  name: string;
  model: string;
  systemPrompt: string;
  /** 创建时的 Team；空串 = unbound。 */
  teamId: string;
  /** 创建判别；编辑表单忽略。缺省按 `peer` 处理。 */
  kind?: AgentKind;
}

export type AgentCreateError = 'peer_requires_team';

/** peer 必须绑定 Team；contractor 可 unbound。 */
export function agentCreateError(draft: AgentDraft): AgentCreateError | undefined {
  return (draft.kind ?? 'peer') === 'peer' && trimmed(draft.teamId) === ''
    ? 'peer_requires_team'
    : undefined;
}

export type AgentUpdateError = 'no_change';

export interface AgentUpdateResult {
  ok: boolean;
  input?: AgentUpdateInput;
  error?: AgentUpdateError;
}

function trimmed(value: string): string {
  return value.trim();
}

/** 创建：`kind` 始终发送；空字段不发送；`team_id` 只有显式选择时才绑定。 */
export function buildAgentCreateInput(draft: AgentDraft): AgentCreateInput {
  const name = trimmed(draft.name);
  const model = trimmed(draft.model);
  const systemPrompt = trimmed(draft.systemPrompt);
  const teamId = trimmed(draft.teamId);
  return {
    kind: draft.kind ?? 'peer',
    ...(name !== '' ? { name } : {}),
    ...(model !== '' ? { model } : {}),
    ...(systemPrompt !== '' ? { system_prompt: systemPrompt } : {}),
    ...(teamId !== '' ? { team_id: teamId } : {}),
  };
}

/**
 * 编辑：只发送真正变化的字段；模型 / system prompt 留空 = 不修改。
 * 没有任何变化时返回 `no_change`，由 UI 提示而不是发一个空请求。
 */
export function buildAgentUpdateInput(
  agentId: string,
  initial: { name: string; model: string; systemPrompt: string },
  draft: AgentDraft,
): AgentUpdateResult {
  const input: AgentUpdateInput = { agent_id: agentId };
  let changed = 0;

  const name = trimmed(draft.name);
  if (name !== '' && name !== trimmed(initial.name)) {
    input.name = name;
    changed += 1;
  }
  const model = trimmed(draft.model);
  if (model !== '' && model !== trimmed(initial.model)) {
    input.model = model;
    changed += 1;
  }
  const systemPrompt = trimmed(draft.systemPrompt);
  if (systemPrompt !== '' && systemPrompt !== trimmed(initial.systemPrompt)) {
    input.system_prompt = systemPrompt;
    changed += 1;
  }

  return changed === 0 ? { ok: false, error: 'no_change' } : { ok: true, input };
}
