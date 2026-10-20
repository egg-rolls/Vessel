import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkEntryFiles,
  collectPublicPackages,
  detectForbiddenFile,
  evaluatePackedFiles,
  evaluatePackedManifest,
  evaluateSourceManifest,
  parseTar,
  unpackTarball,
} from '../release-dry-run';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@vessel-agent/example',
    version: '0.3.0',
    type: 'module',
    main: 'src/index.ts',
    types: 'src/index.ts',
    exports: { '.': './src/index.ts' },
    dependencies: {},
    ...overrides,
  };
}

function codes(issues: Array<{ code: string }>): string[] {
  return issues.map((issue) => issue.code);
}

// ── tar fixture ──────────────────────────────────────────────

function writeAscii(target: Uint8Array, offset: number, text: string, length: number): void {
  const bytes = new TextEncoder().encode(text);
  target.set(bytes.subarray(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  writeAscii(target, offset, text, length - 1);
  target[offset + length - 1] = 0;
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, path, 100);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 'ustar', 5);
  header[262] = 0;
  writeAscii(header, 263, '00', 2);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const text = checksum.toString(8).padStart(6, '0');
  writeAscii(header, 148, text, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildTar(files: Array<{ path: string; content: string }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    const data = new TextEncoder().encode(file.content);
    chunks.push(tarHeader(file.path, data.length));
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

// ── tests ───────────────────────────────────────────────────

describe('evaluateSourceManifest', () => {
  it('accepts a valid manifest at the target version', () => {
    expect(evaluateSourceManifest(manifest(), '0.3.0')).toEqual([]);
  });

  it('rejects a version mismatch', () => {
    const issues = evaluateSourceManifest(manifest({ version: '0.1.0' }), '0.3.0');
    expect(codes(issues)).toContain('version_mismatch');
  });

  it('requires types and main or exports', () => {
    const issues = evaluateSourceManifest(
      manifest({ main: undefined, exports: undefined, types: undefined }),
      '0.3.0',
    );
    expect(codes(issues).filter((code) => code === 'missing_field')).toHaveLength(2);
  });
});

describe('evaluatePackedManifest', () => {
  it('rejects workspace and file dependencies in every dependency field', () => {
    const issues = evaluatePackedManifest(
      manifest({
        dependencies: { '@vessel-agent/core': 'workspace:*' },
        devDependencies: { '@vessel-agent/tui': 'file:../tui' },
      }),
      '0.3.0',
    );
    expect(issues.filter((issue) => issue.code === 'workspace_dependency')).toHaveLength(2);
  });

  it('rejects an exact internal version that differs from the root version', () => {
    const issues = evaluatePackedManifest(
      manifest({ dependencies: { '@vessel-agent/core': '0.1.0' } }),
      '0.3.0',
    );
    expect(codes(issues)).toContain('internal_dependency_version');
  });

  it('warns on internal semver ranges but does not fail', () => {
    const issues = evaluatePackedManifest(
      manifest({ dependencies: { '@vessel-agent/core': '^0.3.0' } }),
      '0.3.0',
    );
    expect(codes(issues)).toContain('internal_dependency_range');
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });
});

describe('detectForbiddenFile', () => {
  it('flags secrets, databases, logs and test artifacts', () => {
    const forbidden = [
      '.env',
      '.env.local',
      'certs/server.pem',
      'credentials.json',
      '.vessel/sessions.db',
      'logs/app.log',
      'coverage/lcov.info',
      'test-results/run.xml',
      'reports/index.html',
      'snapshots/a.snap',
    ];
    for (const path of forbidden) expect(detectForbiddenFile(path)).not.toBeNull();
  });

  it('allows test sources, committed TLS fixtures and normal package files', () => {
    const allowed = [
      '__tests__/a.test.ts',
      '__tests__/fixtures/tls/localhost-cert.pem',
      '__tests__/fixtures/tls/localhost-key.pem',
      'src/index.ts',
      'package.json',
    ];
    for (const path of allowed) expect(detectForbiddenFile(path)).toBeNull();
  });

  it('reports forbidden files from a tarball list', () => {
    const issues = evaluatePackedFiles(['src/index.ts', '.env.local', 'coverage/lcov.info']);
    expect(issues.filter((issue) => issue.code === 'forbidden_file')).toHaveLength(2);
  });
});

describe('checkEntryFiles', () => {
  it('fails when main, types or exports targets are missing from the tarball', () => {
    const issues = checkEntryFiles(
      manifest({
        main: 'src/main.ts',
        types: 'src/types.ts',
        exports: { '.': './src/index.ts' },
      }),
      ['package.json'],
    );
    expect(issues.every((issue) => issue.code === 'entry_file_missing')).toBe(true);
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true);
    expect(issues).toHaveLength(3);
  });

  it('accepts entry targets that are present', () => {
    expect(checkEntryFiles(manifest(), ['package.json', 'src/index.ts'])).toEqual([]);
  });
});

describe('tar parsing', () => {
  it('reads file paths and contents', () => {
    const tar = buildTar([
      { path: 'package/package.json', content: '{"name":"x"}' },
      { path: 'package/src/index.ts', content: 'export {};' },
    ]);
    const entries = parseTar(tar);
    expect(entries.map((entry) => entry.path)).toEqual([
      'package/package.json',
      'package/src/index.ts',
    ]);
    expect(new TextDecoder().decode(entries[1]?.data ?? new Uint8Array())).toBe('export {};');
  });

  it('extracts the packed manifest and strips the package prefix', () => {
    const tar = buildTar([
      { path: 'package/package.json', content: JSON.stringify(manifest()) },
      { path: 'package/src/index.ts', content: 'export {};' },
    ]);
    const packed = unpackTarball(Bun.gzipSync(Uint8Array.from(tar)));
    expect(packed.manifest.name).toBe('@vessel-agent/example');
    expect(packed.files).toEqual(['package.json', 'src/index.ts']);
  });
});

describe('collectPublicPackages', () => {
  it('skips private packages and returns public manifest paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vessel-dry-run-test-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ version: '0.3.0', workspaces: ['packages/*'] }),
      );
      for (const name of ['a', 'b']) {
        await mkdir(join(root, 'packages', name), { recursive: true });
      }
      await writeFile(
        join(root, 'packages/a/package.json'),
        JSON.stringify(manifest({ name: '@vessel-agent/a' })),
      );
      await writeFile(
        join(root, 'packages/b/package.json'),
        JSON.stringify(manifest({ name: '@vessel-agent/b', private: true })),
      );

      const packages = await collectPublicPackages(root);
      expect(packages.map((pkg) => pkg.path)).toEqual(['packages/a/package.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
