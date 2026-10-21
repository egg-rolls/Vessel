import { describe, expect, it } from 'bun:test';
import {
  buildOverrides,
  checkRootIncludesWeb,
  checkToolsOutput,
  checkVersionOutput,
  orderPackages,
  PUBLISH_ORDER,
  parsePackOutput,
  type SmokePackage,
  type TarballInfo,
  WEB_DIST_ENTRY,
} from '../smoke-install';

function pkg(path: string, name = `@vessel-agent/${path}`): SmokePackage {
  return { path, dir: `/repo/${path}`, name, version: '0.10.0' };
}

function tarball(name: string, path = `/tmp/${name}.tgz`): TarballInfo {
  return { name, version: '0.10.0', filename: `${name}.tgz`, tarball: path };
}

describe('orderPackages', () => {
  it('follows the documented publish order', () => {
    const shuffled = [...PUBLISH_ORDER].reverse().map((path) => pkg(path));
    const ordered = orderPackages(shuffled);
    expect(ordered.map((item) => item.path)).toEqual([...PUBLISH_ORDER]);
  });

  it('keeps packages missing from PUBLISH_ORDER and appends them sorted', () => {
    const ordered = orderPackages([
      pkg('plugins/zzz/new'),
      pkg('packages/core'),
      pkg('plugins/aaa/new'),
    ]);
    expect(ordered.map((item) => item.path)).toEqual([
      'packages/core',
      'plugins/aaa/new',
      'plugins/zzz/new',
    ]);
  });

  it('ignores unknown order entries instead of inventing packages', () => {
    const ordered = orderPackages([pkg('packages/core')]);
    expect(ordered).toHaveLength(1);
    expect(ordered[0]?.path).toBe('packages/core');
  });
});

describe('buildOverrides', () => {
  it('maps every package to a local file: tarball', () => {
    const overrides = buildOverrides([
      tarball('@vessel-agent/core'),
      tarball('@vessel-agent/config'),
    ]);
    expect(overrides).toEqual({
      '@vessel-agent/core': 'file:/tmp/@vessel-agent/core.tgz',
      '@vessel-agent/config': 'file:/tmp/@vessel-agent/config.tgz',
    });
  });
});

describe('parsePackOutput', () => {
  it('parses npm pack --json output', () => {
    const entries = parsePackOutput(
      JSON.stringify([
        { name: '@vessel-agent/core', version: '0.10.0', filename: 'vessel-core-0.10.0.tgz' },
      ]),
    );
    expect(entries).toEqual([
      { name: '@vessel-agent/core', version: '0.10.0', filename: 'vessel-core-0.10.0.tgz' },
    ]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parsePackOutput('not json')).toThrow(/invalid JSON/);
  });

  it('rejects entries without name/version/filename', () => {
    expect(() => parsePackOutput(JSON.stringify([{ name: 'x' }]))).toThrow(/missing/);
  });

  it('keeps the reported file list when present', () => {
    const [entry] = parsePackOutput(
      JSON.stringify([
        {
          name: 'vessel-agent',
          version: '0.10.0',
          filename: 'vessel-agent-0.10.0.tgz',
          files: [{ path: 'package.json' }, { path: WEB_DIST_ENTRY }],
        },
      ]),
    );
    expect(entry?.files).toEqual(['package.json', WEB_DIST_ENTRY]);
  });

  it('rejects a malformed files list', () => {
    expect(() =>
      parsePackOutput(
        JSON.stringify([{ name: 'x', version: '1.0.0', filename: 'x.tgz', files: [{ size: 1 }] }]),
      ),
    ).toThrow(/files\[\]\.path/);
  });
});

describe('checkRootIncludesWeb', () => {
  it('accepts a root tarball containing the web entry', () => {
    expect(checkRootIncludesWeb(['package.json', WEB_DIST_ENTRY])).toBeNull();
  });

  it('rejects a root tarball without the web entry', () => {
    expect(checkRootIncludesWeb(['package.json'])).toContain(WEB_DIST_ENTRY);
  });

  it('rejects a missing file list', () => {
    expect(checkRootIncludesWeb(undefined)).toContain('did not report a file list');
  });
});

describe('checkVersionOutput', () => {
  it('accepts the exact version', () => {
    expect(checkVersionOutput('0.10.0\n', '0.10.0')).toBeNull();
  });

  it('reports a mismatch', () => {
    expect(checkVersionOutput('0.9.0', '0.10.0')).toContain('expected "0.10.0"');
  });
});

describe('checkToolsOutput', () => {
  const output = [
    'Tools (3):',
    '  - bash: run commands',
    '  - read: read files',
    '  - edit: edit files',
    'ask_user (interactive REPL / gateway only)',
  ].join('\n');

  it('accepts the default tool set', () => {
    expect(checkToolsOutput(output)).toBeNull();
  });

  it('rejects a missing header', () => {
    expect(checkToolsOutput('bash\nread\nedit')).toContain('header');
  });

  it('rejects missing required tools', () => {
    expect(checkToolsOutput('Tools (3):\n  - bash: x\n  - read: y\n')).toContain('edit');
  });
});
