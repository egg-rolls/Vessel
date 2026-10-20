/**
 * 断言白名单（DECISION-009 §5.2.2 / Addendum B §11.2）。
 */

import type { EvalAssertion, EvalAssertionResult, EvalUsage } from './types.js';

export interface AssertionInput {
  output: string;
  error?: string;
  duration_ms: number;
  iterations?: number;
  usage?: EvalUsage;
  toolNames: string[];
}

function failure(type: string, detail: string): EvalAssertionResult {
  return { type, ok: false, detail };
}

export function evaluateAssertions(
  assertions: EvalAssertion[],
  input: AssertionInput,
): EvalAssertionResult[] {
  return assertions.map((assertion) => evaluateAssertion(assertion, input));
}

function evaluateAssertion(assertion: EvalAssertion, input: AssertionInput): EvalAssertionResult {
  switch (assertion.type) {
    case 'output_contains': {
      const expected = String(assertion.value);
      const ok = input.output.includes(expected);
      return ok
        ? { type: assertion.type, ok }
        : failure(assertion.type, `output does not contain "${expected}"`);
    }

    case 'output_matches': {
      const pattern = new RegExp(String(assertion.value));
      const ok = pattern.test(input.output);
      return ok
        ? { type: assertion.type, ok }
        : failure(assertion.type, `output does not match /${pattern.source}/`);
    }

    case 'no_error': {
      const ok = input.error === undefined;
      return ok ? { type: assertion.type, ok } : failure(assertion.type, input.error ?? 'error');
    }

    case 'tool_called': {
      const expected = String(assertion.value);
      const ok = input.toolNames.includes(expected);
      return ok
        ? { type: assertion.type, ok }
        : failure(assertion.type, `tool "${expected}" was not called`);
    }

    case 'tool_not_called': {
      const expected = String(assertion.value);
      const ok = !input.toolNames.includes(expected);
      return ok
        ? { type: assertion.type, ok }
        : failure(assertion.type, `tool "${expected}" was called`);
    }

    case 'max_duration_ms': {
      const limit = Number(assertion.value);
      const ok = input.duration_ms <= limit;
      return ok
        ? { type: assertion.type, ok }
        : failure(assertion.type, `duration ${input.duration_ms}ms exceeds ${limit}ms`);
    }

    case 'max_iterations': {
      if (input.iterations === undefined) {
        return failure(assertion.type, 'iterations unavailable');
      }
      const limit = Number(assertion.value);
      const ok = input.iterations <= limit;
      return ok
        ? { type: assertion.type, ok }
        : failure(assertion.type, `iterations ${input.iterations} exceeds ${limit}`);
    }

    case 'usage_under': {
      if (input.usage === undefined) {
        return failure(assertion.type, 'usage unavailable');
      }
      const thresholds = assertion.value as Record<string, number>;
      for (const [field, limit] of Object.entries(thresholds)) {
        const actual = input.usage[field as keyof EvalUsage];
        if (actual > limit) {
          return failure(assertion.type, `${field} ${actual} exceeds ${limit}`);
        }
      }
      return { type: assertion.type, ok: true };
    }
  }
}
