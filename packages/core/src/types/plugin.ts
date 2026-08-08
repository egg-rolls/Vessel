/**
 * Plugin 类型定义
 * @module @vessel/core/plugin
 */

import type { Guardrail } from './guardrail.js';
import type { Hook } from './hook.js';
import type { ProviderFactory } from './provider.js';
import type { ToolDefinition } from './tool.js';

/** Plugin 接口 */
export interface Plugin {
  name: string;
  version?: string;
  description?: string;
  install(host: PluginHost): void | Promise<void>;
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
  tools: import('./tool.js').ToolRegistry;
  context: import('./context.js').ContextManager;
  events: import('./event.js').EventStream;
  limits: import('./limits.js').UsageLimits;
  termination: import('./limits.js').TerminationPolicy;
  plugins?: Plugin[];
  session?: import('./session.js').SessionBackend;
  systemPrompt?: string; // 系统提示词
  /** 默认权限策略——未声明 checkPermission 的工具用 default/autoApprove 判定（ADR-029） */
  permission?: RuntimePermissionConfig;
}
