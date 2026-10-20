import { describe, expect, it } from 'bun:test';
import {
  readCapabilityManifest,
  runCapabilitiesCommand,
} from '../src/commands/capabilities-command.js';
import type { CapabilityManifestLike, RpcClientLike } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const MANIFEST: CapabilityManifestLike = {
  version: '0.5.0',
  config_schema_version: 1,
  methods: [
    { name: 'runs.list', permission: 'read' },
    { name: 'runs.resume', permission: 'write' },
    { name: 'tenants.create', permission: 'admin' },
    { name: 'health.get', permission: 'read' },
  ],
  tools: [{ name: 'bash', description: 'Run a shell command' }, { name: 'read' }],
  plugins: [
    { name: 'workflow', enabled: true },
    { name: 'feishu', enabled: false },
  ],
};

function makeRpc(result: unknown): RpcClientLike {
  return {
    request: async <T = unknown>() => result as T,
    subscribe: () => () => undefined,
  };
}

describe('/capabilities', () => {
  it('默认输出摘要与权限计数', async () => {
    const result = await runCapabilitiesCommand([], makeCtx({ rpc: makeRpc(MANIFEST) }));
    expect(result.handled).toBe(true);
    expect(result.output).toContain('Capabilities (Vessel 0.5.0, config_schema_version 1)');
    expect(result.output).toContain('methods: 4 (read 2 / write 1 / admin 1)');
    expect(result.output).toContain('tools: 2 · plugins: 2 (enabled 1)');
  });

  it('methods 按名称排序并带 permission', async () => {
    const result = await runCapabilitiesCommand(['methods'], makeCtx({ rpc: makeRpc(MANIFEST) }));
    const output = result.output ?? '';
    expect(output.indexOf('health.get')).toBeLessThan(output.indexOf('runs.list'));
    expect(output.indexOf('runs.list')).toBeLessThan(output.indexOf('runs.resume'));
    expect(output).toContain('  runs.resume [write]');
    expect(output).toContain('  tenants.create [admin]');
  });

  it('tools / plugins 分节', async () => {
    const tools = await runCapabilitiesCommand(['tools'], makeCtx({ rpc: makeRpc(MANIFEST) }));
    expect(tools.output).toContain('  bash — Run a shell command');
    expect(tools.output).toContain('  read\n');

    const plugins = await runCapabilitiesCommand(['plugins'], makeCtx({ rpc: makeRpc(MANIFEST) }));
    expect(plugins.output).toContain('  feishu (disabled)');
    expect(plugins.output).toContain('  workflow (enabled)');
  });

  it('未知参数给 usage', async () => {
    const result = await runCapabilitiesCommand(['nope'], makeCtx({ rpc: makeRpc(MANIFEST) }));
    expect(result.output).toContain('Usage: /capabilities');
  });

  it('没有 rpc 时给明确提示', async () => {
    const result = await runCapabilitiesCommand([], makeCtx());
    expect(result.output).toContain('RPC control plane is not available');
  });

  it('RPC 错误按 code 展示且不带 details', async () => {
    const rpc: RpcClientLike = {
      request: async () => {
        throw { code: 'forbidden', message: 'not allowed', details: { token: 'x' } };
      },
      subscribe: () => () => undefined,
    };
    const result = await runCapabilitiesCommand([], makeCtx({ rpc }));
    expect(result.output).toContain('✗ [forbidden] not allowed');
    expect(result.output).not.toContain('token');
  });

  it('manifest 字段缺失时按空集合处理', async () => {
    const result = await runCapabilitiesCommand(
      [],
      makeCtx({ rpc: makeRpc({ version: 'x', config_schema_version: 1 }) }),
    );
    expect(result.output).toContain('methods: 0');
    expect(result.output).toContain('tools: 0');
  });

  it('readCapabilityManifest 拒绝非对象', () => {
    expect(readCapabilityManifest(null)).toBeNull();
    expect(readCapabilityManifest('nope')).toBeNull();
  });
});
