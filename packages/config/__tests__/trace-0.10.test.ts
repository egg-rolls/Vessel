/**
 * 0.10 R2-14：trace.includeStreamChunks（类型 / 默认值 / validator）。
 */
import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_TRACE_OPTIONS, loadConfig, type VesselConfig, validateConfig } from '../src/index';

describe('trace.includeStreamChunks', () => {
  it('默认 false，未知键检查接受该键', () => {
    expect(DEFAULT_TRACE_OPTIONS.includeStreamChunks).toBe(false);

    const result = validateConfig({ trace: { includeStreamChunks: true } });
    expect(result.errors).toEqual([]);
  });

  it('非布尔值 → validation error', () => {
    const result = validateConfig({
      trace: { includeStreamChunks: 'yes' },
    } as unknown as VesselConfig);
    expect(result.errors.some((error) => error.path === 'trace.includeStreamChunks')).toBe(true);
  });

  it('YAML 配置可加载并保留 true/false', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-trace-config-'));
    try {
      const configPath = path.join(dir, 'vessel.yaml');
      fs.writeFileSync(
        configPath,
        'trace:\n  enabled: true\n  level: full\n  includeStreamChunks: true\n',
        'utf-8',
      );
      const loaded = await loadConfig({ configPath });
      expect(loaded.validation.errors).toEqual([]);
      expect(loaded.config.trace?.includeStreamChunks).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
