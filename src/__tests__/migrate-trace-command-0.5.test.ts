import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type RunCheckpoint, resolveTenantPaths } from '../../packages/core/src/index';
import { migrateCommand } from '../migrate-command';
import { tracePruneCommand } from '../trace-command';

// 迁移走 durable atomicWrite（temp fsync + rename）。Windows CI 上杀毒扫描
// 偶尔会让单次 fsync 卡住数秒，默认 5s 的 per-test 超时会把偶发 I/O 停顿
// 误报成失败；这里给足余量（本地通常 <100ms）。
setDefaultTimeout(30_000);

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-migrate-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows 上 sqlite 句柄释放可能滞后；临时目录留给系统清理
      }
    }
  }
});

function missingPath(): string {
  return path.join(tempDir(), 'missing.yaml');
}

const runState = {
  run_id: 'run-1',
  session_id: 'session-1',
  messages: [{ role: 'user', content: 'hello' }],
  started_at: 1000,
  completed_at: 2000,
  status: 'completed',
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  title: 'Title',
  preview: 'hello',
  updated_at: 2000,
  branch: 'main',
};

const runCheckpoint: RunCheckpoint = {
  run_id: 'run-1',
  session_id: 'session-1',
  agent_id: 'agent',
  status: 'completed',
  messages: [{ role: 'user', content: 'hello' }],
  iteration: 1,
  created_at: 1000,
  updated_at: 2000,
  metadata: { note: 'kept' },
};

function setupFileV1() {
  const source = tempDir();
  const runsSource = tempDir();
  fs.writeFileSync(path.join(source, 'session-1.json'), JSON.stringify(runState));
  fs.writeFileSync(path.join(source, 'broken.json'), 'not-json');
  fs.writeFileSync(path.join(runsSource, 'run-1.json'), JSON.stringify(runCheckpoint));
  return { source, runsSource };
}

