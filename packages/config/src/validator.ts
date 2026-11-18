/**
 * Vessel 配置校验器
 * @module @vessel-agent/config
 */

import { isIP } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  describeRegisteredAuthKinds,
  getAuthStrategy,
  PASSWORD_STRATEGY_KIND,
  requiresPublicOrigin,
} from './auth-strategies/index.js';
import { validateTeamPolicy } from './team-policy.js';
import type {
  AttentionConfig,
  AuthConfig,
  ConfigValidationError,
  ConfigValidationResult,
  ConfigValidationWarning,
  ContextConfig,
  EvalsConfig,
  FederationConfig,
  FeishuConfig,
  GatewayConfig,
  HubConfig,
  NodeConfig,
  ObservabilityConfig,
  PricingConfig,
  TeamConfigInput,
  TerminationConfig,
  TimelineConfig,
  TraceConfig,
  UsageLimitsConfig,
  VesselConfig,
  VisionConfig,
} from './types.js';

/** Agent/Node ID 字符集（DECISION-005 U1：不含 `:`） */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 合法环境变量名（_env 间接引用） */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** MCP server 名字符集（用于 `mcp__<server>__<tool>`） */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 允许的 loopback 主机名 */

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

/** 校验 limits 块（顶层与 agent 子块共用） */
function validateLimits(
  prefix: string,
  limits: UsageLimitsConfig,
  errors: ConfigValidationError[],
): void {
  const fields: Array<[string, number | undefined, string]> = [
    ['requestLimit', limits.requestLimit, 'Request limit'],
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

/** pricing.models.<model> 的已知键（0.51） */
const PRICING_MODEL_KEYS = [
  'inputPerMillion',
  'outputPerMillion',
  'cacheReadPerMillion',
  'cacheWritePerMillion',
] as const;

/** 校验 pricing 块（0.51：opt-in 模型价格表，单位 = 计价货币 / 百万 token） */
function validatePricing(pricing: PricingConfig, errors: ConfigValidationError[]): void {
  if (!isPlainObject(pricing.models)) {
    errors.push({
      path: 'pricing.models',
      message: 'pricing.models must be an object keyed by provider.model',
      value: pricing.models,
    });
    return;
  }
  for (const [model, raw] of Object.entries(pricing.models)) {
    const prefix = `pricing.models.${model}`;
    if (model.trim() === '') {
      errors.push({ path: prefix, message: 'Model key must be a non-empty string' });
      continue;
    }
    if (!isPlainObject(raw)) {
      errors.push({ path: prefix, message: 'Model price must be an object', value: raw });
      continue;
    }
    const required: Array<[string, string]> = [
      ['inputPerMillion', 'Input price'],
      ['outputPerMillion', 'Output price'],
    ];
    for (const [key, label] of required) {
      const value = raw[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push({
          path: `${prefix}.${key}`,
          message: `${label} must be a non-negative number (per 1M tokens)`,
          value,
        });
      }
    }
    for (const key of ['cacheReadPerMillion', 'cacheWritePerMillion'] as const) {
      const value = raw[key];
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      ) {
        errors.push({
          path: `${prefix}.${key}`,
          message: 'Cache price must be a non-negative number (per 1M tokens)',
          value,
        });
      }
    }
  }
}

/** 校验 termination 块（顶层与 agent 子块共用） */
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

/** 校验 context 块（0.34 S2：阈值与窗口配置的字段范围） */
function validateContext(context: ContextConfig, errors: ConfigValidationError[]): void {
  const { maxTokens, maxMessages, autoCompact, compactThreshold } = context;

  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0)
  ) {
    errors.push({
      path: 'context.maxTokens',
      message: 'Max tokens must be a positive number',
      value: maxTokens,
    });
  }

  if (
    maxMessages !== undefined &&
    (typeof maxMessages !== 'number' || !Number.isInteger(maxMessages) || maxMessages <= 0)
  ) {
    errors.push({
      path: 'context.maxMessages',
      message: 'context.maxMessages must be a positive integer',
      value: maxMessages,
    });
  }

  if (autoCompact !== undefined && typeof autoCompact !== 'boolean') {
    errors.push({
      path: 'context.autoCompact',
      message: 'context.autoCompact must be a boolean',
      value: autoCompact,
    });
  }

  if (
    compactThreshold !== undefined &&
    (typeof compactThreshold !== 'number' || !(compactThreshold > 0 && compactThreshold <= 1))
  ) {
    errors.push({
      path: 'context.compactThreshold',
      message: 'context.compactThreshold must be a number between 0 (exclusive) and 1 (inclusive)',
      value: compactThreshold,
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

/**
 * teams 去重键（0.19 S3）：trim 后 `path.resolve`；仅 win32 忽略大小写。
 * 不做 `~` 展开——validator 没有该 helper，展开留给装配层。
 */
function teamWorkspaceKey(workspace: string): string {
  const resolved = path.resolve(workspace.trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 校验 teams 块（0.19 S3；全局配置，tenant overlay 不允许） */
function validateTeams(teams: unknown, errors: ConfigValidationError[]): void {
  if (!Array.isArray(teams)) {
    errors.push({ path: 'teams', message: 'teams must be an array' });
    return;
  }

  const seen = new Set<string>();
  teams.forEach((raw, index) => {
    const prefix = `teams[${index}]`;
    if (!isPlainObject(raw)) {
      errors.push({ path: prefix, message: 'team entry must be an object' });
      return;
    }
    const team = raw as Partial<TeamConfigInput>;

    if (typeof team.workspace !== 'string' || team.workspace.trim() === '') {
      errors.push({
        path: `${prefix}.workspace`,
        message: 'team workspace must be a non-empty string',
        value: team.workspace,
      });
    } else {
      const key = teamWorkspaceKey(team.workspace);
      if (seen.has(key)) {
        errors.push({
          path: `${prefix}.workspace`,
          message: `duplicate team workspace "${team.workspace.trim()}"`,
          value: team.workspace.trim(),
        });
      } else {
        seen.add(key);
      }
    }

    if (team.name !== undefined && (typeof team.name !== 'string' || team.name.trim() === '')) {
      errors.push({
        path: `${prefix}.name`,
        message: 'team name must be a non-empty string',
        value: team.name,
      });
    }
    if (
      team.description !== undefined &&
      (typeof team.description !== 'string' || team.description.trim() === '')
    ) {
      errors.push({
        path: `${prefix}.description`,
        message: 'team description must be a non-empty string',
        value: team.description,
      });
    }
    if (team.policy !== undefined) {
      if (!isPlainObject(team.policy)) {
        errors.push({
          path: `${prefix}.policy`,
          message: 'team policy must be an object',
          value: team.policy,
        });
      } else {
        for (const issue of validateTeamPolicy(team.policy)) {
          errors.push({
            path:
              issue.field === undefined ? `${prefix}.policy` : `${prefix}.policy.${issue.field}`,
            message: issue.message,
          });
        }
      }
    }
  });
}

/** Team / federation team id 字符集（slug 结果；含哈希后缀）。 */
const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** federation peer 允许的键（camelCase；YAML snake 已由 loader 转换）。 */
const FEDERATION_PEER_KEYS = new Set([
  'nodeId',
  'teamId',
  'url',
  'tokenEnv',
  'caFile',
  'direction',
  'localTeamId',
  'allowDirectory',
  'token',
]);

/**
 * 校验 federation 块（S7；全局，tenant overlay 不允许）。
 *
 * 默认拒绝：未知字段不参与放行；明文 `token` 明确拒绝，只接受 `tokenEnv`。
 */
function validateFederation(
  federation: unknown,
  errors: ConfigValidationError[],
  hostNodeId: string | undefined,
): void {
  if (!isPlainObject(federation)) {
    errors.push({ path: 'federation', message: 'federation must be an object' });
    return;
  }
  const { enabled, maxHops, rateLimitPerMinute, peers } = federation as Partial<FederationConfig>;

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    errors.push({
      path: 'federation.enabled',
      message: 'federation.enabled must be a boolean',
      value: enabled,
    });
  }
  if (
    maxHops !== undefined &&
    (typeof maxHops !== 'number' || !Number.isInteger(maxHops) || maxHops < 1 || maxHops > 16)
  ) {
    errors.push({
      path: 'federation.maxHops',
      message: 'federation.maxHops must be an integer between 1 and 16',
      value: maxHops,
    });
  }
  if (
    rateLimitPerMinute !== undefined &&
    (typeof rateLimitPerMinute !== 'number' ||
      !Number.isInteger(rateLimitPerMinute) ||
      rateLimitPerMinute < 1 ||
      rateLimitPerMinute > 600)
  ) {
    errors.push({
      path: 'federation.rateLimitPerMinute',
      message: 'federation.rateLimitPerMinute must be an integer between 1 and 600',
      value: rateLimitPerMinute,
    });
  }
  if (peers === undefined) return;
  if (!Array.isArray(peers)) {
    errors.push({ path: 'federation.peers', message: 'federation.peers must be an array' });
    return;
  }

  const seen = new Set<string>();
  peers.forEach((raw, index) => {
    const base = `federation.peers[${index}]`;
    if (!isPlainObject(raw)) {
      errors.push({ path: base, message: `${base} must be an object` });
      return;
    }
    const peer = raw as Record<string, unknown>;

    for (const key of Object.keys(peer)) {
      if (FEDERATION_PEER_KEYS.has(key)) continue;
      errors.push({
        path: `${base}.${key}`,
        message: `${base}.${key} is not a valid federation peer key`,
      });
    }

    if (peer.token !== undefined) {
      errors.push({
        path: `${base}.token`,
        message: `${base}.token is not allowed; use tokenEnv`,
      });
    }

    let nodeId: string | undefined;
    if (typeof peer.nodeId !== 'string' || !NODE_ID_RE.test(peer.nodeId)) {
      errors.push({
        path: `${base}.nodeId`,
        message: `${base}.node_id must match ${NODE_ID_RE.source}`,
      });
    } else {
      nodeId = peer.nodeId;
      if (hostNodeId !== undefined && peer.nodeId === hostNodeId) {
        errors.push({
          path: `${base}.nodeId`,
          message: `${base}.node_id must not equal this node's node_id`,
        });
      }
    }

    let teamId: string | undefined;
    if (typeof peer.teamId !== 'string' || !TEAM_ID_RE.test(peer.teamId)) {
      errors.push({
        path: `${base}.teamId`,
        message: `${base}.team_id must match ${TEAM_ID_RE.source}`,
      });
    } else {
      teamId = peer.teamId;
    }

    if (
      peer.localTeamId !== undefined &&
      (typeof peer.localTeamId !== 'string' || !TEAM_ID_RE.test(peer.localTeamId))
    ) {
      errors.push({
        path: `${base}.localTeamId`,
        message: `${base}.localTeamId must match ${TEAM_ID_RE.source}`,
      });
    }

    const direction = peer.direction;
    if (
      direction !== undefined &&
      direction !== 'in' &&
      direction !== 'out' &&
      direction !== 'both'
    ) {
      errors.push({
        path: `${base}.direction`,
        message: `${base}.direction must be "in", "out", or "both"`,
      });
    }
    const needsUrl = direction !== 'in';
    if (peer.url === undefined) {
      if (needsUrl) {
        errors.push({
          path: `${base}.url`,
          message: `${base}.url is required when direction includes out`,
        });
      }
    } else if (typeof peer.url !== 'string' || peer.url.trim() === '') {
      errors.push({ path: `${base}.url`, message: `${base}.url must be a non-empty string` });
    } else {
      const message = federationUrlError(peer.url);
      if (message !== null) errors.push({ path: `${base}.url`, message: `${base}.url ${message}` });
    }

    if (typeof peer.tokenEnv !== 'string' || peer.tokenEnv === '') {
      errors.push({ path: `${base}.tokenEnv`, message: `${base}.tokenEnv is required` });
    } else {
      validateEnvName(`${base}.tokenEnv`, peer.tokenEnv, errors);
    }

    if (
      peer.caFile !== undefined &&
      (typeof peer.caFile !== 'string' || peer.caFile.trim() === '')
    ) {
      errors.push({ path: `${base}.caFile`, message: `${base}.caFile must be a non-empty string` });
    }

    if (peer.allowDirectory !== undefined && typeof peer.allowDirectory !== 'boolean') {
      errors.push({
        path: `${base}.allowDirectory`,
        message: `${base}.allow_directory must be a boolean`,
        value: peer.allowDirectory,
      });
    }

    if (nodeId !== undefined && teamId !== undefined) {
      const key = `${nodeId}\u0000${teamId}`;
      if (seen.has(key)) {
        errors.push({
          path: `${base}.teamId`,
          message: `duplicate federation peer "${nodeId}:${teamId}"`,
        });
      } else {
        seen.add(key);
      }
    }
  });
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

/** observability.log 允许值（与 core log-hub / ObservabilityLogConfig 一致） */
const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];
const LOG_COLORS: readonly string[] = ['auto', 'always', 'never'];
const LOG_FORMATS: readonly string[] = ['pretty', 'json'];
const LOG_TIMES: readonly string[] = ['auto', 'none', 'clock', 'iso'];
/** modules 的键是事件名前缀（小写域段；连字符等不合法，最长前缀匹配按点分段）。 */
const LOG_MODULE_PREFIX = /^[a-z][a-z0-9_.]*$/;

/** 校验 observability.log（枚举 + modules 映射；未知键由 findUnknownNestedKeys 报） */
function validateObservabilityLog(log: unknown, errors: ConfigValidationError[]): void {
  if (!isPlainObject(log)) {
    errors.push({
      path: 'observability.log',
      message: 'observability.log must be an object',
      value: log,
    });
    return;
  }
  const enumField = (key: string, allowed: readonly string[]): void => {
    const value = log[key];
    if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
      errors.push({
        path: `observability.log.${key}`,
        message: `observability.log.${key} must be one of ${allowed.join(' | ')}`,
        value,
      });
    }
  };
  enumField('level', LOG_LEVELS);
  enumField('color', LOG_COLORS);
  enumField('format', LOG_FORMATS);
  enumField('time', LOG_TIMES);
  if (log.modules === undefined) return;
  if (!isPlainObject(log.modules)) {
    errors.push({
      path: 'observability.log.modules',
      message: 'observability.log.modules must be a map of event-name prefix to level',
      value: log.modules,
    });
    return;
  }
  for (const [prefix, level] of Object.entries(log.modules)) {
    if (!LOG_MODULE_PREFIX.test(prefix)) {
      errors.push({
        path: `observability.log.modules.${prefix}`,
        message:
          'observability.log.modules keys must be lowercase event-name prefixes matching ^[a-z][a-z0-9_.]*$',
        value: prefix,
      });
    }
    if (typeof level !== 'string' || !LOG_LEVELS.includes(level)) {
      errors.push({
        path: `observability.log.modules.${prefix}`,
        message: `observability.log.modules.${prefix} must be one of ${LOG_LEVELS.join(' | ')}`,
        value: level,
      });
    }
  }
}

/** 校验 observability 块（0.4；0.14 showProcessErrors；日志中枢 log） */
function validateObservability(
  observability: ObservabilityConfig,
  errors: ConfigValidationError[],
): void {
  const { eventHistory, metrics, showProcessErrors, log } = observability;

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
  if (log !== undefined) validateObservabilityLog(log, errors);
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
  if (ui.showArchived !== undefined && typeof ui.showArchived !== 'boolean') {
    errors.push({
      path: 'ui.showArchived',
      message: 'ui.showArchived must be a boolean',
      value: ui.showArchived,
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
  if (ui.expandCards !== undefined && typeof ui.expandCards !== 'boolean') {
    errors.push({
      path: 'ui.expandCards',
      message: 'ui.expandCards must be a boolean',
      value: ui.expandCards,
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

/** 绝对 http(s) base URL 规则；`label` 只用于错误文案。 */
function absoluteBaseUrlError(value: string, label: string): string | null {
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
    return `non-loopback ${label} must use https`;
  }
  return null;
}

/** S7：federation peer URL；与节点 URL 同规则。 */
function federationUrlError(value: string): string | null {
  return absoluteBaseUrlError(value, 'federation peers');
}

/** S5.1：校验 node 侧 hub URL（绝对 http(s)、无 userinfo / path / query / hash、非回环须 https）。 */
function hubUrlError(value: string): string | null {
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
    return 'non-loopback hubs must use https';
  }
  return null;
}

const PLUGIN_HTTP_LIMIT_KEYS = [
  'maxBodyBytes',
  'maxResponseBytes',
  'timeoutMs',
  'idleTimeoutMs',
  'maxConnections',
  'maxFrameBytes',
] as const;

/** 0.48 M1：`node.plugin_http` 限额校验；`null` = 不限制。 */
function validatePluginHttpLimits(value: unknown, errors: ConfigValidationError[]): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    errors.push({
      path: 'node.pluginHttp',
      message: 'node.pluginHttp must be a mapping',
      value,
    });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(PLUGIN_HTTP_LIMIT_KEYS as readonly string[]).includes(key)) {
      errors.push({
        path: `node.pluginHttp.${key}`,
        message: `node.pluginHttp.${key} is not a known limit`,
      });
    }
  }
  for (const key of PLUGIN_HTTP_LIMIT_KEYS) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    const minimum = key === 'maxBodyBytes' || key === 'maxResponseBytes' ? 0 : 1;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < minimum) {
      errors.push({
        path: `node.pluginHttp.${key}`,
        message:
          `node.pluginHttp.${key} must be ${minimum === 0 ? 'a non-negative' : 'a positive'} ` +
          'integer, or null for unlimited',
        value: raw,
      });
    }
  }
}

/**
 * 校验 `node:` 块（schema 层；文件存在性由启动前检查）。
 * 非回环必须 `allowRemote: true`；TLS 必须 cert/key 成对。
 *
 * **错误路径一律写成 `node.*`**：`serve:` 段 0.55 起已不存在（loader 读到直接报错并
 * 要求改名），所以用户看到的键名必须和他能写的那一个一致 —— 报 `serve.port` 会把人
 * 指到一个已经被拒绝的块上。
 *
 * @param errors 可选的目标数组；缺省返回新数组
 */
export function validateServeSettings(
  node: NodeConfig,
  errors: ConfigValidationError[] = [],
): ConfigValidationError[] {
  const { hostname, port, allowRemote, tls, token, tokenEnv, tokens } = node as Record<
    string,
    unknown
  >;
  // 0.55 P0：反代共享密钥的环境变量名（opt-in；只校验变量名形状，不读值）。
  validateEnvName('node.proxySecretEnv', (node as Record<string, unknown>).proxySecretEnv, errors);

  if (hostname !== undefined) {
    const invalid =
      typeof hostname !== 'string' ||
      hostname.trim() === '' ||
      /\s/.test(hostname) ||
      hostname.includes('/') ||
      hostname.includes('://');
    if (invalid) {
      errors.push({
        path: 'node.hostname',
        message: 'node.hostname must be a host name or IP address (no scheme or path)',
        value: hostname,
      });
    }
  }

  if (
    port !== undefined &&
    (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    errors.push({
      path: 'node.port',
      message: 'node.port must be an integer between 0 and 65535',
      value: port,
    });
  }

  if (allowRemote !== undefined && typeof allowRemote !== 'boolean') {
    errors.push({
      path: 'node.allowRemote',
      message: 'node.allowRemote must be a boolean',
      value: allowRemote,
    });
  }

  // 0.6：独立前端 Origin allowlist（YAML：node.allowed_origins）。
  const allowedOrigins = (node as Record<string, unknown>).allowedOrigins;
  if (allowedOrigins !== undefined) {
    if (!Array.isArray(allowedOrigins)) {
      errors.push({
        path: 'node.allowedOrigins',
        message: 'node.allowedOrigins must be an array of origins',
      });
    } else {
      allowedOrigins.forEach((origin, index) => {
        const message =
          typeof origin === 'string' ? allowedOriginError(origin) : 'origin must be a string';
        if (message !== null) {
          errors.push({
            path: `node.allowedOrigins[${index}]`,
            message: `node.allowedOrigins[${index}] ${message}`,
            // origin 不是密钥，可回显
            value: origin,
          });
        }
      });
    }
  }

  // 0.48 M1：插件 HTTP 反代限额（CONTRACT-0.48 §3.4）。
  validatePluginHttpLimits((node as Record<string, unknown>).pluginHttp, errors);

  if (
    typeof hostname === 'string' &&
    !/\s/.test(hostname) &&
    hostname.trim() !== '' &&
    !isLoopbackHostname(hostname) &&
    allowRemote !== true
  ) {
    errors.push({
      path: 'node.allowRemote',
      message:
        `Refusing to listen on non-loopback hostname "${hostname}": ` +
        'set node.allow_remote=true to expose the gateway.',
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
      path: 'node.tls',
      message:
        `Refusing to expose non-loopback gateway "${hostname}" without TLS: ` +
        'set node.tls.cert_file and node.tls.key_file.',
    });
  }

  validateEnvName('node.tokenEnv', tokenEnv, errors);

  if (token !== undefined && (typeof token !== 'string' || token.trim() === '')) {
    // 不把 token 值放进 error
    errors.push({ path: 'node.token', message: 'node.token must be a non-empty string' });
  }

  if (tokens !== undefined) {
    if (!isPlainObject(tokens)) {
      errors.push({ path: 'node.tokens', message: 'node.tokens must be a mapping' });
    } else {
      for (const [rawToken, rawEntry] of Object.entries(tokens)) {
        // 永不把 token 键写进 error / message。
        if (rawToken.trim() === '') {
          errors.push({
            path: 'node.tokens',
            message: 'node.tokens must not contain an empty token key',
          });
          continue;
        }
        if (!isPlainObject(rawEntry)) {
          errors.push({
            path: 'node.tokens.<entry>',
            message: 'node.tokens entries must be objects',
          });
          continue;
        }
        const entry = rawEntry as { role?: unknown };
        if (
          entry.role !== undefined &&
          !['read', 'write', 'admin'].includes(entry.role as string)
        ) {
          errors.push({
            path: 'node.tokens.<entry>.role',
            message: 'node.tokens role must be "read", "write", or "admin"',
          });
        }
      }
    }
  }

  if (tls !== undefined) {
    if (!isPlainObject(tls)) {
      errors.push({ path: 'node.tls', message: 'node.tls must be an object', value: tls });
    } else {
      const cert = tls.certFile;
      const key = tls.keyFile;
      const certInvalid = typeof cert !== 'string' || cert.trim() === '';
      const keyInvalid = typeof key !== 'string' || key.trim() === '';
      if (certInvalid || keyInvalid) {
        if (certInvalid) {
          errors.push({
            path: 'node.tls.certFile',
            message: 'node.tls requires both cert_file and key_file',
            value: cert,
          });
        }
        if (keyInvalid) {
          errors.push({
            path: 'node.tls.keyFile',
            message: 'node.tls requires both cert_file and key_file',
            value: key,
          });
        }
      }
    }
  }

  return errors;
}

/**
 * `gateway.supervise` 的已知键（0.58）。
 *
 * 负一层嵌套不在 `KNOWN_BLOCK_KEYS` 的检查范围内，所以这里自己收口：写错一个
 * 字母（`probe_intervall`）必须报错，而不是静默退回缺省值。
 */
const KNOWN_GATEWAY_SUPERVISE_KEYS = [
  'enabled',
  'probeIntervalMs',
  'probeTimeoutMs',
  'failureThreshold',
  'maxRestartsPerHour',
  'backoffStartMs',
  'backoffMaxMs',
  'recoveryProbes',
] as const;

/** 数值型看门狗参数的合理区间（只挡笔误，不做业务判断）。 */
const SUPERVISE_NUMBER_BOUNDS: Readonly<Record<string, { min: number; max: number }>> = {
  probeIntervalMs: { min: 1, max: 3_600_000 },
  probeTimeoutMs: { min: 1, max: 3_600_000 },
  failureThreshold: { min: 1, max: 1_000 },
  maxRestartsPerHour: { min: 1, max: 10_000 },
  backoffStartMs: { min: 1, max: 3_600_000 },
  backoffMaxMs: { min: 1, max: 3_600_000 },
  recoveryProbes: { min: 1, max: 10_000 },
};

/**
 * 0.58：校验 `gateway.supervise` 块（父进程侧存活看门狗）。
 *
 * 只校验形状：`enabled` 是布尔，其余是正整数。具体语义（探活周期如何叠加退避）
 * 由 `src/gateway/watchdog.ts` 决定，这里不重复实现。
 */
function validateSuperviseSettings(
  supervise: unknown,
  errors: ConfigValidationError[] = [],
): ConfigValidationError[] {
  if (supervise === undefined) return errors;
  if (!isPlainObject(supervise)) {
    errors.push({ path: 'gateway.supervise', message: 'gateway.supervise must be an object' });
    return errors;
  }
  for (const key of Object.keys(supervise)) {
    if ((KNOWN_GATEWAY_SUPERVISE_KEYS as readonly string[]).includes(key)) continue;
    const suggestion = closestKey(key, [...KNOWN_GATEWAY_SUPERVISE_KEYS]);
    errors.push({
      path: `gateway.supervise.${key}`,
      message: suggestion
        ? `Unknown configuration key "gateway.supervise.${key}". Did you mean "${suggestion}"?`
        : `Unknown configuration key "gateway.supervise.${key}".`,
      value: key,
    });
  }
  const enabled = supervise.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    errors.push({
      path: 'gateway.supervise.enabled',
      message: 'gateway.supervise.enabled must be a boolean',
      value: enabled,
    });
  }
  for (const [key, bounds] of Object.entries(SUPERVISE_NUMBER_BOUNDS)) {
    const value = supervise[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < bounds.min ||
      value > bounds.max
    ) {
      errors.push({
        path: `gateway.supervise.${key}`,
        message: `gateway.supervise.${key} must be an integer between ${bounds.min} and ${bounds.max}`,
        value,
      });
    }
  }
  const start = supervise.backoffStartMs;
  const max = supervise.backoffMaxMs;
  if (typeof start === 'number' && typeof max === 'number' && start > max) {
    errors.push({
      path: 'gateway.supervise.backoffStartMs',
      message: 'gateway.supervise.backoffStartMs must not exceed gateway.supervise.backoffMaxMs',
      value: start,
    });
  }
  return errors;
}

/**
 * 0.49：校验平台 gateway 块（CONTRACT-0.49 §3.1）。
 * 与 `node:` 分区：不复用字段；origin 规则复用 `allowedOriginError`。
 * token 值永不写入 error / message。
 */
function validateGatewaySettings(
  gateway: GatewayConfig,
  errors: ConfigValidationError[] = [],
): ConfigValidationError[] {
  const { port, hostname, token, tokenEnv, allowedOrigins } = gateway as Record<string, unknown>;

  if (port !== undefined) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
      errors.push({
        path: 'gateway.port',
        message: 'gateway.port must be an integer between 0 and 65535',
        value: port,
      });
    }
  }

  if (hostname !== undefined) {
    const invalid =
      typeof hostname !== 'string' ||
      hostname.trim() === '' ||
      /\s/.test(hostname) ||
      hostname.includes('/') ||
      hostname.includes('://');
    if (invalid) {
      errors.push({
        path: 'gateway.hostname',
        message: 'gateway.hostname must be a host name or IP address (no scheme or path)',
        value: hostname,
      });
    }
  }

  if (token !== undefined && (typeof token !== 'string' || token.trim() === '')) {
    // 不把 token 值放进 error
    errors.push({ path: 'gateway.token', message: 'gateway.token must be a non-empty string' });
  }

  validateEnvName('gateway.tokenEnv', tokenEnv, errors);
  // 0.55 P0：反代共享密钥的环境变量名（opt-in；只校验变量名形状，不读值）。
  validateEnvName(
    'gateway.proxySecretEnv',
    (gateway as Record<string, unknown>).proxySecretEnv,
    errors,
  );

  // 0.58：代理开关只能显式布尔（写字符串 "false" 会被当成真值，那种错必须当场报）。
  const proxyNodes = (gateway as Record<string, unknown>).proxyNodes;
  if (proxyNodes !== undefined && typeof proxyNodes !== 'boolean') {
    errors.push({
      path: 'gateway.proxyNodes',
      message: 'gateway.proxyNodes must be a boolean (true = 平台代理 node；false = 直连回退)',
    });
  }

  validateSuperviseSettings((gateway as Record<string, unknown>).supervise, errors);

  if (allowedOrigins !== undefined) {
    if (!Array.isArray(allowedOrigins)) {
      errors.push({
        path: 'gateway.allowedOrigins',
        message: 'gateway.allowedOrigins must be an array of origins',
      });
    } else {
      allowedOrigins.forEach((origin, index) => {
        const message =
          typeof origin === 'string' ? allowedOriginError(origin) : 'origin must be a string';
        if (message !== null) {
          errors.push({
            path: `gateway.allowedOrigins[${index}]`,
            message: `gateway.allowedOrigins[${index}] ${message}`,
            // origin 不是密钥，可回显
            value: origin,
          });
        }
      });
    }
  }

  return errors;
}

/**
 * 校验 `auth` 块（0.56 WebUI 登录）。
 *
 * 只校验形状与「配置是否自洽」；密钥（client_secret）永远不在这里出现 ——
 * 配置里只有**环境变量名**，校验的是名字的形状。
 */
function publicOriginError(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string';
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'must be an absolute URL like https://egg-rolls.top';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must use http or https';
  if (url.username !== '' || url.password !== '') return 'must not carry credentials';
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return 'must be scheme://host[:port] only (no path, query or fragment)';
  }
  return null;
}

