/** Team policy 结构化表单：读取、校验与合并（保留未知键）。 */

export interface PolicyFormState {
  unattended: '' | 'hold' | 'deny-after';
  denyAfterSeconds: string;
  maxHops: string;
  maxTurns: string;
  maxTokens: string;
  maxWallClockSeconds: string;
  warningThreshold: string;
  cycleMaxRepeats: string;
  cycleCooldownSeconds: string;
  allowFork: boolean;
  federationAccept: '' | 'principal' | 'log';
}

/** 只包含数值输入字段；select / checkbox 不产生字段级错误。 */
export type PolicyErrorField =
  | 'denyAfterSeconds'
  | 'maxHops'
  | 'maxTurns'
  | 'maxTokens'
  | 'maxWallClockSeconds'
  | 'warningThreshold'
  | 'cycleMaxRepeats'
  | 'cycleCooldownSeconds';

export type PolicyError =
  | { code: 'integerMin'; min: number }
  | { code: 'denyAfterRange' }
  | { code: 'denyAfterRequired' }
  | { code: 'threshold' };

export type PolicyErrors = Partial<Record<PolicyErrorField, PolicyError>>;

export type PolicyBuildResult =
  | { ok: true; policy: Record<string, unknown> }
  | { ok: false; errors: PolicyErrors };

export function emptyPolicyForm(): PolicyFormState {
  return {
    unattended: '',
    denyAfterSeconds: '',
    maxHops: '',
    maxTurns: '',
    maxTokens: '',
    maxWallClockSeconds: '',
    warningThreshold: '',
    cycleMaxRepeats: '',
    cycleCooldownSeconds: '',
    allowFork: false,
    federationAccept: '',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function group(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function numberText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** 从现有 policy 回填；不认识的已知值（如 federation.accept: 'members'）按未设置处理。 */
export function policyToForm(policy: Record<string, unknown> | undefined): PolicyFormState {
  const permission = isRecord(policy?.permission) ? policy.permission : {};
  const budget = isRecord(policy?.budget) ? policy.budget : {};
  const cycle = isRecord(budget.cycle) ? budget.cycle : {};
  const federation = isRecord(policy?.federation) ? policy.federation : {};
  const unattended = permission.unattended;
  const accept = federation.accept;
  return {
    unattended: unattended === 'hold' || unattended === 'deny-after' ? unattended : '',
    denyAfterSeconds: numberText(permission.denyAfterSeconds),
    maxHops: numberText(budget.maxHops),
    maxTurns: numberText(budget.maxTurns),
    maxTokens: numberText(budget.maxTokens),
    maxWallClockSeconds: numberText(budget.maxWallClockSeconds),
    warningThreshold: numberText(budget.warningThreshold),
    cycleMaxRepeats: numberText(cycle.maxRepeats),
    cycleCooldownSeconds: numberText(cycle.cooldownSeconds),
    allowFork: policy?.allowFork === true,
    federationAccept: accept === 'principal' || accept === 'log' ? accept : '',
  };
}

/** 空串 → undefined；非整数 / 越界 → 记录字段错误并返回 undefined。 */
function integerField(
  raw: string,
  field: PolicyErrorField,
  min: number,
  max: number | undefined,
  errors: PolicyErrors,
): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    errors[field] = max === undefined ? { code: 'integerMin', min } : { code: 'denyAfterRange' };
    return undefined;
  }
  return value;
}

function applyInteger(
  raw: string,
  field: PolicyErrorField,
  target: Record<string, unknown>,
  key: string,
  min: number,
  max: number | undefined,
  errors: PolicyErrors,
): void {
  if (raw.trim() === '') {
    delete target[key];
    return;
  }
  const value = integerField(raw, field, min, max, errors);
  if (value !== undefined) target[key] = value;
}

/**
 * 以 `base` 为底合并表单：
 * - 顶层与已知分组里的未知键原样保留；
 * - 空输入删除对应的已知键；
 * - 只写回显式填写 / 勾选的值。
 */
export function buildPolicy(
  base: Record<string, unknown> | undefined,
  form: PolicyFormState,
): PolicyBuildResult {
  const errors: PolicyErrors = {};
  const next: Record<string, unknown> = { ...(base ?? {}) };
  const permission = group(next.permission);
  const budget = group(next.budget);
  const cycle = group(budget.cycle);
  const federation = group(next.federation);

  // permission
  if (form.unattended === '') {
    delete permission.unattended;
    delete permission.denyAfterSeconds;
  } else if (form.unattended === 'hold') {
    permission.unattended = 'hold';
    delete permission.denyAfterSeconds;
  } else {
    permission.unattended = 'deny-after';
    if (form.denyAfterSeconds.trim() === '') {
      errors.denyAfterSeconds = { code: 'denyAfterRequired' };
    } else {
      const seconds = integerField(form.denyAfterSeconds, 'denyAfterSeconds', 1, 86400, errors);
      if (seconds !== undefined) permission.denyAfterSeconds = seconds;
    }
  }

  // budget
  applyInteger(form.maxHops, 'maxHops', budget, 'maxHops', 1, undefined, errors);
  applyInteger(form.maxTurns, 'maxTurns', budget, 'maxTurns', 1, undefined, errors);
  applyInteger(form.maxTokens, 'maxTokens', budget, 'maxTokens', 1, undefined, errors);
  applyInteger(
    form.maxWallClockSeconds,
    'maxWallClockSeconds',
    budget,
    'maxWallClockSeconds',
    1,
    undefined,
    errors,
  );

  if (form.warningThreshold.trim() === '') {
    delete budget.warningThreshold;
  } else {
    const value = Number(form.warningThreshold.trim());
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      errors.warningThreshold = { code: 'threshold' };
    } else {
      budget.warningThreshold = value;
    }
  }

  // budget.cycle
  applyInteger(form.cycleMaxRepeats, 'cycleMaxRepeats', cycle, 'maxRepeats', 1, undefined, errors);
  applyInteger(
    form.cycleCooldownSeconds,
    'cycleCooldownSeconds',
    cycle,
    'cooldownSeconds',
    0,
    undefined,
    errors,
  );

  if (Object.keys(cycle).length > 0) budget.cycle = cycle;
  else delete budget.cycle;

  if (Object.keys(budget).length > 0) next.budget = budget;
  else delete next.budget;

  if (Object.keys(permission).length > 0) next.permission = permission;
  else delete next.permission;

  // federation
  if (form.federationAccept === '') delete federation.accept;
  else federation.accept = form.federationAccept;
  if (Object.keys(federation).length > 0) next.federation = federation;
  else delete next.federation;

  // allowFork：勾选写 true；未勾选且原本显式 false 时保留 false，否则删除。
  if (form.allowFork) next.allowFork = true;
  else if (base?.allowFork !== false) delete next.allowFork;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, policy: next };
}

/** policy 是否相对初始值发生变化（键序由同一底对象派生，可直接序列化比较）。 */
export function policyChanged(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): boolean {
  return JSON.stringify(before ?? {}) !== JSON.stringify(after);
}
