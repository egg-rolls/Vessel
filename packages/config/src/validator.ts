/**
 * Vessel 配置校验器
 * @module @vessel-agent/config
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
  ServeTokenEntry,
  TenantConfig,
  TenantSettings,
  TerminationConfig,
  TraceConfig,
  UsageLimitsConfig,
  VesselConfig,
  WorkflowConfig,
} from './types.js';

/** Agent/Node ID 字符集（DECISION-005 U1：不含 `:`） */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** tenant id 字符集（DECISION-010 §2.5） */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 合法环境变量名（_env 间接引用） */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

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
  validateEnvName('feishu.appSecretEnv', feishu.appSecretEnv, errors);
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

/** 校验 observability 块（0.4；0.14 showProcessErrors） */
function validateObservability(
  observability: ObservabilityConfig,
  errors: ConfigValidationError[],
): void {
  const { eventHistory, metrics, showProcessErrors } = observability;

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
  if (showProcessErrors !== undefined && typeof showProcessErrors !== 'boolean') {
    errors.push({
      path: 'observability.showProcessErrors',
      message: 'observability.showProcessErrors must be a boolean',
      value: showProcessErrors,
    });
  }
}

/** `ui.statusBars` 允许值（0.13） */
const UI_STATUS_BARS: ReadonlySet<string> = new Set(['top', 'bottom', 'both', 'none']);

/** `ui.verbosity` 允许值（0.14） */
const UI_VERBOSITY: ReadonlySet<string> = new Set(['minimal', 'normal', 'debug']);

/** `ui.errorLevel` 允许值（0.14） */
const UI_ERROR_LEVELS: ReadonlySet<string> = new Set(['user', 'all']);

