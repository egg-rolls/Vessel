/**
 * Vessel 配置校验器
 * @module @vessel/config
 */

import type {
  VesselConfig,
  ConfigValidationResult,
  ConfigValidationError,
  ConfigValidationWarning,
} from './types.js';
import { PROVIDER_PRESETS } from './defaults.js';

/**
 * 校验 Vessel 配置
 * @param config 配置对象
 * @returns 校验结果
 */
export function validateConfig(config: VesselConfig): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  // 校验 API Key
  if (config.api_key !== undefined) {
    if (typeof config.api_key !== 'string' || config.api_key.trim() === '') {
      errors.push({
        path: 'api_key',
        message: 'API key must be a non-empty string',
        value: config.api_key,
      });
    }
  }

  // 校验 provider
  if (config.provider) {
    const { name, model, temperature, max_tokens } = config.provider;

    if (name !== undefined) {
      if (typeof name !== 'string') {
        errors.push({
          path: 'provider.name',
          message: 'Provider name must be a string',
          value: name,
        });
      } else if (!PROVIDER_PRESETS[name]) {
        warnings.push({
          path: 'provider.name',
          message: `Unknown provider "${name}". Known providers: ${Object.keys(PROVIDER_PRESETS).join(', ')}`,
          value: name,
        });
      }
    }

    if (model !== undefined && typeof model !== 'string') {
      errors.push({
        path: 'provider.model',
        message: 'Model must be a string',
        value: model,
      });
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

    if (max_tokens !== undefined) {
      if (typeof max_tokens !== 'number' || max_tokens <= 0) {
        errors.push({
          path: 'provider.max_tokens',
          message: 'Max tokens must be a positive number',
          value: max_tokens,
        });
      }
    }
  }

  // 校验 agent
  if (config.agent) {
    const { name, system_prompt, temperature, max_tokens } = config.agent;

    if (name !== undefined && typeof name !== 'string') {
      errors.push({
        path: 'agent.name',
        message: 'Agent name must be a string',
        value: name,
      });
    }

    if (system_prompt !== undefined && typeof system_prompt !== 'string') {
      errors.push({
        path: 'agent.system_prompt',
        message: 'System prompt must be a string',
        value: system_prompt,
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

    if (max_tokens !== undefined) {
      if (typeof max_tokens !== 'number' || max_tokens <= 0) {
        errors.push({
          path: 'agent.max_tokens',
          message: 'Max tokens must be a positive number',
          value: max_tokens,
        });
      }
    }
  }

  // 校验 tools
  if (config.tools) {
    if (!Array.isArray(config.tools)) {
      errors.push({
        path: 'tools',
        message: 'Tools must be an array',
        value: config.tools,
      });
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
    const { request_limit, tool_calls_limit, input_tokens_limit, output_tokens_limit, total_cost_limit } = config.limits;

    const validateLimit = (path: string, value: unknown, name: string) => {
      if (value !== undefined) {
        if (typeof value !== 'number' || value < 0) {
          errors.push({
            path,
            message: `${name} must be a non-negative number`,
            value,
          });
        }
      }
    };

    validateLimit('limits.request_limit', request_limit, 'Request limit');
    validateLimit('limits.tool_calls_limit', tool_calls_limit, 'Tool calls limit');
    validateLimit('limits.input_tokens_limit', input_tokens_limit, 'Input tokens limit');
    validateLimit('limits.output_tokens_limit', output_tokens_limit, 'Output tokens limit');
    validateLimit('limits.total_cost_limit', total_cost_limit, 'Total cost limit');
  }

  // 校验 termination
  if (config.termination) {
    const { max_iterations, max_runtime_seconds, stop_on_no_tool_calls } = config.termination;

    if (max_iterations !== undefined) {
      if (typeof max_iterations !== 'number' || max_iterations <= 0) {
        errors.push({
          path: 'termination.max_iterations',
          message: 'Max iterations must be a positive number',
          value: max_iterations,
        });
      }
    }

    if (max_runtime_seconds !== undefined) {
      if (typeof max_runtime_seconds !== 'number' || max_runtime_seconds <= 0) {
        errors.push({
          path: 'termination.max_runtime_seconds',
          message: 'Max runtime seconds must be a positive number',
          value: max_runtime_seconds,
        });
      }
    }

    if (stop_on_no_tool_calls !== undefined && typeof stop_on_no_tool_calls !== 'boolean') {
      errors.push({
        path: 'termination.stop_on_no_tool_calls',
        message: 'Stop on no tool calls must be a boolean',
        value: stop_on_no_tool_calls,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 检查配置是否有未知键
 * @param config 配置对象
 * @param knownKeys 已知键列表
 * @returns 未知键列表
 */
export function findUnknownKeys(config: Record<string, unknown>, knownKeys: string[]): string[] {
  return Object.keys(config).filter((key) => !knownKeys.includes(key));
}

/** 已知的配置键 */
export const KNOWN_CONFIG_KEYS = [
  'api_key',
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
