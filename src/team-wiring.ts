/**
 * Team / transport 接线决策（A4；0.6 增加 remote）。
 *
 * 纯函数：给定配置与运行环境（是否 --serve、是否有 Host），决定
 * 是否给 gateway 接 team、构造哪种 transport，以及需要哪些告警。
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
  /** 是否构造 remote transport（kind=remote） */
  useRemote: boolean;
  warnings: string[];
}

export function planTeamWiring(input: TeamWiringInput): TeamWiringPlan {
  const teamEnabled = input.config.team?.enabled === true;
  const kind = input.config.transport?.kind;
  const wantsLoopback = kind === 'loopback';
  const wantsRemote = kind === 'remote';
  const warnings: string[] = [];

  if (!teamEnabled) {
    if (input.hasGateway && (wantsLoopback || wantsRemote)) {
      warnings.push(`transport.kind=${kind} is ignored because team.enabled is false.`);
    }
    return { attachToGateway: false, useLoopback: false, useRemote: false, warnings };
  }

  if (!input.hasGateway) {
    if (wantsLoopback) {
      warnings.push(
        'transport.kind=loopback requires --serve; team falls back to in-process transport.',
      );
    }
    if (wantsRemote) {
      warnings.push(
        'transport.kind=remote requires --serve; team falls back to in-process transport.',
      );
    }
    return { attachToGateway: false, useLoopback: false, useRemote: false, warnings };
  }

  if (!input.hasHost) {
    warnings.push(
      'team.enabled with host.enabled=false: gateway /v1/team/* needs a Host; team tools use an internal in-process host.',
    );
    return { attachToGateway: false, useLoopback: false, useRemote: false, warnings };
  }

  return {
    attachToGateway: true,
    useLoopback: wantsLoopback,
    useRemote: wantsRemote,
    warnings,
  };
}
