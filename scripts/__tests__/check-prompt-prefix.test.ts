import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkPromptPrefix,
  checkSource,
  type PrefixViolation,
  stripCommentsAndStrings,
} from '../check-prompt-prefix';

async function withFixture(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-prefix-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function locations(violations: PrefixViolation[]): string[] {
  return violations.map((violation) => `${violation.file}:${violation.line}: ${violation.pattern}`);
}

describe('stripCommentsAndStrings', () => {
  it('preserves newlines so line numbers stay stable', () => {
    const source = "const a = 'x';\n// comment\nconst b = 1;\n";
    const scrubbed = stripCommentsAndStrings(source);
    expect(scrubbed.split('\n')).toHaveLength(source.split('\n').length);
    expect(scrubbed).not.toContain('x');
    expect(scrubbed).not.toContain('comment');
    expect(scrubbed).toContain('const a =');
    expect(scrubbed).toContain('const b = 1;');
  });

  it('removes block comments, line comments, and string contents', () => {
    const source = [
      "/* ctx.systemPrompt = 'block' */",
      "// additionalContext: 'line'",
      'const one = "additionalContext: nope";',
      'const two = `ctx.systemPrompt = nope`;',
      'const keep = ctx.systemPrompt;',
    ].join('\n');
    const scrubbed = stripCommentsAndStrings(source);
    expect(scrubbed).not.toContain('additionalContext');
    expect(scrubbed).not.toContain('nope');
    expect(scrubbed).toContain('const keep = ctx.systemPrompt;');
  });
});

describe('checkSource', () => {
  it('flags a constructed HookResult additionalContext', () => {
    const source = [
      'export function hook() {',
      "  return { additionalContext: 'notice' };",
      '}',
    ].join('\n');
    expect(locations(checkSource('plugins/demo/src/hook.ts', source))).toEqual([
      'plugins/demo/src/hook.ts:2: additionalContext:',
    ]);
  });

  it('flags ctx.systemPrompt and context.systemPrompt assignments', () => {
    const source = [
      'function hook(ctx) {',
      "  ctx.systemPrompt = 'team';",
      '}',
      'function other(context) {',
      '  context.systemPrompt += "\\nmore";',
      '}',
    ].join('\n');
    expect(locations(checkSource('src/hook.ts', source))).toEqual([
      'src/hook.ts:2: ctx.systemPrompt =',
      'src/hook.ts:5: ctx.systemPrompt =',
    ]);
  });

  it('does not flag comparisons or nullish reads', () => {
    const source = [
      'function hook(ctx) {',
      "  if (ctx.systemPrompt === 'x') return;",
      "  const base = ctx.systemPrompt ?? '';",
      '}',
    ].join('\n');
    expect(checkSource('src/hook.ts', source)).toEqual([]);
  });

  it('does not flag the same text in comments or strings', () => {
    const source = [
      "// ctx.systemPrompt = 'commented out'",
      "/* additionalContext: 'also commented' */",
      'const note = "ctx.systemPrompt = nope";',
      'const template = `additionalContext: nope`;',
    ].join('\n');
    expect(checkSource('src/hook.ts', source)).toEqual([]);
  });

  it('does not flag hookCtx initialization outside the hook contract', () => {
    const source = ['function prepare(hookCtx) {', '  hookCtx.systemPrompt = base;', '}'].join(
      '\n',
    );
    expect(checkSource('packages/core/src/runtime/agent-runtime.ts', source)).toEqual([]);
  });
});

describe('checkPromptPrefix', () => {
  it('passes a clean tree, including the documented allowlist', async () => {
    await withFixture(
      {
        'packages/core/src/types/hook.ts': [
          'export interface HookResult {',
          '  additionalContext?: string;',
          '}',
        ].join('\n'),
        'packages/core/src/runtime/hook-runner.ts': [
          'export function merge() {',
          "  return { additionalContext: 'from a hook' };",
          '}',
        ].join('\n'),
        'packages/core/src/runtime/agent-runtime.ts': [
          'export function build(hook: { additionalContext?: string }) {',
          '  return { additionalContext: hook.additionalContext };',
          '}',
        ].join('\n'),
        'packages/core/src/kernel/plain.ts': 'export const ok = { block: true };\n',
        'src/plain.ts': 'export function noop() {}\n',
      },
      async (root) => {
        const result = await checkPromptPrefix(root);
        expect(result.violations).toEqual([]);
        expect(result.scannedFiles).toBe(5);
      },
    );
  });

  it('fails on an additionalContext producer outside the allowlist', async () => {
    await withFixture(
      {
        'plugins/context/demo/src/hook.ts': [
          'export function hook() {',
          "  return { additionalContext: 'notice' };",
          '}',
        ].join('\n'),
      },
      async (root) => {
        const result = await checkPromptPrefix(root);
        expect(locations(result.violations)).toEqual([
          'plugins/context/demo/src/hook.ts:2: additionalContext:',
        ]);
      },
    );
  });

  it('fails on a ctx.systemPrompt assignment', async () => {
    await withFixture(
      {
        'packages/agent/src/runtime.ts': [
          'export function hook(ctx) {',
          "  ctx.systemPrompt = 'team';",
          '}',
        ].join('\n'),
      },
      async (root) => {
        const result = await checkPromptPrefix(root);
        expect(locations(result.violations)).toEqual([
          'packages/agent/src/runtime.ts:2: ctx.systemPrompt =',
        ]);
      },
    );
  });

  it('skips __tests__, *.test.ts, node_modules, and dist', async () => {
    const violation = "export const hook = { additionalContext: 'x' };\n";
    await withFixture(
      {
        'packages/core/__tests__/fixture.ts': violation,
        'packages/core/src/fixture.test.ts': violation,
        'packages/core/node_modules/dep/index.ts': violation,
        'packages/core/dist/output.ts': violation,
        'packages/core/src/clean.ts': 'export const ok = true;\n',
      },
      async (root) => {
        const result = await checkPromptPrefix(root);
        expect(result.violations).toEqual([]);
        expect(result.scannedFiles).toBe(1);
      },
    );
  });

  it('scans .tsx sources as well', async () => {
    await withFixture(
      {
        'packages/tui/src/Card.tsx': "export const Card = { additionalContext: 'x' };\n",
      },
      async (root) => {
        expect(locations((await checkPromptPrefix(root)).violations)).toEqual([
          'packages/tui/src/Card.tsx:1: additionalContext:',
        ]);
      },
    );
  });
});
