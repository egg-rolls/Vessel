/**
 * Runtime（Stage 4，ADR-098 C4）：per-node 的无状态执行框架。
 *
 * 只持有装配期注册的 tenant profile（配置/引用，不是 live 实例）与按
 * `(tenantId, sessionId)` 的执行单元目录（工厂缓存，条目由 ControlPlane retire）。
 * 不持 Session / Run / WorkingContext / lease / RunRecordStore；不做 I/O、
 * 不启定时器、不感知 Scheduler / Team / Inbox。
 *
 * @module @vessel-agent/core/runtime
 */

import { MemoryWorkingContext } from '../context/index.js';
import { noopLogger } from '../logging.js';
import type { ContextSummarizer, WorkingContext } from '../types/context.js';
import type { EventStream, SessionEventLogPort } from '../types/event.js';
import type { LeaseGrant, LeaseServicePort } from '../types/lease.js';
import type { TerminationPolicy, UsageLimits } from '../types/limits.js';
import type { Logger } from '../types/logging.js';
import type {
  ExecutionUnitOptions,
  Plugin,
  PluginHost,
  RuntimePermissionConfig,
} from '../types/plugin.js';
import type { LLMProvider } from '../types/provider.js';
import type { SessionStore } from '../types/session.js';
import { ExecutionUnit } from './execution-unit.js';
import type { RunJournalFactory } from './run-journal.js';

/** 装配期注册的 tenant 配置；字段是配置/引用，不是 live 实例，也不是 Session。 */
export interface TenantRuntimeProfile {
  tenantId: string;
  providerFactory: () => LLMProvider;
  model: string;
  /** 引用；安装仍发生在 EU 构造（装配层可用 wrapper 绑定插件配置） */
  plugins: readonly Plugin[];
  /** 默认 MemoryPluginHost；tenant 策略宿主由 Assembly 提供 */
  pluginHostFactory?: () => PluginHost;
  limits?: UsageLimits;
  termination?: TerminationPolicy;
  includeReasoning?: boolean;
  context: {
    maxTokens?: number;
    autoCompact?: boolean;
    summarizer?: ContextSummarizer;
  };
  systemPrompt?: string;
  permission?: RuntimePermissionConfig;
  /** 铁律 1：持久端口只到 Runtime 工厂层；EU 只经 journal 写入。 */
  journalFactory: RunJournalFactory;
}

/** 每次 getOrCreate 的请求；tenant + binding/session 标识 + per-binding 覆盖。 */
export interface ExecutionUnitRequest {
  tenantId: string;
  /** EU 目录键（Stage 3 起会话唯一） */
  sessionId: string;
  /** 成员 / owner 身份；与已有 EU 不一致时拒绝复用 */
  agentId?: string;
  /** EU 只读历史 */
  session?: SessionStore;
  /** per-EU 观察流（tenant 或 member） */
  events: EventStream;
  /** EU 只读；写由 RunJournal 承担 */
  eventLog?: SessionEventLogPort;
  leaseService?: LeaseServicePort;
  bindingLease?: LeaseGrant;
  /** 成员 body 自有宿主（白名单工具/桥接 hook）；缺省用 profile 的工厂 */
  pluginHost?: PluginHost;
  /** 覆盖 profile 的插件引用；成员传空数组避免重复安装 tenant 插件 */
  plugins?: readonly Plugin[];
  limits?: UsageLimits;
  termination?: TerminationPolicy;
  includeReasoning?: boolean;
  logger?: Logger;
  /** 成员 RoleAware 包装 */
  contextFactory?: (init: { sessionId: string }) => WorkingContext;
  overrides?: Partial<
    Pick<
      ExecutionUnitOptions,
      | 'model'
      | 'systemPrompt'
      | 'permission'
      | 'selfCard'
      | 'contextPressureHint'
      | 'agentId'
      | 'tenantId'
    >
  >;
}

/** 同一 (tenant, session) 已绑定到另一个 agent。 */
const BINDING_CONFLICT = 'execution_unit_binding_conflict';
/** 同一 tenant 注册了不同 profile。 */
const PROFILE_CONFLICT = 'tenant_profile_conflict';
/** getOrCreate 前 tenant 未注册 profile。 */
const PROFILE_MISSING = 'tenant_profile_not_registered';

function unitKey(tenantId: string, sessionId: string): string {
  return `${tenantId}\0${sessionId}`;
}

