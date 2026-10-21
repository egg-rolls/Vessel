/**
 * 0.15 delegate 嵌套配置：allow_nested / max_descendants 的 YAML 映射与校验。
 *
 * 故障形态：拼错或不认识的键被静默忽略，或非法后代上限进入插件。
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/index';

function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-delegate-cfg-'));
  const file = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function missingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-delegate-missing-'));
  return path.join(dir, 'does-not-exist.yaml');
}

describe('delegate nested config', () => {
  it('maps snake_case keys and accepts valid values', async () => {
    const { config, validation } = await loadConfig({
      configPath: tmpYaml('delegate:\n  allow_nested: true\n  max_descendants: 8\n'),
      userConfigPath: missingPath(),
      env: {},
    });
    expect(config.delegate?.allowNested).toBe(true);
    expect(config.delegate?.maxDescendants).toBe(8);
    expect(validation.errors).toEqual([]);
  });

  it('rejects non-positive or non-integer max_descendants', async () => {
    for (const value of ['0', '-1', '1.5', 'many']) {
      const { validation } = await loadConfig({
        configPath: tmpYaml(`delegate:\n  max_descendants: ${value}\n`),
        userConfigPath: missingPath(),
        env: {},
      });
      expect(validation.errors.some((error) => error.path === 'delegate.maxDescendants')).toBe(
        true,
      );
    }
  });

  it('rejects non-boolean allow_nested', async () => {
    const { validation } = await loadConfig({
      configPath: tmpYaml('delegate:\n  allow_nested: maybe\n'),
      userConfigPath: missingPath(),
      env: {},
    });
    expect(validation.errors.some((error) => error.path === 'delegate.allowNested')).toBe(true);
  });
});