/** 校验 ui 块（0.8.5 language；0.11 clearOnStart；0.11.1 showReasoning；0.13/0.14 可见性；0.15 askUser） */
function validateUi(ui: Record<string, unknown>, errors: ConfigValidationError[]): void {
  if (!isPlainObject(ui)) {
    errors.push({ path: 'ui', message: 'ui must be an object', value: ui });
    return;
  }
  if (ui.language !== undefined && typeof ui.language !== 'string') {
    errors.push({
      path: 'ui.language',
      message: 'ui.language must be a string',
      value: ui.language,
    });
  }
  if (ui.clearOnStart !== undefined && typeof ui.clearOnStart !== 'boolean') {
    errors.push({
      path: 'ui.clearOnStart',
      message: 'ui.clearOnStart must be a boolean',
      value: ui.clearOnStart,
    });
  }
  if (ui.showReasoning !== undefined && typeof ui.showReasoning !== 'boolean') {
    errors.push({
      path: 'ui.showReasoning',
      message: 'ui.showReasoning must be a boolean',
      value: ui.showReasoning,
    });
  }
  if (
    ui.statusBars !== undefined &&
    (typeof ui.statusBars !== 'string' || !UI_STATUS_BARS.has(ui.statusBars))
  ) {
    errors.push({
      path: 'ui.statusBars',
      message: 'ui.statusBars must be one of "top", "bottom", "both", "none"',
      value: ui.statusBars,
    });
  }
  if (
    ui.verbosity !== undefined &&
    (typeof ui.verbosity !== 'string' || !UI_VERBOSITY.has(ui.verbosity))
  ) {
    errors.push({
      path: 'ui.verbosity',
      message: 'ui.verbosity must be one of "minimal", "normal", "debug"',
      value: ui.verbosity,
    });
  }
  if (ui.showInternalEvents !== undefined && typeof ui.showInternalEvents !== 'boolean') {
    errors.push({
      path: 'ui.showInternalEvents',
      message: 'ui.showInternalEvents must be a boolean',
      value: ui.showInternalEvents,
    });
  }
  if (
    ui.errorLevel !== undefined &&
    (typeof ui.errorLevel !== 'string' || !UI_ERROR_LEVELS.has(ui.errorLevel))
  ) {
    errors.push({
      path: 'ui.errorLevel',
      message: 'ui.errorLevel must be one of "user", "all"',
      value: ui.errorLevel,
    });
  }
  if (ui.askUser !== undefined && typeof ui.askUser !== 'boolean') {
    errors.push({
      path: 'ui.askUser',
      message: 'ui.askUser must be a boolean',
      value: ui.askUser,
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
 * 0.6：校验一个浏览器 Origin。
 * 只接受绝对 http(s) origin；禁止 `*` / userinfo / path / query / hash；
 * 非回环必须 https。返回错误消息，合法返回 null。
 */
export function allowedOriginError(value: string): string | null {
  if (value.trim() === '' || value === '*') return 'origin must be an absolute http(s) origin';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'origin must be an absolute http(s) origin';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'origin must use http or https';
  }
  if (url.username !== '' || url.password !== '') return 'origin must not contain userinfo';
  if (url.pathname !== '/' && url.pathname !== '') return 'origin must not contain a path';
  if (url.search !== '' || url.hash !== '') return 'origin must not contain query or hash';
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    return 'non-loopback origins must use https';
  }
  return null;
}

/** 0.6：校验节点 URL（与 HttpRpcClient 的 baseUrl 规则一致）。 */
function nodeUrlError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute http(s) URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'must use http or https';
  }
  if (url.username !== '' || url.password !== '') return 'must not contain userinfo';
  if (url.pathname !== '/' && url.pathname !== '') return 'must not contain a path';
  if (url.search !== '' || url.hash !== '') return 'must not contain query or hash';
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    return 'non-loopback nodes must use https';
  }
  return null;
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
  const { hostname, port, allowRemote, tls, token, tokenEnv, tokens, adminToken, adminTokenEnv } =
    serve as Record<string, unknown>;

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

  // 0.6：独立前端 Origin allowlist（YAML：serve.allowed_origins）。
  const allowedOrigins = (serve as Record<string, unknown>).allowedOrigins;
  if (allowedOrigins !== undefined) {
    if (!Array.isArray(allowedOrigins)) {
      errors.push({
        path: 'serve.allowedOrigins',
        message: 'serve.allowedOrigins must be an array of origins',
      });
    } else {
      allowedOrigins.forEach((origin, index) => {
        const message =
          typeof origin === 'string' ? allowedOriginError(origin) : 'origin must be a string';
        if (message !== null) {
          errors.push({
            path: `serve.allowedOrigins[${index}]`,
            message: `serve.allowedOrigins[${index}] ${message}`,
            // origin 不是密钥，可回显
            value: origin,
          });
        }
      });
    }
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

  // DECISION-014 §2.1：非回环必须 TLS；不提供明文逃生口。
  if (
    typeof hostname === 'string' &&
    !/\s/.test(hostname) &&
    hostname.trim() !== '' &&
    !isLoopbackHostname(hostname) &&
    allowRemote === true &&
    tls === undefined
  ) {
    errors.push({
      path: 'serve.tls',
      message:
        `Refusing to expose non-loopback gateway "${hostname}" without TLS: ` +
        'set serve.tls.cert_file and serve.tls.key_file.',
    });
  }

  validateEnvName('serve.tokenEnv', tokenEnv, errors);
  validateEnvName('serve.adminTokenEnv', adminTokenEnv, errors);

  if (token !== undefined && (typeof token !== 'string' || token.trim() === '')) {
    // 不把 token 值放进 error
    errors.push({ path: 'serve.token', message: 'serve.token must be a non-empty string' });
  }
  if (adminToken !== undefined && (typeof adminToken !== 'string' || adminToken.trim() === '')) {
    errors.push({
      path: 'serve.adminToken',
      message: 'serve.adminToken must be a non-empty string',
    });
  }

  if (tokens !== undefined) {
    if (!isPlainObject(tokens)) {
      errors.push({ path: 'serve.tokens', message: 'serve.tokens must be a mapping' });
    } else {
      for (const [rawToken, rawEntry] of Object.entries(tokens)) {
        // 永不把 token 键写进 error / message。
        if (rawToken.trim() === '') {
          errors.push({
            path: 'serve.tokens',
            message: 'serve.tokens must not contain an empty token key',
          });
          continue;
        }
        if (!isPlainObject(rawEntry)) {
          errors.push({
            path: 'serve.tokens.<entry>',
            message: 'serve.tokens entries must be objects',
          });
          continue;
        }
        const entry = rawEntry as ServeTokenEntry;
        if (entry.role !== undefined && !['read', 'write', 'admin'].includes(entry.role)) {
          errors.push({
            path: 'serve.tokens.<entry>.role',
            message: 'serve.tokens role must be "read", "write", or "admin"',
          });
        }
        if (entry.tenantId !== undefined) {
          if (typeof entry.tenantId !== 'string') {
            errors.push({
              path: 'serve.tokens.<entry>.tenantId',
              message: 'serve.tokens tenantId must be a string',
            });
          } else if (entry.tenantId !== '*' && !isValidTenantId(entry.tenantId)) {
            errors.push({
              path: 'serve.tokens.<entry>.tenantId',
              message: 'serve.tokens tenantId must be a valid tenant id or "*"',
            });
          } else if (entry.tenantId === '*' && entry.role !== 'admin') {
            errors.push({
              path: 'serve.tokens.<entry>.tenantId',
              message: 'serve.tokens tenantId "*" requires role "admin"',
            });
          }
        }
      }
    }
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

/** tenant id 是否合法（除正则外显式拒绝路径穿越） */
export function isValidTenantId(value: string): boolean {
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false;
  return TENANT_ID_RE.test(value);
}

/** 校验 `_env` 字段：空串视为未设置（交给解析层），其余必须匹配环境变量名 */
function validateEnvName(path: string, value: unknown, errors: ConfigValidationError[]): void {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string' || !ENV_NAME_RE.test(value)) {
    errors.push({
      path,
      message: `${path} must be a valid environment variable name`,
    });
  }
}

/** tenant overlay 允许的顶层块（DECISION-010 §11.4） */
export const TENANT_OVERLAY_ALLOWED_KEYS: readonly string[] = [
  'provider',
  'agent',
  'context',
  'limits',
  'termination',
  'session',
  'permission',
  'plugins',
  'workflow',
  'evals',
  'feishu',
  'tools',
  'mcpServers',
  'delegate',
  'team',
  'host',
  'scheduler',
  'transport',
  'quota',
];

/** tenant overlay 明确禁止的块（全局或安全相关） */
export const TENANT_OVERLAY_FORBIDDEN_KEYS: readonly string[] = [
  'dataDir',
  'trace',
  'serve',
  'connect',
  'tenant',
  'update',
];

/** 顶层密钥字段（YAML camelCase 路径）；只返回路径，不返回任何值。 */
export function findExplicitSecretPaths(config: Record<string, unknown>, prefix = ''): string[] {
  const found: string[] = [];
  const at = (path: string): string => (prefix === '' ? path : `${prefix}.${path}`);
  const check = (holder: unknown, key: string, path: string): void => {
    if (!isPlainObject(holder)) return;
    const value = holder[key];
    if (value !== undefined && value !== null && value !== '') found.push(at(path));
  };

  check(config, 'apiKey', 'apiKey');
  check(config.provider, 'apiKey', 'provider.apiKey');
  check(config.feishu, 'appSecret', 'feishu.appSecret');
  check(config.serve, 'token', 'serve.token');
  check(config.serve, 'adminToken', 'serve.adminToken');
  check(config.transport, 'token', 'transport.token');
  check(config.connect, 'token', 'connect.token');
  if (isPlainObject(config.serve) && isPlainObject(config.serve.tokens)) {
    if (Object.keys(config.serve.tokens).length > 0) found.push(at('serve.tokens'));
  }
  if (isPlainObject(config.transport) && Array.isArray(config.transport.nodes)) {
    config.transport.nodes.forEach((node, index) => {
      if (
        isPlainObject(node) &&
        node.token !== undefined &&
        node.token !== null &&
        node.token !== ''
      ) {
        found.push(at(`transport.nodes[${index}].token`));
      }
    });
  }

  return found;
}

/** 递归找出 overlay 内的 null（不允许进入合并），返回路径 */
function findNullPaths(value: unknown, path: string[]): string[] {
  if (value === null) return [path.join('.')];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findNullPaths(item, [...path, String(index)]));
  }
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => findNullPaths(child, [...path, key]));
}

