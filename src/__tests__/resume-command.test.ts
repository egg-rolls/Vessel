import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileRunStore, type RunCheckpoint } from '../../packages/core/src/index';
import { runResumeList } from '../resume-command';

// 隔离 VESSEL_* 环境变量
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VESSEL_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-resume-cmd-'));
}

function writeConfig(dir: string, body: string): { configPath: string; userConfigPath: string } {
  const configPath = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(configPath, body, 'utf-8');
  return { configPath, userConfigPath: path.join(dir, 'missing-user.yaml') };
}

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    run_id: 'run-1',
    session_id: 'session-1',
    status: 'interrupted',
    messages: [{ role: 'user', content: 'hello' }],
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

async function capture(run: () => Promise<number>): Promise<{
  code: number;
  out: string;
  err: string;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  };
  try {
    const code = await run();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

describe('runResumeList', () => {
  it('durable 关闭：明确提示，exit 0', async () => {
    const dir = tmpDir();
    try {
      const paths = writeConfig(
        dir,
        'provider:\n  name: openai\n  model: gpt-4\ndurable:\n  enabled: false\n',
      );
      const result = await capture(() => runResumeList(paths));
      expect(result.code).toBe(0);
      expect(result.out).toContain('not enabled');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有 interrupted run：提示为空，exit 0', async () => {
    const dir = tmpDir();
    try {
      const runsDir = path.join(dir, 'runs');
      const paths = writeConfig(
        dir,
        `durable:\n  enabled: true\n  backend: file\n  path: ${runsDir.replaceAll('\\', '/')}\n`,
      );
      const store = new FileRunStore({ dir: runsDir });
      await store.save(checkpoint({ run_id: 'completed-run', status: 'completed' }));

      const result = await capture(() => runResumeList(paths));
      expect(result.code).toBe(0);
      expect(result.out).toContain('No interrupted runs.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('默认布局：从 <data_dir>/tenants/<tenant>/runs 列出（A4）', async () => {
    const dir = tmpDir();
    try {
      const dataDir = path.join(dir, 'data');
      const runsDir = path.join(dataDir, 'tenants', 'work', 'runs');
      const store = new FileRunStore({ dir: runsDir, tenantId: 'work' });
      await store.save(checkpoint({ run_id: 'tenant-run', tenant_id: 'work' }));

      const paths = writeConfig(
        dir,
        'provider:\n  name: openai\n  model: gpt-4\ndurable:\n  enabled: true\n',
      );
      const result = await capture(() =>
        runResumeList({
          ...paths,
          tenantId: 'work',
          env: { VESSEL_DATA_DIR: dataDir },
        }),
      );

      expect(result.code).toBe(0);
      expect(result.out).toContain('Interrupted runs (1, newest first):');
      expect(result.out).toContain('tenant-run');

      // 其它 tenant 不读取该目录。
      const other = await capture(() =>
        runResumeList({
          ...paths,
          tenantId: 'other',
          env: { VESSEL_DATA_DIR: dataDir },
        }),
      );
      expect(other.code).toBe(0);
      expect(other.out).toContain('No interrupted runs.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('只列出 interrupted，按 updated_at 倒序', async () => {
    const dir = tmpDir();
    try {
      const runsDir = path.join(dir, 'runs');
      const paths = writeConfig(
        dir,
        `durable:\n  enabled: true\n  backend: file\n  path: ${runsDir.replaceAll('\\', '/')}\n`,
      );
      const store = new FileRunStore({ dir: runsDir });
      await store.save(
        checkpoint({ run_id: 'older', session_id: 's1', updated_at: 1000, iteration: 2 }),
      );
      await store.save(
        checkpoint({ run_id: 'newer', session_id: 's2', updated_at: 3000, iteration: 5 }),
      );
      await store.save(checkpoint({ run_id: 'done', status: 'completed', updated_at: 4000 }));

      const result = await capture(() => runResumeList(paths));
      expect(result.code).toBe(0);
      expect(result.out).toContain('Interrupted runs (2, newest first):');
      expect(result.out).toContain('newer');
      expect(result.out).toContain('older');
      expect(result.out).not.toContain('done');
      expect(result.out.indexOf('newer')).toBeLessThan(result.out.indexOf('older'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('配置错误：打印并 exit 1', async () => {
    const dir = tmpDir();
    try {
      const paths = writeConfig(dir, 'durable:\n  enabled: true\n  backend: redis\n');
      const result = await capture(() => runResumeList(paths));
      expect(result.code).toBe(1);
      expect(result.err).toContain('durable.backend');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
