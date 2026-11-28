/**
 * 装配层收集器（ADR-107 决策 1/3/5）：收集 feature register 结果，合并成
 * **一份** deps，两表面（cli 网络面 / bootstrap 本地面）共消费同一份收集
 * 结果——「忘接一路」（R-1/R-6）结构上不可能。
 *
 * - phase 硬闸：调用点留主干显式（host → startOwner → dispatcher → surface，
 *   脊柱不进收集器）；本函数只处理指定 phase 的 feature。
 * - phase 内按 requires 拓扑排序（清单序稳定）；环 = fail-closed 点名环路径。
 * - 键冲突 fail-closed：dispatcher 键 / hotApply scope / config 子应用器名 /
 *   result 键，两 feature 贡献同一名 → 启动报错点名双方（与插件 http 路由
 *   冲突同口径）。
 * - 不做运行期 DI 容器：装配是一次性同步过程，register 只跑一次。
 */

import type { LocalRpcOptions } from '../../packages/serve/src/index';
import type {
  GatewayReloadApplier,
  GatewayReloadWiringOptions,
} from '../gateway/gateway-reload-wiring';
import type { BootstrapResult } from '../runtime/bootstrap-types';
import type {
  AssemblyContext,
  AssemblyFeature,
  AssemblyShutdownStep,
  FeatureRegistration,
} from './feature';

/** config scope 子应用器名（与 GatewayReloadWiringOptions 签名同源） */
type ConfigApplierName = 'applyKanban' | 'applyFederation' | 'applyAutoPrune';

/** 一次 phase 收集的合并结果（两表面共消费） */
export interface CollectedFeatures {
  /** 合并后的 RPC deps（键冲突已 fail-closed；值惰性由 feature 保证） */
  dispatcher: Partial<LocalRpcOptions>;
  /** 热应用面：scope appliers（进 reloadAppliers record）+ config 子应用器（进 runner opts） */
  hotApply: {
    appliers: Record<string, GatewayReloadApplier>;
    config: Partial<Pick<GatewayReloadWiringOptions, ConfigApplierName>>;
  };
  /** BootstrapResult 透传字段（kanbanDeps 等） */
  result: Partial<BootstrapResult>;
  /** 有序退出步（requires 拓扑序；P2 无消费点，见 feature.ts 注释） */
  shutdown: AssemblyShutdownStep[];
  /** dispose 钩子（拓扑序；P2 无消费点） */
  dispose: Array<() => void | Promise<void>>;
}

const PHASE_ORDER: Record<AssemblyFeature['phase'], number> = {
  host: 0,
  dispatcher: 1,
  surface: 2,
};

function fail(message: string): never {
  throw new Error(`assembly collector: ${message} (ADR-107 fail-closed)`);
}

/**
 * phase 内 requires 拓扑排序（DFS，清单序稳定）。
 * 环 / 未知依赖 / 依赖更晚 phase = fail-closed。
 */
function topoSort(phaseFeatures: AssemblyFeature[], all: AssemblyFeature[]): AssemblyFeature[] {
  const byId = new Map(all.map((f) => [f.id, f]));
  const state = new Map<string, 'visiting' | 'done'>();
  const out: AssemblyFeature[] = [];
  const stack: string[] = [];
  const visit = (f: AssemblyFeature): void => {
    const s = state.get(f.id);
    if (s === 'done') return;
    if (s === 'visiting') {
      fail(`requires cycle: ${[...stack.slice(stack.indexOf(f.id)), f.id].join(' -> ')}`);
    }
    state.set(f.id, 'visiting');
    stack.push(f.id);
    for (const dep of f.requires ?? []) {
      const target = byId.get(dep);
      if (target === undefined) fail(`feature "${f.id}" requires unknown feature "${dep}"`);
      if (PHASE_ORDER[target.phase] > PHASE_ORDER[f.phase]) {
        fail(
          `feature "${f.id}" (phase ${f.phase}) requires later-phase feature "${dep}" (${target.phase})`,
        );
      }
      // 更早 phase 的依赖已由主干在更早调用点收集；同 phase 才参与本次排序。
      if (target.phase === f.phase) visit(target);
    }
    stack.pop();
    state.set(f.id, 'done');
    out.push(f);
  };
  for (const f of phaseFeatures) visit(f);
  return out;
}

/** 同名贡献查重：点名双方 feature id 与键名。 */
function claim(map: Map<string, string>, key: string, owner: string, face: string): void {
  const prev = map.get(key);
  if (prev !== undefined) {
    fail(`${face} "${key}" contributed by both "${prev}" and "${owner}"`);
  }
  map.set(key, owner);
}

/**
 * 收集指定 phase 的 feature：拓扑序 register → 合并（冲突 fail-closed）。
 * 主干在装配序的显式调用点调用（phase 硬闸）；同进程每 phase 只调一次。
 */
export function collectFeatures(
  features: readonly AssemblyFeature[],
  ctx: AssemblyContext,
  phase: AssemblyFeature['phase'],
): CollectedFeatures {
  const ids = new Set<string>();
  for (const f of features) {
    if (ids.has(f.id)) fail(`duplicate feature id "${f.id}" in manifest`);
    ids.add(f.id);
  }
  const ordered = topoSort(
    features.filter((f) => f.phase === phase),
    [...features],
  );

  const collected: CollectedFeatures = {
    dispatcher: {},
    hotApply: { appliers: {}, config: {} },
    result: {},
    shutdown: [],
    dispose: [],
  };
  const dispatcherOwners = new Map<string, string>();
  const scopeOwners = new Map<string, string>();
  const configOwners = new Map<string, string>();
  const resultOwners = new Map<string, string>();

  for (const f of ordered) {
    const reg: FeatureRegistration = f.register(ctx);
    if (reg.dispatcher !== undefined) {
      for (const [key, value] of Object.entries(reg.dispatcher)) {
        claim(dispatcherOwners, key, f.id, 'dispatcher key');
        (collected.dispatcher as Record<string, unknown>)[key] = value;
      }
    }
    if (reg.hotApply !== undefined) {
      if ('scope' in reg.hotApply) {
        claim(scopeOwners, reg.hotApply.scope, f.id, 'hotApply scope');
        collected.hotApply.appliers[reg.hotApply.scope] = reg.hotApply.applier;
      } else {
        claim(configOwners, reg.hotApply.config, f.id, 'hotApply config applier');
        collected.hotApply.config[reg.hotApply.config] = reg.hotApply.apply;
      }
    }
    if (reg.result !== undefined) {
      for (const [key, value] of Object.entries(reg.result)) {
        claim(resultOwners, key, f.id, 'result key');
        (collected.result as Record<string, unknown>)[key] = value;
      }
    }
    if (reg.shutdown !== undefined) collected.shutdown.push(reg.shutdown);
    if (reg.dispose !== undefined) collected.dispose.push(() => reg.dispose?.());
  }
  return collected;
}
