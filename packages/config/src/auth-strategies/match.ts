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

function fold(strategy: AuthStrategy, value: string): string {
  const trimmed = value.trim();
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
  const candidates = [identity.userId, ...(identity.aliases ?? [])]
    .map((value) => fold(strategy, value))
    .filter((value) => value !== '');
  return allowUserIds.some((entry) => {
    const folded = fold(strategy, entry);
    return folded !== '' && candidates.includes(folded);
  });
}
