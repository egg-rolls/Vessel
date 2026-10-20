/**
 * 首启向导落盘形状（0.10 R1-12）
 *
 * 只写新版 `provider:`；自定义端点按 OpenAI 兼容写 name=openai + base_url，
 * 不再产生 default_provider / providers / default_model。
 */

import { describe, expect, it } from 'bun:test';
import { stringify as toYaml } from 'yaml';
import { buildWizardFileConfig, inferProvider } from '../src/wizard/setup-wizard.js';

describe('buildWizardFileConfig', () => {
  it('标准 OpenAI 端点写 provider 新形状', () => {
    const config = buildWizardFileConfig('https://api.openai.com/v1', 'gpt-4', 'sk-test');
    expect(config).toEqual({
      provider: {
        name: 'openai',
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4',
        api_key: 'sk-test',
      },
    });
  });

  it('自定义端点按 OpenAI 兼容处理，不写 custom', () => {
    const config = buildWizardFileConfig('https://llm.example.com/v1', 'my-model', 'sk-x');
    expect(config.provider.name).toBe('openai');
    expect(config.provider.base_url).toBe('https://llm.example.com/v1');
  });

  it('YAML 输出不含任何 legacy 键', () => {
    const yaml = toYaml(buildWizardFileConfig('https://llm.example.com/v1', 'm', 'sk'));
    expect(yaml).toContain('provider:');
    expect(yaml).not.toContain('default_provider');
    expect(yaml).not.toContain('default_model');
    expect(yaml).not.toContain('providers:');
    expect(yaml).not.toMatch(/^api_key:/m);
  });
});

describe('inferProvider', () => {
  it('未知端点回退 openai（不再返回 custom）', () => {
    expect(inferProvider('https://my-llm.internal/v1')).toBe('openai');
    expect(inferProvider('https://ws-1234.example.com/v1')).toBe('openai');
  });

  it('已知端点保持原有映射', () => {
    expect(inferProvider('https://api.anthropic.com')).toBe('anthropic');
    expect(inferProvider('http://localhost:11434/v1')).toBe('ollama');
  });
});
