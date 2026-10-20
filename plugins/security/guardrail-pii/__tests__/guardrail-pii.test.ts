import { beforeEach, describe, expect, it } from 'bun:test';
import { GuardrailStage, MemoryPluginHost } from '@vessel-agent/core';
import piiPlugin, {
  createPiiGuardrailPlugin,
  PIIGuardrail,
  type PluginInstallOptions,
} from '../src/index';

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

  it('多种 PII 顺序颠倒时仍正确遮罩（索引不互相破坏）', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('电话 555-123-4567，邮箱 test@example.com', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(String(r.replacement)).not.toContain('555-123-4567');
    expect(String(r.replacement)).not.toContain('test@example.com');
    // 未被遮罩的普通文本保持原位
    expect(String(r.replacement)).toContain('电话');
    expect(String(r.replacement)).toContain('邮箱');
  });

  it('日期不会被误判为电话', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('日期：2026-10-17', { run_id: 'r1', stage: GuardrailStage.Output });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeUndefined();
  });

  it('已知误报：10 位纯数字（订单号）会按电话遮罩', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('订单号 1234567890', { run_id: 'r1', stage: GuardrailStage.Output });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeDefined();
    expect(r.reason).toContain('phone');
  });

  it('中国大陆 11 位手机号可识别', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('手机 13800138000', { run_id: 'r1', stage: GuardrailStage.Output });
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain('phone');
    expect(String(r.replacement)).not.toContain('13800138000');
  });

  it('install 传入 plugins[].config 时生效（E1：开关 + 字符串自定义规则）', async () => {
    const configHost = new MemoryPluginHost();
    (piiPlugin.install as (h: MemoryPluginHost, o?: PluginInstallOptions) => void)(configHost, {
      config: {
        detectEmail: false,
        detectPhone: false,
        detectSSN: false,
        detectCreditCard: false,
        maskingStrategy: 'hash',
        customPatterns: [{ name: 'employee-id', pattern: 'EMP-\\d{4}' }],
      },
    });
    const g = configHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    const email = await g.check('test@example.com', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(email.replacement).toBeUndefined();

    const employee = await g.check('员工 EMP-1234 入职', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(employee.reason).toContain('employee-id');
    expect(String(employee.replacement)).toContain('[REDACTED_EMPLOYEE-ID]');
  });

  it('install 配置覆盖工厂配置', async () => {
    const configHost = new MemoryPluginHost();
    const plugin = createPiiGuardrailPlugin({ detectEmail: true, maskingStrategy: 'full' });
    (plugin.install as (h: MemoryPluginHost, o?: PluginInstallOptions) => void)(configHost, {
      config: { detectEmail: false, maskingStrategy: 'hash' },
    });
    const g = configHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    const r = await g.check('test@example.com', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.replacement).toBeUndefined();
  });

  it('自定义规则参与检测与遮罩', async () => {
    const custom = new PIIGuardrail({
      detectEmail: false,
      detectPhone: false,
      detectSSN: false,
      detectCreditCard: false,
      customPatterns: [{ name: 'employee-id', pattern: /EMP-\d{4}/g }],
      maskingStrategy: 'hash',
    });
    const r = await custom.check('员工 EMP-1234 入职', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain('employee-id');
    expect(String(r.replacement)).toContain('[REDACTED_EMPLOYEE-ID]');
  });
});