/**
 * 回环 / 私网地址：`http://`（明文）只允许这些来源。
 *
 * 口子口径与 `serve/gateway/auth.ts` 的 `isLoopbackHostname` 一致（localhost /
 * 127.0.0.0/8 / ::1），再补上 RFC1918 私网与 IPv6 ULA / link-local —— 内网明文
 * 部署是常态，公网明文（cookie 不带 Secure、可被链路层篡改）不是。
 */
function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = host.toLowerCase();
  if (lower === 'localhost') return true;
  const version = isIP(lower);
  if (version === 4) {
    if (lower.startsWith('127.') || lower.startsWith('10.') || lower.startsWith('192.168.')) {
      return true;
    }
    if (lower.startsWith('169.254.')) return true;
    const parts = lower.split('.');
    const second = Number(parts[1]);
    if (parts[0] === '172' && Number.isInteger(second) && second >= 16 && second <= 31) return true;
    return false;
  }
  if (version === 6) {
    if (lower === '::1') return true;
    // fc00::/7（ULA）与 fe80::/10（link-local）
    return (
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    );
  }
  return false;
}

/**
 * 严格回环判定：`localhost` / `127.0.0.0/8` / `::1`。
 *
 * 与 `packages/serve/src/gateway/auth.ts` 的 `isLoopbackHostname` **同口径**
 * （config 包不能依赖 serve，所以这条判据在这里有一份拷贝；改一处必须改两处）。
 * 注意与下面的 `isLoopbackOrPrivateHostname` 不同：那段是「明文 http 允许谁」，
 * 这段是「端口通配允许谁」，后者**不含**私网。
 */
