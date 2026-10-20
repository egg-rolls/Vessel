import { describe, expect, it } from 'bun:test';
import { type Guardrail, GuardrailStage, MemoryPluginHost } from '@vessel/core';
import redactPlugin, { createRedactSecretsPlugin, type PluginInstallOptions } from '../src/index';

/** 取 Output 阶段的 guardrail */
function outputGuardrail(plugin = redactPlugin): Guardrail {
  const host = new MemoryPluginHost();
  plugin.install(host);
  const guardrail = host.getGuardrails().find((g) => g.stage === GuardrailStage.Output);
  if (!guardrail) throw new Error('Output guardrail not registered');
  return guardrail;
}

/** 对文本跑一次 Output 脱敏，返回替换后的字符串 */
async function redact(text: string, plugin = redactPlugin): Promise<string> {
  const result = await outputGuardrail(plugin).check(text, {
    run_id: 'r1',
    stage: GuardrailStage.Output,
  });
  expect(result.allowed).toBe(true);
  return typeof result.replacement === 'string' ? result.replacement : text;
}

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

  it('正常文本不受影响', async () => {
    const r = await outputGuardrail().check('普通回复，没有密钥', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(r.allowed).toBe(true);
    expect(r.replacement).toBeUndefined();
  });

  it('Anthropic key 优先命中 anthropic 规则（保留 sk-ant- 前缀）', async () => {
    const text = 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz end';
    const redacted = await redact(text);
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redacted).toContain('sk-ant-***REDACTED***');
  });

  it('OpenAI key 保留 sk- 前缀', async () => {
    const redacted = await redact('我的 key 是 sk-abcdefghijklmnopqrstuv 请保密');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuv');
    expect(redacted).toContain('sk-***REDACTED***');
  });

  it('Bearer token / GitHub token / JWT / AWS key', async () => {
    expect(await redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toContain(
      'Bearer ***REDACTED***',
    );
    expect(await redact('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain(
      '***GITHUB-TOKEN-REDACTED***',
    );
    expect(await redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123')).toContain(
      '***JWT-REDACTED***',
    );
    expect(await redact('aws AKIAABCDEFGHIJKLMNOP')).toContain('***AWS-KEY-REDACTED***');
  });

  it('password 字段 / generic api key', async () => {
    expect(await redact('password: "hunter2-secret"')).toContain('password: "***REDACTED***"');
    expect(await redact('api_key=abcdefghijklmnop')).toContain('***REDACTED***');
  });

  it('多行私钥整体遮罩', async () => {
    const text = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const redacted = await redact(text);
    expect(redacted).toContain('***PRIVATE-KEY-REDACTED***');
    expect(redacted).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('连接串中的用户名密码遮罩', async () => {
    const redacted = await redact('postgres://user:pass@localhost:5432/db');
    expect(redacted).toContain('***CONNECTION-STRING-REDACTED***');
    expect(redacted).not.toContain('user:pass');
  });

  it('非字符串对象经 JSON 序列化后脱敏并按 JSON 返回', async () => {
    const r = await outputGuardrail().check(
      { token: 'sk-abcdefghijklmnopqrstuv', ok: true },
      { run_id: 'r1', stage: GuardrailStage.Output },
    );
    expect(r.allowed).toBe(true);
    const replaced = r.replacement as { token: string; ok: boolean };
    expect(replaced.ok).toBe(true);
    expect(replaced.token).not.toContain('abcdefghijklmnopqrstuv');
  });

  it('enableBuiltin: false 只应用自定义规则', async () => {
    const plugin = createRedactSecretsPlugin({
      enableBuiltin: false,
      extraPatterns: [{ name: 'internal-id', pattern: 'INT-\\d{4}', replacement: '***ID***' }],
    });
    expect(await redact('sk-abcdefghijklmnopqrstuv', plugin)).toContain(
      'sk-abcdefghijklmnopqrstuv',
    );
    expect(await redact('编号 INT-1234', plugin)).toContain('***ID***');
  });

  it('install 传入 plugins[].config 时生效（E1，含非法正则跳过）', async () => {
    const host = new MemoryPluginHost();
    const plugin = createRedactSecretsPlugin({ enableBuiltin: true });
    (plugin.install as (h: MemoryPluginHost, o?: PluginInstallOptions) => void)(host, {
      config: {
        enableBuiltin: false,
        extraPatterns: [
          { name: 'internal-id', pattern: 'INT-\\d{4}', replacement: '***ID***' },
          { name: 'broken', pattern: '([' },
        ],
      },
    });
    const guardrail = host.getGuardrails().find((g) => g.stage === GuardrailStage.Output);
    if (!guardrail) throw new Error('Output guardrail not registered');

    const builtin = await guardrail.check('sk-abcdefghijklmnopqrstuv', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(builtin.replacement).toBeUndefined();

    const custom = await guardrail.check('编号 INT-1234', {
      run_id: 'r1',
      stage: GuardrailStage.Output,
    });
    expect(custom.replacement).toContain('***ID***');
  });
});
