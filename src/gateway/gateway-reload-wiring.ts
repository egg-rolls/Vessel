/**
 * `gateway.reload` 的 asm 侧实现（0.12 DECISION-023 §2.3；CONTRACT-hot-apply §1/§4）。
 *
 * serve 只暴露 RPC 形状与 scope 枚举；这里维护 `scope -> applier` 映射，决定哪些东西
 * 真的能热应用：
 * - `plugins`：清空插件扫描缓存（下次 `list()` 重新扫描；已安装插件与 active run 不受影响）；
 * - `config`：重新 `loadConfig()`；`node.allowed_origins` 通过 web 的
 *   `gateway.reconfigure({ allowedOrigins })` 生效；`provider.*` / `models.*` 经注入的
 *   `applyProviderModel` 热应用（P0-1 D4 → P1-w2d 泛化，D5）——重建 registry 快照 +
 *   清 provider 缓存 + 替换**节点缺省模型**（owner profile + 成员宿主缺省）：新 body /
 *   新 EU 立即用新值，live body / EU 的 model 是构造期只读快照（前缀不变量），本具仍旧
 *   值、下一具才生效；凭证轮换经 delegating wrapper 下一请求生效。未注入 applier 或
 *   新配置解析不出有效缺省模型时，变化域进 `requires_restart`，不假装生效。
 *   `config.agent.model` 仍属 `agent` 域，需重启；`federation` 块经注入的
 *   `applyFederation` 热应用（原地更新入站 / 出站 peer，未注入则进 `requires_restart`）；
 *   `kanban` 块经注入的 `applyKanban` 热应用（q-kanban-proxy：重解析 boardPath
 *   原地更新 kanban deps，未注入则进 `requires_restart`）；
 *   `autoPrune` 块经注入的 `applyAutoPrune` 热应用（auto-gc P1：调度器读 live
 *   resolver，applier 喂活配置引用 + reschedule 立即重排，未注入则进 `requires_restart`）；
 *   其余字段一律进 `requires_restart`；
 * - `permission` / `tools` / `mcp`：由 `src/cli.ts` 注入 applier（见下）。
 *
 * ## applier 注册面
 *
 * `appliers` 是 `scope -> () => Promise<string[]>` 的注入表：
 * - 每个 applier 返回**要广播的差异摘要行**（如 `permission: bash always ask`）；
 *   返回空数组表示「该 scope 执行了但无差异」；
 * - 只注册真实存在的 applier（例如没有 MCP server 时不注册 `mcp`），
 *   请求未注册的 scope → 抛 `unknown reload scope`（不静默忽略）；
 * - 单个 scope 的 applier 抛错不中断其余 scope：失败写进该 scope 的摘要
 *   （`<scope>: reload failed (...)`），由调用方广播，不新增失败字段。
 *
 * 这样 serve 的协议形状完全不变，新增 applier 只是往注入表里加一个键，且每个 applier
 * 都能脱离 CLI 单独测试。
 *
 * @module vessel/gateway-reload-wiring
 */

import {
  type DefaultModelIdentity,
  defaultModelRefOf,
  resolveModelRef,
  synthesizeLegacyRegistry,
  type VesselConfig,
} from '../../packages/config/src/index';
import type { GatewayReloadResult } from '../../packages/serve/src/index';

/** web gateway 的可选热重配置入口（尚未合入时缺省） */
export interface GatewayReconfigureTarget {
  reconfigure?(options: { allowedOrigins?: string[] }): void | Promise<void>;
}

/** 一个 scope 的 applier：返回差异摘要行（用于广播 / 调试）。 */
export type GatewayReloadApplier = () => Promise<string[]> | string[];

