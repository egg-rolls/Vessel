/**
 * Plugin 类型定义
 * @module @vessel/core/plugin
 */

import type { Guardrail } from './guardrail.js';
import type { Hook } from './hook.js';
import type { ProviderFactory } from './provider.js';
import type { RunStore } from './run-store.js';
import type { ToolDefinition } from './tool.js';

/**
 * Plugin 安装选项（0.6.1 E1）。
 * 宿主按插件配置透传；未提供配置时沿用旧调用 `install(host)`。
 */
export interface PluginInstallOptions {
  config?: Record<string, unknown>;
}

/** `init` 的上下文（0.9 生命周期 v2）；只暴露宿主，不引入配置/事件依赖 */
export interface PluginInitContext {
  host: PluginHost;
}

/** Plugin 接口 */
export interface Plugin {
  name: string;
  version?: string;
  description?: string;
  /** 第二个参数可选：旧的 `install(host)` 实现与调用继续合法（E1） */
  install(host: PluginHost, options?: PluginInstallOptions): void | Promise<void>;
  /** 所有插件 install 成功后按安装顺序调用；异常被隔离在单个插件内（0.9） */
  init?(ctx: PluginInitContext): void | Promise<void>;
  /** `AgentRuntime.dispose()` 时按逆安装顺序调用；best-effort（0.9） */
  dispose?(): void | Promise<void>;
}

/**
 * 一次插件安装的注册记录（0.9）。
 * `commit()` 丢弃记录；`rollback()` 撤销本次记录的注册条目。
 */
export interface PluginInstallScope {
  commit(): void;
  rollback(): void;
}

/** PluginHost 接口 */
export interface PluginHost {
  registerTool(def: ToolDefinition): void;
  registerProvider(name: string, factory: ProviderFactory): void;
  registerGuardrail(guardrail: Guardrail): void;
  registerHook(hook: Hook): void;
  getTool(name: string): ToolDefinition | undefined;
  getProvider(name: string): ProviderFactory | undefined;
  getGuardrails(): Guardrail[];
  getHooks(): Hook[];
  listTools(): ToolDefinition[];
  listProviders(): string[];
  /**
   * 可选：记录一次插件安装的注册，用于安装失败时回滚（0.9）。
   * 不支持回滚的自定义宿主可以不实现。
   */
  beginPluginInstall?(pluginName: string): PluginInstallScope;
}

/** 默认权限策略（ADR-029：未声明 checkPermission 的工具用此默认判定） */
export interface RuntimePermissionConfig {
  /** 默认判定：'ask'（交互确认）或 'allow'（放行）。默认 'allow'——库默认不确认，由 app 层显式开启 */
  default?: 'allow' | 'ask';
  /** 免确认工具名列表 */
  autoApprove?: string[];
}

/** AgentRuntime 配置 */
export interface AgentRuntimeOptions {
  provider: import('./provider.js').LLMProvider;
  model: string;
  context: import('./context.js').ContextManager;
  events: import('./event.js').EventStream;
  limits: import('./limits.js').UsageLimits;
  termination: import('./limits.js').TerminationPolicy;
  plugins?: Plugin[];
  /**
   * 按插件名提供的安装配置（0.6.1 E1）。
   * 存在时以 `install(host, { config })` 调用；缺省时保持 `install(host)`。
   */
  pluginConfigs?: Record<string, Record<string, unknown>>;
  session?: import('./session.js').SessionBackend;
  systemPrompt?: string; // 系统提示词
  /** 默认权限策略——未声明 checkPermission 的工具用 default/autoApprove 判定（ADR-029） */
  permission?: RuntimePermissionConfig;
  /** 可注入的 PluginHost（默认 MemoryPluginHost）——依赖倒置（ADR-033） */
  pluginHost?: PluginHost;
  /** 可注入的限制检查器（默认 MemoryLimitChecker）——依赖倒置（ADR-033） */
  limitChecker?: import('./limits.js').LimitChecker;
  /** 可选：durable run 检查点存储；缺省不写 checkpoint（零开销） */
  runStore?: RunStore;
  /** 可选：写入 checkpoint.agent_id（Host 注入成员 id；单 agent 可缺省） */
  agentId?: string;
  /** 0.5：所属 tenant；事件 / RunState / RunCheckpoint 在缺失时补齐 */
  tenantId?: string;
  /**
   * 0.10：诊断日志 sink；缺省 noop。
   * 未注入且设置了 `VESSEL_DEBUG` 时，runtime 兜底为 stderr logger（level=debug）。
   */
  logger?: import('./logging.js').Logger;
}
