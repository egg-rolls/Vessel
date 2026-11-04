/**
 * 解开批量 `agents.create|update|close` 的逐条结果。
 *
 * UI 每次只发一条；`results[0].ok === false` 必须按失败处理，
 * 不能把批量响应当成成功，也不能吞掉服务端 error。
 */
import type { AgentBatchResponse, AgentSummary } from './types';

export class AgentActionResultError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentActionResultError';
  }
}

/** 空响应 / 失败条目都抛错；成功返回该条 agent。 */
export function unwrapAgentResult(body: AgentBatchResponse): AgentSummary {
  const first = body?.results?.[0];
  if (!first) {
    throw new AgentActionResultError('invalid_response', 'agents.* returned no results');
  }
  if (!first.ok) {
    throw new AgentActionResultError(
      first.code ?? 'internal',
      first.error ?? 'Agent action failed',
    );
  }
  return first.agent ?? {};
}
