import { describe, expect, it } from 'bun:test';
import { type AssertionInput, evaluateAssertions } from '../src/assertions.js';
import type { EvalAssertion } from '../src/types.js';

function input(overrides: Partial<AssertionInput> = {}): AssertionInput {
  return {
    output: 'hello world',
    duration_ms: 10,
    iterations: 2,
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    toolNames: ['echo'],
    ...overrides,
  };
}

function check(assertion: EvalAssertion, overrides: Partial<AssertionInput> = {}): boolean {
  return evaluateAssertions([assertion], input(overrides))[0]?.ok === true;
}

describe('evaluateAssertions', () => {
  it('output_contains', () => {
    expect(check({ type: 'output_contains', value: 'hello' })).toBe(true);
    expect(check({ type: 'output_contains', value: 'nope' })).toBe(false);
  });

  it('output_matches', () => {
    expect(check({ type: 'output_matches', value: '^hello' })).toBe(true);
    expect(check({ type: 'output_matches', value: '^nope' })).toBe(false);
  });

  it('no_error', () => {
    expect(check({ type: 'no_error' })).toBe(true);
    expect(check({ type: 'no_error' }, { error: 'boom' })).toBe(false);
  });

  it('tool_called and tool_not_called', () => {
    expect(check({ type: 'tool_called', value: 'echo' })).toBe(true);
    expect(check({ type: 'tool_called', value: 'nope' })).toBe(false);
    expect(check({ type: 'tool_not_called', value: 'echo' })).toBe(false);
    expect(check({ type: 'tool_not_called', value: 'nope' })).toBe(true);
  });

  it('max_duration_ms', () => {
    expect(check({ type: 'max_duration_ms', value: 10 })).toBe(true);
    expect(check({ type: 'max_duration_ms', value: 9 })).toBe(false);
  });

  it('max_iterations', () => {
    expect(check({ type: 'max_iterations', value: 2 })).toBe(true);
    expect(check({ type: 'max_iterations', value: 1 })).toBe(false);
    const missing = evaluateAssertions(
      [{ type: 'max_iterations', value: 2 }],
      input({
        iterations: undefined,
      }),
    );
    expect(missing[0]?.ok).toBe(false);
    expect(missing[0]?.detail).toContain('unavailable');
  });

  it('usage_under', () => {
    expect(check({ type: 'usage_under', value: { total_tokens: 3 } })).toBe(true);
    expect(check({ type: 'usage_under', value: { total_tokens: 2 } })).toBe(false);
    const missing = evaluateAssertions(
      [{ type: 'usage_under', value: { total_tokens: 3 } }],
      input({
        usage: undefined,
      }),
    );
    expect(missing[0]?.ok).toBe(false);
    expect(missing[0]?.detail).toContain('unavailable');
  });

  it('reports detail on failures', () => {
    const results = evaluateAssertions([{ type: 'output_contains', value: 'nope' }], input());
    expect(results[0]?.detail).toContain('does not contain');
  });
});
