/**
 * Team / transport 接线决策（A4）。
 *
 * 纯函数：给定配置与运行环境（是否 --serve、是否有 Host），决定
 * 是否给 gateway 接 team、是否构造 loopback，以及需要哪些告警。
 * 默认路径（team 关闭）必须零输出。
 */

import type { VesselConfig } from '../packages/config/src/index';

export interface TeamWiringInput {
  config: VesselConfig;
  hasGateway: boolean;
  hasHost: boolean;
}

export interface TeamWiringPlan {
  /** 是否调用 gateway.attachTeam */
  attachToGateway: boolean;
  /** 是否构造 loopback transport */
  useLoopback: boolean;
  warnings: string[];
}

export function planTeamWiring(input: TeamWiringInput): TeamWiringPlan {
  const teamEnabled = input.config.team?.enabled === true;
  const wantsLoopback = input.config.transport?.kind === 'loopback';
  const warnings: string[] = [];

  if (!teamEnabled) {
    if (input.hasGateway && wantsLoopback) {
      warnings.push('transport.kind=loopback is ignored because team.enabled is false.');
    }
    return { attachToGateway: false, useLoopback: false, warnings };
  }

  if (!input.hasGateway) {
    if (wantsLoopback) {
      warnings.push(
        'transport.kind=loopback requires --serve; team falls back to in-process transport.',
      );
    }
    return { attachToGateway: false, useLoopback: false, warnings };
  }

  if (!input.hasHost) {
    warnings.push(
      'team.enabled with host.enabled=false: gateway /v1/team/* needs a Host; team tools use an internal in-process host.',
    );
    return { attachToGateway: false, useLoopback: false, warnings };
  }

  return { attachToGateway: true, useLoopback: wantsLoopback, warnings };
}
