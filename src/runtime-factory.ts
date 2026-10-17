/**
 * 0.2 Host 路径的装配工厂。
 *
 * - 只在 `host.enabled === true` 时由 bootstrap 调用；
 * - core kernel 用**动态 import** 加载，host 关闭时不加载/不构造；
 * - 失败返回结构化 error，由 bootstrap 告警并回退 0.1 的 AgentRuntime 路径。
 *
 * A2 只提供工厂与 facade，不改 bootstrap（A3 接线）。
 */

import {
  DEFAULT_CONFIG,
  DEFAULT_SCHEDULER_OPTIONS,
  type VesselConfig,
} from '../packages/config/src/index';
import type {
  AgentHandle,
  AgentSpec,
  ContextManager,
  LLMProvider,
  PluginHost,
  RunnableAgent,
  RuntimeHost,
  RuntimeOptions,
  RuntimePermissionConfig,
  SessionBackend,
  TerminationPolicy,
  Transport,
  UsageLimits,
} from '../packages/core/src/index';
import { OwnerRuntimeFacade } from './owner-runtime-facade';

/** 动态加载的 kernel 入口形状（测试可注入 fake） */
export interface HostModule {
  createRuntime(options?: RuntimeOptions): Promise<RuntimeHost>;
}

/** owner agent 所需的装配输入 */
export interface OwnerRuntimeSpec {
  id: string;
  name?: string;
  provider: LLMProvider;
  model: string;
  pluginHost: PluginHost;
  context: ContextManager;
  session: SessionBackend;
  systemPrompt?: string;
  /** run 级限额（0.2 与 agent 同源） */
  limits: UsageLimits;
  termination: TerminationPolicy;
  permission?: RuntimePermissionConfig;
}

export interface CreateHostRuntimeOptions {
  config: VesselConfig;
  owner: OwnerRuntimeSpec;
  /** owner 的初始 sessionId */
  sessionId: string;
  /** 成员上下文工厂；缺省交给 core 的 MemoryContextManager */
  contextFactory?: () => ContextManager;
  /** R3 注入点；A4 接线 */
  transport?: Transport;
  /**
   * createRuntime 之后、spawn owner 之前调用。
   * A5 用它把 delegate/team 工厂插件装到同一个 Host/PluginHost 上。
   */
  beforeSpawn?: (host: RuntimeHost) => void | Promise<void>;
  /** 测试注入口；缺省动态 import kernel */
  loadHostModule?: () => Promise<HostModule>;
}

export type HostRuntimeResult =
  | { ok: true; runtime: RunnableAgent; host: RuntimeHost }
  | { ok: false; error: string };

/** 默认 loader：只在 host 路径执行时才加载 kernel 模块 */
async function loadKernelModule(): Promise<HostModule> {
  const mod = await import('../packages/core/src/kernel/create-runtime.js');
  return { createRuntime: mod.createRuntime };
}

/**
 * 尝试构造 Host 路径。任何异常都转成 `{ ok: false }`，不抛出。
 */
export async function tryCreateHostRuntime(
  options: CreateHostRuntimeOptions,
): Promise<HostRuntimeResult> {
  const { config, owner } = options;
  const loader = options.loadHostModule ?? loadKernelModule;

  try {
    const { createRuntime } = await loader();

    const host = await createRuntime({
      pluginHost: owner.pluginHost,
      session: owner.session,
      ...(options.contextFactory ? { contextFactory: options.contextFactory } : {}),
      ...(owner.permission ? { permission: owner.permission } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      scheduler: resolveScheduler(config),
      limits: resolveLimits(config, owner),
      defaults: {
        provider: owner.provider,
        model: owner.model,
        pluginHost: owner.pluginHost,
        session: owner.session,
        ...(owner.systemPrompt !== undefined ? { systemPrompt: owner.systemPrompt } : {}),
        ...(owner.permission ? { permission: owner.permission } : {}),
      },
    });

    if (options.beforeSpawn) await options.beforeSpawn(host);

    const spawnOwner = (sessionId: string): Promise<AgentHandle> =>
      host.spawn(buildOwnerSpec(owner, sessionId));

    const handle = await spawnOwner(options.sessionId);
    const runtime = new OwnerRuntimeFacade({
      host,
      handle,
      pluginHost: owner.pluginHost,
      initialSessionId: options.sessionId,
      spawnOwner,
    });

    return { ok: true, runtime, host };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** config → SchedulerOptions；缺省值与 0.1 单 agent 串行行为一致 */
function resolveScheduler(config: VesselConfig): RuntimeOptions['scheduler'] {
  return {
    maxConcurrency: config.scheduler?.maxConcurrency ?? DEFAULT_SCHEDULER_OPTIONS.maxConcurrency,
    maxQueueSize: config.scheduler?.maxQueueSize ?? DEFAULT_SCHEDULER_OPTIONS.maxQueueSize,
    perAgentSerial: config.scheduler?.perAgentSerial ?? DEFAULT_SCHEDULER_OPTIONS.perAgentSerial,
  };
}

/** config → Limits；agent 与 run 同源（DECISION-006 Q3） */
function resolveLimits(config: VesselConfig, owner: OwnerRuntimeSpec): RuntimeOptions['limits'] {
  const runLimits = config.limits ?? DEFAULT_CONFIG.limits ?? {};
  return {
    run: runLimits,
    agent: runLimits,
    ...(config.host?.limits ? { host: config.host.limits } : {}),
    termination: owner.termination,
  };
}

/** 构造 owner AgentSpec（无 sessionId 时由调用方补齐） */
function buildOwnerSpec(owner: OwnerRuntimeSpec, sessionId: string): AgentSpec {
  return {
    id: owner.id,
    ...(owner.name !== undefined ? { name: owner.name } : {}),
    provider: owner.provider,
    model: owner.model,
    pluginHost: owner.pluginHost,
    context: owner.context,
    session: owner.session,
    sessionId,
    ...(owner.systemPrompt !== undefined ? { systemPrompt: owner.systemPrompt } : {}),
    limits: {
      run: owner.limits,
      agent: owner.limits,
      termination: owner.termination,
    },
    termination: owner.termination,
    ...(owner.permission ? { permission: owner.permission } : {}),
  };
}

/** 供 bootstrap 做分支判断（保持一处语义） */
export function isHostEnabled(config: VesselConfig): boolean {
  return config.host?.enabled === true;
}

/** 供测试/诊断：暴露 owner spec 的构造规则 */
export { buildOwnerSpec };
