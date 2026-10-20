import { describe, expect, test } from 'bun:test';
import type { WorkflowRunSummary } from '../src/gateway/types';
import {
  inputsToRows,
  parseWorkflowInputRows,
  parseWorkflowInputsJson,
  rowsToJsonText,
  validateWorkflowName,
  validateWorkflowStart,
} from '../src/state/workflow-inputs';
import {
  filterWorkflows,
  progressPercent,
  workflowStatusActive,
  workflowStatusCancellable,
  workflowStatusResumable,
} from '../src/state/workflows';

describe('validateWorkflowName', () => {
  test('accepts the server pattern and trims', () => {
    expect(validateWorkflowName(' smoke ')).toBe('smoke');
    expect(validateWorkflowName('deploy-api_v2')).toBe('deploy-api_v2');
  });

  test('rejects empty, spaced and overlong names', () => {
    expect(validateWorkflowName('')).toBeNull();
    expect(validateWorkflowName('has space')).toBeNull();
    expect(validateWorkflowName('a'.repeat(65))).toBeNull();
    expect(validateWorkflowName('../etc/passwd')).toBeNull();
  });
});

describe('parseWorkflowInputsJson', () => {
  test('empty means no inputs', () => {
    expect(parseWorkflowInputsJson('   ')).toEqual({ ok: true });
  });

  test('accepts a flat string map', () => {
    expect(parseWorkflowInputsJson('{"env":"prod","count":"2"}')).toEqual({
      ok: true,
      value: { env: 'prod', count: '2' },
    });
  });

  test('rejects malformed JSON and non-string values', () => {
    expect(parseWorkflowInputsJson('{nope').ok).toBe(false);
    expect(parseWorkflowInputsJson('[]').ok).toBe(false);
    expect(parseWorkflowInputsJson('{"n":1}').ok).toBe(false);
  });

  test('rejects overlong keys and values', () => {
    const longKey = 'k'.repeat(65);
    expect(parseWorkflowInputsJson(JSON.stringify({ [longKey]: 'v' })).ok).toBe(false);
    const longValue = 'v'.repeat(10_001);
    expect(parseWorkflowInputsJson(JSON.stringify({ k: longValue })).ok).toBe(false);
  });

  test('rejects more than 64 entries', () => {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, 'v']));
    expect(parseWorkflowInputsJson(JSON.stringify(many)).ok).toBe(false);
  });
});

describe('parseWorkflowInputRows', () => {
  test('ignores fully blank rows', () => {
    expect(
      parseWorkflowInputRows([
        { key: '', value: '' },
        { key: '  ', value: '  ' },
      ]),
    ).toEqual({ ok: true });
  });

  test('trims keys but keeps values', () => {
    expect(parseWorkflowInputRows([{ key: ' env ', value: ' prod ' }])).toEqual({
      ok: true,
      value: { env: ' prod ' },
    });
  });

  test('reports a missing key with the row number', () => {
    const result = parseWorkflowInputRows([
      { key: '', value: '' },
      { key: '', value: 'orphan' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('第 2 行');
  });

  test('rejects duplicate keys and overlong values', () => {
    expect(
      parseWorkflowInputRows([
        { key: 'a', value: '1' },
        { key: 'a', value: '2' },
      ]).ok,
    ).toBe(false);
    expect(parseWorkflowInputRows([{ key: 'a', value: 'x'.repeat(10_001) }]).ok).toBe(false);
  });
});

describe('row/json conversion', () => {
  test('inputsToRows preserves insertion order', () => {
    expect(inputsToRows({ b: '2', a: '1' })).toEqual([
      { key: 'b', value: '2' },
      { key: 'a', value: '1' },
    ]);
    expect(inputsToRows(undefined)).toEqual([]);
  });

  test('rowsToJsonText emits sorted-free valid JSON', () => {
    expect(JSON.parse(rowsToJsonText([{ key: 'a', value: '1' }]))).toEqual({ a: '1' });
    expect(rowsToJsonText([{ key: '', value: 'orphan' }])).toBe('');
  });
});

describe('validateWorkflowStart', () => {
  test('validates name and key-value rows together', () => {
    expect(
      validateWorkflowStart({
        name: 'smoke',
        rows: [{ key: 'env', value: 'prod' }],
        jsonText: '',
        advanced: false,
      }),
    ).toEqual({ ok: true, name: 'smoke', inputs: { env: 'prod' } });
  });

  test('returns field errors without throwing', () => {
    const nameError = validateWorkflowStart({
      name: 'bad name',
      rows: [],
      jsonText: '',
      advanced: false,
    });
    expect(nameError.ok).toBe(false);
    if (!nameError.ok) expect(nameError.nameError).toBeTruthy();

    const inputsError = validateWorkflowStart({
      name: 'smoke',
      rows: [],
      jsonText: '{bad',
      advanced: true,
    });
    expect(inputsError.ok).toBe(false);
    if (!inputsError.ok) expect(inputsError.inputsError).toBeTruthy();
  });
});

function workflow(
  id: string,
  status: WorkflowRunSummary['status'],
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  return {
    workflow_run_id: id,
    workflow_name: `wf-${id}`,
    status,
    step_count: 4,
    completed_steps: 2,
    started_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('workflow status helpers', () => {
  test('resumable matches the gateway state machine', () => {
    for (const status of ['pending', 'interrupted', 'failed'] as const) {
      expect(workflowStatusResumable(status)).toBe(true);
    }
    for (const status of ['running', 'completed', 'cancelled'] as const) {
      expect(workflowStatusResumable(status)).toBe(false);
    }
  });

  test('cancellable excludes all terminal states', () => {
    expect(workflowStatusCancellable('failed')).toBe(false);
    expect(workflowStatusCancellable('interrupted')).toBe(true);
  });

  test('active drives 2s polling', () => {
    expect(workflowStatusActive('pending')).toBe(true);
    expect(workflowStatusActive('completed')).toBe(false);
  });

  test('filters by status and accepts all', () => {
    const list = [workflow('a', 'running'), workflow('b', 'failed')];
    expect(filterWorkflows(list, 'all')).toHaveLength(2);
    expect(filterWorkflows(list, 'failed').map((item) => item.workflow_run_id)).toEqual(['b']);
  });

  test('progress percent clamps', () => {
    expect(progressPercent(2, 4)).toBe(50);
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(9, 4)).toBe(100);
  });
});
