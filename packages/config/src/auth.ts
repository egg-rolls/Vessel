/**
 * 0.56：把 auth 块解析成平台入口的运行参数。
 *
 * 本解析器不抛错、也不读密钥：配置写了一半只会降级成「未启用登录」并给告警 ——
 * 把运维锁在一个本来能用的本地 WebUI 外面，比少一个功能更糟。
 *
 * 0.62：后端种类与 `allow_user_ids` 的语义**全部来自策略注册表**
 * （`./auth-strategies/`），这里不再有 `kind` 白名单，也不再有「GitHub 专用」的
 * id 归一规则。
 *
 * @module @vessel-agent/config/auth
 */

import * as path from 'node:path';
import { authOriginRejectReason, parseAuthOrigin } from './auth-origins.js';
import {
  describeRegisteredAuthKinds,
  getAuthStrategy,
  normalizeAllowUserIds,
  PASSWORD_STRATEGY_KIND,
  requiresPublicOrigin,
} from './auth-strategies/index.js';
import type { AuthConfig } from './types.js';

/** Resolved OAuth backend: allowlist ids normalized by the strategy's shape. */
export interface ResolvedOAuthBackend {
  /** `auth.backends[].kind` 的生效值（缺省已填成 `github_oauth`）。 */
  kind: string;
  clientId: string;
  /** Env var NAME of the client secret (never the value). */
  clientSecretEnv: string;
  allowUserIds: string[];
  label?: string;
}

/** 0.56 名称的兼容别名。 */
export type ResolvedGitHubBackend = ResolvedOAuthBackend;

/**
 * Resolved password backend。值（口令 hash / TOTP 密钥）**不在这里**：
 * 只带环境变量名，真值在启动时由 AuthService 从 env 或凭据文件解析。
 */
export interface ResolvedPasswordBackend {
  kind: 'password';
  username: string;
  passwordHashEnv?: string;
  totpSecretEnv?: string;
  label?: string;
}

export type ResolvedAuthBackend = ResolvedOAuthBackend | ResolvedPasswordBackend;

export interface ResolvedAuthSession {
  idleMinutes: number;
  absoluteHours: number;
  /** Session digest file; undefined = memory only. */
  storageFile?: string;
}

export interface ResolvedAuthSettings {
  /**
   * 0.60：公网来源白名单（有序、已归一、去重）。空 = 不启用公网来源（旧行为）。
   * `publicOrigin` 与 `publicOrigins` 合并后的结果。
   */
  publicOrigins: string[];
  /**
   * 单个公网 origin，或 null。
   *
   * 保留给老调用方（= `publicOrigins[0] ?? null`）；新代码一律读 `publicOrigins`
   * 并按受信边缘选一个 —— 单读这个字段等于默认「只有一个来源」。
   */
  publicOrigin: string | null;
  allowedHosts: string[];
  /** undefined = trust only loopback sockets. */
  trustedProxies?: string[];
  backends: ResolvedAuthBackend[];
  session: ResolvedAuthSession;
  /** 凭据库文件（口令 hash / TOTP 密钥 / 恢复码 hash）；undefined = 纯内存。 */
  credentialsFile?: string;
  /** 登录限速状态文件（重启不清锁）；undefined = 纯内存。 */
  lockoutFile?: string;
  /** Human-readable degradations; the composition root prints them.
   */
  warnings: string[];
}

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_ABSOLUTE_HOURS = 12;

/**
 * 0.60：合并 `public_origin`（单来源，兼容）与 `public_origins`（并列白名单）。
 *
 * 顺序：`public_origin` 在前、列表按配置顺序跟上；去重（同一个 origin 写两遍只算一个）。
 * 两条同时出现**不是错误** —— `public_origin` 的语义就是「只有一个元素的
 * `public_origins`」。
 *
 * 非法条目**不静默**：每条都带着「哪个字段、写的是什么、为什么不行」进 `rejected`，
 * 由调用方转成告警。静默丢弃过一次的后果是「白名单为空 ⇒ 谁都登录不了」，而配置看上去
 * 是写了的。
 */