/** 校验 trace 块（0.5） */
function validateTrace(trace: TraceConfig, errors: ConfigValidationError[]): void {
  const { enabled, level, retentionDays, maxRuns, maxBytes, includeStreamChunks } = trace;

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    errors.push({
      path: 'trace.enabled',
      message: 'trace.enabled must be a boolean',
      value: enabled,
    });
  }
  if (level !== undefined && level !== 'full' && level !== 'metadata' && level !== 'off') {
    errors.push({
      path: 'trace.level',
      message: 'trace.level must be "full", "metadata", or "off"',
      value: level,
    });
  }
  if (retentionDays !== undefined && (!Number.isInteger(retentionDays) || retentionDays < 1)) {
    errors.push({
      path: 'trace.retentionDays',
      message: 'trace.retentionDays must be a positive integer',
      value: retentionDays,
    });
  }
  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns < 0)) {
    errors.push({
      path: 'trace.maxRuns',
      message: 'trace.maxRuns must be a non-negative integer',
      value: maxRuns,
    });
  }
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 0)) {
    errors.push({
      path: 'trace.maxBytes',
      message: 'trace.maxBytes must be a non-negative integer (0 = unlimited)',
      value: maxBytes,
    });
  }
  if (includeStreamChunks !== undefined && typeof includeStreamChunks !== 'boolean') {
    errors.push({
      path: 'trace.includeStreamChunks',
      message: 'trace.includeStreamChunks must be a boolean',
      value: includeStreamChunks,
    });
  }
}

