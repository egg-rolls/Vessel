/**
 * 主 agent 的 Self Card（0.15 E9）。
 *
 * 只描述**已知**工具；MCP 工具名在连接前不可知，不写进卡片。
 * 成员的 Self Card 由 AgentService 成员 runtime 注入。
 *
 * @module vessel/self-card
 */

import type { VesselConfig } from '../../packages/config/src/index';
import type { SelfCardOptions } from '../../packages/core/src/index';

/** 推断当前入口已知会注册的工具名。 */
export function knownOwnerToolNames(
  config: VesselConfig,
  options: { askUser?: boolean } = {},
): string[] {
  // 0.55.1：`write` 与 bash/read/edit 同属能力工具（建文件/覆盖/追加，逐字节落盘不经 shell）。
  // 这份清单是 Self Card 里「我有哪些工具」的真相源，加工具必须同步这里，否则模型不会想到用它。
  const names = ['bash', 'read', 'edit', 'write'];
  if (config.agent?.enabled !== false) names.push('agent');
  if (options.askUser === true && config.ui?.askUser !== false) names.push('ask');
  return names;
}

/** 构造 owner 的 Self Card。 */
export function ownerSelfCard(
  config: VesselConfig,
  model: string,
  options: { askUser?: boolean } = {},
): SelfCardOptions {
  const askUser = options.askUser === true && config.ui?.askUser !== false;
  return {
    role: 'owner',
    depth: 0,
    model,
    tools: knownOwnerToolNames(config, { askUser }),
    limits: {
      ...(config.limits ?? {}),
      ...(config.termination?.maxIterations !== undefined
        ? { maxIterations: config.termination.maxIterations }
        : {}),
      ...(config.termination?.maxRuntimeSeconds !== undefined
        ? { maxRuntimeSeconds: config.termination.maxRuntimeSeconds }
        : {}),
    },
    context: { max: config.context?.maxTokens ?? 1_000_000 },
    how_to_ask: askUser
      ? 'Use the ask tool whenever a human must speak: confirmation, choice, missing facts, or intent you cannot infer.'
      : 'This entry cannot ask the user; state assumptions or fail with a clear reason.',
  };
}
