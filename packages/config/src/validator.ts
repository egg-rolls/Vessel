/**
 * Vessel 配置校验器
 * @module @vessel/config
 */

import { DEFAULT_TRANSPORT_OPTIONS } from './defaults.js';
import type {
  ConfigValidationError,
  ConfigValidationResult,
  ConfigValidationWarning,
  EvalsConfig,
  FeishuConfig,
  ObservabilityConfig,
  ServeConfig,
  TerminationConfig,
  UsageLimitsConfig,
  VesselConfig,
  WorkflowConfig,
} from './types.js';

/** Agent/Node ID 字符集（DECISION-005 U1：不含 `:`） */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** MCP server 名字符集（用于 `mcp__<server>__<tool>`） */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 允许的 loopback 主机名 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 是否为纯对象（非数组、非 null） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 是否为 string→string 的映射 */
function isStringMap(value: unknown): value is Record<string, string> {
  return (
    isPlainObject(value) &&
    Object.entries(value).every(([key, v]) => key.trim() !== '' && typeof v === 'string')
  );
}

/**
 * 是否为回环主机名。
 * 与 web/§4.3 一致：localhost、127.0.0.0/8、::1、[::1]。
 */
export function isLoopbackHostname(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return match?.slice(1).every((part) => Number(part) <= 255) === true;
}

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

/** 校验 workflow 块（0.4） */
function validateWorkflow(workflow: WorkflowConfig, errors: ConfigValidationError[]): void {
  const { enabled, dir, path, maxParallel, stepTimeoutMs } = workflow;

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    errors.push({
      path: 'workflow.enabled',
      message: 'workflow.enabled must be a boolean',
      value: enabled,
    });
  }
  if (dir !== undefined && (typeof dir !== 'string' || dir.trim() === '')) {
    errors.push({
      path: 'workflow.dir',
      message: 'workflow.dir must be a non-empty string',
      value: dir,
    });
  }
  if (path !== undefined && (typeof path !== 'string' || path.trim() === '')) {
    errors.push({
      path: 'workflow.path',
      message: 'workflow.path must be a non-empty string',
      value: path,
    });
  }
  if (
    maxParallel !== undefined &&
    (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8)
  ) {
    errors.push({
      path: 'workflow.maxParallel',
      message: 'workflow.maxParallel must be an integer between 1 and 8',
      value: maxParallel,
    });
  }
  if (
    stepTimeoutMs !== undefined &&
    (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs < 1 || stepTimeoutMs > 86400000)
  ) {
    errors.push({
      path: 'workflow.stepTimeoutMs',
      message: 'workflow.stepTimeoutMs must be an integer between 1 and 86400000',
      value: stepTimeoutMs,
    });
  }
}

/** 校验 evals 块（0.4） */
function validateEvals(evals: EvalsConfig, errors: ConfigValidationError[]): void {
  const { enabled, dir, outDir, allowNetwork } = evals;

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    errors.push({
      path: 'evals.enabled',
      message: 'evals.enabled must be a boolean',
      value: enabled,
    });
  }
  if (dir !== undefined && (typeof dir !== 'string' || dir.trim() === '')) {
    errors.push({ path: 'evals.dir', message: 'evals.dir must be a non-empty string', value: dir });
  }
  if (outDir !== undefined && (typeof outDir !== 'string' || outDir.trim() === '')) {
    errors.push({
      path: 'evals.outDir',
      message: 'evals.outDir must be a non-empty string',
      value: outDir,
    });
  }
  if (allowNetwork !== undefined && typeof allowNetwork !== 'boolean') {
    errors.push({
      path: 'evals.allowNetwork',
      message: 'evals.allowNetwork must be a boolean',
      value: allowNetwork,
    });
  }
}

