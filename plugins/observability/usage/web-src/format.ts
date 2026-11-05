import type { CacheUnavailableReason, SummaryResult } from '../src/aggregate.js';

/** Missing counters are an em dash, never 0 (CONTRACT: cache/cost semantics). */
export const MISSING = '—';

export function fmtInt(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US')
    : MISSING;
}

export function fmtPct(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return MISSING;
  let percent = value * 100;
  if (percent >= 99.95) percent = 100;
  return `${(Math.round(percent * 10) / 10).toFixed(1).replace(/\.0$/, '')}%`;
}

export function fmtCost(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return MISSING;
  if (value === 0) return '$0';
  const digits = value < 0.01 ? 6 : 4;
  return `$${value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function fmtDuration(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return MISSING;
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function fmtTime(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MISSING;
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function ratioHint(reason: CacheUnavailableReason | undefined, fallback: string): string {
  switch (reason) {
    case 'no-requests':
      return 'No requests in range';
    case 'no-cache-fields':
      return 'Provider did not report cache';
    case 'zero-denominator':
      return 'No cache activity in range';
    case 'prompt-not-inclusive':
      return 'Cache counters exceed prompt tokens';
    case 'write-not-reported':
      return 'Cache writes were not reported';
    default:
      return fallback;
  }
}

export function costHint(data: Pick<SummaryResult, 'cost' | 'unpriced_requests'>): string {
  const unpriced = Number(data.unpriced_requests) || 0;
  if (data.cost === undefined && unpriced > 0) {
    return 'No configured price for these models';
  }
  if (unpriced > 0) {
    return `${unpriced} unpriced request(s); total covers priced models`;
  }
  return 'USD, from configured prices';
}
