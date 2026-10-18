import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import {
  expandHome,
  isSafeSuiteName,
  isSafeWorkflowName,
  resolveEvalSuite,
  resolveEvalsDir,
  resolveEvalsOutDir,
  resolveWorkflowDefinition,
  resolveWorkflowDefPath,
  resolveWorkflowDefPathSync,
  resolveWorkflowDir,
  resolveWorkflowStorePath,
} from '../path-resolution';

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

describe('config path resolution', () => {
  it('resolves workflow dir / store path against cwd', () => {
    expect(resolveWorkflowDir({ workflow: { dir: './wf' } })).toBe(path.resolve('./wf'));
    expect(resolveWorkflowStorePath({ workflow: { path: './runs' } })).toBe(path.resolve('./runs'));
    expect(resolveWorkflowDir({})).toBe(path.resolve('./workflows'));
    expect(resolveWorkflowStorePath({})).toBe(path.join(os.homedir(), '.vessel/workflows'));
  });

  it('resolves evals dir / out dir', () => {
    expect(resolveEvalsDir({ evals: { dir: './suites' } })).toBe(path.resolve('./suites'));
    expect(resolveEvalsOutDir({ evals: { outDir: './out' } })).toBe(path.resolve('./out'));
    expect(resolveEvalsOutDir({})).toBe(path.join(os.homedir(), '.vessel/evals'));
  });
});

describe('workflow definition resolution', () => {
  it('resolves name.yaml / name.yml / name.json', async () => {
    for (const extension of ['yaml', 'yml', 'json']) {
      const dir = tmpDir();
      const file = path.join(dir, `demo.${extension}`);
      write(file);
      const result = await resolveWorkflowDefinition(config({ workflow: { dir } }), 'demo');
      expect(result).toEqual({ ok: true, path: fs.realpathSync(file) });
    }
  });

  it('rejects multiple matching definitions', async () => {
    const dir = tmpDir();
    write(path.join(dir, 'demo.yaml'));
    write(path.join(dir, 'demo.yml'));

    const result = await resolveWorkflowDefinition(config({ workflow: { dir } }), 'demo');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('workflow_invalid');
      expect(result.error).toContain('multiple definitions');
    }
  });

  it('reports not found for an unknown name', async () => {
    const dir = tmpDir();
    const result = await resolveWorkflowDefinition(config({ workflow: { dir } }), 'missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('workflow_not_found');
      expect(result.error).toContain('missing');
    }
  });

  it('resolves a relative path against workflow.dir', async () => {
    const dir = tmpDir();
    write(path.join(dir, 'nested', 'demo.yaml'));

    const result = await resolveWorkflowDefinition(
      config({ workflow: { dir } }),
      'nested/demo.yaml',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(fs.realpathSync(path.join(dir, 'nested', 'demo.yaml')));
    }
  });

  it('allows an absolute path', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'absolute.yaml');
    write(file);

    const result = await resolveWorkflowDefinition(config(), file);
    expect(result.ok).toBe(true);
  });

  it('rejects .. escape', async () => {
    const base = tmpDir();
    const outside = path.join(base, 'outside.yaml');
    write(outside);
    const workflowDir = path.join(base, 'wf');
    fs.mkdirSync(workflowDir);

    const result = await resolveWorkflowDefinition(
      config({ workflow: { dir: workflowDir } }),
      '../outside.yaml',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('workflow_invalid');
  });

  it('rejects unsafe single-segment names', async () => {
    const dir = tmpDir();
    expect((await resolveWorkflowDefinition(config({ workflow: { dir } }), 'a.b')).ok).toBe(false);
    expect((await resolveWorkflowDefinition(config({ workflow: { dir } }), '..')).ok).toBe(false);
  });

  it('resolveWorkflowDefPath only accepts safe names', async () => {
    const dir = tmpDir();
    write(path.join(dir, 'demo.yaml'));
    const cfg = config({ workflow: { dir } });

    await expect(resolveWorkflowDefPath(cfg, 'demo')).resolves.toBe(
      fs.realpathSync(path.join(dir, 'demo.yaml')),
    );
    await expect(resolveWorkflowDefPath(cfg, '../demo')).resolves.toBeUndefined();
    await expect(resolveWorkflowDefPath(cfg, 'a/b')).resolves.toBeUndefined();
    await expect(resolveWorkflowDefPath(cfg, 'missing')).resolves.toBeUndefined();
  });

  it('sync resolver matches the async safe-name rules', () => {
    const dir = tmpDir();
    write(path.join(dir, 'demo.yaml'));
    const cfg = config({ workflow: { dir } });

    expect(resolveWorkflowDefPathSync(cfg, 'demo')).toBe(
      fs.realpathSync(path.join(dir, 'demo.yaml')),
    );
    expect(resolveWorkflowDefPathSync(cfg, '../demo')).toBeUndefined();
    expect(resolveWorkflowDefPathSync(cfg, 'a/b')).toBeUndefined();
    expect(resolveWorkflowDefPathSync(cfg, 'missing')).toBeUndefined();

    write(path.join(dir, 'dup.yaml'));
    write(path.join(dir, 'dup.json'));
    expect(resolveWorkflowDefPathSync(cfg, 'dup')).toBeUndefined();
  });

  it('rejects a symlink escaping workflow.dir when possible', async () => {
    const dir = tmpDir();
    const workflowDir = path.join(dir, 'wf');
    fs.mkdirSync(workflowDir);
    const outside = path.join(dir, 'outside.yaml');
    write(outside);

    try {
      fs.symlinkSync(outside, path.join(workflowDir, 'link.yaml'));
    } catch {
      // Windows without symlink privilege: skip the escape assertion.
      return;
    }

    const result = await resolveWorkflowDefinition(
      config({ workflow: { dir: workflowDir } }),
      'link.yaml',
    );
    expect(result.ok).toBe(false);
  });
});

describe('eval suite resolution', () => {
  it('resolves a name under evals.dir', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'smoke.yaml');
    write(file);

    const result = await resolveEvalSuite(config({ evals: { dir } }), 'smoke');
    expect(result).toEqual({ ok: true, path: fs.realpathSync(file) });
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
    expect(isSafeWorkflowName('a_b-c9')).toBe(true);
    expect(isSafeWorkflowName('a.b')).toBe(false);
    expect(isSafeWorkflowName('a/b')).toBe(false);
    expect(isSafeWorkflowName('')).toBe(false);
    expect(isSafeSuiteName('smoke-1')).toBe(true);
  });
});
