import { describe, expect, it } from 'bun:test';
import { WorkflowError } from '../src/errors.js';
import { validateDependencies } from '../src/graph.js';
import type { WorkflowStepDefinition } from '../src/types.js';

function step(id: string, dependsOn: string[] = []): WorkflowStepDefinition {
  return { id, type: 'agent', agent: 'o', prompt: 'hi', depends_on: dependsOn };
}

describe('validateDependencies', () => {
  it('returns a stable topological order', () => {
    const order = validateDependencies([step('c', ['b']), step('a'), step('b', ['a'])]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('rejects unknown dependencies', () => {
    expect(() => validateDependencies([step('a', ['missing'])])).toThrow(WorkflowError);
  });

  it('rejects self dependencies', () => {
    expect(() => validateDependencies([step('a', ['a'])])).toThrow(WorkflowError);
  });

  it('rejects cycles', () => {
    expect(() => validateDependencies([step('a', ['b']), step('b', ['a'])])).toThrow(WorkflowError);
  });
});
