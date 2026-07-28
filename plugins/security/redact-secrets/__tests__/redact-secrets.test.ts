import { describe, expect, it } from 'bun:test';
import { GuardrailStage, MemoryPluginHost } from '@vessel/core';
import redactPlugin from '../src/index';

describe('redact-secrets 插件（P2）', () => {
  it('install 注册 2 个 guardrail（ToolResult + Output）', () => {
    const host = new MemoryPluginHost();
    redactPlugin.install(host);
    const guardrails = host.getGuardrails();
    expect(guardrails.length).toBe(2);
    const stages = guardrails.map((g) => g.stage);
    expect(stages).toContain(GuardrailStage.ToolResult);
    expect(stages).toContain(GuardrailStage.Output);
  });

  it('Output guardrail 编辑 API key', async () => {
    const host = new MemoryPluginHost();
    redactPlugin.install(host);
    const g = host.getGuardrails().find((g) => g.stage === GuardrailStage.Output)!;
    const r = await g.check('我的 key 是 sk-abcdefghijklmnopqrstuv 请保密', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeDefined();
    // 原始 key 不应出现在替换文本中；前缀 sk- 可保留（keepPrefix:3）
    expect(String(r.replacement)).not.toContain('abcdefghijklmnopqrstuv');
  });

  it('正常文本不受影响', async () => {
    const host = new MemoryPluginHost();
    redactPlugin.install(host);
    const g = host.getGuardrails().find((g) => g.stage === GuardrailStage.Output)!;
    const r = await g.check('普通回复，没有密钥', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeUndefined();
  });
});