describe('migrate command (0.5)', () => {
  it('file-v1 默认 dry-run：计数但不写', async () => {
    const dataDir = tempDir();
    const { source, runsSource } = setupFileV1();

    const result = await migrateCommand({
      from: 'file-v1',
      to: 'file-v2',
      source,
      runsSource,
      tenantId: 'acme',
      json: true,
      env: { VESSEL_DATA_DIR: dataDir },
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.sessions).toEqual({ found: 2, migrated: 1, skipped: 0, invalid: 1 });
    expect(parsed.runs).toEqual({ found: 1, migrated: 1, skipped: 0, invalid: 0 });

    const paths = resolveTenantPaths(dataDir, 'acme');
    expect(fs.existsSync(paths.sessions_dir)).toBe(false);
    expect(fs.existsSync(paths.runs_dir)).toBe(false);
  });

  it('file-v1 --apply 写入并保留字段、补 tenant_id；重复执行幂等', async () => {
    const dataDir = tempDir();
    const { source, runsSource } = setupFileV1();

    const options = {
      from: 'file-v1' as const,
      to: 'file-v2' as const,
      source,
      runsSource,
      tenantId: 'acme',
      apply: true,
      json: true,
      env: { VESSEL_DATA_DIR: dataDir },
      configPath: missingPath(),
      userConfigPath: missingPath(),
    };

    const first = await migrateCommand(options);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).sessions.migrated).toBe(1);

    const paths = resolveTenantPaths(dataDir, 'acme');
    const migratedSession = JSON.parse(
      fs.readFileSync(path.join(paths.sessions_dir, 'session-1.json'), 'utf8'),
    );
    expect(migratedSession).toEqual({ ...runState, tenant_id: 'acme' });

    const migratedRun = JSON.parse(
      fs.readFileSync(path.join(paths.runs_dir, 'run-1.json'), 'utf8'),
    );
    expect(migratedRun.tenant_id).toBe('acme');
    expect(migratedRun.metadata).toEqual({ note: 'kept' });

    const second = await migrateCommand(options);
    expect(second.exitCode).toBe(0);
    const counts = JSON.parse(second.stdout);
    expect(counts.sessions).toEqual({ found: 2, migrated: 0, skipped: 1, invalid: 1 });
    expect(counts.runs).toEqual({ found: 1, migrated: 0, skipped: 1, invalid: 0 });
  });

  it('sqlite --apply 迁移 sessions 表并保留字段', async () => {
    const dataDir = tempDir();
    const dbPath = path.join(tempDir(), 'sessions.db');
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        messages TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        usage TEXT,
        error TEXT,
        title TEXT,
        preview TEXT,
        updated_at INTEGER,
        branch TEXT
      )
    `);
    db.run(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      runState.session_id,
      runState.run_id,
      JSON.stringify(runState.messages),
      runState.started_at,
      runState.completed_at,
      runState.status,
      JSON.stringify(runState.usage),
      null,
      runState.title,
      runState.preview,
      runState.updated_at,
      runState.branch,
    ]);
    db.close();

    const result = await migrateCommand({
      from: 'sqlite',
      to: 'file-v2',
      source: dbPath,
      tenantId: 'work',
      apply: true,
      json: true,
      env: { VESSEL_DATA_DIR: dataDir },
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions).toEqual({ found: 1, migrated: 1, skipped: 0, invalid: 0 });

    const paths = resolveTenantPaths(dataDir, 'work');
    const migrated = JSON.parse(
      fs.readFileSync(path.join(paths.sessions_dir, 'session-1.json'), 'utf8'),
    );
    expect(migrated).toEqual({ ...runState, tenant_id: 'work' });
  });

  it('多租户源：保留源 tenant_id，foreign 行 skipped 且不改归属', async () => {
    const dataDir = tempDir();
    const dbPath = path.join(tempDir(), 'multi.db');
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        messages TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        usage TEXT,
        error TEXT,
        title TEXT,
        preview TEXT,
        updated_at INTEGER,
        branch TEXT,
        tenant_id TEXT
      )
    `);
    const insert = db.prepare(
      `INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'session-default',
      'run-default',
      JSON.stringify([{ role: 'user', content: 'default' }]),
      1000,
      null,
      'completed',
      null,
      null,
      null,
      null,
      null,
      null,
      'default',
    );
    insert.run(
      'session-acme',
      'run-acme',
      JSON.stringify([{ role: 'user', content: 'acme' }]),
      1000,
      null,
      'completed',
      null,
      null,
      null,
      null,
      null,
      null,
      'acme',
    );
    db.close();

    const result = await migrateCommand({
      from: 'sqlite',
      to: 'file-v2',
      source: dbPath,
      tenantId: 'acme',
      apply: true,
      json: true,
      env: { VESSEL_DATA_DIR: dataDir },
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });

    expect(result.exitCode).toBe(0);
    const counts = JSON.parse(result.stdout);
    expect(counts.sessions).toEqual({ found: 2, migrated: 1, skipped: 1, invalid: 0 });

    const paths = resolveTenantPaths(dataDir, 'acme');
    const migrated = JSON.parse(
      fs.readFileSync(path.join(paths.sessions_dir, 'session-acme.json'), 'utf8'),
    );
    expect(migrated.tenant_id).toBe('acme');
    expect(fs.existsSync(path.join(paths.sessions_dir, 'session-default.json'))).toBe(false);
  });

  it('file-v1 runs：foreign tenant 不迁移', async () => {
    const dataDir = tempDir();
    const source = tempDir();
    const runsSource = tempDir();
    fs.writeFileSync(
      path.join(source, 'legacy.json'),
      JSON.stringify({ ...runState, session_id: 'legacy', run_id: 'legacy-run' }),
    );
    fs.writeFileSync(
      path.join(runsSource, 'foreign.json'),
      JSON.stringify({ ...runCheckpoint, run_id: 'foreign-run', tenant_id: 'default' }),
    );

    const result = await migrateCommand({
      from: 'file-v1',
      to: 'file-v2',
      source,
      runsSource,
      tenantId: 'acme',
      apply: true,
      json: true,
      env: { VESSEL_DATA_DIR: dataDir },
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });

    expect(result.exitCode).toBe(0);
    const counts = JSON.parse(result.stdout);
    expect(counts.runs).toEqual({ found: 1, migrated: 0, skipped: 1, invalid: 0 });
    expect(
      fs.existsSync(path.join(resolveTenantPaths(dataDir, 'acme').runs_dir, 'foreign-run.json')),
    ).toBe(false);
  });

  it('源不存在 / 用法错误返回正确退出码', async () => {
    const dataDir = tempDir();
    const missingSource = await migrateCommand({
      from: 'sqlite',
      to: 'file-v2',
      source: path.join(tempDir(), 'nope.db'),
      tenantId: 'work',
      env: { VESSEL_DATA_DIR: dataDir },
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });
    expect(missingSource.exitCode).toBe(1);
    expect(missingSource.stderr).toContain('source_not_found');

    const badFrom = await migrateCommand({
      from: 'bogus',
      to: 'file-v2',
      env: {},
    });
    expect(badFrom.exitCode).toBe(2);

    const badTo = await migrateCommand({
      from: 'sqlite',
      to: 'sqlite',
      env: {},
    });
    expect(badTo.exitCode).toBe(2);
  });
});

describe('trace prune command (0.5)', () => {
  function writeTrace(dir: string, name: string, ts: number): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'run.completed', run_id: name, data: {}, ts })}\n`,
    );
    return file;
  }

  it('dry-run 保留文件，真实 prune 删除旧 trace', async () => {
    const dataDir = tempDir();
    const paths = resolveTenantPaths(dataDir, 'acme');
    const oldFile = writeTrace(paths.events_dir, 'old.jsonl', Date.now() - 3 * 86_400_000);
    const newFile = writeTrace(paths.events_dir, 'new.jsonl', Date.now());

    const configPath = path.join(tempDir(), 'vessel.yaml');
    fs.writeFileSync(configPath, 'trace:\n  retention_days: 1\n');

    const common = {
      tenantId: 'acme',
      json: true,
      env: { VESSEL_DATA_DIR: dataDir },
      configPath,
      userConfigPath: missingPath(),
    };

    const dry = await tracePruneCommand({ ...common, dryRun: true });
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout)).toEqual({
      deleted_runs: 1,
      kept_runs: 1,
      deleted_bytes: expect.any(Number),
    });
    expect(fs.existsSync(oldFile)).toBe(true);

    const real = await tracePruneCommand(common);
    expect(real.exitCode).toBe(0);
    expect(JSON.parse(real.stdout).deleted_runs).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });
});