function collectOrigins(
  single: unknown,
  list: unknown,
): { origins: string[]; rejected: Array<{ field: string; value: unknown; reason: string }> } {
  const origins: string[] = [];
  const rejected: Array<{ field: string; value: unknown; reason: string }> = [];
  const push = (field: string, raw: unknown): void => {
    if (raw === undefined || raw === null) return;
    const reason = authOriginRejectReason(raw);
    const origin = reason === null ? parseAuthOrigin(raw) : null;
    if (origin === null) {
      rejected.push({ field, value: raw, reason: reason ?? 'not a usable origin' });
      return;
    }
    if (!origins.includes(origin)) origins.push(origin);
  };
  push('auth.publicOrigin', single);
  if (Array.isArray(list)) {
    list.forEach((entry, index) => {
      push(`auth.publicOrigins[${String(index)}]`, entry);
    });
  } else if (list !== undefined) {
    push('auth.publicOrigins', list);
  }
  return { origins, rejected };
}

/** 读取一个「可能是任何东西」的配置值（YAML 进来时没有类型保证）。 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 单条 backend 的解析。入参是**未校验的原始记录**：YAML 里什么都可能写，
 * 这里只降级 + 告警，不抛错（校验器负责把错误说清楚）。
 */
function resolveBackend(
  entry: Record<string, unknown>,
  warnings: string[],
  index: number,
): ResolvedAuthBackend | null {
  const where = `auth.backends[${String(index)}]`;
  const kindRaw = entry.kind;
  if (kindRaw !== undefined && typeof kindRaw !== 'string') {
    warnings.push(`${where}: kind must be a string, backend ignored`);
    return null;
  }
  const kind = typeof kindRaw === 'string' ? kindRaw.trim() : undefined;
  const strategy = getAuthStrategy(kind === '' ? undefined : kind);
  if (strategy === null) {
    // 校验器会把这条报成错误；这里只是让「没有校验器」的调用方也能读懂。
    warnings.push(
      `${where}: unknown kind "${String(kindRaw)}", backend ignored. ` +
        `Registered kinds: ${describeRegisteredAuthKinds()}`,
    );
    return null;
  }
  const label = asString(entry.label);
  if (strategy.kind === PASSWORD_STRATEGY_KIND) {
    const username = asString(entry.username);
    const hashEnv = asString(entry.passwordHashEnv);
    const totpEnv = asString(entry.totpSecretEnv);
    return {
      kind: 'password',
      username: username === '' ? 'admin' : username,
      ...(hashEnv !== '' ? { passwordHashEnv: hashEnv } : {}),
      ...(totpEnv !== '' ? { totpSecretEnv: totpEnv } : {}),
      ...(label !== '' ? { label } : {}),
    };
  }
  const clientId = asString(entry.clientId);
  const secretEnv = asString(entry.clientSecretEnv);
  if (clientId === '' || secretEnv === '') {
    warnings.push(
      `${where} (kind: ${strategy.kind}): clientId / clientSecretEnv missing, backend ignored`,
    );
    return null;
  }
  const rawIds = Array.isArray(entry.allowUserIds) ? entry.allowUserIds : undefined;
  const { ids: allowUserIds, rejected } = normalizeAllowUserIds(strategy, rawIds);
  if (rejected.length > 0) {
    const shape = strategy.allowUserIdsShape;
    warnings.push(
      `${where} (kind: ${strategy.kind}): ignoring ${String(rejected.length)} unusable ` +
        `allowUserIds entr${rejected.length === 1 ? 'y' : 'ies'} ` +
        `(expected ${shape.describe}` +
        (shape.examples.length > 0 ? `, e.g. ${shape.examples[0] ?? ''}` : '') +
        ')',
    );
  }
  if (allowUserIds.length === 0) {
    // Nothing to allow = nobody could log in; say so instead of silently refusing.
    const shape = strategy.allowUserIdsShape;
    warnings.push(
      `${where} (kind: ${strategy.kind}): allowUserIds is empty, login backend ignored ` +
        `(set ${shape.describe}` +
        (shape.examples.length > 0 ? `, e.g. ${shape.examples[0] ?? ''}` : '') +
        ')',
    );
    return null;
  }
  return {
    kind: strategy.kind,
    clientId,
    clientSecretEnv: secretEnv,
    allowUserIds,
    ...(label !== '' ? { label } : {}),
  };
}

