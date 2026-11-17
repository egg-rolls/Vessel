/**
 * 0.56：把 auth 块解析成平台入口的运行参数。
 *
 * 本解析器不抛错、也不读密钥：配置写了一半只会降级成「未启用登录」并给告警 ——
 * 把运维锁在一个本来能用的本地 WebUI 外面，比少一个功能更糟。
 *
 * @module @vessel-agent/config/auth
 */

import * as path from 'node:path';
import type { AuthBackendConfig, AuthConfig } from './types.js';

/** Resolved backend: allowlist ids normalized to decimal strings. */
export interface ResolvedAuthBackend {
  kind: 'github_oauth';
  clientId: string;
  /** Env var NAME of the client secret (never the value). */
  clientSecretEnv: string;
  allowUserIds: string[];
  label?: string;
}

export interface ResolvedAuthSession {
  idleMinutes: number;
  absoluteHours: number;
  /** Session digest file; undefined = memory only. */
  storageFile?: string;
}

export interface ResolvedAuthSettings {
  /** Public origin, or null when not configured. */
  publicOrigin: string | null;
  allowedHosts: string[];
  /** undefined = trust only loopback sockets. */
  trustedProxies?: string[];
  backends: ResolvedAuthBackend[];
  session: ResolvedAuthSession;
  /** Human-readable degradations; the composition root prints them.
   */
  warnings: string[];
}

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_ABSOLUTE_HOURS = 12;

function normalizeOrigin(raw: string | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

function normalizeUserIds(raw: Array<number | string> | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    const value = typeof entry === 'number' ? String(entry) : entry.trim();
    // Numeric ids only: /user emails are mutable and NOT an identity here.
    if (/^[0-9]+$/.test(value)) ids.push(value);
  }
  return ids;
}

function resolveBackend(
  raw: AuthBackendConfig,
  warnings: string[],
  index: number,
): ResolvedAuthBackend | null {
  const label =
    typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : undefined;
  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : '';
  const secretEnv = typeof raw.clientSecretEnv === 'string' ? raw.clientSecretEnv.trim() : '';
  if (clientId === '' || secretEnv === '') {
    warnings.push(
      `auth.backends[${String(index)}]: clientId / clientSecretEnv missing, backend ignored`,
    );
    return null;
  }
  const allowUserIds = normalizeUserIds(raw.allowUserIds);
  if (allowUserIds.length === 0) {
    // Nothing to allow = nobody could log in; say so instead of silently refusing.
    warnings.push(
      'auth.backends[' +
        String(index) +
        ']: allowUserIds is empty, login backend ignored ' +
        '(set the numeric GitHub user id, e.g. 174765587)',
    );
    return null;
  }
  return {
    kind: 'github_oauth',
    clientId,
    clientSecretEnv: secretEnv,
    allowUserIds,
    ...(label !== undefined ? { label } : {}),
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
  const publicOrigin = normalizeOrigin(raw?.publicOrigin);
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
      if (typeof entry !== 'object' || entry === null) {
        warnings.push(`auth.backends[${String(index)}]: not an object, ignored`);
        return;
      }
      if (entry.kind !== undefined && entry.kind !== 'github_oauth') {
        warnings.push(
          'auth.backends[' +
            String(index) +
            ']: unsupported kind ' +
            String(entry.kind) +
            ', ignored',
        );
        return;
      }
      const resolved = resolveBackend(entry, warnings, index);
      if (resolved !== null) backends.push(resolved);
    });
  }

  if (backends.length > 0 && publicOrigin === null) {
    // redirect_uri has exactly one source; without it login would point anywhere.
    warnings.push(
      'auth.publicOrigin is missing or invalid: login backends are disabled ' +
        '(redirect_uri would be undefined). Loopback WebUI keeps working.',
    );
    backends.length = 0;
  }

  return {
    publicOrigin,
    allowedHosts,
    ...(trustedProxies !== undefined ? { trustedProxies } : {}),
    backends,
    session: {
      idleMinutes,
      absoluteHours,
      ...(storageFile !== undefined ? { storageFile } : {}),
    },
    warnings,
  };
}
