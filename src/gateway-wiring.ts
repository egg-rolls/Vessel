/**
 * gateway 0.4 控制面注入（A2）。
 *
 * web 的 `GatewayOptions` 尚未在 asm 分支合入，本模块产出冻结形状的
 * 附加字段，由 cli 用 Object.assign 注入；合并后可直接写进类型。
 */

import type { VesselConfig } from '../packages/config/src/index';
import type {
  HubControlLike,
  HubTeamScopeLike,
  NodeTokenControlLike,
} from '../packages/serve/src/index';
import type {
  FeishuChannelLike,
  MetricsControlLike,
  WorkflowEngineLike,
} from './control-plane-types';
import { latestEvalReport } from './eval-wiring';
import { resolveWorkflowDefPathSync } from './path-resolution';
import { PluginLoader } from './plugin-loader';

/** gateway `workflows` 注入面（与 packages/serve WorkflowGatewayOptions 结构一致） */
export interface WorkflowControlPlaneLike {
  listRuns: WorkflowEngineLike['listRuns'];
  getRun: WorkflowEngineLike['getRun'];
  start: WorkflowEngineLike['start'];
  resume: WorkflowEngineLike['resume'];
  cancel: WorkflowEngineLike['cancel'];
  resolveDefinition(name: string): string | undefined;
}

/** gateway `feishu` 注入面（与 packages/serve FeishuGatewayOptions 结构一致） */
export interface FeishuControlPlaneLike {
  status(): ReturnType<FeishuChannelLike['status']>;
}

export interface GatewayControlPlaneOptions {
  config: VesselConfig;
  metrics?: MetricsControlLike;
  workflows?: WorkflowEngineLike;
  feishu?: FeishuChannelLike;
  /**
   * 0.5.4 P2-1：按请求 tenant 解析控制面。
   * 仅返回已构造 bundle 的 tenant；未配置 / 未启用时返回 undefined。
   */
  workflowsFor?: (tenantId: string) => WorkflowControlPlaneLike | undefined;
  feishuFor?: (tenantId: string) => FeishuControlPlaneLike | undefined;
  /** 默认取 config.evals.enabled */
  evalsEnabled?: boolean;
  /** 测试注入口 */
  loader?: PluginLoader;
  /** S5：hub 目录投影（gateway `hubControl` 选项）。 */
  hubControl?: HubControlLike;
  /** S5：节点动态 token 认证面（gateway `nodeTokens` 选项）。 */
  nodeTokens?: NodeTokenControlLike;
  /** S5：session → team 归属（gateway `hubTeamScope` 选项）。 */
  teamScope?: HubTeamScopeLike;
}

/**
 * 把单个 tenant 的 workflow 引擎适配成 gateway 冻结形状。
 * `resolveDefinition` 绑定该 tenant 的 config（name 解析落在该 tenant 的 workflow.dir）。
 */
export function buildWorkflowControlPlane(
  workflows: WorkflowEngineLike,
  config: VesselConfig,
): WorkflowControlPlaneLike {
  return {
    listRuns: (opts?: Parameters<typeof workflows.listRuns>[0]) => workflows.listRuns(opts),
    getRun: (id: string) => workflows.getRun(id),
    start: (definitionPath: string, opts?: Parameters<typeof workflows.start>[1]) =>
      workflows.start(definitionPath, opts),
    resume: (id: string) => workflows.resume(id),
    cancel: (id: string) => workflows.cancel(id),
    resolveDefinition: (name: string) => resolveWorkflowDefPathSync(config, name),
  };
}

/** 只包含实际启用的控制面；未启用时不出现在对象里 */
export function buildGatewayControlPlane(
  options: GatewayControlPlaneOptions,
): Record<string, unknown> {
  const controlPlane: Record<string, unknown> = {};

  if (options.metrics) {
    const metrics = options.metrics;
    // web 的 MetricsProvider 是函数，不是 { snapshot } 对象。
    controlPlane.metrics = () => metrics.snapshot();
  }

  if (options.workflows) {
    // web 的 WorkflowGatewayOptions extends WorkflowControlsLike（直接带方法）。
    controlPlane.workflows = buildWorkflowControlPlane(options.workflows, options.config);
  }

  if (options.feishu) {
    const feishu = options.feishu;
    controlPlane.feishu = { status: () => feishu.status() };
  }

  // 0.5.4 P2-1：per-tenant 控制面；旧 `workflows` / `feishu` 保持 default 行为不变。
  if (options.workflowsFor) controlPlane.workflowsFor = options.workflowsFor;
  if (options.feishuFor) controlPlane.feishuFor = options.feishuFor;

  // S5：未提供时不出现在返回对象里（与 metrics / workflows 一致）。
  if (options.hubControl) controlPlane.hubControl = options.hubControl;
  if (options.nodeTokens) controlPlane.nodeTokens = options.nodeTokens;
  if (options.teamScope) controlPlane.hubTeamScope = options.teamScope;

  const evalsEnabled = options.evalsEnabled ?? options.config.evals?.enabled === true;
  if (evalsEnabled) {
    const loader = options.loader ?? new PluginLoader();
    controlPlane.evals = {
      latest: (suite: string) => latestEvalReport({ config: options.config, loader }, suite),
    };
  }

  return controlPlane;
}
