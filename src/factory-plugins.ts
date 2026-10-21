/**
 * delegate / team 工厂插件的接线决策（A5；0.3 删除 viaHost 开关）。
 *
 * 纯函数，便于测试：
 * - host 开启：delegate 与 team 都共享同一个 Host。
 * - host 关闭：delegate 用插件自带专用 Host；team 用插件内嵌 Host，并告警。
 * 默认（两者都未启用）零输出。
 */

import type { VesselConfig } from '../packages/config/src/index';
import { resolveAgentWiring } from './agent-wiring';

export interface FactoryPluginDecision {
  enabled: boolean;
  /** true = 注入共享 RuntimeHost；false = 插件自行创建专用/内嵌 Host */
  useHost: boolean;
}

export interface FactoryPluginPlan {
  delegate: FactoryPluginDecision | null;
  team: FactoryPluginDecision | null;
  warnings: string[];
}

export interface FactoryPluginPlanOptions {
  /** 入口是否 headless；缺省 false（交互口径） */
  headless?: boolean;
  /**
   * 已解析的 agent 装配计划；缺省按 `headless` 现算。
   * 也允许调用方显式传 false 关闭（例如 `--tools` 的只读口径）。
   */
  agentEnabled?: boolean;
}

export function planFactoryPlugins(
  config: VesselConfig,
  hasHost: boolean,
  options: FactoryPluginPlanOptions = {},
): FactoryPluginPlan {
  const warnings: string[] = [];
  // 未显式给 agentEnabled / headless 时保持 0.15 口径（delegate_task 默认注册），
  // 避免只读工具或旧测试因入口推断而被静默改变。
  const agentEnabled =
    options.agentEnabled ??
    (options.headless === undefined
      ? false
      : resolveAgentWiring(config, { headless: options.headless }).agentEnabled);
  const teamRequested = config.team?.enabled === true || agentEnabled;

  // agent 可用时只保留一个 canonical schema：不再注册 delegate_task。
  let delegate: FactoryPluginDecision | null = null;
  if (config.delegate?.enabled !== false && !agentEnabled) {
    delegate = { enabled: true, useHost: hasHost };
  }

  let team: FactoryPluginDecision | null = null;
  if (teamRequested) {
    if (!hasHost) {
      warnings.push(
        'team.enabled with host.enabled=false: team uses an internal in-process host created by the assembler.',
      );
    }
    team = { enabled: true, useHost: hasHost };
  }

  return { delegate, team, warnings };
}
