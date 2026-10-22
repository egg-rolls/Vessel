/**
 * gateway 0.4 控制面注入（A2）。
 *
 * web 的 `GatewayOptions` 尚未在 asm 分支合入，本模块产出冻结形状的
 * 附加字段，由 cli 用 Object.assign 注入；合并后可直接写进类型。
 */

import type { VesselConfig } from '../packages/config/src/index';
import type { FeishuChannelLike, MetricsControlLike } from './control-plane-types';
import { latestEvalReport } from './eval-wiring';
import { PluginLoader } from './plugin-loader';

/** gateway `feishu` 注入面（与 packages/serve FeishuGatewayOptions 结构一致） */
export interface FeishuControlPlaneLike {
  status(): ReturnType<FeishuChannelLike['status']>;
}

export interface GatewayControlPlaneOptions {
  config: VesselConfig;
  metrics?: MetricsControlLike;
  feishu?: FeishuChannelLike;
  /**
   * 0.5.4 P2-1：按请求 tenant 解析控制面。
   * 仅返回已构造 bundle 的 tenant；未配置 / 未启用时返回 undefined。
   */
  feishuFor?: (tenantId: string) => FeishuControlPlaneLike | undefined;
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
    // web 的 MetricsProvider 是函数，不是 { snapshot } 对象。
    controlPlane.metrics = () => metrics.snapshot();
  }

  if (options.feishu) {
    const feishu = options.feishu;
    controlPlane.feishu = { status: () => feishu.status() };
  }

  if (options.feishuFor) controlPlane.feishuFor = options.feishuFor;

  const evalsEnabled = options.evalsEnabled ?? options.config.evals?.enabled === true;
  if (evalsEnabled) {
    const loader = options.loader ?? new PluginLoader();
    controlPlane.evals = {
      latest: (suite: string) => latestEvalReport({ config: options.config, loader }, suite),
    };
  }

  return controlPlane;
}
