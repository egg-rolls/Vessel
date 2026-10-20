import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/loader';

function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-ui-'));
  const file = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

describe('ui 配置', () => {
  it('配置文件含 ui.language 时不被当作未知键拒绝', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-ui-'));
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  language: en\n'),
      userConfigPath: path.join(dir, 'missing.yaml'),
      env: {},
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.config.ui?.language).toBe('en');
  });
});
