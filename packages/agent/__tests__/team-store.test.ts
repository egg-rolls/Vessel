import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import type { TeamLogEntry } from '../src/index.js';
import {
  normalizeWorkspace,
  slugifyWorkspace,
  teamIdForWorkspace,
  workspaceKey,
} from '../src/team-slug.js';
import { FileTeamStore, teamLogPath, teamMetadataPath, teamsDirPath } from '../src/team-store.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-agent-team-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function captureLogger(): { logger: Logger; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    warnings,
    errors,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    },
  };
}

function logEntry(
  messageId: string,
  teamId: string,
  overrides: Partial<TeamLogEntry> = {},
): TeamLogEntry {
  return {
    message_id: messageId,
    team_id: teamId,
    from: 'main',
    to: [],
    mentions: [],
    content: `message ${messageId}`,
    ts: 1_700_000_000_000,
    kind: 'post',
    ...overrides,
  };
}

function sha8(workspace: string): string {
  return createHash('sha256')
    .update(normalizeWorkspace(workspace), 'utf8')
    .digest('hex')
    .slice(0, 8);
}

describe('team-slug', () => {
  it('normalizes workspaces and compares by exact normalized path', async () => {
    const dataDir = await tempDir();
    const alpha = join(dataDir, 'alpha');

    expect(normalizeWorkspace(` ${alpha}/ `)).toBe(normalizeWorkspace(alpha));
    expect(normalizeWorkspace(join(alpha, '.', '..', 'alpha', '.'))).toBe(
      normalizeWorkspace(alpha),
    );
    expect(workspaceKey(`${alpha}/`)).toBe(workspaceKey(alpha));

    // 精确相等：前缀 / 祖先目录不匹配
    expect(workspaceKey(join(alpha, 'nested'))).not.toBe(workspaceKey(alpha));
    expect(workspaceKey(dataDir)).not.toBe(workspaceKey(alpha));

    expect(normalizeWorkspace('~/vessel-team-test')).toBe(join(homedir(), 'vessel-team-test'));
  });

  it('slugifies basenames deterministically', async () => {
    const dataDir = await tempDir();
    const queried = normalizeWorkspace(join(dataDir, 'one', 'proj'));
    const otherWorkspace = join(dataDir, 'other', 'proj');

    expect(slugifyWorkspace(join(dataDir, 'My Project'))).toBe('my-project');
    expect(slugifyWorkspace(join(dataDir, '2024-Q1'))).toBe('team-2024-q1');
    expect(slugifyWorkspace(join(dataDir, '项目目录'))).toMatch(/^team-[0-9a-f]{6}$/);
    expect(slugifyWorkspace(join(dataDir, 'x'.repeat(48))).length).toBe(32);

    // 同一 workspace 复用 base slug
    expect(teamIdForWorkspace(queried, (id) => (id === 'proj' ? queried : undefined))).toBe('proj');
    // 不同 workspace 占用同 slug：追加 hash 后缀
    expect(teamIdForWorkspace(queried, (id) => (id === 'proj' ? otherWorkspace : undefined))).toBe(
      `proj-${sha8(queried)}`,
    );
  });
});

