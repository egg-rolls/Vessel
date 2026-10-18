/**
 * gateway 0.4 控制面注入（A2）。
 *
 * web 的 `GatewayOptions` 尚未在 asm 分支合入，本模块产出冻结形状的
 * 附加字段，由 cli 用 Object.assign 注入；合并后可直接写进类型。
 */

import type { VesselConfig } from '../packages/config/src/index';
import type {
  FeishuChannelLike,
  MetricsControlLike,
  WorkflowEngineLike,
} from './control-plane-types';
import { latestEvalReport } from './eval-wiring';
import { resolveWorkflowDefPathSync } from './path-resolution';
import { PluginLoader } from './plugin-loader';

export interface GatewayControlPlaneOptions {
  config: VesselConfig;
  metrics?: MetricsControlLike;
  workflows?: WorkflowEngineLike;
  feishu?: FeishuChannelLike;
  /** 默认取 config.evals.enabled */
  evalsEnabled?: boolean;
  /** 测试注入口 */
  loader?: PluginLoader;
}

/** 只包含实际启用的控制面；未启用时不出现在对象里 */
export function buildGatewayControlPlane(
  options: GatewayControlPlaneOptions,
): Record<string, unknown> {
  const controlPlane: Record<string, unknown> = {};

  if (options.metrics) {
    const metrics = options.metrics;
    controlPlane.metrics = { snapshot: () => metrics.snapshot() };
  }

  if (options.workflows) {
    controlPlane.workflows = {
      controls: options.workflows,
      resolveDefinition: (name: string) => resolveWorkflowDefPathSync(options.config, name),
    };
  }

  if (options.feishu) {
    const feishu = options.feishu;
    controlPlane.feishu = { status: () => feishu.status() };
  }

  const evalsEnabled = options.evalsEnabled ?? options.config.evals?.enabled === true;
  if (evalsEnabled) {
    const loader = options.loader ?? new PluginLoader();
    controlPlane.evals = {
      latest: (suite: string) => latestEvalReport({ config: options.config, loader }, suite),
    };
  }

  return controlPlane;
}
