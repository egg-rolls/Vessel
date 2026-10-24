import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractionsStore, type StoredInteraction } from '../src/interactions-store';

const CORRUPT_PREFIX = 'interactions-default.json.corrupt-';

function validRecord(overrides: Partial<StoredInteraction> = {}): StoredInteraction {
  return {
    requestId: 'req-1',
    run_id: 'run-1',
    tenant_id: 'default',
    tool: 'bash',
    input: { command: 'ls' },
    created_at: 1_700_000_000_000,
    status: 'answered',
    ...overrides,
  };
}

function quarantineFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(CORRUPT_PREFIX));
}

describe('InteractionsStore.loadAllSync quarantine', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vessel-interactions-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadAllSync quarantines a corrupt interactions file instead of letting the next save overwrite it', async () => {
    const corrupt = '{"version":1,"interactions":[{"requestId":';
    const originalPath = join(dir, 'interactions-default.json');
    writeFileSync(originalPath, corrupt);

    const store = new InteractionsStore(dir);
    expect(store.loadAllSync()).toEqual([]);
    expect(existsSync(originalPath)).toBe(false);

    const quarantined = quarantineFiles(dir);
    expect(quarantined.length).toBe(1);
    const quarantinePath = join(dir, quarantined[0] as string);
    expect(readFileSync(quarantinePath).equals(Buffer.from(corrupt))).toBe(true);

    const record = validRecord();
    await store.save('default', [record]);

    const saved = JSON.parse(readFileSync(originalPath, 'utf8')) as {
      interactions: StoredInteraction[];
    };
    expect(saved.interactions).toEqual([record]);
    expect(readFileSync(quarantinePath).equals(Buffer.from(corrupt))).toBe(true);
  });

  it('loadAllSync keeps valid records but quarantines a file containing an invalid record', () => {
    const good1 = validRecord({ requestId: 'good-1' });
    const bad = {
      requestId: 'bad',
      run_id: 'run-2',
      tenant_id: 'default',
      tool: 'bash',
      input: {},
      created_at: 'x',
      status: 'weird',
    };
    const good2 = validRecord({ requestId: 'good-2' });
    const raw = `${JSON.stringify({ version: 1, interactions: [good1, bad, good2] }, null, 2)}\n`;
    const originalPath = join(dir, 'interactions-default.json');
    writeFileSync(originalPath, raw);

    const store = new InteractionsStore(dir);
    const loaded = store.loadAllSync();
    expect(loaded.map((record) => record.requestId)).toEqual(['good-1', 'good-2']);

    const quarantined = quarantineFiles(dir);
    expect(quarantined.length).toBe(1);
    expect(readFileSync(join(dir, quarantined[0] as string), 'utf8')).toBe(raw);
    expect(existsSync(originalPath)).toBe(false);

    // 已隔离后再次加载不会再隔离（原路径已不存在）。
    expect(store.loadAllSync()).toEqual([]);
    expect(quarantineFiles(dir).length).toBe(1);
  });
});
