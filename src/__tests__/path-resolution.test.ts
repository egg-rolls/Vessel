import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import {
  expandHome,
  isSafeSuiteName,
  resolveAgentCwd,
  resolveEvalSuite,
  resolveEvalsDir,
  resolveEvalsOutDir,
} from '../path-resolution';
import { canonicalPath } from './path-helpers';

const dirs: string[] = [];

function tmpDir(prefix = 'vessel-04-path-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function write(filePath: string, content = 'name: test\nsteps: []\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function config(overrides: VesselConfig = {}): VesselConfig {
  return overrides;
}

describe('expandHome', () => {
  it('expands ~ and ~/ paths', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/x/y')).toBe(path.join(os.homedir(), 'x/y'));
    expect(expandHome('~\\x\\y')).toBe(path.join(os.homedir(), 'x\\y'));
  });

  it('leaves other paths untouched', () => {
    expect(expandHome('./x')).toBe('./x');
    expect(expandHome('/tmp/x')).toBe('/tmp/x');
  });
});

describe('resolveAgentCwd（0.11.1）', () => {
  it('未配置/空串返回 undefined', () => {
    expect(resolveAgentCwd({})).toBeUndefined();
    expect(resolveAgentCwd({ agent: { cwd: '' } })).toBeUndefined();
    expect(resolveAgentCwd({ agent: { cwd: '   ' } })).toBeUndefined();
  });

  it('展开 ~ 并解析相对路径为绝对路径', () => {
    expect(resolveAgentCwd({ agent: { cwd: '~' } })).toBe(os.homedir());
    expect(resolveAgentCwd({ agent: { cwd: '~/work' } })).toBe(path.join(os.homedir(), 'work'));
    expect(resolveAgentCwd({ agent: { cwd: './relative' } })).toBe(path.resolve('./relative'));
    expect(resolveAgentCwd({ agent: { cwd: '/absolute/path' } })).toBe(
      path.normalize('/absolute/path'),
    );
  });
});

describe('config path resolution', () => {
  it('resolves evals dir / out dir', () => {
    expect(resolveEvalsDir({ evals: { dir: './suites' } })).toBe(path.resolve('./suites'));
    expect(resolveEvalsOutDir({ evals: { outDir: './out' } })).toBe(path.resolve('./out'));
    expect(resolveEvalsOutDir({})).toBe(path.join(os.homedir(), '.vessel/evals'));
  });
});

describe('eval suite resolution', () => {
  it('resolves a name under evals.dir', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'smoke.yaml');
    write(file);

    const result = await resolveEvalSuite(config({ evals: { dir } }), 'smoke');
    expect(result).toEqual({ ok: true, path: canonicalPath(file) });
  });

  it('rejects multiple / missing suites', async () => {
    const dir = tmpDir();
    write(path.join(dir, 'smoke.yaml'));
    write(path.join(dir, 'smoke.json'));

    const multiple = await resolveEvalSuite(config({ evals: { dir } }), 'smoke');
    expect(multiple.ok).toBe(false);
    if (!multiple.ok) expect(multiple.code).toBe('eval_invalid');

    const missing = await resolveEvalSuite(config({ evals: { dir } }), 'missing');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('eval_not_found');
  });
});

describe('safe names', () => {
  it('accepts [A-Za-z0-9_-]{1,64}', () => {
    expect(isSafeSuiteName('a_b-c9')).toBe(true);
    expect(isSafeSuiteName('a.b')).toBe(false);
    expect(isSafeSuiteName('a/b')).toBe(false);
    expect(isSafeSuiteName('')).toBe(false);
    expect(isSafeSuiteName('smoke-1')).toBe(true);
  });
});
