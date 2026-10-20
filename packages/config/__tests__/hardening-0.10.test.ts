/**
 * 0.10 R1：配置加载硬化（DECISION-020 §R1.2–§R1.4）。
 *
 * - resolveEffectiveApiKey 优先级；
 * - YAML 解析错误 / 重复键上抛为带文件路径的 validation error；
 * - legacy 与新版 provider: 的合并规则与 deprecation warning；
 * - 不提供默认 context.maxMessages（由 core 按 maxTokens 推导）；
 * - redactSourcePaths 不泄露 token 原文。
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildConfigSnapshot,
  loadConfig,
  redactSourcePaths,
  resolveEffectiveApiKey,
  type VesselConfig,
} from '../src/index';

function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-hardening-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function missingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-hardening-missing-'));
  return path.join(dir, 'does-not-exist.yaml');
}

describe('resolveEffectiveApiKey', () => {
  const env = {
    PROVIDER_KEY: 'provider-env-key',
    TOP_KEY: 'top-env-key',
  };

  it('provider.apiKey 优先于其它来源', () => {
    const config: VesselConfig = {
      apiKey: 'top-key',
      apiKeyEnv: 'TOP_KEY',
      provider: { name: 'openai', apiKey: 'provider-key', apiKeyEnv: 'PROVIDER_KEY' },
    };
    expect(resolveEffectiveApiKey(config, env)).toBe('provider-key');
  });

  it('provider.apiKeyEnv 优先于顶层 apiKey', () => {
    const config: VesselConfig = {
      apiKey: 'top-key',
      provider: { name: 'openai', apiKeyEnv: 'PROVIDER_KEY' },
    };
    expect(resolveEffectiveApiKey(config, env)).toBe('provider-env-key');
  });

  it('顶层 apiKey 优先于顶层 apiKeyEnv', () => {
    const config: VesselConfig = {
      apiKey: 'top-key',
      apiKeyEnv: 'TOP_KEY',
    };
    expect(resolveEffectiveApiKey(config, env)).toBe('top-key');
  });

  it('仅有 apiKeyEnv 时解析环境变量', () => {
    expect(resolveEffectiveApiKey({ apiKeyEnv: 'TOP_KEY' }, env)).toBe('top-env-key');
  });

  it('空串 / 缺失变量视为未设置', () => {
    const config: VesselConfig = {
      apiKey: '   ',
      apiKeyEnv: 'MISSING',
      provider: { name: 'openai', apiKeyEnv: 'ALSO_MISSING' },
    };
    expect(resolveEffectiveApiKey(config, env)).toBeUndefined();
  });
});

describe('YAML 错误上抛', () => {
  it('解析失败 → validation error（带文件路径与行号），不静默回落', async () => {
    const userConfigPath = tmpYaml('provider:\n  name: [unclosed\n');
    const result = await loadConfig({ userConfigPath, configPath: missingPath(), env: {} });

    expect(result.validation.valid).toBe(false);
    const error = result.validation.errors.find((item) => item.path === userConfigPath);
    expect(error).toBeDefined();
    expect(error?.message).toContain('YAML parse error');
    expect(error?.message).toMatch(/line \d+/);
    // 不把坏文件当成空配置继续：provider 保持默认（openai），但必须报错。
    expect(result.config.provider?.name).toBe('openai');
  });

  it('重复键 → validation error', async () => {
    const userConfigPath = tmpYaml('provider:\n  name: openai\n  name: anthropic\n');
    const result = await loadConfig({ userConfigPath, configPath: missingPath(), env: {} });

    expect(result.validation.valid).toBe(false);
    const error = result.validation.errors.find((item) => item.path === userConfigPath);
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/unique/i);
  });

  it('项目文件解析失败同样报错', async () => {
    const configPath = tmpYaml('tenant: [\n');
    const result = await loadConfig({ userConfigPath: missingPath(), configPath, env: {} });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((item) => item.path === configPath)).toBe(true);
  });

  it('文件不存在仍按缺省处理（只吞 ENOENT）', async () => {
    const result = await loadConfig({
      userConfigPath: missingPath(),
      configPath: missingPath(),
      env: {},
    });
    expect(result.validation.valid).toBe(true);
    expect(result.validation.errors).toEqual([]);
  });
});

describe('legacy provider 合并', () => {
  it('同层新版 provider: 优先，legacy 被忽略并 warning', async () => {
    const userConfigPath = tmpYaml(
      [
        'default_provider: legacy',
        'default_model: legacy-model',
        'providers:',
        '  legacy:',
        '    base_url: http://legacy.example/v1',
        'provider:',
        '  name: openai',
        '  model: gpt-4o',
        '',
      ].join('\n'),
    );
    const result = await loadConfig({ userConfigPath, configPath: missingPath(), env: {} });

    expect(result.config.provider).toMatchObject({ name: 'openai', model: 'gpt-4o' });
    expect(result.config.provider?.baseUrl).toBeUndefined();
    expect(result.validation.warnings).toHaveLength(1);
    expect(result.validation.warnings[0]?.message).toContain('ignored');
    expect(result.validation.warnings[0]?.message).toContain('default_provider');
  });

  it('仅 legacy → 映射并 warning（deprecated）', async () => {
    const userConfigPath = tmpYaml(
      [
        'api_key: sk-test',
        'default_provider: custom',
        'default_model: custom-model',
        'providers:',
        '  custom:',
        '    base_url: http://custom.example/v1',
        '',
      ].join('\n'),
    );
    const result = await loadConfig({ userConfigPath, configPath: missingPath(), env: {} });

    expect(result.config.provider).toMatchObject({
      name: 'custom',
      model: 'custom-model',
      baseUrl: 'http://custom.example/v1',
    });
    expect(result.validation.valid).toBe(true);
    expect(result.validation.warnings).toHaveLength(1);
    expect(result.validation.warnings[0]?.message).toContain('deprecated');
  });

  it('无 legacy 键 → 无 warning', async () => {
    const userConfigPath = tmpYaml('provider:\n  name: openai\n  model: gpt-4o\n');
    const result = await loadConfig({ userConfigPath, configPath: missingPath(), env: {} });

    expect(result.validation.warnings).toEqual([]);
  });
});

describe('redactSourcePaths', () => {
  it('serve.tokens / *.apiKey / *.token 显示 <set>，且不含 token 原文', () => {
    const sources = {
      'serve.tokens.tok-secret.tenantId': 'user',
      'serve.tokens.tok-secret.role': 'user',
      'serve.tokens.tok-two.tenantId': 'project',
      'provider.apiKey': 'env',
      'serve.token': 'user',
      'transport.token': 'project',
      'provider.model': 'user',
    } as const;

    const redacted = redactSourcePaths(sources);

    expect(JSON.stringify(redacted)).not.toContain('tok-secret');
    expect(JSON.stringify(redacted)).not.toContain('tok-two');
    expect(redacted['serve.tokens.<set>.tenantId']).toBe('<set>');
    expect(redacted['serve.tokens.<set#2>.tenantId']).toBe('<set>');
    expect(redacted['provider.apiKey']).toBe('<set>');
    expect(redacted['serve.token']).toBe('<set>');
    expect(redacted['transport.token']).toBe('<set>');
    expect(redacted['provider.model']).toBe('user');
  });

  it('buildConfigSnapshot 内嵌的 sources 同样脱敏', () => {
    const snapshot = buildConfigSnapshot({
      config: {
        serve: { tokens: { 'tok-secret': { tenantId: 'acme', role: 'read' } } },
      },
      sources: { 'serve.tokens.tok-secret.tenantId': 'user' },
      paths: { user: '/tmp/user.yaml', project: '/tmp/project.yaml' },
    });

    expect(JSON.stringify(snapshot)).not.toContain('tok-secret');
    expect(snapshot.sources['serve.tokens.<set>.tenantId']).toBe('<set>');
  });
});

describe('context.maxMessages 默认值', () => {
  it('未配置时 config 不出现 maxMessages（由 core 按 maxTokens 推导）', async () => {
    const result = await loadConfig({
      userConfigPath: missingPath(),
      configPath: missingPath(),
      env: {},
    });

    expect(result.config.context?.maxTokens).toBe(1_000_000);
    expect(result.config.context?.maxMessages).toBeUndefined();
    expect(result.sources['context.maxMessages']).toBeUndefined();
  });

  it('显式配置仍原样透传（项目层优先）', async () => {
    const userConfigPath = tmpYaml('context:\n  max_messages: 250\n');
    const configPath = tmpYaml('context:\n  max_messages: 40\n');
    const result = await loadConfig({ userConfigPath, configPath, env: {} });

    expect(result.config.context?.maxMessages).toBe(40);
    expect(result.sources['context.maxMessages']).toBe('project');
  });
});
