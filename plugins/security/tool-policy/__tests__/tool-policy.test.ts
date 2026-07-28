import { describe, expect, it } from 'bun:test';
import { GuardrailStage, MemoryPluginHost } from '@vessel/core';
import toolPolicyPlugin from '../src/index';

describe('tool-policy 插件（P2）', () => {
  it('install 注册 1 个 ToolCall guardrail', () => {
    const host = new MemoryPluginHost();
    toolPolicyPlugin.install(host);
    const guardrails = host.getGuardrails();
    expect(guardrails.length).toBe(1);
    expect(guardrails[0]?.stage).toBe(GuardrailStage.ToolCall);
  });

  it('默认 denylist 为空 → 不拦截任何工具', async () => {
    const host = new MemoryPluginHost();
    toolPolicyPlugin.install(host);
    const g = host.getGuardrails()[0]!;
    const r = await g.check('write_file', {
      run_id: 'r1',
      stage: GuardrailStage.ToolCall,
    });
    expect(r.allowed).toBe(true);
  });
});
