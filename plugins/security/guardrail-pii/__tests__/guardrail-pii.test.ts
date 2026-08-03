import { beforeEach, describe, expect, it } from 'bun:test';
import { GuardrailStage, MemoryPluginHost } from '@vessel/core';
import piiPlugin, { PIIGuardrail } from '../src/index';

describe('guardrail-pii 插件（P2）', () => {
  let host: MemoryPluginHost;

  beforeEach(() => {
    host = new MemoryPluginHost();
    piiPlugin.install(host);
  });

  it('install 注册 1 个 Output guardrail', () => {
    const guardrails = host.getGuardrails();
    expect(guardrails.length).toBe(1);
    expect(guardrails[0]?.stage).toBe(GuardrailStage.Output);
  });

  it('PII guardrail 放行正常文本', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('这是一段正常的回复文本，没有敏感信息。', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeUndefined();
  });

  it('检测并脱敏邮箱地址', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('请联系我：test@example.com 或 admin@company.org', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeDefined();
    expect(r.replacement).not.toContain('test@example.com');
    expect(r.replacement).not.toContain('admin@company.org');
    expect(r.reason).toContain('email');
  });

  it('检测并脱敏电话号码', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('我的电话是 555-123-4567 或 +1-555-123-4567', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeDefined();
    expect(r.replacement).not.toContain('555-123-4567');
    expect(r.reason).toContain('phone');
  });

  it('检测并脱敏社会安全号码', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('SSN：123-45-6789', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeDefined();
    expect(r.replacement).not.toContain('123-45-6789');
    expect(r.reason).toContain('ssn');
  });

  it('检测并脱敏信用卡号', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('信用卡号：4111111111111111', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeDefined();
    expect(r.replacement).not.toContain('4111111111111111');
    expect(r.reason).toContain('credit_card');
  });

  it('处理多种 PII 混合文本', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('联系张三，邮箱 zhangsan@example.com，电话 13800138000', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeDefined();
    expect(r.replacement).not.toContain('zhangsan@example.com');
    expect(r.replacement).not.toContain('13800138000');
    expect(r.reason).toContain('email');
    expect(r.reason).toContain('phone');
  });

  it('非字符串输入直接放行', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check(12345, {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeUndefined();
  });

  it('空字符串放行', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeUndefined();
  });

  it('自定义 PIIGuardrail 实例可单独使用', async () => {
    const customGuardrail = new PIIGuardrail({ detectEmail: false, detectPhone: false });
    const r = await customGuardrail.check('test@example.com', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeUndefined(); // 邮箱检测禁用
  });

  it('使用 hash 脱敏策略', async () => {
    const customGuardrail = new PIIGuardrail({ maskingStrategy: 'hash' });
    const r = await customGuardrail.check('联系我：test@example.com', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toContain('[REDACTED_EMAIL]');
  });

  it('使用 full 脱敏策略', async () => {
    const customGuardrail = new PIIGuardrail({ maskingStrategy: 'full' });
    const r = await customGuardrail.check('邮箱：test@example.com', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeDefined();
    // full 策略应该用 * 替换所有字符
    expect(r.replacement).toContain('****');
  });
});