describe('FileTeamStore.ensureForWorkspace', () => {
  it('creates exactly one team for concurrent ensure of the same workspace', async () => {
    const dataDir = await tempDir();
    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    const workspace = join(dataDir, 'workspaces', 'alpha');

    const [first, second, third] = await Promise.all([
      store.ensureForWorkspace({ workspace, name: 'Alpha' }),
      store.ensureForWorkspace({ workspace: `${workspace}/`, name: 'Alpha' }),
      store.ensureForWorkspace({ workspace }),
    ]);

    expect(first.team_id).toBe('alpha');
    expect(second.team_id).toBe(first.team_id);
    expect(third.team_id).toBe(first.team_id);
    expect(await readdir(teamsDirPath(dataDir, 'default'))).toEqual(['alpha']);

    const raw = await readFile(teamMetadataPath(dataDir, 'default', first.team_id), 'utf8');
    const onDisk = JSON.parse(raw) as { team_id: string; name: string; workspace: string };
    expect(onDisk.team_id).toBe('alpha');
    expect(onDisk.name).toBe('Alpha');
    expect(onDisk.workspace).toBe(normalizeWorkspace(workspace));

    // 已存在的 Team 直接复用，不新增目录
    const again = await store.ensureForWorkspace({ workspace, name: 'Renamed' });
    expect(again.team_id).toBe(first.team_id);
    expect(again.name).toBe('Alpha');
    expect(store.list().length).toBe(1);
  });

  it('keeps distinct teams for different workspaces sharing a basename', async () => {
    const dataDir = await tempDir();
    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    const workspaceA = join(dataDir, 'one', 'proj');
    const workspaceB = join(dataDir, 'two', 'proj');

    const a = await store.ensureForWorkspace({ workspace: workspaceA });
    const b = await store.ensureForWorkspace({ workspace: workspaceB });

    expect(a.team_id).toBe('proj');
    expect(b.team_id).toBe(`proj-${sha8(workspaceB)}`);
    expect(b.workspace).toBe(normalizeWorkspace(workspaceB));
    expect(new Set(store.list().map((team) => team.team_id)).size).toBe(2);
    expect((await readdir(teamsDirPath(dataDir, 'default'))).length).toBe(2);

    const reused = await store.ensureForWorkspace({ workspace: workspaceA });
    expect(reused.team_id).toBe(a.team_id);
  });

  it('reloads persisted teams and reuses their team_id', async () => {
    const dataDir = await tempDir();
    const workspace = join(dataDir, 'reload', 'alpha');
    const first = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    const created = await first.ensureForWorkspace({ workspace, name: 'Alpha' });

    const second = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await second.ready();
    expect(second.get(created.team_id)).toEqual(created);

    const reused = await second.ensureForWorkspace({ workspace });
    expect(reused.team_id).toBe(created.team_id);
    expect(second.list().length).toBe(1);
  });
});

describe('FileTeamStore.seed', () => {
  it('seeds only missing metadata and never overwrites existing fields', async () => {
    const dataDir = await tempDir();
    const capture = captureLogger();
    const workspace = join(dataDir, 'seed', 'proj');
    const store = new FileTeamStore({
      dataDir,
      tenantId: 'default',
      durable: false,
      logger: capture.logger,
    });

    await store.seed([{ workspace, name: 'First', policy: { mode: 'alpha' } }]);
    const created = store.list()[0];
    if (!created) throw new Error('expected seeded team');
    expect(created.name).toBe('First');
    expect(created.policy).toEqual({ mode: 'alpha' });
    expect(created.workspace).toBe(normalizeWorkspace(workspace));

    const path = teamMetadataPath(dataDir, 'default', created.team_id);
    const before = await readFile(path, 'utf8');
    await store.seed([{ workspace, name: 'Second', policy: { mode: 'beta' } }]);
    const after = await readFile(path, 'utf8');

    expect(after).toBe(before);
    expect(store.get(created.team_id)?.name).toBe('First');
    expect(store.get(created.team_id)?.policy).toEqual({ mode: 'alpha' });
    expect(capture.warnings).toContain('team.metadata.conflict');
  });

  it('gives same-basename declarations distinct teams instead of merging', async () => {
    const dataDir = await tempDir();
    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    const workspaceA = join(dataDir, 'one', 'proj');
    const workspaceB = join(dataDir, 'two', 'proj');

    await store.seed([{ workspace: workspaceA }, { workspace: workspaceB }]);

    const teams = store.list();
    expect(teams.length).toBe(2);
    expect(new Set(teams.map((team) => team.team_id)).size).toBe(2);
    expect(teams.find((team) => team.workspace === normalizeWorkspace(workspaceB))?.team_id).toBe(
      `proj-${sha8(workspaceB)}`,
    );
  });
});

