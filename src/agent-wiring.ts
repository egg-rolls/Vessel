/**
 * canonical `agent` 工具的装配决策（0.16 Phase A）。
 *
 * 纯函数，便于测试：
 * - 交互入口（REPL / serve）默认注册 `agent`，headless 默认关闭；
 * - `agent` 可用时不再注册 `delegate_task`（配置里的旧名映射为 `agent`）；
 * - `team_*` 只受 `team.legacyTools` 控制，默认保留一个版本。
 *
 * @module vessel/agent-wiring
 */

import type { AgentVisibility, DelegateConfig, VesselConfig } from '../packages/config/src/index';

/** 旧工具名 → canonical 工具名（保留一个版本） */
const DELEGATE_TOOL_ALIAS = 'delegate_task';
const AGENT_TOOL_NAME = 'agent';

export type MemberPermissionMode = 'bridge' | 'allow' | 'deny';

export interface AgentWiringInput {
  /** headless / `--run` 入口为 true；交互 REPL / serve 为 false */
  headless: boolean;
}

export interface AgentWiringPlan {
  /** 注册 canonical `agent` 工具 */
  agentEnabled: boolean;
  /** 需要构造 team 引擎（agent 工具依赖成员注册表；或旧 team.enabled） */
  teamEngine: boolean;
  /** 注册 `team_*` 旧工具（默认 true） */
  legacyTools: boolean;
  /** 注册 `delegate_task`（agent 可用时为 false） */
  delegateEnabled: boolean;
  defaultVisibility: AgentVisibility;
  followReplies: boolean;
  permissionMode: MemberPermissionMode;
  /** 传给成员的工具黑名单（旧 `delegate_task` 名已映射） */
  disallowed: string[];
}

/**
 * 把旧 `delegate_task` 名称映射到 `agent`。
 * 只在 canonical `agent` 可用时映射；否则保留原名，避免 legacy 行为被改掉。
 */
export function mapDelegateToolAlias(names: string[], agentEnabled: boolean): string[] {
  const mapped = agentEnabled
    ? names.map((name) => (name === DELEGATE_TOOL_ALIAS ? AGENT_TOOL_NAME : name))
    : names;
  return [...new Set(mapped)];
}

/** 成员权限模式：显式配置优先；否则交互 bridge、headless allow。 */
function resolveMemberPermissionMode(
  delegate: DelegateConfig | undefined,
  headless: boolean,
): MemberPermissionMode {
  return delegate?.permissionMode ?? (headless ? 'allow' : 'bridge');
}

/** 解析 `agent` / `team` / `delegate` 的装配决策。 */
export function resolveAgentWiring(config: VesselConfig, input: AgentWiringInput): AgentWiringPlan {
  const agentEnabled = config.agent?.enabled ?? !input.headless;
  return {
    agentEnabled,
    teamEngine: agentEnabled || config.team?.enabled === true,
    legacyTools: config.team?.legacyTools !== false,
    delegateEnabled: config.delegate?.enabled !== false && !agentEnabled,
    defaultVisibility: config.agent?.defaultVisibility ?? 'private',
    followReplies: config.agent?.followReplies === true,
    permissionMode: resolveMemberPermissionMode(config.delegate, input.headless),
    disallowed: mapDelegateToolAlias(config.delegate?.disallowed ?? [], agentEnabled),
  };
}

/** 传给 ext team 插件的 0.16 选项（与 TeamPluginOptions 同名同义）。 */
export interface AgentTeamPluginOptions {
  /** 注册 `team_*` 旧工具 */
  legacyTools: boolean;
  defaultVisibility: AgentVisibility;
  permissionMode: MemberPermissionMode;
  /** deny 模式保留的只读工具 */
  readOnlyTools?: string[];
}

export function toAgentTeamPluginOptions(
  config: VesselConfig,
  plan: AgentWiringPlan,
): AgentTeamPluginOptions {
  return {
    legacyTools: plan.legacyTools,
    defaultVisibility: plan.defaultVisibility,
    permissionMode: plan.permissionMode,
    ...(config.delegate?.readOnlyTools !== undefined
      ? { readOnlyTools: config.delegate.readOnlyTools }
      : {}),
  };
}
