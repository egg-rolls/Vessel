/**
 * Team policy 解析与校验（0.19 S4）。
 *
 * 规范拼写是 camelCase；输入同时接受手改 `team.json` 的 snake_case 别名。
 * `policy` 顶层保持开放（S3 兼容），`permission` / `budget` 子树严格白名单。
 *
 * @module @vessel-agent/config
 */

import type {
  TeamBudgetCyclePolicy,
  TeamBudgetPolicy,
  TeamPermissionPolicy,
  TeamPolicy,
} from './types.js';

/** 单条策略问题；`field` 是相对 `policy` 的点路径（非对象时缺省）。 */
export interface TeamPolicyIssue {
  field?: string;
  message: string;
}

/** 非法 Team policy；调用方对 `team.json` 是 catch 后 warning + 忽略。 */
export class TeamPolicyError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'TeamPolicyError';
    if (field !== undefined) this.field = field;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface AliasValue {
  present: boolean;
  value: unknown;
}

/** 读取 camelCase 键或 snake_case 别名；两者共存且值不同报错。 */
function readAlias(
  input: Record<string, unknown>,
  canonical: string,
  snake: string,
  field: string,
  issues: TeamPolicyIssue[],
): AliasValue {
  const hasCanonical = Object.hasOwn(input, canonical);
  const hasSnake = Object.hasOwn(input, snake);
  if (hasCanonical && hasSnake && !Object.is(input[canonical], input[snake])) {
    issues.push({
      field,
      message: `policy.${field} is set by both "${canonical}" and "${snake}" with different values`,
    });
  }
  if (hasCanonical) return { present: true, value: input[canonical] };
  if (hasSnake) return { present: true, value: input[snake] };
  return { present: false, value: undefined };
}

function expectInteger(
  value: unknown,
  field: string,
  min: number,
  max: number | undefined,
  issues: TeamPolicyIssue[],
): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    issues.push({
      field,
      message:
        max === undefined
          ? `policy.${field} must be an integer >= ${min}`
          : `policy.${field} must be an integer between ${min} and ${max}`,
    });
    return undefined;
  }
  return value;
}

const PERMISSION_KEYS = new Set(['unattended', 'denyAfterSeconds']);
const PERMISSION_ALIASES = new Set(['deny_after_seconds']);
const PERMISSION_REJECTED = new Set(['allow_after', 'allowAfter']);

function normalizePermission(
  input: Record<string, unknown>,
  issues: TeamPolicyIssue[],
): TeamPermissionPolicy {
  for (const key of Object.keys(input)) {
    if (PERMISSION_REJECTED.has(key)) {
      issues.push({
        field: `permission.${key}`,
        message: 'allow-after is not supported; use hold or deny-after',
      });
      continue;
    }
    if (PERMISSION_KEYS.has(key) || PERMISSION_ALIASES.has(key)) continue;
    issues.push({
      field: `permission.${key}`,
      message: `policy.permission.${key} is not a valid key`,
    });
  }

  const result: TeamPermissionPolicy = {};

  const rawUnattended = Object.hasOwn(input, 'unattended') ? input.unattended : undefined;
  let unattended: 'hold' | 'deny-after' | undefined;
  if (rawUnattended !== undefined) {
    if (rawUnattended === 'hold' || rawUnattended === 'deny-after') {
      unattended = rawUnattended;
    } else {
      issues.push({
        field: 'permission.unattended',
        message: 'policy.permission.unattended must be "hold" or "deny-after"',
      });
    }
  }

  const deny = readAlias(
    input,
    'denyAfterSeconds',
    'deny_after_seconds',
    'permission.denyAfterSeconds',
    issues,
  );
  let denyAfterSeconds: number | undefined;
  if (deny.present) {
    denyAfterSeconds = expectInteger(deny.value, 'permission.denyAfterSeconds', 1, 86400, issues);
  }

  if (unattended !== undefined) result.unattended = unattended;
  if (denyAfterSeconds !== undefined) result.denyAfterSeconds = denyAfterSeconds;

  const effective = unattended ?? 'hold';
  if (effective === 'deny-after' && !deny.present) {
    issues.push({
      field: 'permission.denyAfterSeconds',
      message: 'policy.permission.denyAfterSeconds is required when unattended is "deny-after"',
    });
  }
  if (effective === 'hold' && deny.present) {
    issues.push({
      field: 'permission.denyAfterSeconds',
      message: 'policy.permission.denyAfterSeconds is only allowed when unattended is "deny-after"',
    });
  }

  return result;
}

const CYCLE_KEYS = new Set(['maxRepeats', 'cooldownSeconds']);
const CYCLE_ALIASES = new Set(['max_repeats', 'cooldown_seconds']);

function normalizeCycle(
  input: Record<string, unknown>,
  issues: TeamPolicyIssue[],
): TeamBudgetCyclePolicy {
  for (const key of Object.keys(input)) {
    if (CYCLE_KEYS.has(key) || CYCLE_ALIASES.has(key)) continue;
    issues.push({
      field: `budget.cycle.${key}`,
      message: `policy.budget.cycle.${key} is not a valid key`,
    });
  }

  const result: TeamBudgetCyclePolicy = {};

  const maxRepeats = readAlias(
    input,
    'maxRepeats',
    'max_repeats',
    'budget.cycle.maxRepeats',
    issues,
  );
  if (maxRepeats.present) {
    const value = expectInteger(maxRepeats.value, 'budget.cycle.maxRepeats', 1, undefined, issues);
    if (value !== undefined) result.maxRepeats = value;
  }

  const cooldown = readAlias(
    input,
    'cooldownSeconds',
    'cooldown_seconds',
    'budget.cycle.cooldownSeconds',
    issues,
  );
  if (cooldown.present) {
    const value = expectInteger(
      cooldown.value,
      'budget.cycle.cooldownSeconds',
      0,
      undefined,
      issues,
    );
    if (value !== undefined) result.cooldownSeconds = value;
  }

  return result;
}

