/**
 * delegate / team 工厂插件的接线决策（A5）。
 *
 * 纯函数，便于测试：
 * - host 开启：delegate.viaHost=true 时共享 Host；team 总是接同一个 Host。
 * - host 关闭：delegate 用插件自带专用 Host；team 用插件内嵌 Host，并告警。
 * 默认（两者都未启用）零输出。
 */

import type { VesselConfig } from '../packages/config/src/index';

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

export function planFactoryPlugins(config: VesselConfig, hasHost: boolean): FactoryPluginPlan {
  const warnings: string[] = [];

  let delegate: FactoryPluginDecision | null = null;
  if (config.delegate?.enabled !== false) {
    const wantsHost = config.delegate?.viaHost === true;
    if (wantsHost && !hasHost) {
      warnings.push(
        'delegate.viaHost is ignored because host.enabled is false; delegate_task uses its dedicated in-process host.',
      );
    }
    delegate = { enabled: true, useHost: wantsHost && hasHost };
  }

  let team: FactoryPluginDecision | null = null;
  if (config.team?.enabled === true) {
    if (!hasHost) {
      warnings.push(
        'team.enabled with host.enabled=false: team uses its embedded in-process host.',
      );
    }
    team = { enabled: true, useHost: hasHost };
  }

  return { delegate, team, warnings };
}