/** 注入面 */
export interface GatewayReloadWiringOptions {
  /** 当前 gateway（RPC 到达时已启动）；返回 null 表示无法热重配 */
  gateway: () => GatewayReconfigureTarget | null;
  /** 启动时的配置（内存值；含首启向导写入） */
  currentConfig: () => VesselConfig;
  /** 重新读取配置；失败必须抛错 */
  reloadConfig: () => Promise<VesselConfig>;
  /** 清空所有 tenant 的插件扫描缓存 */
  refreshPlugins: () => void;
  /**
   * `scope -> applier`。`config` / `plugins` 由本模块自己实现，不需要出现在这里；
   * 请求一个本表没有、也不是 `config` / `plugins` 的 scope → `unknown reload scope`。
   */
  appliers?: Readonly<Record<string, GatewayReloadApplier>>;
  /**
   * `provider.*` / `models.*` 热应用（P0-1 D4 批准的注入字段，P1-w2d 泛化；config scope
   * 内部，不新增 reload scope）。仅在 provider / models 块变化**且新配置能解析出非空
   * 有效缺省模型**时调用；`from` / `to` = 变化前后的有效缺省**身份**（第 6 修 SPAWN-03：
   * ref + wire 分离——ref 是宿主缺省 / spawn 继承 / 比较语义的键，wire 只作展示；
   * env 优先级冻结：VESSEL_MODEL 赢 models.default），`next` = 校验通过的重载配置
   * （装配层据此重建 registry 快照 + 清 provider 缓存）。返回要广播的差异摘要行
   * （并入 `summaries.config`）。生效点 = 节点缺省模型：新 body / 新 EU 用新值，
   * live body / EU 构造期只读、下一具才生效（前缀不变量）。未注入或解析不出有效缺省
   * ⇒ 变化域进 `requires_restart`（不猜 provider 缺省模型，不假装生效）。
   */
  applyProviderModel?: (
    from: DefaultModelIdentity | undefined,
    to: DefaultModelIdentity | undefined,
    next?: VesselConfig,
  ) => Promise<string[]> | string[];
  /**
   * 缺省身份预览（第 6 修 SPAWN-03）：装配层注入 registry.previewDefaultModel——
   * 按运行期同口径（legacyPresent 单向闸）解析给定配置的缺省身份。缺省时回落
   * 本模块只读保守口径（legacyPresent=true，与旧 effectiveDefaultModel 字节等价）。
   * 解析不出 / ModelRefError → undefined ⇒ 变化域进 requires_restart，
   * 不再把不可重解析的 wire 名热应用进宿主缺省（热应用重新污染）。
   */
  previewDefaultModel?: (config: VesselConfig) => DefaultModelIdentity | undefined;
  /**
   * S7 federation 热应用（config scope 内部，与 applyProviderModel 同形，不新增
   * reload scope）。仅在 federation 块变化时调用；`next` = 校验通过的重载配置，
   * 装配层据此重新解析 peer 并**原地**更新入站 / 出站运行时对象（下一请求生效）。
   * 返回要广播的差异摘要行（并入 `summaries.config`；绝不包含 token 值）。
   * 未注入 ⇒ 变化域进 `requires_restart`，不假装生效。
   */
  applyFederation?: (next: VesselConfig) => Promise<string[]> | string[];
  /**
   * q-kanban-proxy：kanban 热应用（config scope 内部，与 applyFederation 同形，
   * 不新增 reload scope）。仅在 kanban 块变化时调用；`next` = 校验通过的重载配置，
   * 装配层据此重解析 boardPath 并**原地**更新 kanban deps（handler 每次调用读
   * deps.boardPath，下一次 kanban.get 即用新板）。返回要广播的差异摘要行
   * （并入 summaries.config）。未注入 ⇒ 变化域进 requires_restart，不假装生效。
   */
  applyKanban?: (next: VesselConfig) => Promise<string[]> | string[];
  /**
   * auto-gc P1：autoPrune 热应用（config scope 内部，与 applyKanban 同形，不新增
   * reload scope）。调度器自启动起就读 live resolver 闭包（每趟求值最新配置：
   * enabled / interval / olderThan / dryRun 全部活生效，cadence 不冻结启动值）；
   * 本 applier 把重载配置喂给调度器持有的活配置引用 + 调 reschedule 立即重排挂起
   * 定时器（O4：热改即重排），并产差异摘要行。
   * 未注入（无本地调度器，如 connectMode）⇒ 变化域进 requires_restart，不假装生效。
   */
  applyAutoPrune?: (next: VesselConfig) => Promise<string[]> | string[];
}

