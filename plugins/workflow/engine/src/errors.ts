/**
 * 稳定错误码（DECISION-009 §5.1.4）。
 */

import type { WorkflowErrorCode } from './types.js';

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

export function invalid(message: string): WorkflowError {
  return new WorkflowError('workflow_invalid', message);
}

export function notFound(message: string): WorkflowError {
  return new WorkflowError('workflow_not_found', message);
}
