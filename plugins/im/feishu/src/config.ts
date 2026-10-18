/**
 * 配置解析：环境变量优先、严格校验、app_id 掩码、agent id 净化。
 */

import { createHash } from 'node:crypto';
import { FeishuError } from './errors.js';
import type { FeishuConfig, ResolvedFeishuConfig } from './types.js';

const APP_ID_ENV = 'VESSEL_FEISHU_APP_ID';
const APP_SECRET_ENV = 'VESSEL_FEISHU_APP_SECRET';

function configError(message: string): FeishuError {
  return new FeishuError('channel_auth_failed', message, 'config');
}

function integerInRange(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw configError(`feishu.${name} must be an integer in [${min}, ${max}]`);
  }
  return resolved;
}

function stringArray(value: string[] | undefined, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw configError(`feishu.${name} must be an array of non-empty strings`);
  }
  return [...value];
}

/** 环境变量优先于配置文件；空字符串视为未设置。 */
function fromEnvOrConfig(
  env: Record<string, string | undefined>,
  key: string,
  value: string | undefined,
): string {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return value ?? '';
}

export function resolveFeishuConfig(
  config: FeishuConfig,
  env: Record<string, string | undefined> = process.env,
): ResolvedFeishuConfig {
  const domain = config.domain ?? 'feishu';
  if (domain !== 'feishu' && domain !== 'lark') {
    throw configError('feishu.domain must be "feishu" or "lark"');
  }

  const sessionPrefix = config.sessionPrefix ?? 'feishu';
  if (
    sessionPrefix === '' ||
    sessionPrefix.includes(':') ||
    sessionPrefix.includes('/') ||
    sessionPrefix.includes('\\')
  ) {
    throw configError(
      'feishu.session_prefix must be non-empty and must not contain ":" or path separators',
    );
  }

  return {
    enabled: config.enabled === true,
    appId: fromEnvOrConfig(env, APP_ID_ENV, config.appId),
    appSecret: fromEnvOrConfig(env, APP_SECRET_ENV, config.appSecret),
    domain,
    allowedChatIds: stringArray(config.allowedChatIds, 'allowed_chat_ids'),
    sessionPrefix,
    replyTimeoutMs: integerInRange(
      config.replyTimeoutMs,
      300_000,
      1,
      86_400_000,
      'reply_timeout_ms',
    ),
    maxReplyChars: integerInRange(config.maxReplyChars, 4000, 1, 100_000, 'max_reply_chars'),
    maxMembers: integerInRange(config.maxMembers, 8, 1, 64, 'max_members'),
  };
}

/** 只允许 app_id 前 4 位 + ***。 */
export function maskAppId(appId: string): string {
  return appId.length > 4 ? `${appId.slice(0, 4)}***` : '***';
}

/** 替换文本中的 app_id / app_secret；用于错误与日志。 */
export function maskSecrets(text: string, appId: string, appSecret: string): string {
  let masked = text;
  if (appSecret !== '') masked = masked.split(appSecret).join('***');
  if (appId !== '') masked = masked.split(appId).join(maskAppId(appId));
  return masked;
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

/**
 * 由 chat_id 派生成员 id：只保留 [A-Za-z0-9_-]，≤64 字符。
 * 超过 64 字符时取前 55 + "_" + 8 位 hash（Addendum B §11.3.2）。
 */
export function sanitizeAgentId(chatId: string): string {
  const cleaned = chatId.replace(/[^A-Za-z0-9_-]/g, '');
  const hash = shortHash(chatId);

  if (cleaned === '') return `feishu_${hash}`;

  const base = `feishu_${cleaned}`;
  if (base.length <= 64) return base;
  return `${base.slice(0, 55)}_${hash}`;
}

/** 冲突时的备用 id。 */
export function fallbackAgentId(chatId: string): string {
  return `feishu_${shortHash(chatId)}`;
}
