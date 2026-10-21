/**
 * 0.15 per-instance interactions：同 dataDir 的命名实例不得共用文件。
 *
 * 故障形态：两个 gateway 实例互相覆盖 `interactions-<tenant>.json`，
 * pending 记录被对方当成 orphaned 或串租户丢失。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureInteractionsDir, resolveInteractionsDir } from '../interactions-dir';

const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vessel-interactions-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  dirs.length = 0;
});

describe('interactions dir per gateway instance', () => {
  it('default keeps the legacy dataDir path', () => {
    const dataDir = tempDataDir();
    expect(resolveInteractionsDir(dataDir, undefined)).toBe(dataDir);
    expect(resolveInteractionsDir(dataDir, 'default')).toBe(dataDir);
    expect(ensureInteractionsDir(dataDir, 'default')).toBe(dataDir);
  });

  it('named instances use separate directories that do not exist yet', () => {
    const dataDir = tempDataDir();
    const web = ensureInteractionsDir(dataDir, 'web');
    const bot = ensureInteractionsDir(dataDir, 'bot');
    expect(web).toBe(join(dataDir, 'instances', 'web'));
    expect(bot).toBe(join(dataDir, 'instances', 'bot'));
    expect(existsSync(web)).toBe(true);
    expect(existsSync(bot)).toBe(true);
    expect(web).not.toBe(bot);
  });

  it('two instances write the same tenant file name without overwriting', () => {
    const dataDir = tempDataDir();
    const web = ensureInteractionsDir(dataDir, 'web');
    const bot = ensureInteractionsDir(dataDir, 'bot');
    writeFileSync(join(web, 'interactions-default.json'), '{"version":1,"interactions":["web"]}');
    writeFileSync(join(bot, 'interactions-default.json'), '{"version":1,"interactions":["bot"]}');
    expect(readFileSync(join(web, 'interactions-default.json'), 'utf8')).toContain('web');
    expect(readFileSync(join(bot, 'interactions-default.json'), 'utf8')).toContain('bot');
  });
});
