import { afterEach, describe, expect, it } from 'bun:test';
import type { PluginHost } from '@vessel-agent/core';
import { EvalsError } from '../src/errors.js';
import { runEvalSuite } from '../src/runner.js';
import { fakeRuntime, makeTempWorkspace, writeSuite } from './fixtures/helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(source: string): Promise<{ out: string; file: string }> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  const file = await writeSuite(workspace.suites, 'suite', source);
  return { out: workspace.out, file };
}

describe('runEvalSuite (offline)', () => {
  it('runs a passing case with the default scripted provider', async () => {
    const { out, file } = await setup(`
name: smoke
cases:
  - id: basic
    input: hello
    mock:
      responses:
        - content: hello
    expect:
      - type: output_contains
        value: hello
      - type: no_error
      - type: max_iterations
        value: 3
      - type: usage_under
        value:
          total_tokens: 0
`);
    const report = await runEvalSuite(file, { outDir: out, timestamp: 't1' });
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.cases[0]?.output).toBe('hello');
    expect(report.cases[0]?.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
    expect(report.network).toBe(false);
  });

  it('records mock_exhausted without failing the case', async () => {
    const { out, file } = await setup(`
name: exhausted
cases:
  - id: empty
    input: hi
    mock:
      responses: []
    expect:
      - type: no_error
`);
    const report = await runEvalSuite(file, { outDir: out, timestamp: 't2' });
    expect(report.passed).toBe(1);
    expect(report.cases[0]?.warnings).toEqual(['mock_exhausted']);
  });

  it('marks filtered cases as skipped and counts them in total', async () => {
    const { out, file } = await setup(`
name: filter
cases:
  - id: smoke
    input: hi
    tags: [smoke]
    mock:
      responses:
        - content: hi
  - id: other
    input: hi
    tags: [other]
    mock:
      responses:
        - content: hi
`);
    const report = await runEvalSuite(file, {
      outDir: out,
      timestamp: 't3',
      filterTags: ['smoke'],
    });
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.cases[1]?.status).toBe('skipped');
  });

  it('uses one shared runtime and session for shared cases', async () => {
    const { out, file } = await setup(`
name: shared
defaults:
  session: shared
cases:
  - id: a
    input: one
  - id: b
    input: two
`);
    let factoryCalls = 0;
    const sessions: Array<string | undefined> = [];
    const report = await runEvalSuite(file, {
      outDir: out,
      timestamp: 't4',
      createRuntime: async () => {
        factoryCalls += 1;
        return fakeRuntime({
          onRun: (_input, sessionId) => {
            sessions.push(sessionId);
          },
        });
      },
    });

    expect(report.passed).toBe(2);
    expect(factoryCalls).toBe(1);
    expect(sessions).toEqual(['eval:shared', 'eval:shared']);
  });

  it('creates a fresh runtime and session per case', async () => {
    const { out, file } = await setup(`
name: fresh
cases:
  - id: a
    input: one
  - id: b
    input: two
`);
    let factoryCalls = 0;
    const sessions: Array<string | undefined> = [];
    await runEvalSuite(file, {
      outDir: out,
      timestamp: 't5',
      createRuntime: async () => {
        factoryCalls += 1;
        return fakeRuntime({
          onRun: (_input, sessionId) => {
            sessions.push(sessionId);
          },
        });
      },
    });

    expect(factoryCalls).toBe(2);
    expect(sessions).toEqual(['eval:fresh:a', 'eval:fresh:b']);
  });

  it('times out a case', async () => {
    const { out, file } = await setup(`
name: timeout
cases:
  - id: slow
    input: hi
    timeout_ms: 20
    expect:
      - type: no_error
`);
    const report = await runEvalSuite(file, {
      outDir: out,
      timestamp: 't6',
      createRuntime: async () => fakeRuntime({ waitForAbort: true }),
    });

    expect(report.errors).toBe(1);
    expect(report.cases[0]?.status).toBe('error');
    expect(report.cases[0]?.error).toContain('timed out');
  });

  it('supports offline tool_calls and tool_called assertions', async () => {
    const { out, file } = await setup(`
name: tools
cases:
  - id: calls
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
        - content: done
    expect:
      - type: tool_called
        value: echo
      - type: output_contains
        value: done
`);
    const plugin = {
      name: 'test-tools',
      install(host: PluginHost): void {
        host.registerTool({
          name: 'echo',
          description: 'echo',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => 'tool-result',
        });
      },
    };

    const report = await runEvalSuite(file, {
      outDir: out,
      timestamp: 't7',
      plugins: [plugin],
    });
    expect(report.passed).toBe(1);
    expect(report.cases[0]?.assertions.every((assertion) => assertion.ok)).toBe(true);
  });

  it('reports createRuntime failures as case errors', async () => {
    const { out, file } = await setup(`
name: factory
cases:
  - id: a
    input: hi
`);
    const report = await runEvalSuite(file, {
      outDir: out,
      timestamp: 't8',
      createRuntime: async () => {
        throw new Error('factory boom');
      },
    });
    expect(report.errors).toBe(1);
    expect(report.cases[0]?.error).toContain('factory boom');
  });

  it('requires outDir or outPath', async () => {
    const { file } = await setup(`
name: noout
cases:
  - id: a
    input: hi
`);
    await expect(runEvalSuite(file, { timestamp: 't9' })).rejects.toBeInstanceOf(EvalsError);
  });
});
