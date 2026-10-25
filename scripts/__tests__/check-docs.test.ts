import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkDocs } from '../check-docs';

async function withFixture(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-docs-'));
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

function validFiles(): Record<string, string> {
  return {
    'README.md': [
      '# Vessel',
      '跨机器远程 静态节点表',
      '微信 不做',
      '| [CI](docs/operations/CI-CD.md) |',
      '| [Release](docs/operations/RELEASE.md) |',
      '| [Config](docs/operations/CONFIG.md) |',
      '| [Migration](docs/operations/MIGRATION.md) |',
      '| [Trace](docs/operations/TRACE.md) |',
    ].join('\n'),
    'docs/ARCHITECTURE.md': '# Arch\n[modules](architecture/INDEX.md)\n',
    'docs/architecture/INDEX.md': '# Index\n[overview](overview.md)\n',
    'docs/architecture/overview.md': '# Overview\n[back](INDEX.md)\n',
    'docs/agents/INDEX.md': '# Agents\n[core](core.md)\n',
    'docs/agents/core.md': '# Core\n[back](INDEX.md)\n',
    'AGENTS.md': '# Agents\n[ARCHITECTURE](docs/ARCHITECTURE.md)\n',
    'docs/operations/CI-CD.md': '# CI\n[back](../FILE-MANAGEMENT.md)\n',
    'docs/operations/RELEASE.md': '# Release\n[back](../FILE-MANAGEMENT.md)\n',
    'docs/operations/CONFIG.md': '# Config\n[back](../FILE-MANAGEMENT.md)\n',
    'docs/operations/MIGRATION.md': '# Migration\n[back](../FILE-MANAGEMENT.md)\n',
    'docs/operations/TRACE.md': '# Trace\n[back](../FILE-MANAGEMENT.md)\n',
    'docs/FILE-MANAGEMENT.md': '# Files\n',
    'CONTRIBUTING.md': '# Contrib\n',
    'docs/ADR.md': '# ADR\n> moved: [index](adr/README.md)\n',
    'docs/adr/README.md':
      '# ADR\n\n| 001 | X | accepted | - | - | [ADR-001-typescript.md](ADR-001-typescript.md) |\n',
    'docs/adr/ADR-001-typescript.md':
      '---\nadr: 1\ntitle: X\nstatus: accepted\ndate: null\n---\n\n## ADR-001：X\n\n- **上下文**：x\n',
  };
}

describe('checkDocs', () => {
  it('passes for a valid fixture', async () => {
    await withFixture(validFiles(), async (root) => {
      expect(await checkDocs(root)).toEqual([]);
    });
  });

  it('reports broken relative links', async () => {
    await withFixture(
      { ...validFiles(), 'AGENTS.md': '# Agents\n[missing](docs/MISSING.md)\n' },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({
            file: 'AGENTS.md',
            message: expect.stringContaining('不存在'),
          }),
        );
      },
    );
  });

  it('reports duplicate ADR numbers', async () => {
    await withFixture(
      {
        ...validFiles(),
        'docs/adr/ADR-001-duplicate.md':
          '---\nadr: 1\ntitle: Dup\nstatus: accepted\ndate: null\n---\n\n## ADR-001：Dup\n',
      },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining('编号重复') }),
        );
      },
    );
  });

  it('reports missing ADR frontmatter', async () => {
    await withFixture(
      { ...validFiles(), 'docs/adr/ADR-001-typescript.md': '# ADR-001：X\n' },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining('frontmatter') }),
        );
      },
    );
  });

  it('reports invalid ADR status', async () => {
    await withFixture(
      {
        ...validFiles(),
        'docs/adr/ADR-001-typescript.md':
          '---\nadr: 1\ntitle: X\nstatus: draft\ndate: null\n---\n\n## ADR-001：X\n',
      },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining('status') }),
        );
      },
    );
  });

  it('reports ADR index gaps', async () => {
    await withFixture({ ...validFiles(), 'docs/adr/README.md': '# ADR\n' }, async (root) => {
      expect(await checkDocs(root)).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('索引缺少') }),
      );
    });
  });

  it('reports a stub that regrows ADR body', async () => {
    await withFixture(
      { ...validFiles(), 'docs/ADR.md': '# ADR\n## ADR-001：X\n[adr](adr/README.md)\n' },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining('正文标题') }),
        );
      },
    );
  });

  it('reports legacy docs/ADR.md links in active docs', async () => {
    await withFixture(
      { ...validFiles(), 'README.md': `${validFiles()['README.md']}\n[old](docs/ADR.md)\n` },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining('docs/adr') }),
        );
      },
    );
  });

  it('exempts historical dead links inside ADR bodies', async () => {
    await withFixture(
      {
        ...validFiles(),
        'docs/adr/ADR-001-typescript.md':
          '---\nadr: 1\ntitle: X\nstatus: accepted\ndate: null\n---\n\n## ADR-001：X\n\n[SPEC](../SPEC.md)\n',
      },
      async (root) => {
        expect(await checkDocs(root)).toEqual([]);
      },
    );
  });

  it('reports broken links inside architecture modules', async () => {
    await withFixture(
      {
        ...validFiles(),
        'docs/architecture/overview.md': '# Overview\n[bad](missing.md)\n',
      },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({
            file: 'docs/architecture/overview.md',
            message: expect.stringContaining('不存在'),
          }),
        );
      },
    );
  });

  it('skips architecture directory when absent', async () => {
    const files = validFiles();
    delete files['docs/architecture/INDEX.md'];
    delete files['docs/architecture/overview.md'];
    files['docs/ARCHITECTURE.md'] = '# Arch\n';
    await withFixture(files, async (root) => {
      expect(await checkDocs(root)).toEqual([]);
    });
  });

  it('reports broken links inside agent advisories', async () => {
    await withFixture(
      {
        ...validFiles(),
        'docs/agents/core.md': '# Core\n[bad](missing.md)\n',
      },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({
            file: 'docs/agents/core.md',
            message: expect.stringContaining('不存在'),
          }),
        );
      },
    );
  });

  it('skips agents directory when absent', async () => {
    const files = validFiles();
    delete files['docs/agents/INDEX.md'];
    delete files['docs/agents/core.md'];
    await withFixture(files, async (root) => {
      expect(await checkDocs(root)).toEqual([]);
    });
  });

  it('reports operations docs missing from README index', async () => {
    await withFixture(
      {
        ...validFiles(),
        'README.md':
          validFiles()['README.md']?.replace('| [Config](docs/operations/CONFIG.md) |\n', '') ?? '',
      },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining('CONFIG.md') }),
        );
      },
    );
  });
});