describe('FileTeamStore.ready', () => {
  it('keeps serving other teams without touching a corrupt team.json', async () => {
    const dataDir = await tempDir();
    const capture = captureLogger();
    const tenantDir = teamsDirPath(dataDir, 'default');

    await mkdir(join(tenantDir, 'broken'), { recursive: true });
    await writeFile(join(tenantDir, 'broken', 'team.json'), '{ nope');
    await mkdir(join(tenantDir, 'versioned'), { recursive: true });
    await writeFile(
      join(tenantDir, 'versioned', 'team.json'),
      JSON.stringify({
        v: 2,
        team_id: 'versioned',
        name: 'x',
        tenant_id: 'default',
        workspace: '/x',
        policy: {},
        created_at: 1,
      }),
    );
    await mkdir(join(tenantDir, 'no-metadata'), { recursive: true });

    const store = new FileTeamStore({
      dataDir,
      tenantId: 'default',
      durable: false,
      logger: capture.logger,
    });
    await store.ready();

    expect(store.list()).toEqual([]);
    expect(capture.errors.filter((message) => message === 'team.metadata.corrupt').length).toBe(2);

    const team = await store.ensureForWorkspace({ workspace: join(dataDir, 'fresh') });
    expect(store.get(team.team_id)?.team_id).toBe(team.team_id);
    // 损坏文件保持原样，不被当作用空元数据补齐的对象。
    expect(await readFile(join(tenantDir, 'broken', 'team.json'), 'utf8')).toBe('{ nope');
  });

  it('does not rebuild a corrupt team.json in place', async () => {
    const dataDir = await tempDir();
    const workspace = join(dataDir, 'rebuild', 'alpha');
    const first = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    const created = await first.ensureForWorkspace({
      workspace,
      name: 'Alpha',
      policy: { mode: 'strict' },
    });
    const path = teamMetadataPath(dataDir, 'default', created.team_id);
    const corrupt = '{"v":1,"team_id":';
    await writeFile(path, corrupt);

    const capture = captureLogger();
    const second = new FileTeamStore({
      dataDir,
      tenantId: 'default',
      durable: false,
      logger: capture.logger,
    });
    await second.ready();
    expect(second.list()).toEqual([]);

    const error = await second
      .ensureForWorkspace({ workspace, name: 'Omega' })
      .catch((reason) => reason);
    expect((error as { code?: string }).code).toBe('team_metadata_corrupt');

    await second.seed([{ workspace, name: 'Omega' }]);
    expect(await readFile(path, 'utf8')).toBe(corrupt);
    expect(capture.errors).toContain('team.metadata.corrupt');
  });
});

describe('FileTeamStore.policy', () => {
  it('parses stored camelCase / snake_case policy into one normalized view', async () => {
    const dataDir = await tempDir();
    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    const team = await store.ensureForWorkspace({
      workspace: join(dataDir, 'policy', 'alpha'),
      policy: {
        permission: { unattended: 'deny-after', deny_after_seconds: 300 },
        budget: { max_hops: 2, cycle: { max_repeats: 3 } },
      },
    });

    expect(store.policy(team.team_id)).toEqual({
      permission: { unattended: 'deny-after', denyAfterSeconds: 300 },
      budget: { maxHops: 2, cycle: { maxRepeats: 3 } },
    });
    // 只读取，不回写 team.json（原始 snake_case 仍在磁盘上）
    const raw = await readFile(teamMetadataPath(dataDir, 'default', team.team_id), 'utf8');
    expect(JSON.parse(raw).policy.budget.max_hops).toBe(2);
  });

  it('warns and returns undefined for invalid policy while the team stays usable', async () => {
    const dataDir = await tempDir();
    const capture = captureLogger();
    const tenantDir = teamsDirPath(dataDir, 'default');
    const workspace = join(dataDir, 'bad-policy');
    await mkdir(join(tenantDir, 'bad-policy'), { recursive: true });
    await writeFile(
      join(tenantDir, 'bad-policy', 'team.json'),
      JSON.stringify({
        v: 1,
        team_id: 'bad-policy',
        name: 'Bad Policy',
        tenant_id: 'default',
        workspace,
        policy: { budget: { maxCost: 10 } },
        created_at: 1,
      }),
    );

    const store = new FileTeamStore({
      dataDir,
      tenantId: 'default',
      durable: false,
      logger: capture.logger,
    });
    await store.ready();

    expect(store.get('bad-policy')?.name).toBe('Bad Policy');
    expect(store.policy('bad-policy')).toBeUndefined();
    expect(capture.warnings).toContain('team.policy.invalid');
    expect(store.list().length).toBe(1);

    const again = await store.ensureForWorkspace({ workspace });
    expect(again.team_id).toBe('bad-policy');
  });

  it('returns undefined for an unknown team', async () => {
    const dataDir = await tempDir();
    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    expect(store.policy('missing')).toBeUndefined();
  });
});