function isStrictLoopbackHostname(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '::1') return true;
  return isIP(lower) === 4 && lower.startsWith('127.');
}

/**
 * 0.60：校验 `auth.public_origins` 的单个条目。
 *
 * 比 `public_origin` 更严（新键没有历史包袱）：
 * - 必须是**具体** origin，**尾斜杠也报错**（`https://host/` 与 `https://host` 归一化后
 *   一样，但写错的人会以为它们不同，禁掉比替人猜更安全）；
 * - 非 https 只允许 loopback / 私网（公网明文会让会话 cookie 丢掉 Secure）。
 *
 * 0.61：**端口通配（`host:*`）在这里一律拒绝** —— 它只属于 `http.allowed_origins`。
 * 理由：`public_origins` 是 OAuth `redirect_uri` 的来源，`redirect_uri` 必须是具体
 * origin；`http://127.0.0.1:*` 拼不出回跳地址，接受它只会让人以为「写了就能登」。
 */
function publicOriginsEntryError(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().endsWith(':*')) {
    return (
      'uses a port wildcard ("host:*"): a port wildcard is only allowed in ' +
      'http.allowed_origins (access control), not in auth.public_origins, because ' +
      'redirect_uri needs a concrete origin. List each port explicitly, ' +
      'e.g. http://127.0.0.1:8642'
    );
  }
  const base = publicOriginError(value);
  if (base !== null) return base;
  const trimmed = (value as string).trim();
  const url = new URL(trimmed);
  if (trimmed.toLowerCase() !== url.origin) {
    return (
      'must be a bare origin without a trailing slash or default port ' +
      '(write https://egg-rolls.top, not https://egg-rolls.top/)'
    );
  }
  if (url.protocol === 'http:' && !isLoopbackOrPrivateHostname(url.hostname)) {
    return (
      'uses http on a public host: only loopback/private hosts may use http ' +
      '(use https:// for a public deployment)'
    );
  }
  return null;
}

/**
 * 登录后端种类**不在校验器里枚举**：合法值只由策略注册表决定
 * （`./auth-strategies/`）。加一个 provider = 加一个策略文件 + 注册一行，
 * 这里一行都不用改。
 */

