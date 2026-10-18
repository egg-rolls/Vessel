import { describe, expect, it } from 'bun:test';
import { WorkflowError } from '../src/errors.js';
import {
  interpolate,
  interpolateValue,
  validateDefinitionInputs,
  validateDefinitionTemplates,
  validateInputRefs,
  validateTemplates,
} from '../src/template.js';
import type { WorkflowDefinition } from '../src/types.js';

function context(): Parameters<typeof interpolate>[1] {
  return {
    inputs: { repo: 'vessel' },
    steps: new Map([
      ['a', { output: 'hello world', status: 'completed' }],
      ['b', { output: 'failed output', status: 'failed' }],
    ]),
    workflowName: 'demo',
  };
}

describe('interpolate', () => {
  it('interpolates inputs, step output/status and workflow name', () => {
    expect(
      interpolate(
        '{{inputs.repo}}/{{steps.a.output}}/{{steps.a.status}}/{{workflow.name}}',
        context(),
      ),
    ).toBe('vessel/hello world/completed/demo');
  });

  it('rejects unknown inputs', () => {
    expect(() => interpolate('{{inputs.missing}}', context())).toThrow(WorkflowError);
  });

  it('rejects unknown steps', () => {
    expect(() => interpolate('{{steps.missing.output}}', context())).toThrow(WorkflowError);
  });

  it('rejects invalid token forms', () => {
    expect(() => interpolate('{{steps.a.nope}}', context())).toThrow(WorkflowError);
    expect(() => interpolate('{{a.b}}', context())).toThrow(WorkflowError);
    expect(() => interpolate('{{inputs.a.b}}', context())).toThrow(WorkflowError);
  });

  it('interpolates nested args', () => {
    const value = interpolateValue(
      { path: '{{inputs.repo}}', nested: ['{{steps.a.output}}', { deep: '{{workflow.name}}' }] },
      context(),
    );
    expect(value).toEqual({
      path: 'vessel',
      nested: ['hello world', { deep: 'demo' }],
    });
  });
});

describe('template validation', () => {
  it('validateTemplates accepts known steps and rejects unknown ones', () => {
    validateTemplates('{{steps.a.output}}', new Set(['a']));
    expect(() => validateTemplates('{{steps.z.output}}', new Set(['a']))).toThrow(WorkflowError);
  });

  it('validateInputRefs checks declared inputs', () => {
    validateInputRefs('{{inputs.repo}}', { repo: 'vessel' });
    expect(() => validateInputRefs('{{inputs.repo}}', {})).toThrow(WorkflowError);
  });

  it('validateDefinitionTemplates scans prompt and args', () => {
    const definition: WorkflowDefinition = {
      name: 'x',
      steps: [
        { id: 'a', type: 'agent', agent: 'o', prompt: '{{steps.missing.output}}' },
        { id: 'b', type: 'tool', tool: 't', args: { path: '{{steps.a.output}}' } },
      ],
    };
    expect(() => validateDefinitionTemplates(definition)).toThrow(WorkflowError);
  });

  it('validateDefinitionInputs scans prompt and args', () => {
    const definition: WorkflowDefinition = {
      name: 'x',
      steps: [
        { id: 'a', type: 'agent', agent: 'o', prompt: '{{inputs.repo}}' },
        { id: 'b', type: 'tool', tool: 't', args: { path: '{{inputs.repo}}' } },
      ],
    };
    validateDefinitionInputs(definition, { repo: 'vessel' });
    expect(() => validateDefinitionInputs(definition, {})).toThrow(WorkflowError);
  });
});