/** 校验 feishu 块（0.4；0.4 已移除单 agent_id） */
function validateFeishu(feishu: FeishuConfig, errors: ConfigValidationError[]): void {
  const {
    enabled,
    appId,
    appSecret,
    domain,
    allowedChatIds,
    sessionPrefix,
    replyTimeoutMs,
    maxReplyChars,
    maxMembers,
  } = feishu;

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    errors.push({
      path: 'feishu.enabled',
      message: 'feishu.enabled must be a boolean',
      value: enabled,
    });
  }
  if (appId !== undefined && typeof appId !== 'string') {
    errors.push({ path: 'feishu.appId', message: 'feishu.appId must be a string', value: appId });
  }
  if (appSecret !== undefined && typeof appSecret !== 'string') {
    // 不把 secret 值放进 error
    errors.push({ path: 'feishu.appSecret', message: 'feishu.appSecret must be a string' });
  }
  if (domain !== undefined && domain !== 'feishu' && domain !== 'lark') {
    errors.push({
      path: 'feishu.domain',
      message: 'feishu.domain must be "feishu" or "lark"',
      value: domain,
    });
  }
  if (
    allowedChatIds !== undefined &&
    (!Array.isArray(allowedChatIds) ||
      allowedChatIds.some((id) => typeof id !== 'string' || id.trim() === ''))
  ) {
    errors.push({
      path: 'feishu.allowedChatIds',
      message: 'feishu.allowedChatIds must be an array of non-empty strings',
      value: allowedChatIds,
    });
  }
  if (
    sessionPrefix !== undefined &&
    (typeof sessionPrefix !== 'string' ||
      sessionPrefix.trim() === '' ||
      /\s/.test(sessionPrefix) ||
      sessionPrefix.includes(':') ||
      sessionPrefix.includes('/') ||
      sessionPrefix.includes('\\'))
  ) {
    errors.push({
      path: 'feishu.sessionPrefix',
      message: 'feishu.sessionPrefix must be non-empty without ":" or path separators',
      value: sessionPrefix,
    });
  }
  if (
    replyTimeoutMs !== undefined &&
    (!Number.isInteger(replyTimeoutMs) || replyTimeoutMs < 1 || replyTimeoutMs > 86400000)
  ) {
    errors.push({
      path: 'feishu.replyTimeoutMs',
      message: 'feishu.replyTimeoutMs must be an integer between 1 and 86400000',
      value: replyTimeoutMs,
    });
  }
  if (
    maxReplyChars !== undefined &&
    (!Number.isInteger(maxReplyChars) || maxReplyChars < 1 || maxReplyChars > 100000)
  ) {
    errors.push({
      path: 'feishu.maxReplyChars',
      message: 'feishu.maxReplyChars must be an integer between 1 and 100000',
      value: maxReplyChars,
    });
  }
  if (
    maxMembers !== undefined &&
    (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 64)
  ) {
    errors.push({
      path: 'feishu.maxMembers',
      message: 'feishu.maxMembers must be an integer between 1 and 64',
      value: maxMembers,
    });
  }

  // 启用态必填：env 已在 loader 合并，这里只看最终 config。
  if (enabled === true) {
    if (typeof appId !== 'string' || appId.trim() === '') {
      errors.push({
        path: 'feishu.appId',
        message: 'feishu.appId is required when feishu.enabled is true',
      });
    }
    if (typeof appSecret !== 'string' || appSecret.trim() === '') {
      errors.push({
        path: 'feishu.appSecret',
        message: 'feishu.appSecret is required when feishu.enabled is true',
      });
    }
  }
}

/** 校验 observability 块（0.4） */
function validateObservability(
  observability: ObservabilityConfig,
  errors: ConfigValidationError[],
): void {
  const { eventHistory, metrics } = observability;

  if (eventHistory !== undefined && (!Number.isInteger(eventHistory) || eventHistory < 0)) {
    errors.push({
      path: 'observability.eventHistory',
      message: 'observability.eventHistory must be a non-negative integer',
      value: eventHistory,
    });
  }
  if (metrics !== undefined && typeof metrics !== 'boolean') {
    errors.push({
      path: 'observability.metrics',
      message: 'observability.metrics must be a boolean',
      value: metrics,
    });
  }
}

/** mcpServers 中单个 server 的已知键 */
const MCP_SERVER_KEYS = [
  'transport',
  'command',
  'args',
  'env',
  'url',
  'headers',
  'enabled',
  'connectTimeoutMs',
  'toolTimeoutMs',
  'toolPrefix',
  'autoApproveTools',
] as const;