/**
 * 回环端口通配条目（`http://127.0.0.1:*`）的校验 —— 只有 `http.allowed_origins` 用。
 *
 * 口径与 `packages/serve/src/gateway/auth.ts#parseOriginPattern` 逐条对齐：
 * `:*` 只能给回环 host（`127.0.0.0/8` / `localhost` / `[::1]`），且不能再带具体端口。
 */
function wildcardOriginEntryError(trimmed: string): string | null {
  const base = trimmed.slice(0, -':*'.length);
  const baseError = publicOriginError(base);
  if (baseError !== null) return baseError;
  const url = new URL(base);
  if (url.port !== '') {
    return 'must not combine an explicit port with the wildcard (write http://127.0.0.1:*, not :8642:*)';
  }
  if (base.toLowerCase() !== url.origin) {
    return (
      'must be a bare origin without a trailing slash or default port ' +
      '(write http://127.0.0.1:*, not http://127.0.0.1/:*)'
    );
  }
  if (!isStrictLoopbackHostname(url.hostname)) {
    return (
      'uses a port wildcard on a non-loopback host: "host:*" is only allowed on loopback ' +
      '(127.0.0.1 / localhost / [::1]). List each port explicitly instead, ' +
      'e.g. https://egg-rolls.top'
    );
  }
  return null;
}

export function validateAuthSettings(
  auth: AuthConfig,
  errors: ConfigValidationError[] = [],
  warnings: ConfigValidationWarning[] = [],
): ConfigValidationError[] {
  const raw = auth as Record<string, unknown>;

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push({ path: 'auth.enabled', message: 'auth.enabled must be a boolean' });
  }

  // 0.63：本机直连免登录。缺省 false 是安全默认；打开时出一句 warning 把代价说清楚
  // （单机开发可接受、共享机/公网部署不要开）。
  if (raw.allowLoopbackAnonymous !== undefined && typeof raw.allowLoopbackAnonymous !== 'boolean') {
    errors.push({
      path: 'auth.allowLoopbackAnonymous',
      message:
        'auth.allowLoopbackAnonymous must be a boolean (auth.allow_loopback_anonymous: true|false)',
      value: raw.allowLoopbackAnonymous,
    });
  } else if (raw.allowLoopbackAnonymous === true) {
    warnings.push({
      path: 'auth.allowLoopbackAnonymous',
      message:
        'auth.allow_loopback_anonymous is on: any process on this machine can reach the data ' +
        'plane without logging in (loopback socket + loopback Host, no proxy secret proof). ' +
        'Acceptable for single-user local development; do not enable on a shared host or a ' +
        'public deployment.',
    });
  }

  if (raw.publicOrigin !== undefined) {
    const message = publicOriginError(raw.publicOrigin);
    if (message !== null) {
      errors.push({
        path: 'auth.publicOrigin',
        message: `auth.publicOrigin ${message}`,
        value: raw.publicOrigin,
      });
    } else if (
      typeof raw.publicOrigin === 'string' &&
      raw.publicOrigin.trim().startsWith('http://')
    ) {
      const host = new URL(raw.publicOrigin.trim()).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
        warnings.push({
          path: 'auth.publicOrigin',
          message:
            'auth.publicOrigin uses http on a non-loopback host: session cookies will not be ' +
            'Secure. Use https:// for a public deployment.',
        });
      }
    }
  }

  if (raw.publicOrigins !== undefined) {
    if (!Array.isArray(raw.publicOrigins)) {
      errors.push({
        path: 'auth.publicOrigins',
        message:
          'auth.publicOrigins must be an array of origins, e.g. ["https://egg-rolls.top", ' +
          '"http://127.0.0.1:8642"]',
        value: raw.publicOrigins,
      });
    } else {
      if (raw.publicOrigins.length === 0) {
        warnings.push({
          path: 'auth.publicOrigins',
          message:
            'auth.publicOrigins is empty: no public origin is whitelisted ' +
            '(GitHub login needs at least one).',
        });
      }
      raw.publicOrigins.forEach((entry, index) => {
        const message = publicOriginsEntryError(entry);
        if (message === null) return;
        errors.push({
          path: `auth.publicOrigins[${index}]`,
          message:
            `auth.publicOrigins[${index}] ${message}. ` +
            'Example: auth.publicOrigins: ["https://egg-rolls.top", "http://127.0.0.1:8642"]',
          value: entry,
        });
      });
    }
  }

  const validateHostList = (path: string, value: unknown): void => {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      errors.push({ path, message: `${path} must be an array of hosts` });
      return;
    }
    value.forEach((entry, index) => {
      const ok = typeof entry === 'string' && entry.trim() !== '' && !/\s/.test(entry);
      if (!ok || (typeof entry === 'string' && entry.includes('://'))) {
        errors.push({
          path: `${path}[${index}]`,
          message: `${path}[${index}] must be a bare host[:port] (no scheme)`,
          value: entry,
        });
      }
    });
  };

  validateHostList('auth.allowedHosts', raw.allowedHosts);
  validateHostList('auth.trustedProxies', raw.trustedProxies);

  if (raw.backends !== undefined) {
    if (!Array.isArray(raw.backends)) {
      errors.push({ path: 'auth.backends', message: 'auth.backends must be an array' });
    } else {
      raw.backends.forEach((entry, index) => {
        const prefix = `auth.backends[${index}]`;
        if (!isPlainObject(entry)) {
          errors.push({ path: prefix, message: `${prefix} must be an object` });
          return;
        }
        const kind = entry.kind;
        // kind 缺省 = 缺省策略（github_oauth，0.56 P1 的写法）。
        const strategy = getAuthStrategy(typeof kind === 'string' ? kind : undefined);
        if (strategy === null) {
          errors.push({
            path: `${prefix}.kind`,
            message:
              `${prefix}.kind: ${JSON.stringify(kind)} is not a registered login backend. ` +
              `Registered kinds: ${describeRegisteredAuthKinds()}. ` +
              "Fix: change this backend's kind; to support a new provider add one strategy file " +
              'under packages/config/src/auth-strategies/ and register it in registry.ts ' +
              '(no change to this validator).',
            value: kind,
          });
        }
        if (strategy !== null && strategy.kind === PASSWORD_STRATEGY_KIND) {
          // 口令后端：hash / TOTP 密钥都只给**环境变量名**，值永不入配置。
          if (entry.username !== undefined && !isNonEmptyStringValue(entry.username)) {
            errors.push({
              path: `${prefix}.username`,
              message: `${prefix}.username must be a non-empty string`,
            });
          }
          if (entry.passwordHashEnv !== undefined) {
            validateEnvName(`${prefix}.passwordHashEnv`, entry.passwordHashEnv, errors);
          }
          if (entry.totpSecretEnv !== undefined) {
            validateEnvName(`${prefix}.totpSecretEnv`, entry.totpSecretEnv, errors);
          }
          for (const field of ['password', 'passwordHash', 'totpSecret', 'recoveryCodes']) {
            if (entry[field] === undefined) continue;
            errors.push({
              path: `${prefix}.${field}`,
              message:
                `${prefix}.${field} must not be stored in config. ` +
                'Fix: delete it — either set the password through the one-time bootstrap code ' +
                '(printed once at startup) or export an argon2id hash and point ' +
                `${prefix}.passwordHashEnv at that env var.`,
            });
          }
          if (entry.allowUserIds !== undefined) {
            // 口令后端的身份是登录名，没有白名单；配了就是误解了字段语义。
            errors.push({
              path: `${prefix}.allowUserIds`,
              message:
                `${prefix}.allowUserIds (kind: ${strategy.kind}): ${strategy.allowUserIdsShape.describe}. ` +
                'Fix: delete this field — the password backend allows exactly one login name ' +
                `(${prefix}.username)` +
                '; use an OAuth backend if you want an id allowlist.',
              value: entry.allowUserIds,
            });
          }
        } else if (strategy !== null) {
          const shape = strategy.allowUserIdsShape;
          if (!isNonEmptyStringValue(entry.clientId)) {
            errors.push({
              path: `${prefix}.clientId`,
              message: `${prefix}.clientId must be a non-empty string (the ${strategy.label} OAuth app client id)`,
            });
          }
          validateEnvName(`${prefix}.clientSecretEnv`, entry.clientSecretEnv, errors);
          if (entry.clientSecretEnv === undefined) {
            errors.push({
              path: `${prefix}.clientSecretEnv`,
              message: `${prefix}.clientSecretEnv is required: it holds the env var NAME of the client secret`,
            });
          }
          if (entry.allowUserIds !== undefined) {
            if (!Array.isArray(entry.allowUserIds) || entry.allowUserIds.length === 0) {
              errors.push({
                path: `${prefix}.allowUserIds`,
                message:
                  `${prefix}.allowUserIds (kind: ${strategy.kind}): must be a non-empty array of ` +
                  `${shape.describe}. Example: ${shape.examples[0] ?? 'n/a'}`,
              });
            } else {
              entry.allowUserIds.forEach((id, idIndex) => {
                const reason = shape.rejectReason(id);
                if (reason === null) return;
                errors.push({
                  path: `${prefix}.allowUserIds[${idIndex}]`,
                  message:
                    `${prefix}.allowUserIds[${idIndex}] (kind: ${strategy.kind}): ` +
                    `${JSON.stringify(id)} is not valid there — ${reason}. ` +
                    `Expected ${shape.describe}. Example: ${shape.examples[0] ?? 'n/a'}`,
                  value: id,
                });
              });
            }
          }
          if (entry.clientSecret !== undefined) {
            // 密钥不入配置：给出可照做的修复提示（不回显值）。
            errors.push({
              path: `${prefix}.clientSecret`,
              message:
                `${prefix}.clientSecret must not be stored in config. ` +
                `Fix: delete it, export the secret as an env var, and set ${prefix}.clientSecretEnv to that name.`,
            });
          }
        }
      });

      const backends = raw.backends.filter(isPlainObject);
      const enabledBackends = raw.enabled === false ? [] : backends;
      // 只有 OAuth 后端需要来源白名单（redirect_uri 的唯一来源）；口令后端不需要。
      // 判据来自注册表，不是这里的一份 kind 清单。
      const oauthBackends = enabledBackends.filter((entry) => {
        const strategy = getAuthStrategy(typeof entry.kind === 'string' ? entry.kind : undefined);
        return strategy !== null && requiresPublicOrigin(strategy.kind);
      });
      const hasPublicOrigins =
        raw.publicOrigin !== undefined ||
        (Array.isArray(raw.publicOrigins) && raw.publicOrigins.length > 0);
      if (oauthBackends.length > 0 && !hasPublicOrigins) {
        errors.push({
          path: 'auth.publicOrigins',
          message:
            'auth.publicOrigins (or auth.publicOrigin) is required when an OAuth backend is ' +
            'configured: it is the only source of the OAuth redirect_uri (never derived from request ' +
            'headers). Example: auth.publicOrigins: ["https://egg-rolls.top", "http://127.0.0.1:8642"]',
        });
      }
      if (enabledBackends.length > 0 && raw.enabled === undefined) {
        // 不是错误：只是让「我配了登录」这件事在启动日志里显式可见。
        warnings.push({
          path: 'auth',
          message: 'WebUI login is enabled (auth.backends): public requests need a session cookie.',
        });
      }
    }
  }

  if (raw.session !== undefined) {
    if (!isPlainObject(raw.session)) {
      errors.push({ path: 'auth.session', message: 'auth.session must be an object' });
    } else {
      const { idleMinutes, absoluteHours, persist } = raw.session;
      const isPositiveInt = (value: unknown): boolean =>
        typeof value === 'number' && Number.isInteger(value) && value > 0;
      if (idleMinutes !== undefined && !isPositiveInt(idleMinutes)) {
        errors.push({
          path: 'auth.session.idleMinutes',
          message: 'auth.session.idleMinutes must be a positive integer',
          value: idleMinutes,
        });
      }
      if (absoluteHours !== undefined && !isPositiveInt(absoluteHours)) {
        errors.push({
          path: 'auth.session.absoluteHours',
          message: 'auth.session.absoluteHours must be a positive integer',
          value: absoluteHours,
        });
      }
      if (persist !== undefined && typeof persist !== 'boolean') {
        errors.push({
          path: 'auth.session.persist',
          message: 'auth.session.persist must be a boolean',
        });
      }
    }
  }

  return errors;
}

