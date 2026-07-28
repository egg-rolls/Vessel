/**
 * Vessel 配置校验器
 * @module @vessel/config
 */

import type {
  ConfigValidationError,
  ConfigValidationResult,
  ConfigValidationWarning,
  VesselConfig,
} from './types.js';

/**
 * 校验 Vessel 配置。所有字段为 camelCase（ADR-019）。
 * @param config 配置对象
 * @returns 校验结果
 */
export function validateConfig(config: VesselConfig): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  // 校验 API Key
  if (config.apiKey !== undefined) {
    if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
      errors.push({
        path: 'apiKey',
        message: 'API key must be a non-empty string',
        value: config.apiKey,
      });
    }
  }

  // 校验 provider
  if (config.provider) {
    const { name, model, temperature, maxTokens } = config.provider;

    if (name !== undefined) {
      if (typeof name !== 'string') {
        errors.push({
          path: 'provider.name',
          message: 'Provider name must be a string',
          value: name,
        });
      }
    }

    if (model !== undefined && typeof model !== 'string') {
      errors.push({ path: 'provider.model', message: 'Model must be a string', value: model });
    }

    if (temperature !== undefined) {
      if (typeof temperature !== 'number' || temperature < 0 || temperature > 2) {
        errors.push({
          path: 'provider.temperature',
          message: 'Temperature must be a number between 0 and 2',
          value: temperature,
        });
      }
    }

    if (maxTokens !== undefined) {
      if (typeof maxTokens !== 'number' || maxTokens <= 0) {
        errors.push({
          path: 'provider.maxTokens',
          message: 'Max tokens must be a positive number',
          value: maxTokens,
        });
      }
    }
  }

  // 配置了 provider 但未指定 model -- fail-fast
  if (config.apiKey && config.provider && !config.provider.model) {
    errors.push({
      path: 'provider.model',
      message: `Provider "${config.provider.name ?? 'unknown'}" has no model configured. Set "defaultModel" in ~/.vessel/config.yaml or run /setup.`,
    });
  }

  // 校验 agent
  if (config.agent) {
    const { name, systemPrompt, temperature, maxTokens } = config.agent;

    if (name !== undefined && typeof name !== 'string') {
      errors.push({ path: 'agent.name', message: 'Agent name must be a string', value: name });
    }

    if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
      errors.push({
        path: 'agent.systemPrompt',
        message: 'System prompt must be a string',
        value: systemPrompt,
      });
    }

    if (temperature !== undefined) {
      if (typeof temperature !== 'number' || temperature < 0 || temperature > 2) {
        errors.push({
          path: 'agent.temperature',
          message: 'Temperature must be a number between 0 and 2',
          value: temperature,
        });
      }
    }

    if (maxTokens !== undefined) {
      if (typeof maxTokens !== 'number' || maxTokens <= 0) {
        errors.push({
          path: 'agent.maxTokens',
          message: 'Max tokens must be a positive number',
          value: maxTokens,
        });
      }
    }
  }

  // 校验 tools
  if (config.tools) {
    if (!Array.isArray(config.tools)) {
      errors.push({ path: 'tools', message: 'Tools must be an array', value: config.tools });
    } else {
      config.tools.forEach((tool, index) => {
        if (!tool.name || typeof tool.name !== 'string') {
          errors.push({
            path: `tools[${index}].name`,
            message: 'Tool name must be a non-empty string',
            value: tool.name,
          });
        }
      });
    }
  }

  // 校验 limits
  if (config.limits) {
    const { requestLimit, toolCallsLimit, inputTokensLimit, outputTokensLimit, totalCostLimit } =
      config.limits;

    const validateLimit = (path: string, value: unknown, name: string) => {
      if (value !== undefined) {
        if (typeof value !== 'number' || value < 0) {
          errors.push({ path, message: `${name} must be a non-negative number`, value });
        }
      }
    };

    validateLimit('limits.requestLimit', requestLimit, 'Request limit');
    validateLimit('limits.toolCallsLimit', toolCallsLimit, 'Tool calls limit');
    validateLimit('limits.inputTokensLimit', inputTokensLimit, 'Input tokens limit');
    validateLimit('limits.outputTokensLimit', outputTokensLimit, 'Output tokens limit');
    validateLimit('limits.totalCostLimit', totalCostLimit, 'Total cost limit');
  }

  // 校验 termination
  if (config.termination) {
    const { maxIterations, maxRuntimeSeconds } = config.termination;

    if (maxIterations !== undefined) {
      if (typeof maxIterations !== 'number' || maxIterations <= 0) {
        errors.push({
          path: 'termination.maxIterations',
          message: 'Max iterations must be a positive number',
          value: maxIterations,
        });
      }
    }

    if (maxRuntimeSeconds !== undefined) {
      if (typeof maxRuntimeSeconds !== 'number' || maxRuntimeSeconds <= 0) {
        errors.push({
          path: 'termination.maxRuntimeSeconds',
          message: 'Max runtime seconds must be a positive number',
          value: maxRuntimeSeconds,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * 检查配置是否有未知键（camelCase，由 loader 映射后产出的对象）。
 * @param config 配置对象
 * @param knownKeys 已知键列表
 * @returns 未知键列表
 */
export function findUnknownKeys(config: Record<string, unknown>, knownKeys: string[]): string[] {
  return Object.keys(config).filter((key) => !knownKeys.includes(key));
}

/** 已知的配置键（camelCase，ADR-019） */
export const KNOWN_CONFIG_KEYS = [
  'apiKey',
  'provider',
  'agent',
  'tools',
  'guardrails',
  'hooks',
  'limits',
  'termination',
  'session',
  'context',
  'plugins',
];
