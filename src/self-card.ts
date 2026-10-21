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
  options: { askUser?: boolean } = {},
): string[] {
  const names = ['bash', 'read', 'edit'];
  // delegate-task 默认启用（配置显式 enabled:false 才关闭）。
  if (config.delegate?.enabled !== false) names.push('delegate_task');
  if (options.askUser === true && config.ui?.askUser !== false) names.push('ask_user');
  if (config.team?.enabled === true) {
    names.push('team_spawn', 'team_send', 'team_inbox', 'team_status', 'team_cancel');
  }
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
      ? 'Use the ask_user tool when a decision or missing information blocks progress.'
      : 'This entry cannot ask the user; state assumptions or fail with a clear reason.',
  };
}