/** 校验单个 MCP server 配置 */
function validateMcpServer(
  name: string,
  raw: unknown,
  errors: ConfigValidationError[],
  warnings: ConfigValidationWarning[],
): void {
  const prefix = `mcpServers.${name}`;

  if (!MCP_SERVER_NAME_RE.test(name)) {
    errors.push({
      path: prefix,
      message: `MCP server name "${name}" must be 1-64 chars of [A-Za-z0-9_-]`,
      value: name,
    });
  }

  if (!isPlainObject(raw)) {
    errors.push({
      path: prefix,
      message: `${prefix} must be an object`,
      value: raw,
    });
    return;
  }

  const cfg = raw as Record<string, unknown>;
  const transport = cfg.transport;
  if (transport !== 'stdio' && transport !== 'http') {
    errors.push({
      path: `${prefix}.transport`,
      message: `${prefix}.transport must be "stdio" or "http"`,
      value: transport,
    });
  }

  const commandInvalid = typeof cfg.command !== 'string' || cfg.command.trim() === '';
  if (transport === 'stdio' && commandInvalid) {
    errors.push({
      path: `${prefix}.command`,
      message: `${prefix}.command is required for transport "stdio"`,
      value: cfg.command,
    });
  }
  if (transport === 'stdio' && cfg.url !== undefined) {
    warnings.push({
      path: `${prefix}.url`,
      message: `${prefix}.url is ignored for transport "stdio"`,
      value: cfg.url,
    });
  }

  const urlInvalid = typeof cfg.url !== 'string' || !/^https?:\/\//.test(cfg.url);
  if (transport === 'http' && urlInvalid) {
    errors.push({
      path: `${prefix}.url`,
      message: `${prefix}.url must be an http(s) URL for transport "http"`,
      value: cfg.url,
    });
  }
  if (
    transport === 'http' &&
    (cfg.command !== undefined || cfg.args !== undefined || cfg.env !== undefined)
  ) {
    warnings.push({
      path: `${prefix}.command`,
      message: `${prefix}.command/args/env are ignored for transport "http"`,
      value: cfg.command,
    });
  }

  if (cfg.args !== undefined) {
    if (!Array.isArray(cfg.args) || cfg.args.some((v) => typeof v !== 'string')) {
      errors.push({
        path: `${prefix}.args`,
        message: `${prefix}.args must be an array of strings`,
        value: cfg.args,
      });
    }
  }
  if (cfg.env !== undefined && !isStringMap(cfg.env)) {
    errors.push({
      path: `${prefix}.env`,
      message: `${prefix}.env must be a mapping of non-empty names to strings`,
      value: cfg.env,
    });
  }
  if (cfg.headers !== undefined && !isStringMap(cfg.headers)) {
    errors.push({
      path: `${prefix}.headers`,
      message: `${prefix}.headers must be a mapping of non-empty names to strings`,
      value: cfg.headers,
    });
  }
  if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean') {
    errors.push({
      path: `${prefix}.enabled`,
      message: `${prefix}.enabled must be a boolean`,
      value: cfg.enabled,
    });
  }
  if (cfg.toolPrefix !== undefined && typeof cfg.toolPrefix !== 'boolean') {
    errors.push({
      path: `${prefix}.toolPrefix`,
      message: `${prefix}.toolPrefix must be a boolean`,
      value: cfg.toolPrefix,
    });
  }
  for (const key of ['connectTimeoutMs', 'toolTimeoutMs'] as const) {
    const value = cfg[key];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
      errors.push({
        path: `${prefix}.${key}`,
        message: `${prefix}.${key} must be a positive integer`,
        value,
      });
    }
  }
  if (cfg.autoApproveTools !== undefined) {
    if (
      !Array.isArray(cfg.autoApproveTools) ||
      cfg.autoApproveTools.some((v) => typeof v !== 'string')
    ) {
      errors.push({
        path: `${prefix}.autoApproveTools`,
        message: `${prefix}.autoApproveTools must be an array of strings`,
        value: cfg.autoApproveTools,
      });
    }
  }
}

