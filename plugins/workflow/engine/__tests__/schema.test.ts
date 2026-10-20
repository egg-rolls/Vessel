import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WorkflowError } from '../src/errors.js';
import { parseWorkflowDefinition, resolveDefinitionPath } from '../src/schema.js';
import { makeTempWorkspace, type TempWorkspace, writeWorkflow } from './fixtures/fakes.js';

const VALID = `
name: release-check
defaults:
  agent: owner
steps:
  - id: plan
    type: agent
    prompt: plan it
  - id: check
    type: tool
    tool: read
    depends_on: [plan]
`;

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe('workflow_invalid');
    return;
  }
  throw new Error('expected workflow_invalid');
}

async function expectInvalidAsync(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe('workflow_invalid');
    return;
  }
  throw new Error('expected workflow_invalid');
}

describe('parseWorkflowDefinition', () => {
  it('accepts a valid YAML definition', () => {
    const definition = parseWorkflowDefinition(VALID, 'valid.yaml');
    expect(definition.name).toBe('release-check');
    expect(definition.steps).toHaveLength(2);
    expect(definition.steps[0]?.depends_on).toBeUndefined();
    expect(definition.steps[1]?.depends_on).toEqual(['plan']);
  });

  it('accepts JSON (YAML subset)', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        name: 'json-flow',
        steps: [{ id: 'a', type: 'agent', agent: 'owner', prompt: 'hi' }],
      }),
      'flow.json',
    );
    expect(definition.name).toBe('json-flow');
  });

  it('rejects unknown top-level keys', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(
        'name: x\nnope: 1\nsteps:\n  - id: a\n    type: agent\n    agent: o\n    prompt: hi\n',
      ),
    );
  });

  it('rejects duplicate step ids', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: one
  - id: a
    type: agent
    agent: o
    prompt: two
`),
    );
  });

  it('rejects invalid step ids', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: bad id
    type: agent
    agent: o
    prompt: hi
`),
    );
  });

  it('rejects unknown dependencies', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: hi
    depends_on: [missing]
`),
    );
  });

  it('rejects self dependencies', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: hi
    depends_on: [a]
`),
    );
  });

  it('rejects cycles', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: hi
    depends_on: [b]
  - id: b
    type: agent
    agent: o
    prompt: hi
    depends_on: [a]
`),
    );
  });

  it('validates retry ranges', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: hi
    retry:
      max_attempts: 11
`),
    );
    const definition = parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: hi
    retry:
      max_attempts: 2
      backoff_ms: 0
`);
    expect(definition.steps[0]?.retry?.max_attempts).toBe(2);
  });

  it('requires when.step to be a dependency', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: hi
  - id: b
    type: agent
    agent: o
    prompt: hi
    when:
      step: a
`),
    );
  });

  it('rejects when.contains and when.equals together', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: hi
  - id: b
    type: agent
    agent: o
    prompt: hi
    depends_on: [a]
    when:
      step: a
      contains: one
      equals: two
`),
    );
  });

  it('accepts when.status alone and when.contains alone', () => {
    const definition = parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: hi
  - id: b
    type: agent
    agent: o
    prompt: hi
    depends_on: [a]
    when:
      step: a
      status: completed
  - id: c
    type: agent
    agent: o
    prompt: hi
    depends_on: [a]
    when:
      step: a
      contains: ok
`);
    expect(definition.steps[1]?.when?.status).toBe('completed');
    expect(definition.steps[2]?.when?.contains).toBe('ok');
  });

  it('requires an agent id for agent steps', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    prompt: hi
`),
    );
  });

  it('requires a tool name for tool steps', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: tool
`),
    );
  });

  it('rejects unsupported versions', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
version: 2
steps:
  - id: a
    type: agent
    agent: o
    prompt: hi
`),
    );
  });

  it('rejects templates that reference unknown steps', () => {
    expectInvalid(() =>
      parseWorkflowDefinition(`
name: x
steps:
  - id: a
    type: agent
    agent: o
    prompt: "use {{steps.missing.output}}"
`),
    );
  });

  it('rejects malformed YAML', () => {
    expectInvalid(() => parseWorkflowDefinition('name: [unclosed'));
  });
});

describe('resolveDefinitionPath', () => {
  let workspace: TempWorkspace | undefined;

  afterEach(async () => {
    await workspace?.cleanup();
    workspace = undefined;
  });

  it('resolves a single matching extension', async () => {
    workspace = await makeTempWorkspace();
    await writeWorkflow(workspace.dir, 'flow', 'name: yml\nsteps: []\n', 'yml');
    const resolved = await resolveDefinitionPath('flow', workspace.dir);
    expect(path.basename(resolved)).toBe('flow.yml');
  });

  it('rejects ambiguous names when multiple extensions exist', async () => {
    const ws = await makeTempWorkspace();
    workspace = ws;
    await writeWorkflow(ws.dir, 'flow', 'name: yaml\nsteps: []\n', 'yaml');
    await writeWorkflow(ws.dir, 'flow', 'name: json\nsteps: []\n', 'json');
    await expectInvalidAsync(() => resolveDefinitionPath('flow', ws.dir));
  });

  it('rejects missing names with workflow_not_found', async () => {
    workspace = await makeTempWorkspace();
    try {
      await resolveDefinitionPath('missing', workspace.dir);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe('workflow_not_found');
    }
  });

  it('rejects relative paths that escape workflow.dir', async () => {
    const ws = await makeTempWorkspace();
    workspace = ws;
    const outside = path.join(ws.root, 'outside.yaml');
    await fs.writeFile(outside, 'name: x\nsteps: []\n', 'utf8');
    await expectInvalidAsync(() => resolveDefinitionPath('../outside.yaml', ws.dir));
  });

  it('accepts absolute paths (CLI)', async () => {
    workspace = await makeTempWorkspace();
    const target = await writeWorkflow(workspace.dir, 'flow', VALID);
    const resolved = await resolveDefinitionPath(target, workspace.dir);
    expect(resolved).toBe(target);
  });

  it('rejects unsafe single-segment names', async () => {
    const ws = await makeTempWorkspace();
    workspace = ws;
    await expectInvalidAsync(() => resolveDefinitionPath('bad name', ws.dir));
  });
});
