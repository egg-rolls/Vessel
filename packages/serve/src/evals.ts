/**
 * Evals 报告网关边界（0.4 W2，DECISION-009 §5.2.3）。
 *
 * gateway 只读最近一次报告：asm 注入
 * `latest(suite) => Promise<EvalReport | null>`，gateway 不读盘。
 *
 * @module @vessel/serve/evals
 */

export interface EvalCaseAssertion {
  type: string;
  ok: boolean;
  detail?: string;
}

export interface EvalUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface EvalCaseResult {
  id: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  duration_ms: number;
  assertions: EvalCaseAssertion[];
  output?: string;
  usage?: EvalUsage;
  error?: string;
}

export interface EvalReport {
  suite: string;
  network: boolean;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  cases: EvalCaseResult[];
}

/** gateway 注入面；缺省 = evals 端点关闭（返回 eval_not_found） */
export interface EvalsGatewayOptions {
  latest(suite: string): Promise<EvalReport | null>;
}

const CASE_STATUSES: readonly EvalCaseResult['status'][] = ['passed', 'failed', 'error', 'skipped'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeAssertion(input: unknown): EvalCaseAssertion | null {
  if (!isRecord(input)) return null;
  const type = input.type;
  const ok = input.ok;
  if (typeof type !== 'string' || type.length === 0) return null;
  if (typeof ok !== 'boolean') return null;
  const detail = optionalString(input.detail);
  return { type, ok, ...(detail !== undefined ? { detail } : {}) };
}

function normalizeUsage(input: unknown): EvalUsage | undefined {
  if (!isRecord(input)) return undefined;
  return {
    prompt_tokens: toCount(input.prompt_tokens),
    completion_tokens: toCount(input.completion_tokens),
    total_tokens: toCount(input.total_tokens),
  };
}

function normalizeCase(input: unknown): EvalCaseResult | null {
  if (!isRecord(input)) return null;
  const id = input.id;
  const status = input.status;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof status !== 'string' || !CASE_STATUSES.includes(status as EvalCaseResult['status'])) {
    return null;
  }
  const assertions = Array.isArray(input.assertions)
    ? input.assertions
        .map((item) => normalizeAssertion(item))
        .filter((item): item is EvalCaseAssertion => item !== null)
    : [];
  const output = optionalString(input.output);
  const usage = normalizeUsage(input.usage);
  const error = optionalString(input.error);
  return {
    id,
    status: status as EvalCaseResult['status'],
    duration_ms: toNumber(input.duration_ms),
    assertions,
    ...(output !== undefined ? { output } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** 归一化报告：suite 缺失/非法返回 null（→ 404 eval_not_found）。 */
export function normalizeEvalReport(input: unknown): EvalReport | null {
  if (!isRecord(input)) return null;
  const suite = input.suite;
  if (typeof suite !== 'string' || suite.length === 0) return null;
  const cases = Array.isArray(input.cases)
    ? input.cases
        .map((item) => normalizeCase(item))
        .filter((item): item is EvalCaseResult => item !== null)
    : [];
  return {
    suite,
    network: input.network === true,
    started_at: toNumber(input.started_at),
    finished_at: toNumber(input.finished_at),
    duration_ms: toNumber(input.duration_ms),
    total: toCount(input.total),
    passed: toCount(input.passed),
    failed: toCount(input.failed),
    errors: toCount(input.errors),
    skipped: toCount(input.skipped),
    cases,
  };
}