/** 展开 `~` 并解析为绝对路径（用于 hub data dir 冲突检查）。 */
function comparablePath(value: string): string {
  const expanded =
    value === '~'
      ? os.homedir()
      : value.startsWith('~/') || value.startsWith('~\\')
        ? path.join(os.homedir(), value.slice(2))
        : value;
  const resolved = path.resolve(expanded);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isNonEmptyStringValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * `http.allowed_origins` 的单条校验：非通配条目与 `public_origins` **完全同一套**；
 * 只有端口通配这一处分叉（这里收，`public_origins` 拒）—— 见两处函数上的注释。
 */
function httpAllowedOriginsEntryError(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().endsWith(':*')) {
    return wildcardOriginEntryError(value.trim());
  }
  return publicOriginsEntryError(value);
}

/**
 * 0.62：`gateway.proxy_nodes: false` 与「启用了 WebUI 登录」是一对互相拆台的组合。
 *
 * 关掉平台代理后，浏览器只能靠 `platform.nodes.credentials` 去拿 node token —— 而那个端点
 * **只发给持平台 token 的客户端**（`mode === 'token'`），浏览器拿到的是
 * `platform_token_required`。于是它要么连不上 node，要么得有人在连接设置里手工粘平台 token。
 *
 * 这不是**错误**（关代理是受支持的老形态），所以只告警；但部署者必须知道代价是
 * 「WebUI 数据面默认不可用」。文案刻意不给命令行：说清代价与出路即可。
 */
function validateProxyNodesAgainstAuth(
  config: VesselConfig,
  warnings: ConfigValidationWarning[],
): void {
  if (config.gateway?.proxyNodes !== false) return;
  const auth = config.auth;
  if (auth === undefined || auth.enabled === false) return;
  if (!Array.isArray(auth.backends) || auth.backends.length === 0) return;
  warnings.push({
    path: 'gateway.proxyNodes',
    message:
      'gateway.proxyNodes: false 关掉了平台代理：浏览器拿不到 node token' +
      '（platform.nodes.credentials 只发给持平台 token 的客户端），WebUI 的数据面请求会 401，' +
      '除非有人在连接设置里手工粘平台 token。删掉这一行（或设为 true）之后，浏览器才会走 ' +
      '/nodes/<node_id>/ 前缀。',
  });
}

/**
 * 0.61：校验 `http` 块。
 *
 * 目前只有 `allowed_origins`（**访问控制**：浏览器能不能发 RPC）。它与
 * `auth.public_origins`（`redirect_uri` 的来源选择）是两件事：
 * - 非通配条目的判定**完全相同**（同一份 `publicOriginsEntryError`）；
 * - **只有这一处**接受回环端口通配 `http://127.0.0.1:*`（`public_origins` 拒）。
 *
 * 未配置不是错误：缺省回落到 `auth.public_origins` + 回环通配三条。
 */
export function validateHttpSettings(
  http: Record<string, unknown>,
  errors: ConfigValidationError[] = [],
): ConfigValidationError[] {
  const allowedOrigins = http.allowedOrigins;
  if (allowedOrigins === undefined) return errors;
  if (!Array.isArray(allowedOrigins)) {
    errors.push({
      path: 'http.allowedOrigins',
      message:
        'http.allowedOrigins must be an array of origins, e.g. ["http://127.0.0.1:*", ' +
        '"http://localhost:*", "https://egg-rolls.top"]',
      value: allowedOrigins,
    });
    return errors;
  }
  allowedOrigins.forEach((entry, index) => {
    const message = httpAllowedOriginsEntryError(entry);
    if (message === null) return;
    errors.push({
      path: `http.allowedOrigins[${index}]`,
      message: `http.allowedOrigins[${index}] ${message}`,
      value: entry,
    });
  });
  return errors;
}

/**
 * 校验 hub 块（S5；schema 层，文件存在性由启动前检查）。
 *
 * `direction: 'node'` 为 gateway 出站加入 hub（S5.1）。非回环必须同时满足
 * `allowRemote=true`、TLS cert/key 成对、非空 `tokenEnv`（fail-closed）。
 * node 角色的 `url` / `caFile` / `joinCodeEnv` 只在出现时校验。
 */
export function validateHubSettings(
  hub: HubConfig,
  errors: ConfigValidationError[] = [],
  globalDataDir?: string,
): ConfigValidationError[] {
  const {
    dataDir,
    autoStart,
    direction,
    url,
    caFile,
    joinCodeEnv,
    listen,
    allowRemote,
    tls,
    allowedOrigins,
    tokenEnv,
    proxySecretEnv,
    allowFileSecrets,
    pairingTtlSeconds,
    tokenTtlDays,
  } = hub as unknown as Record<string, unknown>;

  if (dataDir !== undefined) {
    if (!isNonEmptyStringValue(dataDir)) {
      errors.push({
        path: 'hub.dataDir',
        message: 'hub.dataDir must be a non-empty string',
        value: dataDir,
      });
    } else if (dataDir.includes('\0')) {
      errors.push({ path: 'hub.dataDir', message: 'hub.dataDir must not contain NUL' });
    } else if (
      isNonEmptyStringValue(globalDataDir) &&
      comparablePath(dataDir) === comparablePath(globalDataDir)
    ) {
      errors.push({
        path: 'hub.data_dir',
        message: 'hub_data_dir_conflict: hub.dataDir must differ from dataDir',
      });
    }
  }

  if (autoStart !== undefined && typeof autoStart !== 'boolean') {
    errors.push({
      path: 'hub.autoStart',
      message: 'hub.autoStart must be a boolean',
      value: autoStart,
    });
  }

  if (direction !== undefined && direction !== 'node') {
    errors.push({
      path: 'hub.direction',
      message: 'hub.direction must be "node"',
      value: direction,
    });
  }

  // S5.1 node 角色：url 只在出现时校验形状；join 前 state 也可提供，故不强制。
  if (url !== undefined) {
    if (typeof url !== 'string' || url.trim() === '') {
      errors.push({
        path: 'hub.url',
        message: 'hub.url must be a non-empty string',
        value: url,
      });
    } else if (url.includes('\0')) {
      errors.push({ path: 'hub.url', message: 'hub.url must not contain NUL' });
    } else {
      const message = hubUrlError(url);
      if (message !== null) {
        errors.push({ path: 'hub.url', message: `hub.url ${message}`, value: url });
      }
    }
  }

  if (caFile !== undefined) {
    if (!isNonEmptyStringValue(caFile)) {
      errors.push({
        path: 'hub.caFile',
        message: 'hub.caFile must be a non-empty string',
        value: caFile,
      });
    } else if (caFile.includes('\0')) {
      errors.push({ path: 'hub.caFile', message: 'hub.caFile must not contain NUL' });
    }
  }

  if (joinCodeEnv !== undefined && typeof joinCodeEnv !== 'string') {
    errors.push({
      path: 'hub.joinCodeEnv',
      message: 'hub.joinCodeEnv must be a string',
      value: joinCodeEnv,
    });
  } else {
    validateEnvName('hub.joinCodeEnv', joinCodeEnv, errors);
  }

  let listenHostname: unknown;
  if (listen !== undefined) {
    if (!isPlainObject(listen)) {
      errors.push({ path: 'hub.listen', message: 'hub.listen must be an object' });
    } else {
      listenHostname = listen.hostname;
      if (listen.hostname !== undefined) {
        const invalid =
          typeof listen.hostname !== 'string' ||
          listen.hostname.trim() === '' ||
          /\s/.test(listen.hostname) ||
          listen.hostname.includes('/') ||
          listen.hostname.includes('://');
        if (invalid) {
          errors.push({
            path: 'hub.listen.hostname',
            message: 'hub.listen.hostname must be a host name or IP address (no scheme or path)',
            value: listen.hostname,
          });
        }
      }
      if (
        listen.port !== undefined &&
        (typeof listen.port !== 'number' ||
          !Number.isInteger(listen.port) ||
          listen.port < 0 ||
          listen.port > 65535)
      ) {
        errors.push({
          path: 'hub.listen.port',
          message: 'hub.listen.port must be an integer between 0 and 65535',
          value: listen.port,
        });
      }
    }
  }

  if (allowRemote !== undefined && typeof allowRemote !== 'boolean') {
    errors.push({
      path: 'hub.allowRemote',
      message: 'hub.allowRemote must be a boolean',
      value: allowRemote,
    });
  }

  let tlsComplete = false;
  if (tls !== undefined) {
    if (!isPlainObject(tls)) {
      errors.push({ path: 'hub.tls', message: 'hub.tls must be an object' });
    } else {
      const certValid = tls.certFile === undefined || isNonEmptyStringValue(tls.certFile);
      const keyValid = tls.keyFile === undefined || isNonEmptyStringValue(tls.keyFile);
      if (!certValid) {
        errors.push({
          path: 'hub.tls.certFile',
          message: 'hub.tls.certFile must be a non-empty string',
        });
      }
      if (!keyValid) {
        errors.push({
          path: 'hub.tls.keyFile',
          message: 'hub.tls.keyFile must be a non-empty string',
        });
      }
      const hasCert = tls.certFile !== undefined;
      const hasKey = tls.keyFile !== undefined;
      if (hasCert !== hasKey) {
        errors.push({
          path: 'hub.tls',
          message: 'hub.tls requires both certFile and keyFile',
        });
      }
      tlsComplete = isNonEmptyStringValue(tls.certFile) && isNonEmptyStringValue(tls.keyFile);
    }
  }

  if (allowedOrigins !== undefined) {
    if (!Array.isArray(allowedOrigins)) {
      errors.push({
        path: 'hub.allowedOrigins',
        message: 'hub.allowedOrigins must be an array of origins',
      });
    } else {
      allowedOrigins.forEach((origin, index) => {
        const message =
          typeof origin === 'string' ? allowedOriginError(origin) : 'origin must be a string';
        if (message !== null) {
          errors.push({
            path: `hub.allowedOrigins[${index}]`,
            message: `hub.allowedOrigins[${index}] ${message}`,
            value: origin,
          });
        }
      });
    }
  }

  if (tokenEnv !== undefined && typeof tokenEnv !== 'string') {
    errors.push({
      path: 'hub.tokenEnv',
      message: 'hub.tokenEnv must be a string',
      value: tokenEnv,
    });
  } else {
    validateEnvName('hub.tokenEnv', tokenEnv, errors);
  }
  // 0.55 P0：hub 反代共享密钥的环境变量名（opt-in；只校验变量名形状，不读值）。
  validateEnvName('hub.proxySecretEnv', proxySecretEnv, errors);

  if (allowFileSecrets !== undefined && typeof allowFileSecrets !== 'boolean') {
    errors.push({
      path: 'hub.allowFileSecrets',
      message: 'hub.allowFileSecrets must be a boolean',
      value: allowFileSecrets,
    });
  }

  if (
    pairingTtlSeconds !== undefined &&
    (typeof pairingTtlSeconds !== 'number' ||
      !Number.isInteger(pairingTtlSeconds) ||
      pairingTtlSeconds < 60 ||
      pairingTtlSeconds > 3600)
  ) {
    errors.push({
      path: 'hub.pairingTtlSeconds',
      message: 'hub.pairingTtlSeconds must be an integer between 60 and 3600',
      value: pairingTtlSeconds,
    });
  }

  // 0.61：node token 有效期（天）。区间只挡笔误：0 天会让 token 立刻过期。
  if (
    tokenTtlDays !== undefined &&
    (typeof tokenTtlDays !== 'number' ||
      !Number.isInteger(tokenTtlDays) ||
      tokenTtlDays < 1 ||
      tokenTtlDays > 365)
  ) {
    errors.push({
      path: 'hub.tokenTtlDays',
      message: 'hub.tokenTtlDays must be an integer between 1 and 365',
      value: tokenTtlDays,
    });
  }

  if (isNonEmptyStringValue(listenHostname) && !isLoopbackHostname(listenHostname)) {
    if (allowRemote !== true) {
      errors.push({
        path: 'hub.allowRemote',
        message:
          `Refusing to listen on non-loopback hostname "${listenHostname}": ` +
          'set hub.allowRemote=true to expose the hub.',
        value: allowRemote,
      });
    } else {
      if (!tlsComplete) {
        errors.push({
          path: 'hub.tls',
          message:
            `Refusing to expose non-loopback hub "${listenHostname}" without TLS: ` +
            'set hub.tls.certFile and hub.tls.keyFile.',
        });
      }
      if (!isNonEmptyStringValue(tokenEnv)) {
        errors.push({
          path: 'hub.tokenEnv',
          message: 'Remote hub requires a non-empty hub.tokenEnv resolved from the environment',
        });
      }
    }
  }

  return errors;
}