/**
 * Resolve the auth block. Never throws: every degradation lands in warnings.
 */
export function resolveAuthSettings(input: {
  auth?: AuthConfig | undefined;
  /** Gateway data dir; session digests live under <dataDir>/auth/.
   */
  dataDir?: string | undefined;
}): ResolvedAuthSettings {
  const warnings: string[] = [];
  const raw = input.auth;
  const originScan = collectOrigins(raw?.publicOrigin, raw?.publicOrigins);
  const publicOrigins = originScan.origins;
  // 非法条目**不静默**：写错的来源 + 原因进告警（静默丢过的后果是「白名单为空 ⇒
  // 谁都登录不了」，而配置看上去是写了的）。
  for (const item of originScan.rejected) {
    warnings.push(`${item.field} (${JSON.stringify(item.value)}) is ignored: ${item.reason}`);
  }
  const publicOrigin = publicOrigins[0] ?? null;
  const allowedHosts = Array.isArray(raw?.allowedHosts)
    ? raw.allowedHosts
        .filter((entry): entry is string => typeof entry === 'string')
        .map((e) => e.trim())
        .filter((e) => e !== '')
    : [];
  const trustedProxies = Array.isArray(raw?.trustedProxies)
    ? raw.trustedProxies
        .filter((entry): entry is string => typeof entry === 'string')
        .map((e) => e.trim())
        .filter((e) => e !== '')
    : undefined;

  const idleMinutes =
    typeof raw?.session?.idleMinutes === 'number' && raw.session.idleMinutes > 0
      ? Math.floor(raw.session.idleMinutes)
      : DEFAULT_IDLE_MINUTES;
  const absoluteHours =
    typeof raw?.session?.absoluteHours === 'number' && raw.session.absoluteHours > 0
      ? Math.floor(raw.session.absoluteHours)
      : DEFAULT_ABSOLUTE_HOURS;
  const persist = raw?.session?.persist !== false;
  const storageFile =
    persist && typeof input.dataDir === 'string' && input.dataDir !== ''
      ? path.join(input.dataDir, 'auth', 'sessions.json')
      : undefined;

  const backends: ResolvedAuthBackend[] = [];
  if (raw?.enabled !== false && Array.isArray(raw?.backends)) {
    raw.backends.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        warnings.push(`auth.backends[${String(index)}]: not an object, ignored`);
        return;
      }
      const resolved = resolveBackend(entry as Record<string, unknown>, warnings, index);
      if (resolved !== null) backends.push(resolved);
    });
  }

  if (backends.length > 0 && publicOrigins.length === 0) {
    // redirect_uri has exactly one source: the whitelist; without it the OAuth
    // backend would point anywhere.
    // 口令后端不需要 redirect_uri，所以只摘掉 OAuth 项 —— 配了口令后端却
    // 因为少一个 publicOrigin 就连登录一起关掉，就是又一次「配置半截 ⇒ 把自己锁在外」。
    if (backends.some((backend) => requiresPublicOrigin(backend.kind))) {
      warnings.push(
        'auth.publicOrigin / auth.publicOrigins is missing or invalid: OAuth backends are ' +
          'disabled (redirect_uri would be undefined). Password login and the loopback WebUI keep working.',
      );
      const kept = backends.filter((backend) => !requiresPublicOrigin(backend.kind));
      backends.length = 0;
      backends.push(...kept);
    }
  }

  const authDir =
    typeof input.dataDir === 'string' && input.dataDir !== ''
      ? path.join(input.dataDir, 'auth')
      : undefined;

  return {
    publicOrigins,
    publicOrigin,
    allowedHosts,
    ...(trustedProxies !== undefined ? { trustedProxies } : {}),
    backends,
    session: {
      idleMinutes,
      absoluteHours,
      ...(storageFile !== undefined ? { storageFile } : {}),
    },
    ...(authDir !== undefined ? { credentialsFile: path.join(authDir, 'credentials.json') } : {}),
    ...(authDir !== undefined ? { lockoutFile: path.join(authDir, 'lockout.json') } : {}),
    warnings,
  };
}
