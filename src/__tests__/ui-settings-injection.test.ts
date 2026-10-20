import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type BootstrapResult, bootstrap } from '../bootstrap';
import type { RpcClient } from '../rpc/index';
import type { ReplSettingsControlLike } from '../ui-settings';

const dirs: string[] = [];
const results: BootstrapResult[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VESSEL_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

afterEach(async () => {
  for (const result of results.splice(0)) {
    await result.shutdown();
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-ui-inject-'));
  dirs.push(dir);
  return dir;
}

function writeUserConfig(content: string): string {
  const file = path.join(tempDir(), 'config.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function readRoot(configPath: string): Record<string, unknown> {
  return parseYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
}

/** tui 合并前 ReplContext 尚未声明 settings；按 DECISION-021 §3.2 结构读取。 */
function settingsOf(result: BootstrapResult): ReplSettingsControlLike | undefined {
  return (result.ctx as BootstrapResult['ctx'] & { settings?: ReplSettingsControlLike }).settings;
}

describe('bootstrap settings 注入（0.11）', () => {
  it('本地模式注入 settings，language 跟随 config.ui.language，setLanguage 写用户配置', async () => {
    const userConfigPath = writeUserConfig(
      'api_key: sk-test\nui:\n  language: en\n  clear_on_start: false\n',
    );
    const result = await bootstrap({
      useMock: true,
      headless: true,
      dataDir: path.join(tempDir(), 'data'),
      configPath: path.join(tempDir(), 'missing.yaml'),
      userConfigPath,
    });
    results.push(result);

    expect(settingsOf(result)?.language).toBe('en');
    await settingsOf(result)?.setLanguage('zh-CN');

    const root = readRoot(userConfigPath);
    expect(root.api_key).toBe('sk-test');
    expect(root.ui).toEqual({ clear_on_start: false, language: 'zh-CN' });
  });

  it('connect 模式也注入 settings 并写本地用户配置', async () => {
    const userConfigPath = writeUserConfig('ui:\n  language: zh-CN\n');
    const client: RpcClient & { close(): Promise<void> } = {
      request: async <T = unknown>(method: string): Promise<T> =>
        (method === 'health.get'
          ? { tenant_id: 'default', node: { node_id: 'remote-1' } }
          : {}) as T,
      subscribe: () => () => {},
      close: async () => {},
    };

    const result = await bootstrap({
      useMock: true,
      headless: true,
      connect: 'http://127.0.0.1:1',
      connectToken: 'connect-token',
      dataDir: path.join(tempDir(), 'data'),
      configPath: path.join(tempDir(), 'missing.yaml'),
      userConfigPath,
      rpcClientFactory: () => client,
    });
    results.push(result);

    expect(settingsOf(result)?.language).toBe('zh-CN');
    await settingsOf(result)?.setLanguage('en');
    expect(readRoot(userConfigPath).ui).toEqual({ language: 'en' });
  });

  it('本地模式注入 statusBars，setStatusBars 写 ui.status_bars（0.13）', async () => {
    const userConfigPath = writeUserConfig('ui:\n  status_bars: bottom\n');
    const result = await bootstrap({
      useMock: true,
      headless: true,
      dataDir: path.join(tempDir(), 'data'),
      configPath: path.join(tempDir(), 'missing.yaml'),
      userConfigPath,
    });
    results.push(result);

    expect(settingsOf(result)?.statusBars).toBe('bottom');
    await settingsOf(result)?.setStatusBars('both');

    const root = readRoot(userConfigPath);
    expect(root.ui).toEqual({ status_bars: 'both' });
  });

  it('connect 模式也注入 statusBars 并写本地用户配置（0.13）', async () => {
    const userConfigPath = writeUserConfig('ui:\n  status_bars: top\n');
    const client: RpcClient & { close(): Promise<void> } = {
      request: async <T = unknown>(method: string): Promise<T> =>
        (method === 'health.get'
          ? { tenant_id: 'default', node: { node_id: 'remote-1' } }
          : {}) as T,
      subscribe: () => () => {},
      close: async () => {},
    };

    const result = await bootstrap({
      useMock: true,
      headless: true,
      connect: 'http://127.0.0.1:1',
      connectToken: 'connect-token',
      dataDir: path.join(tempDir(), 'data'),
      configPath: path.join(tempDir(), 'missing.yaml'),
      userConfigPath,
      rpcClientFactory: () => client,
    });
    results.push(result);

    expect(settingsOf(result)?.statusBars).toBe('top');
    await settingsOf(result)?.setStatusBars('none');
    expect(readRoot(userConfigPath).ui).toEqual({ status_bars: 'none' });
  });

  it('VESSEL_LANG 优先于 config.ui.language', async () => {
    process.env.VESSEL_LANG = 'en-US';
    const result = await bootstrap({
      useMock: true,
      headless: true,
      dataDir: path.join(tempDir(), 'data'),
      configPath: path.join(tempDir(), 'missing.yaml'),
      userConfigPath: writeUserConfig('ui:\n  language: zh-CN\n'),
    });
    results.push(result);

    expect(settingsOf(result)?.language).toBe('en');
  });
});
