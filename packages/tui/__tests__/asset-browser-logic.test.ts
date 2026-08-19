import { describe, expect, test } from 'bun:test';
import { buildTestInput } from '../src/components/ToolsBrowser';

describe('asset browser test input generation', () => {
  test('generates valid ask_user options', () => {
    const input = buildTestInput(
      JSON.stringify({
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: { type: 'object' },
          },
        },
        required: ['questions'],
      }),
    );
    expect(input.questions).toEqual([
      { header: 'Test', question: 'Did the tool test run?', options: ['Yes', 'No'] },
    ]);
  });

  test('generates required scalar fields', () => {
    const input = buildTestInput(
      JSON.stringify({
        type: 'object',
        properties: { name: { type: 'string' }, enabled: { type: 'boolean' } },
        required: ['name', 'enabled'],
      }),
    );
    expect(input).toEqual({ name: 'test-name', enabled: false });
  });
});