/** 需要重启才能生效的配置域（DECISION-023 §2.3；`permission` 已可热应用）。 */
interface RestartField {
  name: string;
  read: (config: VesselConfig) => unknown;
}

// `provider.*` / `models.*` 不在这里：它们走 config scope 的 `applyProviderModel`
// 热应用分支（P0-1 D4 → P1-w2d 泛化，D5）；未注入 applier / 解析不出有效缺省模型时
// 由该分支补 push 变化域进 requires_restart。新增 provider 插件目录仍 restart
// （loader 启动扫描一次，plugins scope 的 in-process 指纹判定）。
const RESTART_FIELDS: readonly RestartField[] = [
  { name: 'agent', read: (config) => config.agent },
  // CONTRACT-hot-apply §1：permission 走 applier，不再进 requires_restart。
  { name: 'tls', read: (config) => config.node?.tls },
  {
    name: 'token',
    read: (config) => ({
      token: config.node?.token,
      tokenEnv: config.node?.tokenEnv,
      tokens: config.node?.tokens,
    }),
  },
  { name: 'port', read: (config) => config.node?.port },
];

/** 稳定序列化（对象键排序；undefined 也参与比较） */
export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** 比较两份配置，返回需要重启的字段名（顺序固定） */
export function diffRestartFields(current: VesselConfig, next: VesselConfig): string[] {
  return RESTART_FIELDS.filter(
    (field) => stableValue(field.read(current)) !== stableValue(field.read(next)),
  ).map((field) => field.name);
}

/**
 * q-error-e3（§3.8，D8）：inert 域 = 变化但**既无热 applier 又不在 RESTART_FIELDS**
 * 的顶层块（如 observability/ui/limits）。行为修复（补进 restart 清单或加热 applier）
 * 归 hardening；本期只报告。node 块按残差比较（tls/token/port/allowedOrigins 已有归属）。
 */
const COVERED_TOP_BLOCKS = new Set(['provider', 'models', 'federation', 'kanban', 'autoPrune', 'agent']);

function nodeResidual(config: VesselConfig): unknown {
  const node = config.node;
  if (node === undefined) return undefined;
  const { tls, token, tokenEnv, tokens, port, allowedOrigins, ...rest } = node;
  return rest;
}

export function diffInertFields(current: VesselConfig, next: VesselConfig): string[] {
  const left = current as unknown as Record<string, unknown>;
  const right = next as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const inert: string[] = [];
  for (const key of keys) {
    if (COVERED_TOP_BLOCKS.has(key)) continue;
    if (key === 'node') {
      if (stableValue(nodeResidual(current)) !== stableValue(nodeResidual(next))) {
        inert.push('node.*');
      }
      continue;
    }
    if (stableValue(left[key]) !== stableValue(right[key])) inert.push(key);
  }
  return inert;
}

/**
 * 判断 allowed_origins 是否变化。CORS 列表与顺序无关；缺省与空数组等价。
 */
export function allowedOriginsChanged(current: VesselConfig, next: VesselConfig): boolean {
  const normalize = (value: string[] | undefined): string[] => [...(value ?? [])].sort();
  const left = normalize(current.node?.allowedOrigins);
  const right = normalize(next.node?.allowedOrigins);
  return left.length !== right.length || left.some((origin, index) => origin !== right[index]);
}

