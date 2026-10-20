import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applyVersion,
  changelogHasVersion,
  checkVersions,
  collectManifests,
  rootVersionMissing,
  validateVersion,
} from '../version';

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-version-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('validateVersion', () => {
  it('accepts stable and prerelease versions', () => {
    expect(validateVersion('0.1.0')).toBe(true);
    expect(validateVersion('1.2.3')).toBe(true);
    expect(validateVersion('0.2.0-beta.1')).toBe(true);
  });

  it('rejects invalid versions', () => {
    expect(validateVersion('0.1')).toBe(false);
    expect(validateVersion('v0.1.0')).toBe(false);
    expect(validateVersion('0.1.0+build')).toBe(false);
    expect(validateVersion('latest')).toBe(false);
  });
});

describe('collectManifests', () => {
  it('collects root, workspace, plugin, and web manifests', async () => {
    await withTempRoot(async (root) => {
      await writeJson(join(root, 'package.json'), { name: 'vessel', version: '0.1.0' });
      await writeJson(join(root, 'packages/core/package.json'), {
        name: '@vessel/core',
        version: '0.1.0',
      });
      await writeJson(join(root, 'packages/config/package.json'), {
        name: '@vessel/config',
        version: '0.1.0',
      });
      await writeJson(join(root, 'plugins/tools/basic-tools/package.json'), {
        name: '@vessel/basic-tools',
        version: '0.1.0',
      });
      await writeJson(join(root, 'apps/web/package.json'), {
        name: '@vessel/web',
        version: '0.1.0',
      });

      const manifests = await collectManifests(root);
      expect(manifests.map((manifest) => manifest.path)).toEqual([
        'apps/web/package.json',
        'package.json',
        'packages/config/package.json',
        'packages/core/package.json',
        'plugins/tools/basic-tools/package.json',
      ]);
    });
  });

  it('skips a root manifest without a version', async () => {
    await withTempRoot(async (root) => {
      await writeJson(join(root, 'package.json'), { name: 'vessel', private: true });
      await writeJson(join(root, 'packages/core/package.json'), {
        name: '@vessel/core',
        version: '0.1.0',
      });

      expect(await rootVersionMissing(root)).toBe(true);
      const manifests = await collectManifests(root);
      expect(manifests.map((manifest) => manifest.path)).toEqual(['packages/core/package.json']);
    });
  });
});

describe('applyVersion', () => {
  it('writes the new version to every manifest', async () => {
    await withTempRoot(async (root) => {
      await writeJson(join(root, 'package.json'), { name: 'vessel', version: '0.1.0' });
      await writeJson(join(root, 'packages/core/package.json'), {
        name: '@vessel/core',
        version: '0.1.0',
      });
      await writeJson(join(root, 'apps/web/package.json'), {
        name: '@vessel/web',
        version: '0.1.0',
      });

      const changed = await applyVersion(root, '0.2.0');
      expect(changed).toEqual([
        'apps/web/package.json',
        'package.json',
        'packages/core/package.json',
      ]);

      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        version: string;
      };
      expect(pkg.version).toBe('0.2.0');
    });
  });

  it('rewrites internal dependency versions and leaves external ones untouched', async () => {
    await withTempRoot(async (root) => {
      await writeJson(join(root, 'package.json'), {
        name: 'vessel',
        version: '0.1.0',
        dependencies: {
          '@vessel/core': '^0.1.0',
          '@vessel/serve': 'workspace:*',
          yaml: '^2.9.0',
        },
        devDependencies: {
          '@vessel/config': 'workspace:*',
          typescript: '^7.0.2',
        },
        peerDependencies: {
          '@vessel/tui': '>=0.1.0',
        },
      });
      await writeJson(join(root, 'packages/core/package.json'), {
        name: '@vessel/core',
        version: '0.1.0',
        dependencies: {},
      });

      const changed = await applyVersion(root, '0.2.0');
      expect(changed).toEqual(['package.json', 'packages/core/package.json']);

      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        version: string;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
        peerDependencies: Record<string, string>;
      };
      expect(pkg.version).toBe('0.2.0');
      expect(pkg.dependencies['@vessel/core']).toBe('0.2.0');
      expect(pkg.dependencies['@vessel/serve']).toBe('0.2.0');
      expect(pkg.devDependencies['@vessel/config']).toBe('0.2.0');
      expect(pkg.peerDependencies['@vessel/tui']).toBe('0.2.0');
      expect(pkg.dependencies.yaml).toBe('^2.9.0');
      expect(pkg.devDependencies.typescript).toBe('^7.0.2');
    });
  });

  it('rewrites stale internal deps even when the version is already current', async () => {
    await withTempRoot(async (root) => {
      await writeJson(join(root, 'package.json'), {
        name: 'vessel',
        version: '0.2.0',
        dependencies: { '@vessel/core': '^0.1.0' },
      });
      await writeJson(join(root, 'packages/core/package.json'), {
        name: '@vessel/core',
        version: '0.2.0',
      });

      const changed = await applyVersion(root, '0.2.0');
      expect(changed).toEqual(['package.json']);

      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      };
      expect(pkg.dependencies['@vessel/core']).toBe('0.2.0');

      // 再跑一次应当幂等：没有需要改的内容。
      expect(await applyVersion(root, '0.2.0')).toEqual([]);
    });
  });
});

describe('changelogHasVersion', () => {
  it('matches only the exact version heading', async () => {
    await withTempRoot(async (root) => {
      await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.0] - 2026-10-17\n');

      expect(await changelogHasVersion(root, '0.1.0')).toBe(true);
      expect(await changelogHasVersion(root, '0.1')).toBe(false);
      expect(await changelogHasVersion(root, '0.2.0')).toBe(false);
    });
  });
});

describe('checkVersions', () => {
  it('reports mismatches and missing changelog entries', async () => {
    await withTempRoot(async (root) => {
      await writeJson(join(root, 'package.json'), { name: 'vessel', version: '0.1.0' });
      await writeJson(join(root, 'packages/core/package.json'), {
        name: '@vessel/core',
        version: '0.1.1',
      });
      await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n');

      const errors = await checkVersions(root, '0.1.0');
      expect(errors.some((error) => error.includes('version mismatch'))).toBe(true);
      expect(errors.some((error) => error.includes('missing "## [0.1.0]"'))).toBe(true);
    });
  });
});
