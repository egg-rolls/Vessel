/**
 * 装配层声明式 feature 接口（ADR-107，设计稿 §3.3）。
 *
 * 边界（ADR-107 决策 6，红线）：
 * - 只收编**宿主原生 harness 接线面**（GatewayOptions RPC deps / hotApply /
 *   result 透传 / shutdown 步）——宿主收集自己的贡献点，不是扩展机制。
 * - 能力注册（tool/provider/guardrail/hook）一律仍经 `Plugin.install(host)`；
 *   AssemblyFeature 只编排 install 的时机（phase 闸），不新增注册 API。
 * - 插件永不进 feature 清单（loader/manifest/install 单一路径不变）。
 * - 本模块住装配层（src/assembly），core 不感知 feature/收集器。
 *
 * deps 值必须惰性（ADR-107 决策 4）：handler 一律闭包读 ctx.liveConfig /
 * LateRef / 可变对象原地改，禁止 register 时定格活值。opts 对象仍一次构造
 * （serve 接口不变），惰性在 handler 内部。
 */

import type { EngineClient } from '@vessel-agent/engine-client';
import type { VesselConfig } from '../../packages/config/src/index';
import type { Logger, Runtime, TenantPaths } from '../../packages/core/src/index';
import type {
  AgentControlLike,
  GatewayRestartInput,
  GatewayRestartResult,
  LocalRpcOptions,
  PluginHostManager,
} from '../../packages/serve/src/index';
import type { GatewayReloadApplier } from '../gateway/gateway-reload-wiring';
import type { BootstrapResult } from '../runtime/bootstrap-types';
import type { RuntimeNoticeBus } from '../runtime/runtime-notice';
import type { TenantRuntimeBundle } from '../runtime/tenant-runtime-factory';

/**
 * 晚绑定端口（{ current } 活引用，装配序后段回填；与 vessel-meta /
 * toolsEngine.bridgeDeny / liveConfigRef 同口径）。handler 每次调用读
 * `.current`，装配前为 undefined 时按各 feature 既有语义报错/缺省。
 */
export interface LateRef<T> {
  current: T | undefined;
}

/**
 * 装配上下文：register 唯一入参。启动快照 + 活引用 + 晚绑定端口。
 * 脊柱（config 加载/engine/bundle 构造/startOwner 先后）不在这里——
 * 那些顺序承重代码留主干显式书写（ADR-107 决策 7）。
 */
export interface AssemblyContext {
  /** 启动快照（构造期常量；活配置请读 liveConfig） */
  config: VesselConfig;
  /** 活引用（= bootstrap liveConfigRef；cli 热应用同步写 .current） */
  liveConfig: { current: VesselConfig };
  /** tenant 共享 bundle（pluginHost/plugins/pluginLoader/pluginSurfaces/…） */
  bundle: TenantRuntimeBundle;
  tenantPaths: TenantPaths;
  dataDir: string;
  tenantId: string;
  nodeId: string;
  nodeName: string;
  logger: Logger;
  engineClient: EngineClient;
  executionRuntime: Runtime;
  // ── 晚绑定端口（装配序后段回填）──
  /** startOwner / agent 装配之后才有 */
  agent: LateRef<AgentControlLike>;
  notice: LateRef<RuntimeNoticeBus>;
  pluginManager: LateRef<PluginHostManager>;
  /** gateway.restart 预约面（node-restart 工厂；惰性包装跨 TDZ 的接口化） */
  gatewayRestart: LateRef<(input: GatewayRestartInput) => Promise<GatewayRestartResult>>;
}

/**
 * 热应用贡献，两形态（实证：cli 第二集中注册区有两种接线形状）：
 * - `scope`：进 createGatewayReloadRunner 的 `appliers` record
 *   （`gateway.reload` 的 scope → applier，如 log/mcp）。
 * - `config`：进 runner 的 config 子应用器选项（applyKanban/applyFederation/
 *   applyAutoPrune，gateway-reload-wiring.ts；config scope 内部按块触发，
 *   不新增 reload scope）。
 * 两形态各自键冲突 = 装配错误 fail-closed（点名双方）。
 */
export type FeatureHotApply =
  | { scope: string; applier: GatewayReloadApplier }
  | {
      config: 'applyKanban' | 'applyFederation' | 'applyAutoPrune';
      apply: (next: VesselConfig) => Promise<string[]> | string[];
    };

/**
 * 有序退出步（类型占位：P2 四 feature 均无 shutdown 贡献；退出序列的依赖序
 * 是脊柱，留主干显式书写——收集器只按 requires 序收集，消费点后续批另议）。
 */
export interface AssemblyShutdownStep {
  id: string;
  run: () => Promise<void> | void;
}

/**
 * 一个 feature 的收集结果。四面：
 * - dispatcher：RPC deps（两表面共消费同一份；键冲突 fail-closed）。
 *   类型取 Partial<LocalRpcOptions>（= GatewayOptions 去网络字段）——
 *   feature 不得贡献 port/hostname/tls 等网络面字段，比草案
 *   Partial<GatewayOptions> 收紧一格，两表面（cli GatewayOptions /
 *   bootstrap LocalRpcOptions）都能安全展开。
 * - hotApply：见 FeatureHotApply。
 * - result：BootstrapResult 透传字段（kanbanDeps 等，消灭 return 三件套手加）。
 * - shutdown / dispose：有序退出步 / 释放钩子（P2 未消费）。
 */
export interface FeatureRegistration {
  dispatcher?: Partial<LocalRpcOptions>;
  hotApply?: FeatureHotApply;
  result?: Partial<BootstrapResult>;
  shutdown?: AssemblyShutdownStep;
  dispose?(): void | Promise<void>;
}

/**
 * 宿主原生 feature 的静态装配声明（编译期清单，非运行期扩展）：
 * 无清单文件、无发现、无信任模型、无安装生命周期（ADR-107 决策 6）。
 *
 * phase 硬闸（ADR-107 决策 3，保 ADR-003/004 spawn 快照不变式）：
 * `host`（早于 startOwner，注册目标 tenant 共享 bundle.pluginHost）→
 * startOwner → `dispatcher`（晚于 agent 装配，贡献 RPC deps）→ `surface`。
 * phase 内按 requires 拓扑排序，环 = fail-closed。不做运行期 DI 容器。
 */
export interface AssemblyFeature {
  /** 'kanban' | 'jobs' | 'restart' | 'attachments' | …（清单按 id 字典序） */
  id: string;
  /** 依赖 feature id（拓扑排序；跨 phase 依赖须指向更早 phase） */
  requires?: string[];
  phase: 'host' | 'dispatcher' | 'surface';
  register(ctx: AssemblyContext): FeatureRegistration;
}