/**
 * 有效缺省身份（env 优先级冻结 §2.6：VESSEL_MODEL 赢 models.default）：
 * 与 wiring.resolveModel(undefined) 同一 resolver 口径，只读解析、不构造 provider。
 * 保守回落口径（legacyPresent=true）：装配层注入 previewDefaultModel 时以运行期
 * 同口径预览为准（第 6 修 SPAWN-03）。ref 与 wire 分离：ref 供继承 / 比较，wire 供展示。
 */
function effectiveDefaultModel(config: VesselConfig): DefaultModelIdentity | undefined {
  const envModel = process.env.VESSEL_MODEL;
  const snapshot = synthesizeLegacyRegistry(config);
  const resolved = resolveModelRef(
    snapshot,
    envModel !== undefined && envModel !== '' ? envModel : undefined,
  );
  if (!resolved?.wireModel) return undefined;
  return { ref: defaultModelRefOf(resolved, true), wireModel: resolved.wireModel };
}

/** 缺省 scopes（`gateway.reload({})` 时跑）：与 serve 的 `RELOAD_SCOPES` 同序。 */
const DEFAULT_SCOPES = ['config', 'plugins'] as const;

/**
 * 一次 `gateway.reload` 的完整结果：serve 需要的 `{ reloaded, requires_restart }`
 * 加上每个 applier 产出的差异摘要（供 `runtime.notice` 广播）。
 */
export interface GatewayReloadOutcome extends GatewayReloadResult {
  /** scope → 该 scope 的差异摘要行（无差异时是空数组） */
  summaries: Record<string, string[]>;
}

export interface GatewayReloadRunner {
  /** serve `GatewayOptions.reload` 的形状（只返回契约字段） */
  reload(scopes: string[]): Promise<GatewayReloadResult>;
  /** 同上，但额外返回每个 scope 的差异摘要（装配层广播 notice 用） */
  reloadWithSummaries(scopes: string[]): Promise<GatewayReloadOutcome>;
  /** 当前已注册 applier 的 scope 名（配置监听据此过滤，避免请求不可用 scope） */
  registeredScopes(): string[];
}

/**
 * 构造 `GatewayOptions.reload` 及带摘要的变体。
 * @param options 注入面（gateway / 配置读取 / 插件刷新 / appliers）
 */
