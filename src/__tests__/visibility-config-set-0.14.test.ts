import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseArgs } from '../cli-args';
import { configSetCommand } from '../config-command';

describe('0.14 visibility config set', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-visibility-set-'));
    configPath = path.join(dir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses new keys and rejects bad values', () => {
    expect(parseArgs(['config', 'set', 'ui.errorLevel', 'all']).ok).toBe(true);
    expect(parseArgs(['config', 'set', 'ui.showInternalEvents', 'true']).ok).toBe(true);
    expect(parseArgs(['config', 'set', 'ui.verbosity', 'debug']).ok).toBe(true);
    expect(parseArgs(['config', 'set', 'observability.showProcessErrors', 'false']).ok).toBe(true);
    expect(parseArgs(['config', 'set', 'ui.errorLevel', 'diagnostic']).ok).toBe(false);
    expect(parseArgs(['config', 'set', 'ui.verbosity', 'verbose']).ok).toBe(false);
    expect(parseArgs(['config', 'set', 'ui.showInternalEvents', 'yes']).ok).toBe(false);
  });

  it('writes YAML snake_case and preserves other keys', async () => {
    fs.writeFileSync(configPath, 'api_key: sk-test\nui:\n  language: en\n', 'utf-8');

    expect(
      (await configSetCommand('ui.errorLevel', 'all', { userConfigPath: configPath })).exitCode,
    ).toBe(0);
    expect(
      (await configSetCommand('ui.showInternalEvents', 'true', { userConfigPath: configPath }))
        .exitCode,
    ).toBe(0);
    expect(
      (await configSetCommand('ui.verbosity', 'minimal', { userConfigPath: configPath })).exitCode,
    ).toBe(0);
    expect(
      (
        await configSetCommand('observability.showProcessErrors', 'true', {
          userConfigPath: configPath,
        })
      ).exitCode,
    ).toBe(0);

    const root = parseYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(root.api_key).toBe('sk-test');
    expect(root.ui).toEqual({
      language: 'en',
      error_level: 'all',
      show_internal_events: true,
      verbosity: 'minimal',
    });
    expect(root.observability).toEqual({ show_process_errors: true });
  });

  it('rejects invalid values without writing', async () => {
    const bad = await configSetCommand('ui.errorLevel', 'diagnostic', {
      userConfigPath: configPath,
    });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('ui.errorLevel');
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