/** 校验 `env_file`：一个路径或非空路径数组；只校验形态，不读文件（读文件在 loader 里） */
function validateEnvFile(value: unknown, errors: ConfigValidationError[]): void {
  if (value === undefined) return;
  const paths = Array.isArray(value) ? value : [value];
  if (paths.length === 0) {
    errors.push({
      path: 'envFile',
      message: 'envFile must be a path or a non-empty list of paths',
    });
    return;
  }
  for (const item of paths) {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push({ path: 'envFile', message: 'envFile entries must be non-empty strings' });
      return;
    }
    if (item.includes('\0')) {
      errors.push({ path: 'envFile', message: 'envFile must not contain NUL' });
      return;
    }
  }
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
  check(config.node, 'token', 'node.token');
  check(config.gateway, 'token', 'gateway.token');
  check(config.transport, 'token', 'transport.token');
  check(config.connect, 'token', 'connect.token');
  if (isPlainObject(config.node) && isPlainObject(config.node.tokens)) {
    if (Object.keys(config.node.tokens).length > 0) found.push(at('node.tokens'));
  }
  return found;
}

/** 0.49 T4（R4）：已删除的 tenant 配置键 → 启动 fail-fast。 */
export interface RemovedTenantConfigKey {
  path: string;
  /** 逐项修复提示；不回显 token 值 */
  message: string;
}

/**
 * 找出 T4 删除的 tenant 配置键（R4）。
 *
 * 这些键不再被静默忽略：旧配置与旧 token 映射必须由用户显式删除，否则启动
 * 失败并逐项给出修复提示。token 键是密钥，不在 path / message 里回显。
 */
export function findRemovedTenantConfigKeys(
  config: Record<string, unknown>,
): RemovedTenantConfigKey[] {
  const removed: RemovedTenantConfigKey[] = [];

  if (Object.hasOwn(config, 'tenant')) {
    removed.push({
      path: 'tenant',
      message:
        'The "tenant" configuration block was removed in 0.49: this node serves a single company. ' +
        'Fix: delete the whole "tenant:" block (tenant.default / tenant.tenants / overlay / quota are no longer read).',
    });
  }

  const node = isPlainObject(config.node) ? config.node : undefined;
  if (node === undefined) return removed;

  if (Object.hasOwn(node, 'adminToken')) {
    removed.push({
      path: 'node.adminToken',
      message:
        'node.adminToken was removed in 0.49. ' +
        'Fix: delete node.adminToken and put the admin client token under node.tokens as `<token>: { role: admin }`.',
    });
  }
  if (Object.hasOwn(node, 'adminTokenEnv')) {
    removed.push({
      path: 'node.adminTokenEnv',
      message:
        'node.adminTokenEnv was removed in 0.49. ' +
        'Fix: delete node.adminTokenEnv and put the admin client token under node.tokens as `<token>: { role: admin }`.',
    });
  }

  if (isPlainObject(node.tokens)) {
    Object.values(node.tokens).forEach((entry, index) => {
      if (!isPlainObject(entry) || !Object.hasOwn(entry, 'tenantId')) return;
      removed.push({
        path: `node.tokens.<entry#${index + 1}>.tenantId`,
        message:
          'node.tokens[*].tenantId was removed in 0.49: every token belongs to this node. ' +
          'Fix: delete the tenantId key from the token entry and keep only role.',
      });
    });
  }

  return removed;
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

/**
 * 校验 timeline 块（0.54 A，ADR-105 §11）。
 *
 * `dualWrite` 只收布尔：写成 `"false"` 字符串会让「开关关」变成「开关开」，
 * 那是本单最不能出的错（ADR-105 要求开关关时旧链路逐字节不变）。
 */
function validateTimeline(timeline: TimelineConfig, errors: ConfigValidationError[]): void {
  const { dualWrite, chunkFlushMs, archiveIntervalMs } = timeline;

  if (dualWrite !== undefined && typeof dualWrite !== 'boolean') {
    errors.push({
      path: 'timeline.dualWrite',
      message: 'timeline.dualWrite must be a boolean',
      value: dualWrite,
    });
  }
  if (
    chunkFlushMs !== undefined &&
    (typeof chunkFlushMs !== 'number' || !Number.isInteger(chunkFlushMs) || chunkFlushMs < 1)
  ) {
    errors.push({
      path: 'timeline.chunkFlushMs',
      message: 'timeline.chunkFlushMs must be a positive integer (1..1000, clamped by writer)',
      value: chunkFlushMs,
    });
  }
  if (
    archiveIntervalMs !== undefined &&
    (typeof archiveIntervalMs !== 'number' ||
      !Number.isInteger(archiveIntervalMs) ||
      archiveIntervalMs < 0 ||
      archiveIntervalMs > 3_600_000)
  ) {
    errors.push({
      path: 'timeline.archiveIntervalMs',
      message: 'timeline.archiveIntervalMs must be an integer in [0, 3600000] (0 = run end only)',
      value: archiveIntervalMs,
    });
  }
  // 0.54 C（plan-054 判据 C-3）：`timeline.read_from` 在 cutover 被删除。旧配置**必须**在
  // 启动时 fail loud，不许静默忽略 —— 静默会让人以为"已经切回旧源"，而读源只剩时间线一个。
  // （未知键的通用校验也会报，但那句 "Did you mean ...?" 不说明为什么消失；这里给原因。）
  const removedReadFrom = (timeline as { readFrom?: unknown }).readFrom;
  if (removedReadFrom !== undefined) {
    errors.push({
      path: 'timeline.readFrom',
      message:
        'timeline.read_from was removed in 0.54: the only read source is the session timeline ' +
        '(delete the key; there is no fallback to the legacy session log)',
      value: removedReadFrom,
    });
  }
  // 0.54（同一口径）：抽样对拍的配置键 `timeline.verify_sample_rate` 已随那套装置一起删除。
  // 旧配置**不会**被静默忽略：它已经不在 `KNOWN_BLOCK_KEYS.timeline` 里，`validateConfig`
  // 的未知键校验会在启动时 hard error（`Unknown configuration key "timeline.…"`）。
  // 这里不再单独给「为什么消失」的文案 —— 那需要在源码里写出已删除标识符本身。
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

/** 多节点 attention 的允许键；`token` 不在其中（凭据只从 `tokenEnv` 读取）。 */
const ATTENTION_NODE_KEYS = ['name', 'url', 'tokenEnv', 'nodeId', 'caFile'] as const;

/**
 * 校验 attention 块（S9.4）。
 *
 * 每节点必须有唯一 name、绝对 http(s) URL 与 `tokenEnv`；
 * 内联 `token` 是未知键，直接报错，避免密钥落 YAML。
 */
export function validateAttentionSettings(
  attention: AttentionConfig,
  errors: ConfigValidationError[] = [],
): ConfigValidationError[] {
  const nodes = attention.nodes;
  if (nodes === undefined) return errors;
  if (!Array.isArray(nodes)) {
    errors.push({ path: 'attention.nodes', message: 'attention.nodes must be an array' });
    return errors;
  }
  const seen = new Set<string>();
  nodes.forEach((node, index) => {
    const base = `attention.nodes[${index}]`;
    if (!isPlainObject(node)) {
      errors.push({ path: base, message: 'attention node must be an object' });
      return;
    }
    for (const key of Object.keys(node)) {
      if (!(ATTENTION_NODE_KEYS as readonly string[]).includes(key)) {
        errors.push({
          path: `${base}.${key}`,
          message: `Unknown attention node key "${key}"; tokens must come from tokenEnv`,
        });
      }
    }

    const { name, url, tokenEnv, nodeId, caFile } = node;
    if (typeof name !== 'string' || !NODE_ID_RE.test(name)) {
      errors.push({
        path: `${base}.name`,
        message: `${base}.name must match ${NODE_ID_RE.source}`,
      });
    } else if (seen.has(name)) {
      errors.push({ path: `${base}.name`, message: `duplicate attention node "${name}"` });
    } else {
      seen.add(name);
    }

    if (typeof url !== 'string' || url.trim() === '') {
      errors.push({ path: `${base}.url`, message: `${base}.url must be a non-empty string` });
    } else {
      const message = absoluteBaseUrlError(url, 'attention nodes');
      if (message !== null) errors.push({ path: `${base}.url`, message: `${base}.url ${message}` });
    }

    if (typeof tokenEnv !== 'string' || tokenEnv === '') {
      errors.push({
        path: `${base}.tokenEnv`,
        message: `${base}.token_env is required (human gateway/team token)`,
      });
    } else {
      validateEnvName(`${base}.tokenEnv`, tokenEnv, errors);
    }

    if (nodeId !== undefined && (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId))) {
      errors.push({
        path: `${base}.nodeId`,
        message: `${base}.node_id must match ${NODE_ID_RE.source}`,
      });
    }
    if (caFile !== undefined && (typeof caFile !== 'string' || caFile.trim() === '')) {
      errors.push({ path: `${base}.caFile`, message: `${base}.caFile must be a non-empty string` });
    }
  });
  return errors;
}

/**
 * 0.48 M4：`plugins[].expose` 只允许 `http` / `cli` 两个键，值为非空字符串数组；
 * 不接受 `true` 简写，重复 id 视为配置错误（CONTRACT-0.48 §5.1）。
 */
function validatePluginExpose(path: string, value: unknown, errors: ConfigValidationError[]): void {
  if (!isPlainObject(value)) {
    errors.push({
      path,
      message: `${path} must be an object with optional http/cli arrays`,
      value,
    });
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'http' && key !== 'cli') {
      errors.push({
        path: `${path}.${key}`,
        message: `${path}.${key} is not supported (allowed: http, cli)`,
        value: key,
      });
    }
  }
  for (const key of ['http', 'cli'] as const) {
    const list = value[key];
    if (list === undefined) continue;
    const listPath = `${path}.${key}`;
    if (!Array.isArray(list)) {
      errors.push({ path: listPath, message: `${listPath} must be an array of ids`, value: list });
      continue;
    }
    const seen = new Set<string>();
    for (const [index, id] of list.entries()) {
      if (typeof id !== 'string' || id.trim() === '') {
        errors.push({
          path: `${listPath}.${index}`,
          message: `${listPath}[${index}] must be a non-empty string`,
          value: id,
        });
        continue;
      }
      if (seen.has(id)) {
        errors.push({
          path: `${listPath}.${index}`,
          message: `duplicate expose id "${id}"`,
          value: id,
        });
        continue;
      }
      seen.add(id);
    }
  }
}

