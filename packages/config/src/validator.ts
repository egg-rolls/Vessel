/**
 * Vessel 配置校验器
 * @module @vessel/config
 */

import { DEFAULT_TRANSPORT_OPTIONS } from './defaults.js';
import type {
  ConfigValidationError,
  ConfigValidationResult,
  ConfigValidationWarning,
  TerminationConfig,
  UsageLimitsConfig,
  VesselConfig,
} from './types.js';

/** Agent/Node ID 字符集（DECISION-005 U1：不含 `:`） */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 允许的 loopback 主机名 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 校验 limits 块（顶层与 delegate 子块共用） */
function validateLimits(
  prefix: string,
  limits: UsageLimitsConfig,
  errors: ConfigValidationError[],
): void {
  const fields: Array<[string, number | undefined, string]> = [
    ['requestLimit', limits.requestLimit, 'Request limit'],
    ['toolCallsLimit', limits.toolCallsLimit, 'Tool calls limit'],
    ['inputTokensLimit', limits.inputTokensLimit, 'Input tokens limit'],
    ['outputTokensLimit', limits.outputTokensLimit, 'Output tokens limit'],
    ['totalCostLimit', limits.totalCostLimit, 'Total cost limit'],
  ];
  for (const [key, value, label] of fields) {
    if (value !== undefined && (typeof value !== 'number' || value < 0)) {
      errors.push({
        path: `${prefix}.${key}`,
        message: `${label} must be a non-negative number`,
        value,
      });
    }
  }
}

