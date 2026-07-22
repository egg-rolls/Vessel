/**
 * Plugin 类型定义
 * @module @vessel/core/plugin
 */

import type { ToolDefinition } from './tool.js';
import type { ProviderFactory } from './provider.js';
import type { Guardrail } from './guardrail.js';
import type { Hook } from './hook.js';

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
}
