/**
 * `allow_user_ids` 的三种形状。
 *
 * 三种形状的差别不是「格式偏好」，而是**每个 provider 用什么当身份**：
 * - GitHub：数值 account id。`login` 可改名、email 可换，都不是身份；
 * - Microsoft：Graph `/v1.0/me` 的 `id`。工作/学校账号是 GUID，个人账号是不透明的
 *   16 进制串（如 `8364acbdb89d0ff1`），所以是「像不像一个 id」的粗筛 + 精确匹配；
 * - Gitee：数值 id 或用户名二选一（用户白名单里写用户名更常见）。
 *
 * @module @vessel-agent/config/auth-strategies/shapes
 */

import type { AllowUserIdsShape } from './types.js';

/** 纯十进制（不整数溢出判断在这里做，见 numeric）。 */
const DECIMAL = /^[0-9]+$/;

/** 非负安全整数，或十进制字符串（>0）。 */
function numericIdReason(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return 'a number must be a positive integer';
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!DECIMAL.test(trimmed)) return 'a string must be all digits';
    if (Number(trimmed) <= 0) return 'the id must be greater than 0';
    return null;
  }
  return 'it must be a number or a string';
}

function numericIdOf(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!DECIMAL.test(trimmed)) return null;
    return Number(trimmed) > 0 ? trimmed : null;
  }
  return null;
}

/**
 * GitHub：**只**接受数值 user id。
 *
 * `/user` 的 `login` 和 email 都可变，只有数值 id 是稳定的，所以字符串形式的
 * 用户名一律拒绝（错误文案会说清「不是格式问题，是语义问题」）。
 */
export const NUMERIC_USER_ID_SHAPE: AllowUserIdsShape = {
  shape: 'github-numeric-id',
  applicable: true,
  caseSensitive: true,
  describe: 'numeric GitHub user id (the account id, NOT the login name)',
  examples: ['174765587', '"174765587"'],
  rejectReason: numericIdReason,
  normalize: numericIdOf,
};

/**
 * Microsoft：Graph `/me` 的 `id`，**大小写不敏感**。
 *
 * GUID 与个人账号的 16 进制 id 都接受；大小写由匹配阶段忽略（`caseSensitive: false`），
 * 这里保留原样字符串（日志里好认）。
 */
const MICROSOFT_OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const MICROSOFT_OBJECT_ID_SHAPE: AllowUserIdsShape = {
  shape: 'microsoft-object-id',
  applicable: true,
  caseSensitive: false,
  describe:
    'Microsoft Graph object id (a GUID for work/school accounts, e.g. ' +
    '`8f3c1f4e-2b7a-4c1d-9a55-0f1e2d3c4b5a`; personal accounts use a 16-hex id like ' +
    '`8364acbdb89d0ff1`), compared case-insensitively',
  examples: ['8f3c1f4e-2b7a-4c1d-9a55-0f1e2d3c4b5a', '8364acbdb89d0ff1'],
  rejectReason: (value: unknown): string | null => {
    if (typeof value !== 'string') return 'it must be a string (Graph object ids are strings)';
    const trimmed = value.trim();
    if (trimmed === '') return 'it must not be empty';
    if (!MICROSOFT_OBJECT_ID.test(trimmed)) {
      return 'it may only contain letters, digits, dot, underscore and dash (max 128 chars)';
    }
    return null;
  },
  normalize: (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return MICROSOFT_OBJECT_ID.test(trimmed) ? trimmed : null;
  },
};

/** Gitee 用户名：字母数字，允许 `_` `-` `.`，2–64 位（Gitee 的 login 规则）。 */
const GITEE_LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

/**
 * Gitee：**数值 id 或用户名**。
 *
 * 两者都接受是因为 Gitee 的 `login` 在实践中就是稳定标识；但 `login` 一旦全数字，
 * 就和 id 同形了 —— 所以归一后一律按「原样字符串」精确匹配，不做 id ↔ login 的互推。
 */
export const GITEE_ID_OR_LOGIN_SHAPE: AllowUserIdsShape = {
  shape: 'gitee-id-or-login',
  applicable: true,
  caseSensitive: false,
  describe: 'Gitee numeric user id OR Gitee login name, compared case-insensitively',
  examples: ['1234567', 'octocat'],
  rejectReason: (value: unknown): string | null => {
    if (typeof value === 'number') return numericIdReason(value);
    if (typeof value !== 'string') return 'it must be a number or a string';
    const trimmed = value.trim();
    if (DECIMAL.test(trimmed)) return numericIdReason(trimmed);
    if (!GITEE_LOGIN.test(trimmed)) {
      return 'a login name must be 2-64 chars of letters, digits, dot, underscore or dash';
    }
    return null;
  },
  normalize: (value: unknown): string | null => {
    if (typeof value === 'number') return numericIdOf(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (DECIMAL.test(trimmed)) return numericIdOf(trimmed);
    return GITEE_LOGIN.test(trimmed) ? trimmed : null;
  },
};

/** 口令后端：**不适用**（配了就是配置错误，见 validator）。 */
export const NO_ALLOW_USER_IDS_SHAPE: AllowUserIdsShape = {
  shape: 'not-applicable',
  applicable: false,
  caseSensitive: true,
  describe:
    'not applicable: the password backend has no allowlist (the login name is the identity)',
  examples: [],
  rejectReason: () => 'the password backend does not take allowUserIds',
  normalize: () => null,
};