/**
 * 校验 `vision` 段（0.56）。
 *
 * 这里**不判**「哪个模型支持视觉」（那张表注定与 provider 配置漂移，判据在
 * `provider.vision`）。只判形状与范围：布尔 / 非负整数 / 小时与天数的上下界。
 */
export function validateVisionConfig(
  vision: VisionConfig | undefined,
  errors: ConfigValidationError[] = [],
): ConfigValidationError[] {
  if (vision === undefined) return errors;
  for (const key of ['disabled', 'blobGcEnabled', 'blobGcDryRun'] as const) {
    const value = vision[key];
    if (value !== undefined && typeof value !== 'boolean') {
      errors.push({ path: `vision.${key}`, message: `vision.${key} must be a boolean`, value });
    }
  }
  for (const key of ['maxImagesPerRequest', 'orphanGraceHours', 'blobGcIntervalHours'] as const) {
    const value = vision[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      errors.push({
        path: `vision.${key}`,
        message: `vision.${key} must be a non-negative finite number`,
        value,
      });
    }
  }
  const ttl = vision.imageBlobTtlDays;
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 1)) {
    errors.push({
      path: 'vision.imageBlobTtlDays',
      message: 'vision.imageBlobTtlDays must be a finite number >= 1',
      value: ttl,
    });
  }
  for (const key of ['detail', 'preprocess'] as const) {
    const value = vision[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      errors.push({
        path: `vision.${key}`,
        message: `vision.${key} must be a non-empty string`,
        value,
      });
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

  // 0.49 T4（R4）：已删除的 tenant 键先给出逐项修复提示，并跳过通用未知键报错。
  const removedTenantKeys = findRemovedTenantConfigKeys(
    config as unknown as Record<string, unknown>,
  );
  const removedTenantPaths = new Set(removedTenantKeys.map((entry) => entry.path));
  for (const { path, message } of removedTenantKeys) {
    errors.push({ path, message });
  }

  // 未知键（0.5）：顶层与已知块内都按 error 处理。
  for (const key of findUnknownKeys(config, KNOWN_CONFIG_KEYS)) {
    if (removedTenantPaths.has(key)) continue;
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
    if (removedTenantPaths.has(path)) continue;
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

  // 0.56：`env_file`（密钥文件路径；值不在这里，只有路径）
  validateEnvFile(config.envFile, errors);

  // 0.56：视觉段（错误拼写的键不再静默失效；取值范围在这里夹一次，别让运行时各自夹）。
  validateVisionConfig(config.vision, errors);

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
    const { name, model, temperature, maxTokens, timeoutMs, promptCache } = config.provider;

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

    if (promptCache !== undefined && typeof promptCache !== 'boolean') {
      errors.push({
        path: 'provider.promptCache',
        message: 'provider.promptCache must be a boolean',
        value: promptCache,
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

    const agent = config.agent;
    if (agent.limits) validateLimits('agent.limits', agent.limits, errors);
    if (agent.termination) validateTermination('agent.termination', agent.termination, errors);
    if (
      agent.permissionMode !== undefined &&
      agent.permissionMode !== 'bridge' &&
      agent.permissionMode !== 'allow' &&
      agent.permissionMode !== 'deny'
    ) {
      errors.push({
        path: 'agent.permissionMode',
        message: 'agent.permissionMode must be "bridge", "allow" or "deny"',
        value: agent.permissionMode,
      });
    }
    if (agent.readOnlyTools !== undefined) {
      if (
        !Array.isArray(agent.readOnlyTools) ||
        agent.readOnlyTools.some((value) => typeof value !== 'string')
      ) {
        errors.push({
          path: 'agent.readOnlyTools',
          message: 'agent.readOnlyTools must be an array of strings',
          value: agent.readOnlyTools,
        });
      }
    }
    if (agent.ownerId !== undefined && typeof agent.ownerId !== 'string') {
      errors.push({
        path: 'agent.ownerId',
        message: 'agent.ownerId must be a string',
        value: agent.ownerId,
      });
    }
    // 0.28：临时 agent 空闲回收 TTL。0 = 关闭，负数无意义（拒绝，不静默回退默认）。
    if (
      agent.temporaryTtlHours !== undefined &&
      (typeof agent.temporaryTtlHours !== 'number' ||
        !Number.isFinite(agent.temporaryTtlHours) ||
        agent.temporaryTtlHours < 0)
    ) {
      errors.push({
        path: 'agent.temporaryTtlHours',
        message: 'agent.temporaryTtlHours must be a non-negative number',
        value: agent.temporaryTtlHours,
      });
    }
    // 0.32：成员收件箱上限。必须为正整数（0 / 负数 / 非整数 / 非有限均拒绝）；
    // 缺省不传，由 store 使用默认 200。
    if (
      agent.inboxMaxMessages !== undefined &&
      (typeof agent.inboxMaxMessages !== 'number' ||
        !Number.isInteger(agent.inboxMaxMessages) ||
        agent.inboxMaxMessages <= 0)
    ) {
      errors.push({
        path: 'agent.inboxMaxMessages',
        message: 'agent.inboxMaxMessages must be a positive integer',
        value: agent.inboxMaxMessages,
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

  // 校验 pricing（0.51；opt-in 模型价格表）
  if (config.pricing) {
    validatePricing(config.pricing, errors);
  }
  if (config.limits?.totalCostLimit !== undefined) {
    const model = config.provider?.model;
    const priced = model !== undefined && config.pricing?.models?.[model] !== undefined;
    if (!priced) {
      warnings.push({
        path: 'limits.totalCostLimit',
        message:
          'totalCostLimit has no effect without pricing.models.<provider.model>; ' +
          'configure a per-model price table to accumulate total_cost.',
      });
    }
  }

  // 校验 termination
  if (config.termination) {
    validateTermination('termination', config.termination, errors);
  }

  // 校验 context（0.34 S2）
  if (config.context) {
    validateContext(config.context, errors);
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
      const { autoApprove, neverAutoApprove } = config.permission;
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
      if (neverAutoApprove !== undefined) {
        if (
          !Array.isArray(neverAutoApprove) ||
          neverAutoApprove.some((name) => typeof name !== 'string' || name.trim() === '')
        ) {
          errors.push({
            path: 'permission.neverAutoApprove',
            message: 'permission.neverAutoApprove must be an array of non-empty strings',
            value: neverAutoApprove,
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
        if (plugin.expose !== undefined) {
          validatePluginExpose(`${prefix}.expose`, plugin.expose, errors);
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

  // 校验 host（节点身份；无开关）
  if (config.host) {
    const { nodeId, nodeName } = config.host;
    if (nodeId !== undefined && (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId))) {
      errors.push({
        path: 'host.nodeId',
        message: 'host.nodeId must be 1-64 chars of [A-Za-z0-9_-]',
        value: nodeId,
      });
    }
    if (nodeName !== undefined && (typeof nodeName !== 'string' || nodeName.trim() === '')) {
      errors.push({
        path: 'host.nodeName',
        message: 'host.nodeName must be a non-empty string',
        value: nodeName,
      });
    }
  }

  // 校验 scheduler（所有 agent/body 都经同一 scheduler）
  if (config.scheduler) {
    const { maxConcurrency, maxQueueSize, perBodySerial } = config.scheduler;
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
    if (perBodySerial !== undefined && typeof perBodySerial !== 'boolean') {
      errors.push({
        path: 'scheduler.perBodySerial',
        message: 'scheduler.perBodySerial must be a boolean',
        value: perBodySerial,
      });
    }
  }

  // 校验 lease（0.34 两级租约；EU 续租与过期）
  if (config.lease) {
    const { ttlMs, renewMs } = config.lease;
    const isPositiveInteger = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value > 0;
    const ttlOk = isPositiveInteger(ttlMs);
    const renewOk = isPositiveInteger(renewMs);
    if (ttlMs !== undefined && !ttlOk) {
      errors.push({
        path: 'lease.ttlMs',
        message: 'lease.ttlMs must be a positive integer',
        value: ttlMs,
      });
    }
    if (renewMs !== undefined && !renewOk) {
      errors.push({
        path: 'lease.renewMs',
        message: 'lease.renewMs must be a positive integer',
        value: renewMs,
      });
    }
    if (renewOk && renewMs < 1000) {
      errors.push({
        path: 'lease.renewMs',
        message: 'lease.renewMs must be at least 1000',
        value: renewMs,
      });
    }
    if (ttlOk && renewOk) {
      if (ttlMs <= renewMs) {
        errors.push({
          path: 'lease.ttlMs',
          message: 'lease.ttlMs must be greater than lease.renewMs',
          value: ttlMs,
        });
      } else if (ttlMs < renewMs + 1000) {
        errors.push({
          path: 'lease.ttlMs',
          message: 'lease.ttlMs must be at least lease.renewMs + 1000',
          value: ttlMs,
        });
      }
    }
  }

  // 校验 transport（0.2；0.22.1 只剩 in-process）
  if (config.transport) {
    const { kind, token } = config.transport;

    if (kind !== undefined && kind !== 'in-process') {
      errors.push({
        path: 'transport.kind',
        message: 'transport.kind must be "in-process"; remote and loopback transports were removed',
        value: kind,
      });
    }
    if (token !== undefined && (typeof token !== 'string' || token.trim() === '')) {
      errors.push({
        path: 'transport.token',
        message: 'transport.token must be a non-empty string',
        value: token,
      });
    }
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

  // 校验 `node:` 段（0.3 起就有这个块，0.55 起它是唯一的名字；默认回环 + 明文）
  if (config.node !== undefined) {
    if (!isPlainObject(config.node)) {
      errors.push({ path: 'node', message: 'node must be an object' });
    } else {
      validateServeSettings(config.node, errors);
    }
  }

  // 0.56：单一根密钥（只校验环境变量名形状，不读值）
  if (config.security !== undefined) {
    if (!isPlainObject(config.security)) {
      errors.push({ path: 'security', message: 'security must be an object' });
    } else {
      validateEnvName(
        'security.rootSecretEnv',
        (config.security as Record<string, unknown>).rootSecretEnv,
        errors,
      );
    }
  }

  // 校验 gateway（0.49；平台侧，与 `node:` 分区）
  if (config.gateway !== undefined) {
    if (!isPlainObject(config.gateway)) {
      errors.push({ path: 'gateway', message: 'gateway must be an object' });
    } else {
      validateGatewaySettings(config.gateway as GatewayConfig, errors);
    }
  }

  // 校验 auth（0.56；WebUI 登录：多 provider，见 auth-strategies）
  if (config.auth !== undefined) {
    if (!isPlainObject(config.auth)) {
      errors.push({ path: 'auth', message: 'auth must be an object' });
    } else {
      validateAuthSettings(config.auth as AuthConfig, errors, warnings);
    }
  }

  // 0.62：跨分区检查 —— `gateway.proxy_nodes: false` 与「启用了 WebUI 登录」互相拆台。
  validateProxyNodesAgainstAuth(config, warnings);

  // 0.61：`http:` 段（浏览器能不能发 RPC 的访问控制，与 `auth.public_origins` 的
  // redirect_uri 来源选择分开）。缺省 = 回落 `auth.public_origins` + 回环通配。
  const httpBlock = (config as unknown as Record<string, unknown>).http;
  if (httpBlock !== undefined) {
    if (!isPlainObject(httpBlock)) {
      errors.push({ path: 'http', message: 'http must be an object' });
    } else {
      validateHttpSettings(httpBlock, errors);
    }
  }

  // 校验 hub（S5；data dir 必须独立）
  if (config.hub !== undefined) {
    if (!isPlainObject(config.hub)) {
      errors.push({ path: 'hub', message: 'hub must be an object' });
    } else {
      validateHubSettings(config.hub as HubConfig, errors, config.dataDir);
    }
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

  // 校验 attention（S9.4；多节点连接与凭据只从 env 读取）
  if (config.attention !== undefined) {
    if (!isPlainObject(config.attention)) {
      errors.push({ path: 'attention', message: 'attention must be an object' });
    } else {
      validateAttentionSettings(config.attention as AttentionConfig, errors);
    }
  }

  // 校验 0.5 trace（tenant 块已在 0.49 T4 删除，旧配置由 R4 fail-fast 拦截）
  if (config.trace !== undefined) {
    if (!isPlainObject(config.trace)) {
      errors.push({ path: 'trace', message: 'trace must be an object' });
    } else {
      validateTrace(config.trace, errors);
    }
  }

  // 校验 0.54 A timeline（双写开关；缺省 = 关，消费 DEFAULT_TIMELINE_OPTIONS）
  if (config.timeline !== undefined) {
    if (!isPlainObject(config.timeline)) {
      errors.push({ path: 'timeline', message: 'timeline must be an object' });
    } else {
      validateTimeline(config.timeline as TimelineConfig, errors);
    }
  }

  // 校验 0.4 块；块缺省时不做任何事（保持 0.3 行为）。
  if (config.evals) validateEvals(config.evals, errors);
  if (config.feishu) validateFeishu(config.feishu, errors);
  if (config.observability) validateObservability(config.observability, errors);

  // 校验 ui（0.8.5 language；0.11 clearOnStart）
  if (config.ui !== undefined) validateUi(config.ui as unknown as Record<string, unknown>, errors);

  // 校验 teams（0.19 S3；全局，tenant overlay 不允许）
  if (config.teams !== undefined) validateTeams(config.teams, errors);

  // 校验 federation（S7；全局，tenant overlay 不允许）
  if (config.federation !== undefined) {
    validateFederation(config.federation, errors, config.host?.nodeId);
  }

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
    'promptCache',
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
    'limits',
    'termination',
    'permissionMode',
    'readOnlyTools',
    'ownerId',
    'temporaryTtlHours',
    'inboxMaxMessages',
  ],
  session: ['backend', 'storagePath', 'maxHistory'],
  pricing: ['models'],
  permission: ['autoApprove', 'neverAutoApprove'],
  update: ['autoCheck', 'channel', 'source'],
  host: ['nodeId', 'nodeName'],
  scheduler: ['maxConcurrency', 'maxQueueSize', 'perBodySerial'],
  // 0.34：两级 body/session 租约。
  lease: ['ttlMs', 'renewMs'],
  transport: ['kind', 'token'],
  durable: ['enabled', 'backend', 'path', 'checkpointEvery'],
  // 0.55：`node:` 是这个块的唯一名字（`serve:` 段已移除，loader 读到直接报错）。
  node: [
    'hostname',
    'allowedOrigins',
    'port',
    'allowRemote',
    'tls',
    'token',
    'tokenEnv',
    'tokens',
    'pluginHttp',
    'proxySecretEnv',
  ],
  security: ['rootSecretEnv'],
  gateway: [
    'port',
    'hostname',
    'token',
    'tokenEnv',
    'allowedOrigins',
    'proxySecretEnv',
    'proxyNodes',
    'supervise',
  ],
  // 0.56：WebUI 登录（嵌套 entries 由 validateAuthSettings 单独校验）。
  auth: [
    'enabled',
    'publicOrigin',
    'publicOrigins',
    'allowedHosts',
    'trustedProxies',
    'backends',
    'session',
    // 0.63：本机直连免登录（缺省 false）。
    'allowLoopbackAnonymous',
  ],
  connect: ['token', 'tokenEnv', 'caFile'],
  // 0.61：`http.allowed_origins`（访问控制；缺省回落 auth.public_origins）。
  http: ['allowedOrigins'],
  attention: ['nodes'],
  hub: [
    'dataDir',
    'autoStart',
    'direction',
    'url',
    'caFile',
    'joinCodeEnv',
    'listen',
    'allowRemote',
    'tls',
    'allowedOrigins',
    'tokenEnv',
    'proxySecretEnv',
    'allowFileSecrets',
    'pairingTtlSeconds',
    'tokenTtlDays',
  ],
  federation: ['enabled', 'maxHops', 'rateLimitPerMinute', 'peers'],
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
  observability: ['eventHistory', 'metrics', 'showProcessErrors', 'log'],
  'observability.log': ['level', 'modules', 'color', 'format', 'time'],
  ui: [
    'language',
    'clearOnStart',
    'showReasoning',
    'statusBars',
    'verbosity',
    'showInternalEvents',
    'showArchived',
    'errorLevel',
    'askUser',
    'expandCards',
  ],
  trace: ['enabled', 'level', 'retentionDays', 'maxRuns', 'maxBytes', 'includeStreamChunks'],
  timeline: ['dualWrite', 'chunkFlushMs', 'archiveIntervalMs'],
  // 0.56：视觉（kill switch / 预算 / 精度 / 预处理 / blob 生命周期 / GC 定时）。
  // 加进 KNOWN_BLOCK_KEYS 之前这里是个洞：`vision:` 段写什么都无人校验（错拼的键
  // 静默不生效）。现在至少「不认识的键」会在启动时报出来。
  vision: [
    'disabled',
    'maxImagesPerRequest',
    'detail',
    'preprocess',
    'orphanGraceHours',
    'imageBlobTtlDays',
    'blobGcEnabled',
    'blobGcIntervalHours',
    'blobGcDryRun',
  ],
};

/** `node.tls` / `hub.tls` 的已知键 */
const KNOWN_TLS_KEYS = ['certFile', 'keyFile'] as const;

/** hub.listen 的已知键 */
const KNOWN_HUB_LISTEN_KEYS = ['hostname', 'port'] as const;

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

  const tls = isPlainObject(config.node) ? config.node.tls : undefined;
  if (isPlainObject(tls)) {
    for (const key of Object.keys(tls)) {
      if (!KNOWN_TLS_KEYS.includes(key as (typeof KNOWN_TLS_KEYS)[number])) {
        unknown.push({ path: `node.tls.${key}`, key, block: 'node.tls' });
      }
    }
  }

  // observability.log 子块（modules 的键是事件名前缀，属数据不属配置键，不查未知）。
  const logBlock = isPlainObject(config.observability) ? config.observability.log : undefined;
  if (isPlainObject(logBlock)) {
    const knownLog = KNOWN_BLOCK_KEYS['observability.log'] ?? [];
    for (const key of Object.keys(logBlock)) {
      if (!knownLog.includes(key)) {
        unknown.push({ path: `observability.log.${key}`, key, block: 'observability.log' });
      }
    }
  }

  if (isPlainObject(config.hub)) {
    const hubTls = config.hub.tls;
    if (isPlainObject(hubTls)) {
      for (const key of Object.keys(hubTls)) {
        if (!KNOWN_TLS_KEYS.includes(key as (typeof KNOWN_TLS_KEYS)[number])) {
          unknown.push({ path: `hub.tls.${key}`, key, block: 'hub.tls' });
        }
      }
    }
    const hubListen = config.hub.listen;
    if (isPlainObject(hubListen)) {
      for (const key of Object.keys(hubListen)) {
        if (!(KNOWN_HUB_LISTEN_KEYS as readonly string[]).includes(key)) {
          unknown.push({ path: `hub.listen.${key}`, key, block: 'hub.listen' });
        }
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

  const pricingModels = isPlainObject(config.pricing) ? config.pricing.models : undefined;
  if (isPlainObject(pricingModels)) {
    for (const [model, price] of Object.entries(pricingModels)) {
      if (!isPlainObject(price)) continue;
      for (const key of Object.keys(price)) {
        if (!(PRICING_MODEL_KEYS as readonly string[]).includes(key)) {
          unknown.push({ path: `pricing.models.${model}.${key}`, key, block: 'pricing.models' });
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
  'envFile',
  'trace',
  'timeline',
  'provider',
  'agent',
  'guardrails',
  'hooks',
  'limits',
  'termination',
  'pricing',
  'session',
  'context',
  // 0.56：视觉段（刻意没有 `enable` 键：支持即直通，`disabled` 是 kill switch）。
  'vision',
  'permission',
  'plugins',
  'update',
  'host',
  'scheduler',
  'lease',
  'transport',
  'connect',
  'attention',
  'mcpServers',
  'durable',
  // 0.55：`node:` 是唯一的块名（`serve:` 已移除，由 loader 单独报错并要求改名）。
  'node',
  // 0.56：单一根密钥覆盖点（`security.root_secret_env`）。
  'security',
  'gateway',
  'auth',
  // 0.61：访问控制（浏览器能不能发 RPC），与 `auth.public_origins` 的 redirect_uri 来源分开。
  'http',
  'hub',
  'evals',
  'feishu',
  'observability',
  'ui',
  'teams',
  'federation',
];
