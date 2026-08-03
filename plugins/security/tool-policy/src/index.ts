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

// ── 默认配置 ──────────────────────────────────────

const DEFAULT_CONFIG: Required<ToolPolicyConfig> = {
  mode: 'denylist',
  tools: [],
  enableWildcards: true,
  blockMessage: '此工具调用已被 tool-policy 策略拦截。',
};

// ── 工具匹配 ──────────────────────────────────────

/**
 * 检查工具名是否匹配策略规则
 * 支持通配符 `*`（匹配任意字符序列）
 */
function matchesPolicy(toolName: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === '*') return true;

    if (pattern.includes('*')) {
      const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
      if (regex.test(toolName)) return true;
    }

    if (toolName === pattern) return true;
  }
  return false;
}

// ── Guardrail ─────────────────────────────────────

function createToolPolicyGuardrail(config: Required<ToolPolicyConfig>): Guardrail {
  return {
    name: 'tool-policy',
    stage: GuardrailStage.ToolCall,
    priority: 50,
    check: async (value: unknown, ctx: GuardrailContext): Promise<GuardrailResult> => {
      const toolName = ((value as { name?: string })?.name ??
        (ctx as unknown as Record<string, unknown>)?.tool_name ??
        '') as string;

      if (!toolName) {
        return { allowed: true };
      }

      const matched = matchesPolicy(toolName, config.tools);

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
    install(host: PluginHost) {
      const mergedConfig: Required<ToolPolicyConfig> = {
        ...DEFAULT_CONFIG,
        ...(config ?? {}),
      };

      host.registerGuardrail(createToolPolicyGuardrail(mergedConfig));
    },
  };
}

/** 默认实例——现有调用方无需改动 */
export const toolPolicyPlugin = createToolPolicyPlugin();

export default toolPolicyPlugin;