export function createGatewayReloadRunner(
  options: GatewayReloadWiringOptions,
): GatewayReloadRunner {
  const appliers = options.appliers ?? {};

  const reloadWithSummaries = async (scopes: string[]): Promise<GatewayReloadOutcome> => {
    const requested = scopes.length > 0 ? scopes : [...DEFAULT_SCOPES];
    const reloaded: string[] = [];
    const requiresRestart: string[] = [];
    const summaries: Record<string, string[]> = {};
    // q-error-e3（D8）：三域报告收集器；有字段变化即随响应附 field_report（lead 裁定）。
    const appliedReport: Array<{ field: string; reason: string }> = [];
    const restartReport: Array<{ field: string; reason: string }> = [];
    const inertReport: Array<{ field: string; reason: string }> = [];
    let sawFieldChange = false;

    for (const scope of requested) {
      // 未知 scope 是请求错误，不是执行失败：在隔离之外显式抛出（契约 §1：不静默忽略）。
      if (scope !== 'plugins' && scope !== 'config' && appliers[scope] === undefined) {
        throw new Error(`unknown reload scope: ${scope}`);
      }
      // 每个 scope 独立收口：单个 applier 失败不阻断后续 scope，失败写进该 scope
      // 的摘要（不新增 `failures` 字段），调用方仍能广播失败原因。
      try {
        if (scope === 'plugins') {
          // 只失效目录缓存；pluginHost / 已安装插件 / active run 不动。
          options.refreshPlugins();
          reloaded.push('plugins');
          summaries.plugins = [];
          appliedReport.push({
            field: 'plugins',
            reason: 'plugin scan cache invalidated; installed plugins and active runs untouched',
          });
          continue;
        }

        if (scope === 'config') {
          const current = options.currentConfig();
          let next: VesselConfig;
          try {
            next = await options.reloadConfig();
          } catch (error) {
            throw new Error(
              `config_reload_failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          const restartFields = diffRestartFields(current, next);
          // provider.* / models.* 热应用（P0-1 D4 → P1-w2d 泛化，D5）：与 diffRestartFields
          // 同一 stableValue 口径。块变化且新配置能解析出非空有效缺省模型且注入了 applier
          // ⇒ 应用（重建快照 + 清缓存 + 原地改节点缺省）并把摘要行并入 summaries.config；
          // 否则变化域补进 requires_restart —— 不猜 provider 缺省模型，不假装生效。
          // 生效点由 applier 的摘要行写清（节点缺省，live 下一具才换）。
          const providerChanged = stableValue(current.provider) !== stableValue(next.provider);
          const modelsChanged = stableValue(current.models) !== stableValue(next.models);
          const modelLines: string[] = [];
          if (providerChanged || modelsChanged) {
            // 第 6 修（SPAWN-03）：from/to 是缺省**身份**（ref + wire）——比较语义在
            // ref 级（异键同 wire = changed；同键异 wire = 缺省未变、仅 wire 改名），
            // 展示面保留 wire。预览优先用运行期同口径（legacyPresent 单向闸）。
            const preview = options.previewDefaultModel ?? effectiveDefaultModel;
            const modelFrom = preview(current);
            const modelTo = preview(next);
            if (modelTo !== undefined && options.applyProviderModel !== undefined) {
              const lines = await options.applyProviderModel(modelFrom, modelTo, next);
              if (Array.isArray(lines)) modelLines.push(...lines);
              appliedReport.push({
                field: providerChanged && modelsChanged ? 'provider+models' : providerChanged ? 'provider' : 'models',
                reason: 'hot-applied: node default model rebuilt; live bodies keep construction snapshot until next body',
              });
            } else {
              if (providerChanged) restartFields.push('provider');
              if (modelsChanged) restartFields.push('models');
            }
          }
          // S7 federation 热应用：块变化且注入了 applier ⇒ 原地更新入站 / 出站
          // 运行时对象；否则变化域进 requires_restart（不假装生效）。
          const federationChanged =
            stableValue(current.federation) !== stableValue(next.federation);
          const federationLines: string[] = [];
          if (federationChanged) {
            if (options.applyFederation !== undefined) {
              const lines = await options.applyFederation(next);
              if (Array.isArray(lines)) federationLines.push(...lines);
              appliedReport.push({
                field: 'federation',
                reason: 'hot-applied: inbound/outbound peers updated in place',
              });
            } else {
              restartFields.push('federation');
            }
          }
          // q-kanban-proxy：kanban 热应用：块变化且注入了 applier ⇒ 重解析
          // boardPath 原地更新 deps；否则变化域进 requires_restart（不假装生效）。
          const kanbanChanged = stableValue(current.kanban) !== stableValue(next.kanban);
          const kanbanLines: string[] = [];
          if (kanbanChanged) {
            if (options.applyKanban !== undefined) {
              const lines = await options.applyKanban(next);
              if (Array.isArray(lines)) kanbanLines.push(...lines);
              appliedReport.push({
                field: 'kanban',
                reason: 'hot-applied: boardPath re-resolved into kanban deps',
              });
            } else {
              restartFields.push('kanban');
            }
          }
          // auto-gc P1：autoPrune 热应用——调度器读 live resolver，applier 把重载配置
          // 喂进活配置引用即下一趟生效（enabled=false 只跳过趟，链不断，再开即活）。
          const autoPruneChanged = stableValue(current.autoPrune) !== stableValue(next.autoPrune);
          const autoPruneLines: string[] = [];
          if (autoPruneChanged) {
            if (options.applyAutoPrune !== undefined) {
              const lines = await options.applyAutoPrune(next);
              if (Array.isArray(lines)) autoPruneLines.push(...lines);
              appliedReport.push({
                field: 'autoPrune',
                reason: 'hot-applied: live config reference fed to scheduler + reschedule',
              });
            } else {
              restartFields.push('autoPrune');
            }
          }
          if (allowedOriginsChanged(current, next)) {
            const target = options.gateway();
            const reconfigure = target?.reconfigure;
            if (!target || typeof reconfigure !== 'function') {
              // web 尚未提供 reconfigure：不声称 config 已生效。
              requiresRestart.push('node.allowedOrigins');
            } else {
              await reconfigure.call(target, {
                allowedOrigins: next.node?.allowedOrigins ?? [],
              });
              reloaded.push('config');
              appliedReport.push({
                field: 'node.allowedOrigins',
                reason: 'hot-applied via gateway.reconfigure',
              });
            }
          } else {
            reloaded.push('config');
          }
          requiresRestart.push(...restartFields);
          // q-error-e3（D8）：三域报告——applied/requires_restart/inert + 每域 reason。
          appliedReport.push({ field: 'config', reason: 'config reloaded from disk' });
          for (const field of restartFields) {
            restartReport.push({ field, reason: 'no hot applier; takes effect after restart' });
          }
          const inertFields = diffInertFields(current, next);
          for (const field of inertFields) {
            inertReport.push({
              field,
              reason:
                'changed but neither hot-applied nor declared requires_restart (hardening gap); restart loads it from disk',
            });
          }
          // lead 红线⑤裁定：有字段变化即出现（三域全列）；空 diff 缺省响应省略。
          if (
            restartFields.length > 0 ||
            providerChanged ||
            modelsChanged ||
            federationChanged ||
            kanbanChanged ||
            autoPruneChanged ||
            allowedOriginsChanged(current, next) ||
            inertFields.length > 0
          ) {
            sawFieldChange = true;
          }
          summaries.config = [
            ...restartFields.map((field) => `config: ${field} requires restart`),
            ...modelLines,
            ...federationLines,
            ...kanbanLines,
            ...autoPruneLines,
          ];
          continue;
        }

        const applier = appliers[scope] as GatewayReloadApplier;
        const lines = await applier();
        reloaded.push(scope);
        summaries[scope] = Array.isArray(lines) ? [...lines] : [];
        appliedReport.push({ field: scope, reason: `hot-applied via ${scope} applier` });
      } catch (error) {
        summaries[scope] = [
          `${scope}: reload failed (${error instanceof Error ? error.message : String(error)})`,
        ];
      }
    }

    // q-error-e3（D8 + lead 红线⑤裁定）：有字段变化即附 field_report；空 diff 省略。
    const fieldReport = sawFieldChange
      ? { applied: appliedReport, requires_restart: restartReport, inert: inertReport }
      : undefined;
    return {
      reloaded,
      requires_restart: requiresRestart,
      summaries,
      ...(fieldReport !== undefined ? { field_report: fieldReport } : {}),
    };
  };

  return {
    reloadWithSummaries,
    async reload(scopes) {
      const outcome = await reloadWithSummaries(scopes);
      return {
        reloaded: outcome.reloaded,
        requires_restart: outcome.requires_restart,
        ...(outcome.field_report !== undefined ? { field_report: outcome.field_report } : {}),
      };
    },
    registeredScopes() {
      return Object.keys(appliers);
    },
  };
}

/**
 * 构造 `GatewayOptions.reload`（只返回契约字段）。
 * @param options 注入面（gateway / 配置读取 / 插件刷新 / appliers）
 */
export function createGatewayReload(
  options: GatewayReloadWiringOptions,
): (scopes: string[]) => Promise<GatewayReloadResult> {
  return createGatewayReloadRunner(options).reload;
}
