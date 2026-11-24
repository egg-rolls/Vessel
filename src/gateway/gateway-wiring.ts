/**
 * gateway 0.4 控制面注入（A2）。
 *
 * web 的 `GatewayOptions` 尚未在 asm 分支合入，本模块产出冻结形状的
 * 附加字段，由 cli 用 Object.assign 注入；合并后可直接写进类型。
 */

import type { Logger } from '@vessel-agent/core';
import type { VesselConfig } from '../../packages/config/src/index';
import type {
  AgentControlLike,
  FederationGatewayOptions,
  TeamControlLike,
} from '../../packages/serve/src/index';
import type { FeishuChannelLike, MetricsControlLike } from '../cli/control-plane-types';
import { resolveFederationOptions } from '../federation/federation-config';
import { latestEvalReport } from '../plugin/eval-wiring';
import { PluginLoader } from '../plugin/plugin-loader';

export interface GatewayControlPlaneOptions {
  config: VesselConfig;
  metrics?: MetricsControlLike;
  feishu?: FeishuChannelLike;
  /**
   * 0.19 S3：canonical `teams.*` 注入面（结构化接口，serve 不依赖 agent）。
   * 未提供时方法仍在 manifest 中，handler 返回 not_found。
   */
  teams?: TeamControlLike;
  /**
   * 0.25：canonical agent 生命周期注入面（bootstrap 的 AgentService 适配器）。
   * 未提供时方法仍在 manifest 中，handler 返回 not_found。
   */
  agentControl?: AgentControlLike;
  /** 默认取 config.evals.enabled（缺省开启） */
  evalsEnabled?: boolean;
  /** 测试注入口 */
  loader?: PluginLoader;
  /**
   * S7：节点身份（`resolveNodeId()` 的结果）。
   * 本字段存在即注入 federation 运行时对象（enabled:false 时入站仍 404，
   * 但对象必须在场，热应用才能原地启用）。
   */
  nodeId?: string;
  /** 丢弃 federation peer（缺 token / 自指 / token 重复）时记录原因。 */
  logger?: Logger;
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

  // 0.19 S3：只透传 canonical `teams.*` 的 TeamControlLike。
  if (options.teams) controlPlane.teams = options.teams;
  // 0.25：canonical `agents.create|update|close`（生产装配始终存在，除 agent 关闭）。
  if (options.agentControl) controlPlane.agent = options.agentControl;

  // S7：缺省开启；显式 `federation.enabled: false` 时入站路由仍 404（serve 逐请求
  // 读 enabled）。这里**始终注入**已解析对象（只要有 nodeId）：热应用要原地改同一
  // 个对象，启动时不注入会让 enabled:false → true 永远无法热生效。缺 token 的 peer
  // 由 resolver 丢弃（fail closed）；这里不打印 token / env，也不因缺失 token 报错。
  if (options.nodeId !== undefined) {
    const resolved = resolveFederationOptions({
      federation: options.config.federation,
      nodeId: options.nodeId,
    });
    for (const issue of resolved.issues) {
      options.logger?.warn('federation.peer.skipped', {
        peer: issue.peer,
        reason: issue.reason,
      });
    }
    const federation: FederationGatewayOptions = resolved.options;
    controlPlane.federation = federation;
  }

  const evalsEnabled = options.evalsEnabled ?? options.config.evals?.enabled !== false;
  if (evalsEnabled) {
    const loader = options.loader ?? new PluginLoader();
    controlPlane.evals = {
      latest: (suite: string) => latestEvalReport({ config: options.config, loader }, suite),
    };
  }

  return controlPlane;
}