const TENANT_SETTINGS_KEYS = ['name', 'status', 'quota', 'tools', 'config'];
const TENANT_QUOTA_KEYS = ['maxSessions', 'maxRunsPerDay', 'maxConcurrentRuns', 'maxStorageBytes'];

/** 校验 tenant 块与 overlay 白名单（0.5） */
function validateTenant(tenant: TenantConfig, errors: ConfigValidationError[]): void {
  if (tenant.default !== undefined) {
    if (typeof tenant.default !== 'string' || !isValidTenantId(tenant.default)) {
      errors.push({
        path: 'tenant.default',
        message: 'tenant.default must match ^[a-z0-9][a-z0-9_-]{0,63}$',
        value: tenant.default,
      });
    }
  }

  if (tenant.tenants === undefined) return;
  if (!isPlainObject(tenant.tenants)) {
    errors.push({
      path: 'tenant.tenants',
      message: 'tenant.tenants must be a mapping of tenant id to settings',
    });
    return;
  }

  for (const [id, rawSettings] of Object.entries(tenant.tenants)) {
    const settingsPath = `tenant.tenants.${id}`;
    if (!isValidTenantId(id)) {
      errors.push({
        path: settingsPath,
        message: 'tenant id must match ^[a-z0-9][a-z0-9_-]{0,63}$',
      });
    }
    if (!isPlainObject(rawSettings)) {
      errors.push({ path: settingsPath, message: 'tenant settings must be an object' });
      continue;
    }

    const settings = rawSettings as TenantSettings;
    for (const key of Object.keys(rawSettings)) {
      if (!TENANT_SETTINGS_KEYS.includes(key)) {
        errors.push({
          path: `${settingsPath}.${key}`,
          message: `Unknown tenant setting "${key}"`,
        });
      }
    }

    if (settings.name !== undefined && typeof settings.name !== 'string') {
      errors.push({ path: `${settingsPath}.name`, message: 'tenant name must be a string' });
    }
    if (
      settings.status !== undefined &&
      settings.status !== 'active' &&
      settings.status !== 'disabled'
    ) {
      errors.push({
        path: `${settingsPath}.status`,
        message: 'tenant status must be "active" or "disabled"',
        value: settings.status,
      });
    }

    if (settings.quota !== undefined) {
      if (!isPlainObject(settings.quota)) {
        errors.push({ path: `${settingsPath}.quota`, message: 'tenant quota must be an object' });
      } else {
        for (const [key, value] of Object.entries(settings.quota)) {
          if (!TENANT_QUOTA_KEYS.includes(key)) {
            errors.push({
              path: `${settingsPath}.quota.${key}`,
              message: `Unknown tenant quota key "${key}"`,
            });
          } else if (!Number.isInteger(value) || (value as number) < 0) {
            errors.push({
              path: `${settingsPath}.quota.${key}`,
              message: 'tenant quota values must be non-negative integers',
              value,
            });
          }
        }
      }
    }

    if (settings.tools !== undefined) {
      const tools = settings.tools as Record<string, unknown>;
      if (!isPlainObject(tools)) {
        errors.push({ path: `${settingsPath}.tools`, message: 'tenant tools must be an object' });
      } else {
        for (const [listKey, list] of Object.entries(tools)) {
          if (listKey !== 'allow' && listKey !== 'deny') {
            errors.push({
              path: `${settingsPath}.tools.${listKey}`,
              message: `Unknown tenant tools key "${listKey}"`,
            });
          } else if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
            errors.push({
              path: `${settingsPath}.tools.${listKey}`,
              message: `tenant tools.${listKey} must be an array of strings`,
            });
          }
        }
      }
    }

    if (settings.config !== undefined) {
      const overlay = settings.config as unknown;
      const overlayPath = `${settingsPath}.config`;
      if (!isPlainObject(overlay)) {
        errors.push({ path: overlayPath, message: 'tenant config overlay must be an object' });
        continue;
      }

      for (const nullPath of findNullPaths(overlay, [])) {
        errors.push({
          path: `${overlayPath}.${nullPath}`,
          message: 'null is not allowed in a tenant config overlay',
        });
      }

      for (const key of Object.keys(overlay)) {
        if (TENANT_OVERLAY_ALLOWED_KEYS.includes(key)) continue;
        errors.push({
          path: `${overlayPath}.${key}`,
          message: TENANT_OVERLAY_FORBIDDEN_KEYS.includes(key)
            ? `"${key}" is not allowed in a tenant config overlay`
            : `Unknown tenant overlay key "${key}"`,
        });
      }

      for (const secretPath of findExplicitSecretPaths(overlay, overlayPath)) {
        errors.push({
          path: secretPath,
          message: 'Tenant overlay may contain secrets only via the _env form',
        });
      }

      validateEnvName(`${overlayPath}.apiKeyEnv`, overlay.apiKeyEnv, errors);
      validateEnvName(
        `${overlayPath}.provider.apiKeyEnv`,
        isPlainObject(overlay.provider) ? overlay.provider.apiKeyEnv : undefined,
        errors,
      );
      validateEnvName(
        `${overlayPath}.feishu.appSecretEnv`,
        isPlainObject(overlay.feishu) ? overlay.feishu.appSecretEnv : undefined,
        errors,
      );
    }
  }
}

