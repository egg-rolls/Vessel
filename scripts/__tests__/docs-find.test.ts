import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDocsFind } from '../docs-find';

function moduleDoc(
  fields: { title: string; kind: string; triggers: string; paths: string; appliesTo?: string },
  body: string,
): string {
  return [
    '---',
    `title: ${fields.title}`,
    `kind: ${fields.kind}`,
    `triggers: ${fields.triggers}`,
    `paths: ${fields.paths}`,
    ...(fields.appliesTo ? [`applies_to: ${fields.appliesTo}`] : []),
    '---',
    '',
    body,
  ].join('\n');
}

function validDocs(): Record<string, string> {
  return {
    'docs/architecture/INDEX.md': moduleDoc(
      {
        title: '架构索引',
        kind: 'current',
        triggers: '[architecture, rpc, permission, docs]',
        paths: '[docs/architecture/**]',
      },
      '# 架构索引\n\n| [rpc](gateway-rpc.md) | RPC |\n',
    ),
    'docs/architecture/gateway-rpc.md': moduleDoc(
      {
        title: '统一 RPC 方法表',
        kind: 'current',
        triggers: '[rpc, method, canonical, permission]',
        paths: '[packages/serve/src/gateway/methods/**, packages/serve/src/protocol.ts]',
      },
      '# 统一 RPC 方法表\n\n<a id="rpc-methods"></a>\n\n## 方法\n',
    ),
    'docs/agents/INDEX.md': moduleDoc(
      {
        title: 'Agent 领域告诫索引',
        kind: 'current',
        triggers: '[agents, permission, docs]',
        paths: '[docs/agents/**]',
      },
      '# Agent 索引\n\n| [core](core.md) | Core |\n',
    ),
    'docs/agents/core.md': moduleDoc(
      {
        title: 'Core 边界',
        kind: 'advisory',
        triggers: '[core, runtime, permission, 权限, 超时]',
        paths: '[packages/core/**]',
        appliesTo: '[N, M]',
      },
      '# Core 边界\n\n权限默认无限等待。\n',
    ),
    'docs/agents/serve.md': moduleDoc(
      {
        title: 'Gateway 与远程',
        kind: 'advisory',
        triggers: '[gateway, remote, permission]',
        paths: '[packages/serve/**]',
        appliesTo: '[N, M]',
      },
      '# Gateway 与远程\n\n远程必须 TLS。\n',
    ),
  };
}

async function withDocs(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-docs-find-'));
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

async function jsonRun(argv: string[], root: string): Promise<{ exitCode: number; payload: unknown }> {
  const result = await runDocsFind([...argv, '--json'], root);
  return { exitCode: result.exitCode, payload: JSON.parse(result.stdout) as unknown };
}

describe('docs-find', () => {
  it('matches paths globs and ranks the exact module first', async () => {
    await withDocs(validDocs(), async (root) => {
      const result = await runDocsFind(
        ['--paths', 'packages/serve/src/gateway/methods'],
        root,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('docs/architecture/gateway-rpc.md');
      expect(result.stdout.split('\n')[0]).toContain('gateway-rpc.md');
    });
  });

  it('matches triggers from goal text', async () => {
    await withDocs(validDocs(), async (root) => {
      const { exitCode, payload } = await jsonRun(['--goal', 'permission'], root);
      expect(exitCode).toBe(0);
      const results = (payload as { results: { path: string; why: string[] }[] }).results;
      expect(results.some((item) => item.path === 'docs/agents/core.md')).toBe(true);
      expect(results.some((item) => item.why.includes('trigger:permission'))).toBe(true);
    });
  });

  it('adds title bonus once', async () => {
    await withDocs(validDocs(), async (root) => {
      const { payload } = await jsonRun(['--goal', '统一 RPC'], root);
      const first = (payload as { results: { path: string; score: number; why: string[] }[] }).results[0];
      expect(first?.path).toBe('docs/architecture/gateway-rpc.md');
      expect(first?.why).toContain('title');
      expect(first?.score).toBeGreaterThanOrEqual(2);
    });
  });

  it('returns exit 1 with fallback on no match', async () => {
    await withDocs(validDocs(), async (root) => {
      const { exitCode, payload } = await jsonRun(['--goal', 'zzzz-none'], root);
      expect(exitCode).toBe(1);
      expect((payload as { fallback: boolean }).fallback).toBe(true);
      expect((payload as { count: number }).count).toBe(0);
    });
  });

  it('returns the documented JSON shape', async () => {
    await withDocs(validDocs(), async (root) => {
      const { payload } = await jsonRun(['--goal', 'permission'], root);
      const body = payload as {
        query: { goal: string; paths: string[]; triggers: string[] };
        results: { title: string; path: string; kind: string; score: number; why: string[]; estTokens: number; anchors: unknown[] }[];
        count: number;
        fallback: boolean;
      };
      expect(body.query.goal).toBe('permission');
      expect(Array.isArray(body.results)).toBe(true);
      expect(typeof body.count).toBe('number');
      expect(body.fallback).toBe(false);
      expect(body.results[0]).toHaveProperty('estTokens');
      expect(body.results[0]).toHaveProperty('anchors');
    });
  });

  it('matches Chinese goals', async () => {
    await withDocs(validDocs(), async (root) => {
      const { exitCode, payload } = await jsonRun(['--goal', '权限超时'], root);
      expect(exitCode).toBe(0);
      const results = (payload as { results: { path: string }[] }).results;
      expect(results.some((item) => item.path === 'docs/agents/core.md')).toBe(true);
    });
  });

  it('excludes INDEX.md from results', async () => {
    await withDocs(validDocs(), async (root) => {
      const { exitCode, payload } = await jsonRun(['--paths', 'docs/architecture'], root);
      expect(exitCode).toBe(1);
      expect((payload as { results: unknown[] }).results).toEqual([]);
    });
  });

  it('rejects unknown flags and empty goals with exit 2', async () => {
    await withDocs(validDocs(), async (root) => {
      expect((await runDocsFind(['--nope'], root)).exitCode).toBe(2);
      expect((await runDocsFind(['--goal', ''], root)).exitCode).toBe(2);
      expect((await runDocsFind([], root)).exitCode).toBe(2);
    });
  });

  it('warns and skips a module with broken frontmatter', async () => {
    await withDocs(
      { ...validDocs(), 'docs/agents/broken.md': '# Broken\n' },
      async (root) => {
        const result = await runDocsFind(['--goal', 'permission'], root);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('docs/agents/broken.md');
      },
    );
  });

  it('honors --limit', async () => {
    await withDocs(validDocs(), async (root) => {
      const { payload } = await jsonRun(['--goal', 'permission', '--limit', '1'], root);
      expect((payload as { results: unknown[] }).results.length).toBe(1);
    });
  });
});
