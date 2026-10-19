import { describe, expect, it } from 'bun:test';
import {
  parseConfigArgs,
  readConfigSnapshot,
  runConfigCommand,
} from '../src/commands/config-command.js';
import type { RpcClientLike } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const SNAPSHOT = {
  schema_version: 1,
  config: {
    provider: {
      name: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-secret-123',
    },
    dataDir: '~/.vessel/data',
    session: { backend: 'file' },
    trace: { enabled: true, level: 'full', retentionDays: 30 },
    tenant: { default: 'default' },
  },
  sources: {
    'provider.name': 'user',
    'provider.apiKey': 'env',
    'session.backend': 'default',
  },
  paths: { user: '/home/u/.vessel/config.yaml', project: './vessel.yaml' },
  tenant_id: 'default',
  tenant_overlay_keys: ['session.backend'],
  validation: { errors: [], warnings: [] },
};

function makeRpc(handlers: Record<string, () => unknown>): RpcClientLike {
  return {
    async request<T = unknown>(method: string): Promise<T> {
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return (await handler()) as T;
    },
    subscribe: () => () => undefined,
  };
}

describe('/config', () => {
  it('默认摘要显示 provider / dataDir / trace 与路径提示', async () => {
    const ctx = makeCtx({ rpc: makeRpc({ 'config.get': () => SNAPSHOT }) });
    const result = await runConfigCommand([], ctx);
    const output = result.output ?? '';

    expect(output).toContain('Config (schema_version 1, tenant default)');
    expect(output).toContain('provider.name:      openai');
    expect(output).toContain('dataDir:            ~/.vessel/data');
    expect(output).toContain('session.backend:    file');
    expect(output).toContain('trace.level:        full');
    expect(output).toContain('User config:    /home/u/.vessel/config.yaml');
    expect(output).toContain('Create user config: vessel config init');
  });

  it('摘要不输出密钥', async () => {
    const ctx = makeCtx({ rpc: makeRpc({ 'config.get': () => SNAPSHOT }) });
    const result = await runConfigCommand([], ctx);
    expect(result.output).not.toContain('sk-secret-123');
  });

  it('--sources 合并 config.sources 并标注 tenant overlay', async () => {
    const ctx = makeCtx({
      rpc: makeRpc({
        'config.get': () => SNAPSHOT,
        'config.sources': () => ({
          sources: { 'provider.model': 'project', 'trace.level': 'user' },
        }),
      }),
    });
    const result = await runConfigCommand(['show', '--sources'], ctx);
    const output = result.output ?? '';

    expect(output).toContain('Config sources (');
    expect(output).toContain('(env)');
    expect(output).toContain('(project)');
    expect(output).toContain('(default +tenant)');
    expect(output).not.toContain('sk-secret-123');
  });

  it('config.sources 失败时退回快照内嵌来源', async () => {
    const ctx = makeCtx({
      rpc: makeRpc({
        'config.get': () => SNAPSHOT,
        'config.sources': () => {
          throw { code: 'not_found', message: 'method missing' };
        },
      }),
    });
    const result = await runConfigCommand(['--sources'], ctx);
    expect(result.output).toContain('(default');
  });

  it('--json 输出可解析且已脱敏', async () => {
    const ctx = makeCtx({ rpc: makeRpc({ 'config.get': () => SNAPSHOT }) });
    const result = await runConfigCommand(['--json'], ctx);
    const parsed = JSON.parse((result.output ?? '').trim()) as {
      config: { provider: { apiKey: string } };
    };
    expect(parsed.config.provider.apiKey).toBe('***');
  });

  it('/config path 只显示路径', async () => {
    const ctx = makeCtx({ rpc: makeRpc({ 'config.get': () => SNAPSHOT }) });
    const result = await runConfigCommand(['path'], ctx);
    expect(result.output).toContain('User config:');
    expect(result.output).not.toContain('provider.name');
  });

  it('校验错误优先展示', async () => {
    const ctx = makeCtx({
      rpc: makeRpc({
        'config.get': () => ({
          ...SNAPSHOT,
          validation: { errors: [{ path: 'provider.model', message: 'required' }] },
        }),
      }),
    });
    const result = await runConfigCommand([], ctx);
    expect(result.output).toContain('✗ Configuration errors:');
    expect(result.output).toContain('provider.model: required');
  });

  it('未知参数给 usage', async () => {
    const ctx = makeCtx({ rpc: makeRpc({ 'config.get': () => SNAPSHOT }) });
    const result = await runConfigCommand(['--nope'], ctx);
    expect(result.output).toContain('Usage: /config');
  });

  it('没有 rpc 时给明确提示', async () => {
    const result = await runConfigCommand([], makeCtx());
    expect(result.output).toContain('RPC control plane is not available');
  });

  it('RPC 错误按 code 展示', async () => {
    const ctx = makeCtx({
      rpc: makeRpc({
        'config.get': () => {
          throw { code: 'forbidden', message: 'no access', details: { token: 'x' } };
        },
      }),
    });
    const result = await runConfigCommand([], ctx);
    expect(result.output).toContain('✗ [forbidden] no access');
    expect(result.output).not.toContain('token');
  });

  it('readConfigSnapshot 接受包装形状', () => {
    const snapshot = readConfigSnapshot({ config: { dataDir: '/x' }, validation: {} });
    expect(snapshot?.config.dataDir).toBe('/x');
  });

  it('parseConfigArgs 组合参数', () => {
    const parsed = parseConfigArgs(['path', '--json']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.action).toBe('path');
      expect(parsed.value.json).toBe(true);
    }
  });
});
