/**
 * 稳定错误码（DECISION-009 §5.2.3）。
 */

import type { EvalErrorCode } from './types.js';

export class EvalsError extends Error {
  readonly code: EvalErrorCode;

  constructor(code: EvalErrorCode, message: string) {
    super(message);
    this.name = 'EvalsError';
    this.code = code;
  }
}

export function invalid(message: string): EvalsError {
  return new EvalsError('eval_invalid', message);
}

export function notFound(message: string): EvalsError {
  return new EvalsError('eval_not_found', message);
}
