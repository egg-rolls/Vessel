import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import { createRunEngine, type RunEngine } from '../src/run-engine';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vessel-interactions-'));
  tempDirs.push(dir);
  return dir;
}

function setup(interactionsDir?: string) {
  const events = new MemoryEventStream();
  const engine = createRunEngine({
    tenantEventsFor: () => events,
    defaultTenantId: 'default',
    ...(interactionsDir !== undefined ? { interactionsDir } : {}),
  });
  const seen: RunEvent[] = [];
  events.subscribe((event) => {
    seen.push(event);
  });
  return { events, engine, seen };
}

function requestPermission(
  engine: RunEngine,
  overrides: Record<string, unknown> = {},
  ts = Date.now(),
): void {
  engine.handleEvent({
    type: 'tool.permission.request',
    run_id: 'run-1',
    ts,
    data: {
      requestId: 'perm-1',
      tool: 'bash',
      input: { cmd: 'ls' },
      session_id: 'session-1',
      tool_call_id: 'call-1',
      source: 'runtime',
      ...overrides,
    },
  });
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function storePath(dir: string, tenant = 'default'): string {
  return join(dir, `interactions-${tenant}.json`);
}

interface StoreFile {
  version: number;
  interactions: Array<Record<string, unknown>>;
}

function readStore(dir: string, tenant = 'default'): StoreFile | null {
  const path = storePath(dir, tenant);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
}

async function waitForStore(
  dir: string,
  predicate: (file: StoreFile | null) => boolean,
): Promise<StoreFile | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const file = readStore(dir);
    if (predicate(file)) return file;
    await Bun.sleep(10);
  }
  return readStore(dir);
}

describe('run engine permission lifecycle', () => {
  it('captures session / tool_call / source and keeps deadline_at only as metadata', () => {
    const { engine } = setup();
    const ts = Date.now();
    requestPermission(engine, { deadline_at: ts + 1 }, ts);
    expect(engine.pendingPermissions.get('perm-1')).toMatchObject({
      run_id: 'run-1',
      tenant_id: 'default',
      tool: 'bash',
      session_id: 'session-1',
      tool_call_id: 'call-1',
      source: 'runtime',
      deadline_at: ts + 1,
    });
  });

  it('keeps pending permissions until an answer or a terminal run event (Addendum A)', () => {
    const { engine, seen } = setup();
    const now = Date.now();
    requestPermission(engine, { deadline_at: now + 1 }, now);

    // 0.18：没有 TTL / sweep，时间流逝与 deadline_at 都不淘汰 pending。
    expect(engine.pendingPermissions.has('perm-1')).toBe(true);
    expect(seen.some((event) => event.type === 'tool.permission.expired')).toBe(false);

    const result = engine.respondPermission('perm-1', 'allow', false, undefined, 'once');
    expect(result).toEqual({ ok: true, decision: 'allow', scope: 'once' });
  });

  it('treats a repeated response as idempotent and rejects a conflicting decision', () => {
    const { engine, seen } = setup();
    requestPermission(engine);

    const first = engine.respondPermission('perm-1', 'allow', false, undefined, 'session');
    expect(first).toEqual({ ok: true, decision: 'allow', scope: 'session' });
    expect(engine.pendingPermissions.has('perm-1')).toBe(false);

    const responses = () => seen.filter((event) => event.type === 'tool.permission.response');
    expect(responses()).toHaveLength(1);
    expect(responses()[0]?.data).toMatchObject({
      requestId: 'perm-1',
      decision: 'allow',
      scope: 'session',
      session_id: 'session-1',
    });

    const repeat = engine.respondPermission('perm-1', 'allow', false);
    expect(repeat).toEqual({ ok: true, decision: 'allow', scope: 'session', duplicate: true });
    expect(responses()).toHaveLength(1);

    expect(codeOf(() => engine.respondPermission('perm-1', 'deny', false))).toBe('conflict');
  });

  it('maps remember:true to always for old clients', () => {
    const { engine, seen } = setup();
    requestPermission(engine);
    const result = engine.respondPermission('perm-1', 'allow', true);
    expect(result.scope).toBe('always');
    const response = seen.find((event) => event.type === 'tool.permission.response');
    expect(response?.data).toMatchObject({ remember: true, scope: 'always' });
  });

  it('clears pending permissions on every terminal run event and returns run_ended', () => {
    for (const type of ['run.completed', 'run.failed', 'run.cancelled'] as const) {
      const { engine } = setup();
      requestPermission(engine, { requestId: `${type}-perm` });
      engine.handleEvent({ type, run_id: 'run-1', ts: Date.now(), data: {} });
      expect(engine.pendingPermissions.size).toBe(0);
      expect(codeOf(() => engine.respondPermission(`${type}-perm`, 'allow', false))).toBe(
        'run_ended',
      );
      expect(engine.interactionRecords.get(`${type}-perm`)?.status).toBe('orphaned');
    }
  });

  it('scopes an answer to the tenant that created the request', () => {
    const { engine } = setup();
    requestPermission(engine);
    expect(codeOf(() => engine.respondPermission('perm-1', 'allow', false, 'other'))).toBe(
      'not_found',
    );
    expect(engine.pendingPermissions.has('perm-1')).toBe(true);
  });

  it('does not publish response events twice under concurrent duplicate submits', () => {
    const { engine, seen } = setup();
    requestPermission(engine);
    engine.respondPermission('perm-1', 'allow', false);
    engine.respondPermission('perm-1', 'allow', false);
    expect(seen.filter((event) => event.type === 'tool.permission.response')).toHaveLength(1);
  });
});

