import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { type GatewayPidRecord, writeGatewayPid } from '../gateway/pid';
import {
  gatewayBaseUrl,
  parseReloadResult,
  type ReloadClient,
  reloadGateway,
} from '../gateway/reload';
import { reloadGatewayCommand } from '../gateway-command';
import { RpcClientError } from '../rpc';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-gateway-reload-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function record(overrides: Partial<GatewayPidRecord> = {}): GatewayPidRecord {
  return {
    pid: process.pid,
    started_at: new Date().toISOString(),
    host: '127.0.0.1',
    port: 8642,
    version: '0.12.0',
    ...overrides,
  };
}

function fakeClient(handler: (method: string, params: unknown) => unknown) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let closed = false;
  const client: ReloadClient = {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return handler(method, params) as T;
    },
    close: async () => {
      closed = true;
    },
  };
  return { client, calls, isClosed: () => closed };
}

describe('gatewayBaseUrl', () => {
  it('通配绑定归一回环，IPv6 加括号', () => {
    expect(gatewayBaseUrl(record({ host: '0.0.0.0', port: 1234 }))).toBe('http://127.0.0.1:1234');
    expect(gatewayBaseUrl(record({ host: '::', port: 1234 }))).toBe('http://[::1]:1234');
    expect(gatewayBaseUrl(record({ host: '::1', port: 1234 }))).toBe('http://[::1]:1234');
    expect(gatewayBaseUrl(record({ host: 'localhost', port: 1 }), true)).toBe(
      'https://localhost:1',
    );
  });
});

describe('parseReloadResult', () => {
  it('接受冻结形状，拒绝其它', () => {
    expect(parseReloadResult({ reloaded: ['config'], requires_restart: [] })).toEqual({
      reloaded: ['config'],
      requires_restart: [],
    });
    expect(parseReloadResult(null)).toBeNull();
    expect(parseReloadResult({ reloaded: 'config', requires_restart: [] })).toBeNull();
    expect(parseReloadResult({ reloaded: [1], requires_restart: [] })).toBeNull();
    expect(parseReloadResult({ reloaded: [] })).toBeNull();
  });
});

describe('reloadGateway', () => {
  it('调用 gateway.reload 并关闭客户端', async () => {
    const fake = fakeClient(() => ({
      reloaded: ['config', 'plugins'],
      requires_restart: ['provider'],
    }));
    const result = await reloadGateway({
      record: record(),
      token: 'secret',
      scopes: ['config'],
      createClient: () => fake.client,
    });
    expect(result).toEqual({
      ok: true,
      result: { reloaded: ['config', 'plugins'], requires_restart: ['provider'] },
    });
    expect(fake.calls).toEqual([{ method: 'gateway.reload', params: { scopes: ['config'] } }]);
    expect(fake.isClosed()).toBe(true);
  });

  it('web 尚未提供方法时返回明确错误', async () => {
    const fake = fakeClient(() => {
      throw new RpcClientError('not_found', 'unknown method');
    });
    const result = await reloadGateway({
      record: record(),
      token: 'secret',
      createClient: () => fake.client,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_found');
      expect(result.error).toContain('does not expose gateway.reload');
    }
  });

  it('结果形状漂移不算成功', async () => {
    const fake = fakeClient(() => ({ reloaded: ['config'] }));
    const result = await reloadGateway({
      record: record(),
      token: 'secret',
      createClient: () => fake.client,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_result');
  });
});

describe('reloadGatewayCommand', () => {
  const config = { serve: {} } as VesselConfig;

  it('无 gateway → 非 0', async () => {
    const err: string[] = [];
    const code = await reloadGatewayCommand({
      dataDir: tmpDir(),
      config,
      env: {},
      print: () => undefined,
      printErr: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err.length).toBe(1);
  });

  it('无 token → 非 0（不打印 token）', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record());
    const err: string[] = [];
    const code = await reloadGatewayCommand({
      dataDir: dir,
      config,
      env: {},
      // 用 win32 分支 + 注入的命令执行器，避免依赖本机 /proc 内容。
      platform: 'win32',
      runCommand: async () => ({ exitCode: 0, stdout: 'vessel gateway start', stderr: '' }),
      print: () => undefined,
      printErr: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).not.toContain('secret');
  });
});
