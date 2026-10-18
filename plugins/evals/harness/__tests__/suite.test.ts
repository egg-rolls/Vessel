import { afterEach, describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import { EvalsError } from '../src/errors.js';
import { parseEvalSuite, resolveSuitePath } from '../src/suite.js';
import { makeTempWorkspace, type TempWorkspace, writeSuite } from './fixtures/helpers.js';

const VALID = `
name: smoke
defaults:
  timeout_ms: 30000
  session: fresh
cases:
  - id: basic
    input: "hello"
    tags: [smoke]
    mock:
      responses:
        - content: "hello"
    expect:
      - type: output_contains
        value: "hello"
      - type: no_error
`;

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EvalsError);
    expect((error as EvalsError).code).toBe('eval_invalid');
    return;
  }
  throw new Error('expected eval_invalid');
}

describe('parseEvalSuite', () => {
  it('accepts a valid suite', () => {
    const suite = parseEvalSuite(VALID, 'valid.yaml');
    expect(suite.name).toBe('smoke');
    expect(suite.cases).toHaveLength(1);
    expect(suite.cases[0]?.expect[0]?.type).toBe('output_contains');
  });

  it('rejects unknown keys', () => {
    expectInvalid(() => parseEvalSuite('name: x\nnope: 1\ncases:\n  - id: a\n    input: hi\n'));
  });

  it('rejects duplicate case ids', () => {
    expectInvalid(() =>
      parseEvalSuite(`
name: x
cases:
  - id: a
    input: one
  - id: a
    input: two
`),
    );
  });

  it('rejects unknown assertion types', () => {
    expectInvalid(() =>
      parseEvalSuite(`
name: x
cases:
  - id: a
    input: hi
    expect:
      - type: nope
`),
    );
  });

  it('rejects invalid regular expressions', () => {
    expectInvalid(() =>
      parseEvalSuite(`
name: x
cases:
  - id: a
    input: hi
    expect:
      - type: output_matches
        value: "["
`),
    );
  });

  it('validates usage_under shape', () => {
    expectInvalid(() =>
      parseEvalSuite(`
name: x
cases:
  - id: a
    input: hi
    expect:
      - type: usage_under
        value: {}
`),
    );
    expectInvalid(() =>
      parseEvalSuite(`
name: x
cases:
  - id: a
    input: hi
    expect:
      - type: usage_under
        value:
          unknown: 1
`),
    );
    const suite = parseEvalSuite(`
name: x
cases:
  - id: a
    input: hi
    expect:
      - type: usage_under
        value:
          total_tokens: 10
`);
    expect(suite.cases[0]?.expect[0]?.value).toEqual({ total_tokens: 10 });
  });

  it('validates session and timeout ranges', () => {
    expectInvalid(() =>
      parseEvalSuite(`
name: x
cases:
  - id: a
    input: hi
    session: sometimes
`),
    );
    expectInvalid(() =>
      parseEvalSuite(`
name: x
cases:
  - id: a
    input: hi
    timeout_ms: 0
`),
    );
  });

  it('validates mock tool_calls', () => {
    const suite = parseEvalSuite(`
name: x
cases:
  - id: a
    input: hi
    mock:
      responses:
        - content: ""
          tool_calls:
            - id: call_1
              type: function
              function:
                name: echo
                arguments: "{}"
`);
    expect(suite.cases[0]?.mock?.responses[0]?.tool_calls?.[0]?.function.name).toBe('echo');

    expectInvalid(() =>
      parseEvalSuite(`
name: x
cases:
  - id: a
    input: hi
    mock:
      responses:
        - content: ""
          tool_calls:
            - id: call_1
              type: function
              function:
                name: echo
                arguments: 1
`),
    );
  });

  it('rejects unsafe suite names', () => {
    expectInvalid(() =>
      parseEvalSuite(`
name: "bad name"
cases:
  - id: a
    input: hi
`),
    );
  });
});

describe('resolveSuitePath', () => {
  let workspace: TempWorkspace | undefined;

  afterEach(async () => {
    await workspace?.cleanup();
    workspace = undefined;
  });

  it('resolves a single extension under suiteDir', async () => {
    workspace = await makeTempWorkspace();
    await writeSuite(workspace.suites, 'smoke', VALID, 'yml');
    const resolved = await resolveSuitePath('smoke', workspace.suites);
    expect(path.basename(resolved)).toBe('smoke.yml');
  });

  it('rejects ambiguous names', async () => {
    workspace = await makeTempWorkspace();
    await writeSuite(workspace.suites, 'smoke', VALID, 'yaml');
    await writeSuite(workspace.suites, 'smoke', VALID, 'json');
    await expect(resolveSuitePath('smoke', workspace.suites)).rejects.toBeInstanceOf(EvalsError);
  });

  it('rejects missing suites with eval_not_found', async () => {
    workspace = await makeTempWorkspace();
    try {
      await resolveSuitePath('missing', workspace.suites);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EvalsError);
      expect((error as EvalsError).code).toBe('eval_not_found');
    }
  });
});
