import { describe, expect, it } from 'bun:test';
import { GuardrailStage, MemoryPluginHost } from '@vessel/core';
import piiPlugin from '../src/index';

describe('guardrail-pii 插件（P2）', () => {
  it('install 注册 1 个 Output guardrail', () => {
    const host = new MemoryPluginHost();
    piiPlugin.install(host);
    const guardrails = host.getGuardrails();
    expect(guardrails.length).toBe(1);
    expect(guardrails[0]?.stage).toBe(GuardrailStage.Output);
  });

  it('PII guardrail 放行正常文本', async () => {
    const host = new MemoryPluginHost();
    piiPlugin.install(host);
    const g = host.getGuardrails()[0]!;
    const r = await g.check('这是一段正常的回复文本，没有敏感信息。', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
  });
});
