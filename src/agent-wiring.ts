/**
 * canonical `agent` 工具的装配决策（0.17 A4）。
 *
 * 纯函数：只看 `config.agent`；headless / 交互只影响成员权限模式缺省。
 *
 * @module vessel/agent-wiring
 */

import type {
  AgentVisibility,
  TerminationConfig,
  UsageLimitsConfig,
  VesselConfig,
} from '../packages/config/src/index';

export type MemberPermissionMode = 'bridge' | 'allow' | 'deny';

export interface AgentWiringInput {
  /** headless / `--run` 入口为 true；交互 REPL / serve 为 false */
  headless: boolean;
}

export interface AgentWiringPlan {
  /** 缺省注册 `agent` 工具并启动 AgentService；显式 `agent.enabled: false` 才关闭 */
  agentEnabled: boolean;
  defaultVisibility: AgentVisibility;
  followReplies: boolean;
  permissionMode: MemberPermissionMode;
  model?: string;
  limits?: UsageLimitsConfig;
  termination?: TerminationConfig;
  readOnlyTools?: string[];
}

/** 成员权限模式：显式配置优先；否则交互 bridge、headless allow。 */
export function resolveAgentWiring(config: VesselConfig, input: AgentWiringInput): AgentWiringPlan {
  const agent = config.agent;
  return {
    agentEnabled: agent?.enabled !== false,
    defaultVisibility: agent?.defaultVisibility ?? 'private',
    followReplies: agent?.followReplies === true,
    permissionMode: agent?.permissionMode ?? (input.headless ? 'allow' : 'bridge'),
    ...(agent?.model !== undefined ? { model: agent.model } : {}),
    ...(agent?.limits !== undefined ? { limits: agent.limits } : {}),
    ...(agent?.termination !== undefined ? { termination: agent.termination } : {}),
    ...(agent?.readOnlyTools !== undefined ? { readOnlyTools: agent.readOnlyTools } : {}),
  };
}