/** 校验 termination 块（顶层与 delegate 子块共用） */
function validateTermination(
  prefix: string,
  termination: TerminationConfig,
  errors: ConfigValidationError[],
): void {
  const { maxIterations, maxRuntimeSeconds } = termination;
  if (maxIterations !== undefined) {
    if (typeof maxIterations !== 'number' || maxIterations <= 0) {
      errors.push({
        path: `${prefix}.maxIterations`,
        message: 'Max iterations must be a positive number',
        value: maxIterations,
      });
    }
  }
  if (maxRuntimeSeconds !== undefined) {
    if (typeof maxRuntimeSeconds !== 'number' || maxRuntimeSeconds <= 0) {
      errors.push({
        path: `${prefix}.maxRuntimeSeconds`,
        message: 'Max runtime seconds must be a positive number',
        value: maxRuntimeSeconds,
      });
    }
  }
}

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
    const { name, model, temperature, maxTokens, timeoutMs } = config.provider;

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

    // <=0 是合法值（显式关闭超时），只拒绝非数字/NaN。
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs))) {
      errors.push({
        path: 'provider.timeoutMs',
        message: 'provider.timeoutMs must be a finite number (<=0 disables the timeout)',
        value: timeoutMs,
      });
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

    // 0.1.0 只有 systemPrompt 被消费——其余字段明确警告，不静默忽略。
    for (const key of ['name', 'temperature', 'maxTokens'] as const) {
      if (config.agent[key] !== undefined) {
        warnings.push({
          path: `agent.${key}`,
          message: `agent.${key} is declared but not applied in 0.1.0 (use provider.* instead).`,
          value: config.agent[key],
        });
      }
    }
  }

  // 校验 limits
  if (config.limits) {
    validateLimits('limits', config.limits, errors);
  }

  // 校验 termination
  if (config.termination) {
    validateTermination('termination', config.termination, errors);
  }

  // 校验 session
  if (config.session) {
    const { backend, storagePath } = config.session;
    if (backend !== undefined && !['sqlite', 'file', 'memory'].includes(backend)) {
      errors.push({
        path: 'session.backend',
        message: 'session.backend must be one of "sqlite", "file", "memory"',
        value: backend,
      });
    }
    if (storagePath !== undefined && typeof storagePath !== 'string') {
      errors.push({
        path: 'session.storagePath',
        message: 'session.storagePath must be a string',
        value: storagePath,
      });
    }
    if (config.session.maxHistory !== undefined) {
      warnings.push({
        path: 'session.maxHistory',
        message: 'session.maxHistory is declared but not applied in 0.1.0.',
        value: config.session.maxHistory,
      });
    }
  }

  // 校验 update
  if (config.update) {
    const { autoCheck, channel, source } = config.update;
    if (autoCheck !== undefined && typeof autoCheck !== 'boolean') {
      errors.push({
        path: 'update.autoCheck',
        message: 'update.autoCheck must be a boolean',
        value: autoCheck,
      });
    }
    if (channel !== undefined && channel !== 'latest' && channel !== 'beta') {
      errors.push({
        path: 'update.channel',
        message: 'update.channel must be "latest" or "beta"',
        value: channel,
      });
    }
    if (source !== undefined) {
      if (typeof source !== 'string' || !/^https?:\/\//.test(source)) {
        errors.push({
          path: 'update.source',
          message: 'update.source must be an http(s) URL',
          value: source,
        });
      }
    }
  }

  // 校验 delegate
  if (config.delegate) {
    const {
      enabled,
      maxDepth,
      disallowed,
      model,
      termination,
      limits,
      permissionMode,
      readOnlyTools,
      viaHost,
    } = config.delegate;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      errors.push({
        path: 'delegate.enabled',
        message: 'delegate.enabled must be a boolean',
        value: enabled,
      });
    }
    if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth <= 0)) {
      errors.push({
        path: 'delegate.maxDepth',
        message: 'delegate.maxDepth must be a positive integer',
        value: maxDepth,
      });
    }
    if (disallowed !== undefined) {
      if (!Array.isArray(disallowed) || disallowed.some((v) => typeof v !== 'string')) {
        errors.push({
          path: 'delegate.disallowed',
          message: 'delegate.disallowed must be an array of strings',
          value: disallowed,
        });
      }
    }
    if (model !== undefined && typeof model !== 'string') {
      errors.push({
        path: 'delegate.model',
        message: 'delegate.model must be a string',
        value: model,
      });
    }
    if (
      permissionMode !== undefined &&
      permissionMode !== 'bridge' &&
      permissionMode !== 'allow' &&
      permissionMode !== 'deny'
    ) {
      errors.push({
        path: 'delegate.permissionMode',
        message: 'delegate.permissionMode must be "bridge", "allow" or "deny"',
        value: permissionMode,
      });
    }
    if (readOnlyTools !== undefined) {
      if (!Array.isArray(readOnlyTools) || readOnlyTools.some((v) => typeof v !== 'string')) {
        errors.push({
          path: 'delegate.readOnlyTools',
          message: 'delegate.readOnlyTools must be an array of strings',
          value: readOnlyTools,
        });
      }
    }
    if (viaHost !== undefined && typeof viaHost !== 'boolean') {
      errors.push({
        path: 'delegate.viaHost',
        message: 'delegate.viaHost must be a boolean',
        value: viaHost,
      });
    }
    if (limits) validateLimits('delegate.limits', limits, errors);
    if (termination) validateTermination('delegate.termination', termination, errors);
  }

  // 校验 host（0.2；默认关闭）
  if (config.host) {
    const { enabled, nodeId, limits } = config.host;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      errors.push({
        path: 'host.enabled',
        message: 'host.enabled must be a boolean',
        value: enabled,
      });
    }
    if (nodeId !== undefined && (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId))) {
      errors.push({
        path: 'host.nodeId',
        message: 'host.nodeId must be 1-64 chars of [A-Za-z0-9_-]',
        value: nodeId,
      });
    }
    if (limits) validateLimits('host.limits', limits, errors);
  }

  // 校验 scheduler（schema 层始终校验；host 关闭时由 bootstrap 告警忽略）
  if (config.scheduler) {
    const { maxConcurrency, maxQueueSize, perAgentSerial } = config.scheduler;
    if (
      maxConcurrency !== undefined &&
      (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0)
    ) {
      errors.push({
        path: 'scheduler.maxConcurrency',
        message: 'scheduler.maxConcurrency must be a positive integer',
        value: maxConcurrency,
      });
    }
    if (maxQueueSize !== undefined && (!Number.isInteger(maxQueueSize) || maxQueueSize <= 0)) {
      errors.push({
        path: 'scheduler.maxQueueSize',
        message: 'scheduler.maxQueueSize must be a positive integer',
        value: maxQueueSize,
      });
    }
    if (perAgentSerial !== undefined && typeof perAgentSerial !== 'boolean') {
      errors.push({
        path: 'scheduler.perAgentSerial',
        message: 'scheduler.perAgentSerial must be a boolean',
        value: perAgentSerial,
      });
    }
  }

  // 校验 transport（0.2；默认 in-process）
  if (config.transport) {
    const { kind, hostname, token, peersDir, heartbeatMs, peerTtlMs } = config.transport;

    if (kind !== undefined && kind !== 'in-process' && kind !== 'loopback') {
      errors.push({
        path: 'transport.kind',
        message: 'transport.kind must be "in-process" or "loopback"',
        value: kind,
      });
    }
    if (hostname !== undefined && !LOOPBACK_HOSTNAMES.has(hostname)) {
      errors.push({
        path: 'transport.hostname',
        message: 'transport.hostname must be a loopback address (127.0.0.1, localhost, ::1)',
        value: hostname,
      });
    }
    if (token !== undefined && (typeof token !== 'string' || token.trim() === '')) {
      errors.push({
        path: 'transport.token',
        message: 'transport.token must be a non-empty string',
        value: token,
      });
    }
    if (peersDir !== undefined && (typeof peersDir !== 'string' || peersDir.trim() === '')) {
      errors.push({
        path: 'transport.peersDir',
        message: 'transport.peersDir must be a non-empty string',
        value: peersDir,
      });
    }

    const heartbeatValid =
      heartbeatMs === undefined ||
      (typeof heartbeatMs === 'number' && Number.isInteger(heartbeatMs) && heartbeatMs > 0);
    if (!heartbeatValid) {
      errors.push({
        path: 'transport.heartbeatMs',
        message: 'transport.heartbeatMs must be a positive integer',
        value: heartbeatMs,
      });
    }
    const ttlValid =
      peerTtlMs === undefined ||
      (typeof peerTtlMs === 'number' && Number.isInteger(peerTtlMs) && peerTtlMs > 0);
    if (!ttlValid) {
      errors.push({
        path: 'transport.peerTtlMs',
        message: 'transport.peerTtlMs must be a positive integer',
        value: peerTtlMs,
      });
    }

    // DECISION-006 R6：peerTtlMs > heartbeatMs > 0，在 config 层早失败。
    if (heartbeatValid && ttlValid) {
      const effectiveHeartbeat = heartbeatMs ?? DEFAULT_TRANSPORT_OPTIONS.heartbeatMs ?? 0;
      const effectiveTtl = peerTtlMs ?? DEFAULT_TRANSPORT_OPTIONS.peerTtlMs ?? 0;
      if (effectiveTtl <= effectiveHeartbeat) {
        errors.push({
          path: 'transport.peerTtlMs',
          message: 'transport.peerTtlMs must be greater than transport.heartbeatMs',
          value: peerTtlMs,
        });
      }
    }
  }

  // 校验 team（0.1.0 显式 opt-in，默认关闭）
  if (config.team) {
    const { enabled, maxMembers, ownerId, model, memberLimits, memberTermination } = config.team;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      errors.push({
        path: 'team.enabled',
        message: 'team.enabled must be a boolean',
        value: enabled,
      });
    }
    if (maxMembers !== undefined && (!Number.isInteger(maxMembers) || maxMembers <= 0)) {
      errors.push({
        path: 'team.maxMembers',
        message: 'team.maxMembers must be a positive integer',
        value: maxMembers,
      });
    }
    if (ownerId !== undefined && typeof ownerId !== 'string') {
      errors.push({
        path: 'team.ownerId',
        message: 'team.ownerId must be a string',
        value: ownerId,
      });
    }
    if (model !== undefined && typeof model !== 'string') {
      errors.push({ path: 'team.model', message: 'team.model must be a string', value: model });
    }
    if (memberLimits) validateLimits('team.memberLimits', memberLimits, errors);
    if (memberTermination) validateTermination('team.memberTermination', memberTermination, errors);
  }

  // guardrails / hooks 在 0.1.0 尚未由装配层消费——明确警告，不静默忽略。
  if (config.guardrails && config.guardrails.length > 0) {
    warnings.push({
      path: 'guardrails',
      message: 'guardrails are declared but not applied in 0.1.0.',
      value: config.guardrails.length,
    });
  }
  if (config.hooks && config.hooks.length > 0) {
    warnings.push({
      path: 'hooks',
      message: 'hooks are declared but not applied in 0.1.0.',
      value: config.hooks.length,
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * 检查配置是否有未知键（camelCase，由 loader 映射后产出的对象）。
 * @param config 配置对象
 * @param knownKeys 已知键列表
 * @returns 未知键列表
 */
export function findUnknownKeys(config: object, knownKeys: string[]): string[] {
  return Object.keys(config).filter((key) => !knownKeys.includes(key));
}

/** 已知的配置键（camelCase，ADR-019） */
export const KNOWN_CONFIG_KEYS = [
  'apiKey',
  'provider',
  'agent',
  'guardrails',
  'hooks',
  'limits',
  'termination',
  'session',
  'context',
  'plugins',
  'update',
  'delegate',
  'team',
  'host',
  'scheduler',
  'transport',
];
