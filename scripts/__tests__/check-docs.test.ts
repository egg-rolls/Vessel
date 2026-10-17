import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkDocs } from '../check-docs';

const PRIORITY = 'config > VESSEL_GATEWAY_TOKEN > gateway 自动生成';

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
    '.env.example': `# token\n${PRIORITY}\nVESSEL_GATEWAY_TOKEN=\n`,
    'README.md': `# Vessel\nVESSEL_GATEWAY_TOKEN\n${PRIORITY}\n`,
    'docs/ARCHITECTURE.md': `# Arch\nVESSEL_GATEWAY_TOKEN\n${PRIORITY}\n`,
    'AGENTS.md': '# Agents\n[ARCHITECTURE](docs/ARCHITECTURE.md)\n',
    'docs/operations/CI-CD.md': '# CI\n[back](../FILE-MANAGEMENT.md)\n',
    'docs/FILE-MANAGEMENT.md': '# Files\n',
    'CONTRIBUTING.md': '# Contrib\n',
    'docs/operations/RELEASE.md': '# Release\n[back](../FILE-MANAGEMENT.md)\n',
  };
}

describe('checkDocs', () => {
  it('passes for a valid fixture', async () => {
    await withFixture(validFiles(), async (root) => {
      expect(await checkDocs(root)).toEqual([]);
    });
  });

  it('rejects a non-empty gateway token', async () => {
    await withFixture(
      { ...validFiles(), '.env.example': `${PRIORITY}\nVESSEL_GATEWAY_TOKEN=secret\n` },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({
            file: '.env.example',
            message: expect.stringContaining('留空'),
          }),
        );
      },
    );
  });

  it('rejects VESSEL_NODE_ID', async () => {
    await withFixture(
      { ...validFiles(), '.env.example': `${PRIORITY}\nVESSEL_GATEWAY_TOKEN=\nVESSEL_NODE_ID=x\n` },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining('VESSEL_NODE_ID') }),
        );
      },
    );
  });

  it('reports missing token priority text', async () => {
    await withFixture(
      { ...validFiles(), 'README.md': '# Vessel\nVESSEL_GATEWAY_TOKEN\n' },
      async (root) => {
        expect(await checkDocs(root)).toContainEqual(
          expect.objectContaining({
            file: 'README.md',
            message: expect.stringContaining('优先级'),
          }),
        );
      },
    );
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
});