describe('interaction persistence (Addendum A)', () => {
  it('persists pending, rewrites on terminal, and reports orphaned after reload', async () => {
    const dir = makeDir();
    const first = setup(dir);
    requestPermission(first.engine, {}, 1_000);

    const pendingFile = await waitForStore(
      dir,
      (file) => file?.interactions.some((item) => item.status === 'pending') === true,
    );
    expect(pendingFile?.interactions[0]).toMatchObject({
      requestId: 'perm-1',
      run_id: 'run-1',
      tenant_id: 'default',
      session_id: 'session-1',
      tool_call_id: 'call-1',
      tool: 'bash',
      status: 'pending',
    });

    // 进程重启：新 engine 加载同一目录，旧 pending 没有对应 run → orphaned。
    const second = setup(dir);
    expect(second.engine.pendingPermissions.size).toBe(0);
    expect(second.engine.interactionRecords.get('perm-1')?.status).toBe('orphaned');
    expect(codeOf(() => second.engine.respondPermission('perm-1', 'allow', false))).toBe(
      'run_ended',
    );

    const orphanedFile = await waitForStore(
      dir,
      (file) => file?.interactions[0]?.status === 'orphaned',
    );
    expect(orphanedFile?.interactions[0]?.status).toBe('orphaned');
  });

  it('persists answered results so a reload is still idempotent', async () => {
    const dir = makeDir();
    const first = setup(dir);
    requestPermission(first.engine, {}, 2_000);
    first.engine.respondPermission('perm-1', 'allow', false, undefined, 'always');

    const answeredFile = await waitForStore(
      dir,
      (file) => file?.interactions[0]?.status === 'answered',
    );
    expect(answeredFile?.interactions[0]?.answer).toMatchObject({
      decision: 'allow',
      scope: 'always',
    });

    const second = setup(dir);
    const repeat = second.engine.respondPermission('perm-1', 'allow', false);
    expect(repeat).toEqual({ ok: true, decision: 'allow', scope: 'always', duplicate: true });
    expect(codeOf(() => second.engine.respondPermission('perm-1', 'deny', false))).toBe('conflict');
  });

  it('writes 0600 files on POSIX', async () => {
    if (process.platform === 'win32') return;
    const dir = makeDir();
    const { engine } = setup(dir);
    requestPermission(engine);
    await waitForStore(dir, (file) => file !== null);
    expect(statSync(storePath(dir)).mode & 0o777).toBe(0o600);
  });

  it('removes pending records from disk when the run reaches a terminal state', async () => {
    const dir = makeDir();
    const { engine } = setup(dir);
    requestPermission(engine);
    await waitForStore(dir, (file) => file?.interactions[0]?.status === 'pending');

    engine.handleEvent({ type: 'run.cancelled', run_id: 'run-1', ts: Date.now(), data: {} });
    const file = await waitForStore(dir, (item) => item?.interactions[0]?.status === 'orphaned');
    expect(file?.interactions[0]?.status).toBe('orphaned');
    expect(file?.interactions.some((item) => item.status === 'pending')).toBe(false);
  });
});
