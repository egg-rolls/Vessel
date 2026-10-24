/** Agent create / edit 表单（纯函数）：裁剪、空值省略、至少一个有效变更。 */
import type { AgentCreateInput, AgentUpdateInput } from '../../gateway/types';

export interface AgentDraft {
  name: string;
  model: string;
  systemPrompt: string;
  /** 创建时的 Team；空串 = unbound。 */
  teamId: string;
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

/** 创建：空字段不发送；`team_id` 只有显式选择时才绑定。 */
export function buildAgentCreateInput(draft: AgentDraft): AgentCreateInput {
  const name = trimmed(draft.name);
  const model = trimmed(draft.model);
  const systemPrompt = trimmed(draft.systemPrompt);
  const teamId = trimmed(draft.teamId);
  return {
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
