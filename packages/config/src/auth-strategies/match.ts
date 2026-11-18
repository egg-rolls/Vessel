/**
 * 白名单的**归一**与**比对**（与 provider 无关的策略：每个策略只声明形状）。
 *
 * 归一（配置加载时）与比对（登录回调时）必须用同一份形状声明，否则会出现
 * 「校验说这条合法，解析时被静默丢掉 → 白名单为空 → 谁都登录不了」这类
 * 「配置写对了却进不去」的故障。
 *
 * @module @vessel-agent/config/auth-strategies/match
 */

import type { AuthStrategy, AuthStrategyIdentity } from './types.js';

/** 归一结果：`ids` 用于匹配，`rejected` 是写错的条目（调用方给告警用）。 */
export interface NormalizedAllowUserIds {
  ids: string[];
  rejected: unknown[];
}

/** 按策略形状归一 `allow_user_ids`（去重、保序）。 */
export function normalizeAllowUserIds(
  strategy: AuthStrategy,
  raw: readonly unknown[] | undefined,
): NormalizedAllowUserIds {
  const ids: string[] = [];
  const rejected: unknown[] = [];
  if (!Array.isArray(raw)) return { ids, rejected };
  for (const entry of raw) {
    const value = strategy.allowUserIdsShape.normalize(entry);
    if (value === null) {
      rejected.push(entry);
      continue;
    }
    const folded = fold(strategy, value);
    if (!ids.includes(folded)) ids.push(folded);
  }
  return { ids, rejected };
}

/**
 * 归一成比较用的字符串；**非字符串一律 null**（不是 `String(value)`）。
 *
 * 这里必须拒绝而不是强转：万一有调用方手搓配置把数字塞进 `allowUserIds`，
 * 强转会得到 "174765587" 这种「看起来对」的值，而 `undefined` 强转成 "undefined"
 * 更会让一个本来该拒绝的身份命中白名单。宁可这条配置项不参与比较。
 */
function fold(strategy: AuthStrategy, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return strategy.allowUserIdsShape.caseSensitive ? trimmed : trimmed.toLowerCase();
}

/**
 * 身份是否在白名单里。
 *
 * 比对的候选值是 `userId` 与 `aliases`（`username` 只在策略明确把它声明成
 * `aliases` 时才参与 —— 见 Gitee）。
 */
export function isAllowlisted(
  strategy: AuthStrategy,
  allowUserIds: readonly string[],
  identity: Pick<AuthStrategyIdentity, 'userId' | 'username' | 'aliases'>,
): boolean {
  const candidates = new Set(
    [identity.userId, ...(identity.aliases ?? [])]
      .map((value) => fold(strategy, value))
      .filter((value): value is string => value !== null),
  );
  if (candidates.size === 0) return false;
  return allowUserIds.some((entry) => {
    const folded = fold(strategy, entry);
    return folded !== null && candidates.has(folded);
  });
}