const BUDGET_KEYS = new Set([
  'maxHops',
  'maxTurns',
  'maxTokens',
  'maxWallClockSeconds',
  'warningThreshold',
  'cycle',
]);
const BUDGET_ALIASES = new Set([
  'max_hops',
  'max_turns',
  'max_tokens',
  'max_wall_clock_seconds',
  'warning_threshold',
]);
const BUDGET_REJECTED = new Set(['maxCost', 'max_cost']);

function normalizeBudget(
  input: Record<string, unknown>,
  issues: TeamPolicyIssue[],
): TeamBudgetPolicy {
  for (const key of Object.keys(input)) {
    if (BUDGET_REJECTED.has(key)) {
      issues.push({
        field: `budget.${key}`,
        message: 'policy.budget.maxCost is not supported',
      });
      continue;
    }
    if (BUDGET_KEYS.has(key) || BUDGET_ALIASES.has(key)) continue;
    issues.push({
      field: `budget.${key}`,
      message: `policy.budget.${key} is not a valid key`,
    });
  }

  const result: TeamBudgetPolicy = {};

  const maxHops = readAlias(input, 'maxHops', 'max_hops', 'budget.maxHops', issues);
  if (maxHops.present) {
    const value = expectInteger(maxHops.value, 'budget.maxHops', 1, undefined, issues);
    if (value !== undefined) result.maxHops = value;
  }

  const maxTurns = readAlias(input, 'maxTurns', 'max_turns', 'budget.maxTurns', issues);
  if (maxTurns.present) {
    const value = expectInteger(maxTurns.value, 'budget.maxTurns', 1, undefined, issues);
    if (value !== undefined) result.maxTurns = value;
  }

  const maxTokens = readAlias(input, 'maxTokens', 'max_tokens', 'budget.maxTokens', issues);
  if (maxTokens.present) {
    const value = expectInteger(maxTokens.value, 'budget.maxTokens', 1, undefined, issues);
    if (value !== undefined) result.maxTokens = value;
  }

  const maxWallClock = readAlias(
    input,
    'maxWallClockSeconds',
    'max_wall_clock_seconds',
    'budget.maxWallClockSeconds',
    issues,
  );
  if (maxWallClock.present) {
    const value = expectInteger(
      maxWallClock.value,
      'budget.maxWallClockSeconds',
      1,
      undefined,
      issues,
    );
    if (value !== undefined) result.maxWallClockSeconds = value;
  }

  const threshold = readAlias(
    input,
    'warningThreshold',
    'warning_threshold',
    'budget.warningThreshold',
    issues,
  );
  if (threshold.present) {
    const value = threshold.value;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1) {
      result.warningThreshold = value;
    } else {
      issues.push({
        field: 'budget.warningThreshold',
        message: 'policy.budget.warningThreshold must be a number between 0 and 1 (exclusive)',
      });
    }
  }

  if (Object.hasOwn(input, 'cycle')) {
    const cycle = input.cycle;
    if (!isRecord(cycle)) {
      issues.push({ field: 'budget.cycle', message: 'policy.budget.cycle must be an object' });
    } else {
      result.cycle = normalizeCycle(cycle, issues);
    }
  }

  return result;
}

function normalizeTeamPolicy(policy: unknown, issues: TeamPolicyIssue[]): TeamPolicy {
  if (policy === undefined || policy === null) return {};
  if (!isRecord(policy)) {
    issues.push({ message: 'team policy must be an object' });
    return {};
  }

  const result: TeamPolicy = {};
  for (const [key, value] of Object.entries(policy)) {
    if (key === 'allowFork' || key === 'allow_fork') {
      if (typeof value !== 'boolean') {
        issues.push({ field: 'allowFork', message: 'policy.allowFork must be a boolean' });
        continue;
      }
      result.allowFork = value;
      continue;
    }
    if (key === 'permission') {
      if (!isRecord(value)) {
        issues.push({ field: 'permission', message: 'policy.permission must be an object' });
        continue;
      }
      result.permission = normalizePermission(value, issues);
      continue;
    }
    if (key === 'budget') {
      if (!isRecord(value)) {
        issues.push({ field: 'budget', message: 'policy.budget must be an object' });
        continue;
      }
      result.budget = normalizeBudget(value, issues);
      continue;
    }
    // 顶层其它键保持原样（S3 兼容）。
    result[key] = value;
  }
  return result;
}

/** 收集全部策略问题；不抛错（validator 使用）。 */
export function validateTeamPolicy(policy: unknown): TeamPolicyIssue[] {
  const issues: TeamPolicyIssue[] = [];
  normalizeTeamPolicy(policy, issues);
  return issues;
}

/** 解析并归一化为 camelCase；非法时抛 `TeamPolicyError`。 */
export function parseTeamPolicy(policy: unknown): TeamPolicy {
  const issues: TeamPolicyIssue[] = [];
  const normalized = normalizeTeamPolicy(policy, issues);
  const first = issues[0];
  if (first !== undefined) throw new TeamPolicyError(first.message, first.field);
  return normalized;
}