/** per-node 无状态 Runtime：tenant profile 注册表 + EU 工厂缓存。 */
export class Runtime {
  private readonly profiles = new Map<string, TenantRuntimeProfile>();
  private readonly units = new Map<string, ExecutionUnit | Promise<ExecutionUnit>>();
  private readonly logger: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.logger = opts.logger ?? noopLogger;
  }

  /** 注册 tenant profile；同一 profile 幂等，同一 tenant 不同 profile 抛错。 */
  registerProfile(profile: TenantRuntimeProfile): void {
    const existing = this.profiles.get(profile.tenantId);
    if (existing === undefined) {
      this.profiles.set(profile.tenantId, profile);
      return;
    }
    if (existing === profile) return;
    throw new Error(`${PROFILE_CONFLICT}: ${profile.tenantId}`);
  }

  /**
   * 取或创建 `(tenantId, sessionId)` 的 ExecutionUnit。
   *
   * 单飞：并发调用只创建一次；已有 EU 但 `agentId` 不一致时拒绝复用，
   * 不静默串台。
   */
  async getOrCreateExecutionUnit(req: ExecutionUnitRequest): Promise<ExecutionUnit> {
    const profile = this.profiles.get(req.tenantId);
    if (profile === undefined) throw new Error(`${PROFILE_MISSING}: ${req.tenantId}`);

    const key = unitKey(req.tenantId, req.sessionId);
    const existing = this.units.get(key);
    if (existing !== undefined) {
      const unit = await existing;
      this.assertBinding(unit, req.agentId);
      return unit;
    }

    const creation = ExecutionUnit.create(this.materializeOptions(profile, req)).then(
      (unit) => {
        this.units.set(key, unit);
        return unit;
      },
      (error: unknown) => {
        this.units.delete(key);
        throw error;
      },
    );
    this.units.set(key, creation);
    return creation;
  }

  /** 已解析的 EU；仍在创建中或不存在时返回 undefined。 */
  getExecutionUnit(key: { tenantId: string; sessionId: string }): ExecutionUnit | undefined {
    const entry = this.units.get(unitKey(key.tenantId, key.sessionId));
    if (entry === undefined || entry instanceof Promise) return undefined;
    return entry;
  }

  /** 幂等 retire：dispose 并移除目录条目；创建失败 / dispose 失败不抛出。 */
  async retireExecutionUnit(key: { tenantId: string; sessionId: string }): Promise<void> {
    const mapKey = unitKey(key.tenantId, key.sessionId);
    const entry = this.units.get(mapKey);
    if (entry === undefined) return;
    this.units.delete(mapKey);
    try {
      const unit = await entry;
      await unit.dispose();
    } catch {
      // 工厂缓存条目已移除；创建/dispose 失败由调用方观测，不在 retire 重复抛出。
    }
  }

  /** 诊断 / 探针用：已解析的 EU 快照。 */
  listExecutionUnits(): readonly ExecutionUnit[] {
    const units: ExecutionUnit[] = [];
    for (const entry of this.units.values()) {
      if (!(entry instanceof Promise)) units.push(entry);
    }
    return units;
  }

  /** 诊断 / 探针用：已注册 tenant 数。 */
  get profileCount(): number {
    return this.profiles.size;
  }

  private assertBinding(unit: ExecutionUnit, requestedAgentId?: string): void {
    if (requestedAgentId === undefined) return;
    if (unit.agentId !== requestedAgentId) {
      throw new Error(`${BINDING_CONFLICT}: ${requestedAgentId}`);
    }
  }

  private materializeOptions(
    profile: TenantRuntimeProfile,
    req: ExecutionUnitRequest,
  ): ExecutionUnitOptions {
    const overrides = req.overrides;
    const agentId = req.agentId ?? overrides?.agentId;
    const tenantId = overrides?.tenantId ?? req.tenantId;
    const systemPrompt = overrides?.systemPrompt ?? profile.systemPrompt;
    const permission = overrides?.permission ?? profile.permission;
    return {
      provider: profile.providerFactory(),
      model: overrides?.model ?? profile.model,
      contextFactory: req.contextFactory ?? this.defaultContextFactory(profile),
      events: req.events,
      limits: req.limits ?? profile.limits ?? {},
      // 缺省不设累计上限：交互 run 靠自动压缩 / 模型自然停止 / 用户中断收口。
      termination: req.termination ?? profile.termination ?? {},
      plugins: req.plugins !== undefined ? [...req.plugins] : [...profile.plugins],
      journalFactory: profile.journalFactory,
      logger: req.logger ?? this.logger,
      ...(req.session !== undefined ? { session: req.session } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(permission !== undefined ? { permission } : {}),
      ...(req.pluginHost !== undefined
        ? { pluginHost: req.pluginHost }
        : profile.pluginHostFactory !== undefined
          ? { pluginHost: profile.pluginHostFactory() }
          : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(req.includeReasoning !== undefined
        ? { includeReasoning: req.includeReasoning }
        : profile.includeReasoning !== undefined
          ? { includeReasoning: profile.includeReasoning }
          : {}),
      ...(overrides?.selfCard !== undefined ? { selfCard: overrides.selfCard } : {}),
      ...(overrides?.contextPressureHint !== undefined
        ? { contextPressureHint: overrides.contextPressureHint }
        : {}),
      ...(req.eventLog !== undefined ? { eventLog: req.eventLog } : {}),
      ...(req.leaseService !== undefined ? { leaseService: req.leaseService } : {}),
      ...(req.bindingLease !== undefined ? { bindingLease: req.bindingLease } : {}),
    } satisfies ExecutionUnitOptions;
  }

  private defaultContextFactory(
    profile: TenantRuntimeProfile,
  ): (init: { sessionId: string }) => WorkingContext {
    const config = profile.context;
    return ({ sessionId }) => {
      const context = new MemoryWorkingContext({
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.autoCompact !== undefined ? { autoCompact: config.autoCompact } : {}),
        ...(config.summarizer !== undefined ? { summarizer: config.summarizer } : {}),
      });
      context.setSessionId(sessionId);
      return context;
    };
  }
}
