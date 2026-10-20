/**
 * 0.10 R1：provider key / 未知 provider / config init / 错误输出（DECISION-020 §R1.2–§R1.7）。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../../packages/config/src/index';
import {
  MemoryLLMProvider,
  OpenAICompatibleProvider,
  type Plugin,
  type PluginHost,
} from '../../packages/core/src/index';
import { configInitCommand, configShowCommand, USER_CONFIG_TEMPLATE } from '../config-command';
import {
  createProvider,
  ProviderConfigError,
  resetUnknownProviderNotice,
} from '../provider-factory';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-hardening-src-'));
}

function missingPath(): string {
  return path.join(tmpDir(), 'does-not-exist.yaml');
}

describe('未知 provider fail-fast', () => {
  afterEach(() => {
    resetUnknownProviderNotice();
  });

  it('未注册且无 base_url → ProviderConfigError', async () => {
    const loader = { getProviders: () => [] as string[], load: async () => null };
    await expect(
      createProvider({ provider: { name: 'not-a-provider', model: 'test-model' } }, loader, false),
    ).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it('未注册但有 base_url → OpenAI 兼容，stderr info 只打一次', async () => {
    resetUnknownProviderNotice();
    const loader = { getProviders: () => [] as string[], load: async () => null };
    const config = {
      provider: {
        name: 'not-a-provider',
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:1/v1',
      },
    };

    const writes: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const first = await createProvider(config, loader, false);
      const second = await createProvider(config, loader, false);

      expect(first.provider).toBeInstanceOf(OpenAICompatibleProvider);
      expect(second.provider).toBeInstanceOf(OpenAICompatibleProvider);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain('not registered; using OpenAI-compatible endpoint');
      expect(writes[0]).toContain('http://127.0.0.1:1/v1');
    } finally {
      process.stderr.write = original;
    }
  });
});

describe('provider key 生效', () => {
  function capturingLoader() {
    const captured: Array<Record<string, unknown>> = [];
    const plugin: Plugin = {
      name: 'fake',
      install(host: PluginHost) {
        host.registerProvider('fake', (config) => {
          captured.push(config);
          return new MemoryLLMProvider();
        });
      },
    };
    const loader = {
      getProviders: () => ['fake'],
      load: async () => plugin,
    };
    return { loader, captured };
  }

  it('provider.apiKey 优先于顶层 apiKey', async () => {
    const { loader, captured } = capturingLoader();
    await createProvider(
      {
        apiKey: 'top-level-key',
        provider: { name: 'fake', model: 'test-model', apiKey: 'provider-key' },
      },
      loader,
      false,
    );
    expect(captured[0]?.api_key).toBe('provider-key');
  });

  it('provider.apiKeyEnv 优先于顶层 apiKey', async () => {
    const key = 'vessel-hardening-provider-key';
    const previous = process.env[key];
    process.env[key] = 'from-provider-env';
    try {
      const { loader, captured } = capturingLoader();
      await createProvider(
        {
          apiKey: 'top-level-key',
          provider: { name: 'fake', model: 'test-model', apiKeyEnv: key },
        },
        loader,
        false,
      );
      expect(captured[0]?.api_key).toBe('from-provider-env');
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

describe('config init 可启动', () => {
  it('模板不写生效的 api_key_env，加载零错误，并输出下一步', async () => {
    const dir = tmpDir();
    const target = path.join(dir, 'config.yaml');

    const result = await configInitCommand({ userConfigPath: target });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('next:');
    expect(result.stdout).toContain('vessel doctor');

    // 注释形式才允许出现。
    const activeKeyEnv = USER_CONFIG_TEMPLATE.split('\n').some(
      (line) => line.trim().startsWith('api_key_env:') && !line.trim().startsWith('#'),
    );
    expect(activeKeyEnv).toBe(false);

    const loaded = await loadConfig({
      userConfigPath: target,
      configPath: missingPath(),
      env: {},
    });
    expect(loaded.validation.errors).toEqual([]);
    expect(loaded.validation.valid).toBe(true);
  });
});

describe('config show --json 错误形状', () => {
  it('校验失败时 stdout 输出 {errors:[{path,message}]}', async () => {
    const dir = tmpDir();
    const userConfigPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(userConfigPath, 'bogus_key: 1\n', 'utf-8');

    const result = await configShowCommand({
      json: true,
      userConfigPath,
      configPath: missingPath(),
      env: {},
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      errors: Array<{ path: string; message: string }>;
    };
    expect(parsed.errors.some((error) => error.path === 'bogusKey')).toBe(true);
    expect(parsed.errors[0]?.message).toContain('Unknown configuration key');
    // 可读文本仍在 stderr。
    expect(result.stderr).toContain('bogusKey');
    expect(result.stderr).toContain('vessel doctor');
  });
});