describe('FileTeamStore spawn_frozen', () => {
  it('persists true, survives reload, and removes the field on false', async () => {
    const dataDir = await tempDir();
    const workspace = join(dataDir, 'freeze', 'alpha');
    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    const team = await store.ensureForWorkspace({ workspace });

    const frozen = await store.setSpawnFrozen(team.team_id, true);
    expect(frozen.spawn_frozen).toBe(true);
    const path = teamMetadataPath(dataDir, 'default', team.team_id);
    expect(
      (JSON.parse(await readFile(path, 'utf8')) as { spawn_frozen?: boolean }).spawn_frozen,
    ).toBe(true);

    const reopened = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await reopened.ready();
    expect(reopened.get(team.team_id)?.spawn_frozen).toBe(true);

    const thawed = await reopened.setSpawnFrozen(team.team_id, false);
    expect(thawed.spawn_frozen).toBeUndefined();
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(raw, 'spawn_frozen')).toBe(false);

    const again = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await again.ready();
    expect(again.get(team.team_id)?.spawn_frozen).toBeUndefined();
  });

  it('keeps spawn_frozen across update and rejects archived teams', async () => {
    const dataDir = await tempDir();
    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    const team = await store.ensureForWorkspace({ workspace: join(dataDir, 'freeze', 'beta') });
    await store.setSpawnFrozen(team.team_id, true);

    const updated = await store.update(team.team_id, { name: 'Beta' });
    expect(updated.spawn_frozen).toBe(true);
    expect(store.get(team.team_id)?.spawn_frozen).toBe(true);

    await store.archive(team.team_id);
    await expect(store.setSpawnFrozen(team.team_id, false)).rejects.toThrow('team_archived');
    await expect(store.setSpawnFrozen('missing', true)).rejects.toThrow('team_not_found');
  });

  it('ignores a non-boolean spawn_frozen instead of invalidating the team', async () => {
    const dataDir = await tempDir();
    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    const team = await store.ensureForWorkspace({ workspace: join(dataDir, 'freeze', 'gamma') });
    const path = teamMetadataPath(dataDir, 'default', team.team_id);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw.spawn_frozen = 'yes';
    await writeFile(path, `${JSON.stringify(raw)}\n`);

    const reopened = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await reopened.ready();
    expect(reopened.get(team.team_id)?.spawn_frozen).toBeUndefined();
  });
});

describe('FileTeamStore log', () => {
  it('preserves append order, skips bad and truncated lines, and bounds the limit', async () => {
    const dataDir = await tempDir();
    const capture = captureLogger();
    const store = new FileTeamStore({
      dataDir,
      tenantId: 'default',
      durable: false,
      logger: capture.logger,
    });
    const team = await store.ensureForWorkspace({ workspace: join(dataDir, 'logs', 'alpha') });

    await store.appendLog(logEntry('m1', team.team_id));
    await store.appendLog(logEntry('m2', team.team_id));
    await store.appendLog(logEntry('m3', team.team_id));
    await store.flush();
    expect((await store.readLog(team.team_id)).map((entry) => entry.message_id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);

    const path = teamLogPath(dataDir, 'default', team.team_id);
    await appendFile(path, 'not json\n');
    await appendFile(path, '{"message_id":"m4","team_id"');

    const read = await store.readLog(team.team_id);
    expect(read.map((entry) => entry.message_id)).toEqual(['m1', 'm2', 'm3']);
    expect(capture.warnings).toContain('team.log.invalid_line');

    expect(
      (await store.readLog(team.team_id, { limit: 2 })).map((entry) => entry.message_id),
    ).toEqual(['m2', 'm3']);
    expect(await store.readLog(team.team_id, { limit: 0 })).toEqual([]);
    expect((await store.readLog(team.team_id, { limit: 1000 })).length).toBe(3);
  });

  it('repairs a half line before the first append', async () => {
    const dataDir = await tempDir();
    const team = await new FileTeamStore({
      dataDir,
      tenantId: 'default',
      durable: false,
    }).ensureForWorkspace({ workspace: join(dataDir, 'heal', 'alpha') });

    const path = teamLogPath(dataDir, 'default', team.team_id);
    await writeFile(path, `${JSON.stringify(logEntry('old', team.team_id))}\n{"message_id":"half`);

    // 新实例：首次 append 前先截断崩溃残留半行
    const reopened = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await reopened.ready();
    await reopened.appendLog(logEntry('new', team.team_id));
    await reopened.flush();

    expect((await reopened.readLog(team.team_id)).map((entry) => entry.message_id)).toEqual([
      'old',
      'new',
    ]);
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).not.toContain('half');
  });
});
