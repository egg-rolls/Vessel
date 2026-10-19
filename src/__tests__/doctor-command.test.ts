import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { doctorCommand } from '../doctor-command';

describe('doctor-command（0.6.1 P2）', () => {
  let root: string;
  let configPath: string;
  let dataDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-doctor-'));
    configPath = path.join(root, 'vessel.yaml');
    dataDir = path.join(root, 'data');
    fs.writeFileSync(
      configPath,
      [
        `data_dir: ${JSON.stringify(dataDir)}`,
        'provider:',
        '  name: openai',
        '  model: gpt-4',
        'permission:',
        '  auto_approve:',
        '    - bash',
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function options() {
    return {
      json: false,
      configPath,
      userConfigPath: path.join(root, 'missing-user.yaml'),
      env: { VESSEL_API_KEY: 'sk-test' },
    };
  }

  it('正常配置 exit 0，并覆盖 provider/data_dir/session/plugins', async () => {
    const result = await doctorCommand(options());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Vessel doctor');
    expect(result.stdout).toContain('provider: openai / gpt-4 / api key <set>');
    expect(result.stdout).toContain(`data_dir: ${dataDir}`);
    expect(result.stdout).toContain('session: backend=file');
    expect(result.stdout).toContain('plugins:');
    expect(result.stdout).toContain('0 failure(s)');
  });

  it('JSON 输出包含 checks 与 summary', async () => {
    const result = await doctorCommand({ ...options(), json: true });
    const parsed = JSON.parse(result.stdout) as {
      version: string;
      checks: Array<{ name: string; status: string; message: string }>;
      summary: { ok: number; warn: number; fail: number };
    };
    expect(parsed.version).toBeTruthy();
    expect(parsed.checks.some((check) => check.name === 'provider')).toBe(true);
    expect(parsed.summary.fail).toBe(0);
  });

  it('缺少 API Key 时 fail（exit 1）', async () => {
    fs.writeFileSync(
      configPath,
      [
        'provider:',
        '  name: openai',
        '  model: gpt-4',
        `data_dir: ${JSON.stringify(dataDir)}`,
      ].join('\n'),
      'utf-8',
    );
    const result = await doctorCommand({ ...options(), env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('api key <unset>');
  });

  it('配置未知键时 config 检查 fail', async () => {
    fs.writeFileSync(
      configPath,
      ['provider:', '  name: openai', '  model: gpt-4', 'bogus_key: 1'].join('\n'),
      'utf-8',
    );
    const result = await doctorCommand(options());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/\[fail\]\s+config:/);
  });
});