/**
 * 校验 serve 块（schema 层；文件存在性由启动前检查）。
 * 非回环必须 `allowRemote: true`；TLS 必须 cert/key 成对。
 * @param errors 可选的目标数组；缺省返回新数组
 */
export function validateServeSettings(
  serve: ServeConfig,
  errors: ConfigValidationError[] = [],
): ConfigValidationError[] {
  const { hostname, port, allowRemote, tls } = serve as Record<string, unknown>;

  if (hostname !== undefined) {
    const invalid =
      typeof hostname !== 'string' ||
      hostname.trim() === '' ||
      /\s/.test(hostname) ||
      hostname.includes('/') ||
      hostname.includes('://');
    if (invalid) {
      errors.push({
        path: 'serve.hostname',
        message: 'serve.hostname must be a host name or IP address (no scheme or path)',
        value: hostname,
      });
    }
  }

  if (
    port !== undefined &&
    (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    errors.push({
      path: 'serve.port',
      message: 'serve.port must be an integer between 0 and 65535',
      value: port,
    });
  }

  if (allowRemote !== undefined && typeof allowRemote !== 'boolean') {
    errors.push({
      path: 'serve.allowRemote',
      message: 'serve.allowRemote must be a boolean',
      value: allowRemote,
    });
  }

  if (
    typeof hostname === 'string' &&
    !/\s/.test(hostname) &&
    hostname.trim() !== '' &&
    !isLoopbackHostname(hostname) &&
    allowRemote !== true
  ) {
    errors.push({
      path: 'serve.allowRemote',
      message:
        `Refusing to listen on non-loopback hostname "${hostname}": ` +
        'set serve.allow_remote=true to expose the gateway.',
      value: allowRemote,
    });
  }

  if (tls !== undefined) {
    if (!isPlainObject(tls)) {
      errors.push({ path: 'serve.tls', message: 'serve.tls must be an object', value: tls });
    } else {
      const cert = tls.certFile;
      const key = tls.keyFile;
      const certInvalid = typeof cert !== 'string' || cert.trim() === '';
      const keyInvalid = typeof key !== 'string' || key.trim() === '';
      if (certInvalid || keyInvalid) {
        if (certInvalid) {
          errors.push({
            path: 'serve.tls.certFile',
            message: 'serve.tls requires both cert_file and key_file',
            value: cert,
          });
        }
        if (keyInvalid) {
          errors.push({
            path: 'serve.tls.keyFile',
            message: 'serve.tls requires both cert_file and key_file',
            value: key,
          });
        }
      }
    }
  }

  return errors;
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
    const { enabled, ownerId, model, memberLimits, memberTermination } = config.team;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      errors.push({
        path: 'team.enabled',
        message: 'team.enabled must be a boolean',
        value: enabled,
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

  // 校验 mcpServers（0.3；map 键为 server 名）
  if (config.mcpServers !== undefined) {
    if (!isPlainObject(config.mcpServers)) {
      errors.push({
        path: 'mcpServers',
        message: 'mcpServers must be a mapping of server name to server config',
        value: config.mcpServers,
      });
    } else {
      for (const [name, raw] of Object.entries(config.mcpServers)) {
        validateMcpServer(name, raw, errors, warnings);
      }
    }
  }

  // 校验 durable（0.3；默认关闭）
  if (config.durable) {
    const { enabled, backend, path, checkpointEvery } = config.durable;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      errors.push({
        path: 'durable.enabled',
        message: 'durable.enabled must be a boolean',
        value: enabled,
      });
    }
    if (backend !== undefined && backend !== 'file' && backend !== 'memory') {
      errors.push({
        path: 'durable.backend',
        message: 'durable.backend must be "file" or "memory"',
        value: backend,
      });
    }
    if (path !== undefined && (typeof path !== 'string' || path.trim() === '')) {
      errors.push({
        path: 'durable.path',
        message: 'durable.path must be a non-empty string',
        value: path,
      });
    }
    if (checkpointEvery !== undefined && checkpointEvery !== 'iteration') {
      errors.push({
        path: 'durable.checkpointEvery',
        message: 'durable.checkpointEvery must be "iteration" in 0.3',
        value: checkpointEvery,
      });
    }
  }

  // 校验 serve（0.3；默认回环 + 明文）
  if (config.serve) {
    validateServeSettings(config.serve, errors);
  }

  // 校验 0.4 四块；块缺省时不做任何事（保持 0.3 行为）。
  if (config.workflow) validateWorkflow(config.workflow, errors);
  if (config.evals) validateEvals(config.evals, errors);
  if (config.feishu) validateFeishu(config.feishu, errors);
  if (config.observability) validateObservability(config.observability, errors);

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

/** 已知的配置块键（camelCase，ADR-019）；用于嵌套未知键检查 */
export const KNOWN_BLOCK_KEYS: Readonly<Record<string, readonly string[]>> = {
  provider: ['name', 'apiKey', 'baseUrl', 'model', 'temperature', 'maxTokens', 'timeoutMs'],
  agent: ['name', 'systemPrompt', 'model', 'temperature', 'maxTokens'],
  session: ['backend', 'storagePath', 'maxHistory'],
  update: ['autoCheck', 'channel', 'source'],
  delegate: [
    'enabled',
    'maxDepth',
    'disallowed',
    'model',
    'termination',
    'limits',
    'permissionMode',
    'readOnlyTools',
  ],
  host: ['enabled', 'nodeId', 'limits'],
  scheduler: ['maxConcurrency', 'maxQueueSize', 'perAgentSerial'],
  transport: ['kind', 'hostname', 'token', 'peersDir', 'heartbeatMs', 'peerTtlMs'],
  team: ['enabled', 'ownerId', 'model', 'memberLimits', 'memberTermination'],
  durable: ['enabled', 'backend', 'path', 'checkpointEvery'],
  serve: ['hostname', 'port', 'allowRemote', 'tls'],
  workflow: ['enabled', 'dir', 'path', 'maxParallel', 'stepTimeoutMs'],
  evals: ['enabled', 'dir', 'outDir', 'allowNetwork'],
  feishu: [
    'enabled',
    'appId',
    'appSecret',
    'domain',
    'allowedChatIds',
    'sessionPrefix',
    'replyTimeoutMs',
    'maxReplyChars',
    'maxMembers',
  ],
  observability: ['eventHistory', 'metrics'],
};

/** serve.tls 的已知键 */
const KNOWN_TLS_KEYS = ['certFile', 'keyFile'] as const;

export interface UnknownNestedKey {
  /** 完整路径（camelCase），如 `durable.foo` */
  path: string;
  key: string;
  block: string;
}

/**
 * 找出已知配置块内的未知键（以及 mcpServers 每个 server 内的未知键）。
 * 顶层未知键仍由 `findUnknownKeys` 负责。
 */
export function findUnknownNestedKeys(config: Record<string, unknown>): UnknownNestedKey[] {
  const unknown: UnknownNestedKey[] = [];

  for (const [block, known] of Object.entries(KNOWN_BLOCK_KEYS)) {
    const value = config[block];
    if (!isPlainObject(value)) continue;
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) unknown.push({ path: `${block}.${key}`, key, block });
    }
  }

  const tls = isPlainObject(config.serve) ? config.serve.tls : undefined;
  if (isPlainObject(tls)) {
    for (const key of Object.keys(tls)) {
      if (!KNOWN_TLS_KEYS.includes(key as (typeof KNOWN_TLS_KEYS)[number])) {
        unknown.push({ path: `serve.tls.${key}`, key, block: 'serve.tls' });
      }
    }
  }

  const servers = config.mcpServers;
  if (isPlainObject(servers)) {
    for (const [name, server] of Object.entries(servers)) {
      if (!isPlainObject(server)) continue;
      for (const key of Object.keys(server)) {
        if (!(MCP_SERVER_KEYS as readonly string[]).includes(key)) {
          unknown.push({ path: `mcpServers.${name}.${key}`, key, block: 'mcpServers' });
        }
      }
    }
  }

  return unknown;
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
  'mcpServers',
  'durable',
  'serve',
  'workflow',
  'evals',
  'feishu',
  'observability',
];
