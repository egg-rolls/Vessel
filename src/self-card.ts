/**
 * 主 agent 的 Self Card（0.15 E9）。
 *
 * 只描述**已知**工具；MCP 工具名在连接前不可知，不写进卡片。
 * 成员 / 子 agent 的 Self Card 由 delegate 轨注入。
 *
 * @module vessel/self-card
 */

import type { VesselConfig } from '../packages/config/src/index';
import type { SelfCardOptions } from '../packages/core/src/index';

/** 推断当前入口已知会注册的工具名。 */
export function knownOwnerToolNames(
  config: VesselConfig,
  options: { askUser?: boolean; headless?: boolean } = {},
): string[] {
  const names = ['bash', 'read', 'edit'];
  // 0.16：team 构造时总会注册 agent，因此只声明 canonical 工具；否则回退 delegate_task。
  const agentEnabled =
    (config.agent?.enabled ?? options.headless !== true) || config.team?.enabled === true;
  if (agentEnabled) {
    names.push('agent');
  } else if (config.delegate?.enabled !== false) {
    names.push('delegate_task');
  }
  if (options.askUser === true && config.ui?.askUser !== false) names.push('ask_user');
  if (config.team?.enabled === true && config.team?.legacyTools === true) {
    names.push('team_spawn', 'team_send', 'team_inbox', 'team_status', 'team_cancel');
  }
  return names;
}

/** 构造 owner 的 Self Card。 */
export function ownerSelfCard(
  config: VesselConfig,
  model: string,
  options: { askUser?: boolean; headless?: boolean } = {},
): SelfCardOptions {
  const askUser = options.askUser === true && config.ui?.askUser !== false;
  return {
    role: 'owner',
    depth: 0,
    model,
    tools: knownOwnerToolNames(config, { askUser, headless: options.headless }),
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
      ? 'Use the ask_user tool when a decision or missing information blocks progress.'
      : 'This entry cannot ask the user; state assumptions or fail with a clear reason.',
  };
}
