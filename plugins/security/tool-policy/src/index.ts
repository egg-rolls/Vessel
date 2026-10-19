/**
 * @vessel/tool-policy - 工具允许/禁止策略插件
 * @module @vessel/tool-policy
 *
 * 通过 Guardrail (ToolCall 阶段) 拦截或允许工具调用。
 * 支持 allowlist / denylist 两种模式。
 * Tier 1。
 */

import type {
  Guardrail,
  GuardrailContext,
  GuardrailResult,
  Plugin,
  PluginHost,
} from '@vessel/core';
import { GuardrailStage } from '@vessel/core';

// ── 类型 ──────────────────────────────────────────

/** 策略模式 */
export type PolicyMode = 'allowlist' | 'denylist';

/** 插件配置 */
export interface ToolPolicyConfig {
  /** 策略模式：allowlist（仅允许列表内工具）/ denylist（禁止列表内工具，默认） */
  mode?: PolicyMode;
  /** 工具名列表 */
  tools?: string[];
  /** 是否允许通配符匹配（例如 "mcp__*" 匹配所有 MCP 工具） */
  enableWildcards?: boolean;
  /** 阻断时的提示信息 */
  blockMessage?: string;
}

/** E1：`install(host, {config})` 的窄类型（core 尚未声明第二参数） */
export interface PluginInstallOptions {
  config?: Record<string, unknown>;
}

/** 类型守卫 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取布尔值（同时接受 camelCase / snake_case） */
function readBoolean(
  config: Record<string, unknown>,
  camel: string,
  snake: string,
): boolean | undefined {
  const value = config[camel] ?? config[snake];
  return typeof value === 'boolean' ? value : undefined;
}

/** 把 YAML 里的插件配置解析成已知字段（未知键忽略） */
export function parseToolPolicyConfig(value: unknown): ToolPolicyConfig {
  if (!isRecord(value)) return {};
  const parsed: ToolPolicyConfig = {};
  if (value.mode === 'allowlist' || value.mode === 'denylist') parsed.mode = value.mode;
  if (Array.isArray(value.tools)) {
    parsed.tools = value.tools.filter((tool): tool is string => typeof tool === 'string');
  }
  const enableWildcards = readBoolean(value, 'enableWildcards', 'enable_wildcards');
  if (enableWildcards !== undefined) parsed.enableWildcards = enableWildcards;
  const blockMessage = value.blockMessage ?? value.block_message;
  if (typeof blockMessage === 'string') parsed.blockMessage = blockMessage;
  return parsed;
}

// ── 默认配置 ──────────────────────────────────────

const DEFAULT_CONFIG: Required<ToolPolicyConfig> = {
  mode: 'denylist',
  tools: [],
  enableWildcards: true,
  blockMessage: '此工具调用已被 tool-policy 策略拦截。',
};

// ── 工具匹配 ──────────────────────────────────────

/** 转义正则元字符（通配符之外的部分按字面量匹配） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 检查工具名是否匹配策略规则。
 * 支持通配符 `*`（匹配任意字符序列）；`enableWildcards: false` 时按字面量匹配。
 */
function matchesPolicy(toolName: string, patterns: string[], enableWildcards: boolean): boolean {
  for (const pattern of patterns) {
    if (toolName === pattern) return true;
    if (!enableWildcards) continue;

    if (pattern === '*') return true;
    if (pattern.includes('*')) {
      const source = pattern.split('*').map(escapeRegExp).join('.*');
      if (new RegExp(`^${source}$`).test(toolName)) return true;
    }
  }
  return false;
}

/** 从 ToolCall / 工具定义 / 上下文中取工具名（runtime 传的是 ToolCall） */
function readToolName(value: unknown, ctx: GuardrailContext): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const fn = record.function;
    if (typeof fn === 'object' && fn !== null) {
      const name = (fn as Record<string, unknown>).name;
      if (typeof name === 'string' && name !== '') return name;
    }
    if (typeof record.name === 'string' && record.name !== '') return record.name;
  }
  const contextName = (ctx as unknown as Record<string, unknown>).tool_name;
  return typeof contextName === 'string' ? contextName : '';
}

// ── Guardrail ─────────────────────────────────────

function createToolPolicyGuardrail(config: Required<ToolPolicyConfig>): Guardrail {
  return {
    name: 'tool-policy',
    stage: GuardrailStage.ToolCall,
    priority: 50,
    check: async (value: unknown, ctx: GuardrailContext): Promise<GuardrailResult> => {
      const toolName = readToolName(value, ctx);

      if (!toolName) {
        return { allowed: true };
      }

      const matched = matchesPolicy(toolName, config.tools, config.enableWildcards);

      if (config.mode === 'allowlist') {
        // 白名单模式：不在列表中的工具被拦截
        if (!matched) {
          return {
            allowed: false,
            reason: `${config.blockMessage} 工具 "${toolName}" 不在白名单中。`,
          };
        }
      } else {
        // 黑名单模式：在列表中的工具被拦截
        if (matched) {
          return {
            allowed: false,
            reason: `${config.blockMessage} 工具 "${toolName}" 已被禁止。`,
          };
        }
      }

      return { allowed: true };
    },
  };
}

// ── 插件导出 ──────────────────────────────────────

/**
 * 创建 Tool Policy 插件
 */
export function createToolPolicyPlugin(config?: ToolPolicyConfig): Plugin {
  return {
    name: 'tool-policy',
    version: '0.1.0',
    description: 'Tool allow/deny policy — intercepts tool calls via ToolCall guardrail',
    install(host: PluginHost, options?: PluginInstallOptions) {
      const mergedConfig: Required<ToolPolicyConfig> = {
        ...DEFAULT_CONFIG,
        ...(config ?? {}),
        ...parseToolPolicyConfig(options?.config),
      };

      host.registerGuardrail(createToolPolicyGuardrail(mergedConfig));
    },
  };
}

/** 默认实例——现有调用方无需改动 */
export const toolPolicyPlugin = createToolPolicyPlugin();

export default toolPolicyPlugin;