/** 校验 mcpServers env / headers 的 `_env` 键（0.5） */
function validateMcpEnvRefs(
  servers: Record<string, unknown>,
  errors: ConfigValidationError[],
): void {
  for (const [name, server] of Object.entries(servers)) {
    if (!isPlainObject(server)) continue;
    for (const mapKey of ['env', 'headers'] as const) {
      const map = server[mapKey];
      if (!isPlainObject(map)) continue;
      for (const [key, value] of Object.entries(map)) {
        if (!key.endsWith('_env')) continue;
        const path = `mcpServers.${name}.${mapKey}.${key}`;
        if (key === '_env') {
          errors.push({
            path,
            message: `"${mapKey}._env" is missing a target key name`,
          });
          continue;
        }
        validateEnvName(path, value, errors);
      }
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

  // 未知键（0.5）：顶层与已知块内都按 error 处理。
  for (const key of findUnknownKeys(config, KNOWN_CONFIG_KEYS)) {
    const suggestion = closestKey(key, KNOWN_CONFIG_KEYS);
    errors.push({
      path: key,
      message: suggestion
        ? `Unknown configuration key "${key}". Did you mean "${suggestion}"?`
        : `Unknown configuration key "${key}".`,
      value: key,
    });
  }
  for (const { path, key, block } of findUnknownNestedKeys(
    config as unknown as Record<string, unknown>,
  )) {
    const candidates = KNOWN_BLOCK_KEYS[block] ?? [];
    const suggestion = closestKey(key, [...candidates]);
    errors.push({
      path,
      message: suggestion
        ? `Unknown configuration key "${path}". Did you mean "${suggestion}"?`
        : `Unknown configuration key "${path}".`,
      value: key,
    });
  }

  // 校验 dataDir（0.5；全局数据根）
  if (config.dataDir !== undefined) {
    if (typeof config.dataDir !== 'string' || config.dataDir.trim() === '') {
      errors.push({
        path: 'dataDir',
        message: 'dataDir must be a non-empty string',
        value: config.dataDir,
      });
    } else if (config.dataDir.includes('\0')) {
      errors.push({ path: 'dataDir', message: 'dataDir must not contain NUL' });
    }
  }

  validateEnvName('apiKeyEnv', config.apiKeyEnv, errors);

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
    validateEnvName('provider.apiKeyEnv', config.provider.apiKeyEnv, errors);
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

    // 0.11.1：默认工作目录。只校验类型/非空；`~` 与相对路径由装配层解析。
    if (
      config.agent.cwd !== undefined &&
      (typeof config.agent.cwd !== 'string' || config.agent.cwd.trim() === '')
    ) {
      errors.push({
        path: 'agent.cwd',
        message: 'agent.cwd must be a non-empty string',
        value: config.agent.cwd,
      });
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

    // 0.16：canonical agent 工具与成员回复策略。非法值拒绝，不静默回退默认。
    if (config.agent.enabled !== undefined && typeof config.agent.enabled !== 'boolean') {
      errors.push({
        path: 'agent.enabled',
        message: 'agent.enabled must be a boolean',
        value: config.agent.enabled,
      });
    }
    const visibility = config.agent.defaultVisibility;
    if (visibility !== undefined && !['private', 'team', 'tenant'].includes(visibility)) {
      errors.push({
        path: 'agent.defaultVisibility',
        message: 'agent.defaultVisibility must be "private", "team" or "tenant"',
        value: visibility,
      });
    }
    if (
      config.agent.followReplies !== undefined &&
      typeof config.agent.followReplies !== 'boolean'
    ) {
      errors.push({
        path: 'agent.followReplies',
        message: 'agent.followReplies must be a boolean',
        value: config.agent.followReplies,
      });
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

  // 校验 permission（0.6.1）：免确认工具名
  if (config.permission !== undefined) {
    if (!isPlainObject(config.permission)) {
      errors.push({ path: 'permission', message: 'permission must be an object' });
    } else {
      const { autoApprove } = config.permission;
      if (autoApprove !== undefined) {
        if (
          !Array.isArray(autoApprove) ||
          autoApprove.some((name) => typeof name !== 'string' || name.trim() === '')
        ) {
          errors.push({
            path: 'permission.autoApprove',
            message: 'permission.autoApprove must be an array of non-empty strings',
            value: autoApprove,
          });
        }
      }
    }
  }

  // 校验 plugins（0.6.1）：数组、name 非空、config 为对象
  if (config.plugins !== undefined) {
    if (!Array.isArray(config.plugins)) {
      errors.push({ path: 'plugins', message: 'plugins must be an array' });
    } else {
      const seen = new Set<string>();
      for (const [index, plugin] of config.plugins.entries()) {
        const prefix = `plugins.${index}`;
        if (!isPlainObject(plugin)) {
          errors.push({ path: prefix, message: 'plugin entry must be an object' });
          continue;
        }
        if (typeof plugin.name !== 'string' || plugin.name.trim() === '') {
          errors.push({
            path: `${prefix}.name`,
            message: 'plugin name must be a non-empty string',
          });
        } else if (seen.has(plugin.name)) {
          errors.push({
            path: `${prefix}.name`,
            message: `duplicate plugin "${plugin.name}"`,
            value: plugin.name,
          });
        } else {
          seen.add(plugin.name);
        }
        if (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean') {
          errors.push({
            path: `${prefix}.enabled`,
            message: 'plugin enabled must be a boolean',
            value: plugin.enabled,
          });
        }
        if (plugin.config !== undefined && !isPlainObject(plugin.config)) {
          errors.push({ path: `${prefix}.config`, message: 'plugin config must be an object' });
        }
      }
    }
  }

  // 校验授权规则声明块（0.6.1）：name 必填，config 为对象。
  // 这些条目在装配层映射为同名插件的安装配置（见 src/plugin-config.ts）。
  for (const block of ['guardrails', 'hooks'] as const) {
    const entries = config[block];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      errors.push({ path: block, message: `${block} must be an array` });
      continue;
    }
    for (const [index, entry] of entries.entries()) {
      const prefix = `${block}.${index}`;
      if (!isPlainObject(entry)) {
        errors.push({ path: prefix, message: `${block} entry must be an object` });
        continue;
      }
      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        errors.push({
          path: `${prefix}.name`,
          message: `${block} name must be a non-empty string`,
        });
      } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name)) {
        errors.push({
          path: `${prefix}.name`,
          message: `${block} name must contain only letters, digits, ".", "_" or "-"`,
          value: entry.name,
        });
      }
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        errors.push({
          path: `${prefix}.enabled`,
          message: `${block} enabled must be a boolean`,
          value: entry.enabled,
        });
      }
      if (entry.config !== undefined && !isPlainObject(entry.config)) {
        errors.push({ path: `${prefix}.config`, message: `${block} config must be an object` });
      }
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
      allowNested,
      maxDescendants,
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
    if (allowNested !== undefined && typeof allowNested !== 'boolean') {
      errors.push({
        path: 'delegate.allowNested',
        message: 'delegate.allowNested must be a boolean',
        value: allowNested,
      });
    }
    if (
      maxDescendants !== undefined &&
      (!Number.isInteger(maxDescendants) || maxDescendants <= 0)
    ) {
      errors.push({
        path: 'delegate.maxDescendants',
        message: 'delegate.maxDescendants must be a positive integer',
        value: maxDescendants,
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
    const { kind, hostname, token, peersDir, heartbeatMs, peerTtlMs, nodes } = config.transport;

    if (kind !== undefined && kind !== 'in-process' && kind !== 'loopback' && kind !== 'remote') {
      errors.push({
        path: 'transport.kind',
        message: 'transport.kind must be "in-process", "loopback", or "remote"',
        value: kind,
      });
    }
    if (kind === 'remote' && nodes === undefined) {
      errors.push({
        path: 'transport.nodes',
        message: 'transport.kind "remote" requires transport.nodes',
      });
    }
    if (nodes !== undefined) {
      if (!Array.isArray(nodes)) {
        errors.push({ path: 'transport.nodes', message: 'transport.nodes must be an array' });
      } else {
        const seen = new Set<string>();
        nodes.forEach((raw, index) => {
          const base = `transport.nodes[${index}]`;
          if (!isPlainObject(raw)) {
            errors.push({ path: base, message: `${base} must be an object` });
            return;
          }
          const node = raw as Record<string, unknown>;
          if (typeof node.id !== 'string' || !NODE_ID_RE.test(node.id)) {
            errors.push({
              path: `${base}.id`,
              message: `${base}.id must match ${NODE_ID_RE.source}`,
            });
          } else if (seen.has(node.id)) {
            errors.push({ path: `${base}.id`, message: `${base}.id must be unique` });
          } else {
            seen.add(node.id);
          }
          if (typeof node.url !== 'string' || node.url.trim() === '') {
            errors.push({ path: `${base}.url`, message: `${base}.url must be a non-empty string` });
          } else {
            const message = nodeUrlError(node.url);
            if (message !== null) {
              errors.push({ path: `${base}.url`, message: `${base}.url ${message}` });
            }
          }
          if (node.token !== undefined && (typeof node.token !== 'string' || node.token === '')) {
            // 不把 token 值放进 error
            errors.push({
              path: `${base}.token`,
              message: `${base}.token must be a non-empty string`,
            });
          }
          validateEnvName(`${base}.tokenEnv`, node.tokenEnv, errors);
          if (
            node.caFile !== undefined &&
            (typeof node.caFile !== 'string' || node.caFile.trim() === '')
          ) {
            errors.push({
              path: `${base}.caFile`,
              message: `${base}.caFile must be a non-empty string`,
            });
          }
        });
      }
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
    const { enabled, ownerId, model, memberLimits, memberTermination, legacyTools } = config.team;
    if (legacyTools !== undefined && typeof legacyTools !== 'boolean') {
      errors.push({
        path: 'team.legacyTools',
        message: 'team.legacyTools must be a boolean',
        value: legacyTools,
      });
    }
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
      validateMcpEnvRefs(config.mcpServers as unknown as Record<string, unknown>, errors);
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

  // 校验 connect（0.6；客户端 token/CA）
  if (config.connect !== undefined) {
    if (!isPlainObject(config.connect)) {
      errors.push({ path: 'connect', message: 'connect must be an object' });
    } else {
      const { token, tokenEnv, caFile } = config.connect;
      if (token !== undefined && (typeof token !== 'string' || token === '')) {
        // 不把 token 值放进 error
        errors.push({ path: 'connect.token', message: 'connect.token must be a non-empty string' });
      }
      validateEnvName('connect.tokenEnv', tokenEnv, errors);
      if (caFile !== undefined && (typeof caFile !== 'string' || caFile.trim() === '')) {
        errors.push({
          path: 'connect.caFile',
          message: 'connect.caFile must be a non-empty string',
        });
      }
    }
  }

  // 校验 0.5 tenant / trace
  if (config.tenant !== undefined) {
    if (!isPlainObject(config.tenant)) {
      errors.push({ path: 'tenant', message: 'tenant must be an object' });
    } else {
      validateTenant(config.tenant, errors);
    }
  }
  if (config.trace !== undefined) {
    if (!isPlainObject(config.trace)) {
      errors.push({ path: 'trace', message: 'trace must be an object' });
    } else {
      validateTrace(config.trace, errors);
    }
  }

  // 校验 0.4 四块；块缺省时不做任何事（保持 0.3 行为）。
  if (config.workflow) validateWorkflow(config.workflow, errors);
  if (config.evals) validateEvals(config.evals, errors);
  if (config.feishu) validateFeishu(config.feishu, errors);
  if (config.observability) validateObservability(config.observability, errors);

  // 校验 ui（0.8.5 language；0.11 clearOnStart）
  if (config.ui !== undefined) validateUi(config.ui as unknown as Record<string, unknown>, errors);

  // guardrails / hooks 由装配层映射为同名插件的安装配置（0.6.1），
  // 不再产生「声明但未应用」警告。

  return { valid: errors.length === 0, errors, warnings };
}

/** 简单编辑距离（用于未知键的拼写建议） */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(above + 1, (prev[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return prev[b.length] ?? 0;
}

/** 取编辑距离最近的已知键（距离 <= 3 才建议） */
function closestKey(key: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const candidate of candidates) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
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
  provider: [
    'name',
    'apiKey',
    'apiKeyEnv',
    'baseUrl',
    'model',
    'temperature',
    'maxTokens',
    'timeoutMs',
  ],
  agent: [
    'name',
    'systemPrompt',
    'model',
    'temperature',
    'maxTokens',
    'cwd',
    'enabled',
    'defaultVisibility',
    'followReplies',
  ],
  session: ['backend', 'storagePath', 'maxHistory'],
  permission: ['autoApprove'],
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
    'allowNested',
    'maxDescendants',
  ],
  host: ['enabled', 'nodeId', 'limits'],
  scheduler: ['maxConcurrency', 'maxQueueSize', 'perAgentSerial'],
  transport: ['kind', 'hostname', 'token', 'peersDir', 'heartbeatMs', 'peerTtlMs', 'nodes'],
  team: ['enabled', 'ownerId', 'model', 'memberLimits', 'memberTermination', 'legacyTools'],
  durable: ['enabled', 'backend', 'path', 'checkpointEvery'],
  serve: [
    'hostname',
    'allowedOrigins',
    'port',
    'allowRemote',
    'tls',
    'token',
    'tokenEnv',
    'tokens',
    'adminToken',
    'adminTokenEnv',
  ],
  connect: ['token', 'tokenEnv', 'caFile'],
  workflow: ['enabled', 'dir', 'path', 'maxParallel', 'stepTimeoutMs'],
  evals: ['enabled', 'dir', 'outDir', 'allowNetwork'],
  feishu: [
    'enabled',
    'appId',
    'appSecret',
    'appSecretEnv',
    'domain',
    'allowedChatIds',
    'sessionPrefix',
    'replyTimeoutMs',
    'maxReplyChars',
    'maxMembers',
  ],
  observability: ['eventHistory', 'metrics', 'showProcessErrors'],
  ui: [
    'language',
    'clearOnStart',
    'showReasoning',
    'statusBars',
    'verbosity',
    'showInternalEvents',
    'errorLevel',
    'askUser',
  ],
  tenant: ['default', 'tenants'],
  trace: ['enabled', 'level', 'retentionDays', 'maxRuns', 'maxBytes', 'includeStreamChunks'],
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
  'apiKeyEnv',
  'dataDir',
  'tenant',
  'trace',
  'provider',
  'agent',
  'guardrails',
  'hooks',
  'limits',
  'termination',
  'session',
  'context',
  'permission',
  'plugins',
  'update',
  'delegate',
  'team',
  'host',
  'scheduler',
  'transport',
  'connect',
  'mcpServers',
  'durable',
  'serve',
  'workflow',
  'evals',
  'feishu',
  'observability',
  'ui',
];
