import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { checkTlsFiles, resolveServeOptions } from '../serve-config';

function cli(overrides: Partial<Parameters<typeof resolveServeOptions>[1]> = {}) {
  return {
    port: 8642,
    portExplicit: false,
    hostname: null,
    allowRemote: false,
    tlsCert: null,
    tlsKey: null,
    ...overrides,
  };
}

function resolve(
  config: VesselConfig,
  overrides: Partial<Parameters<typeof resolveServeOptions>[1]> = {},
) {
  return resolveServeOptions(config, cli(overrides));
}

describe('resolveServeOptions', () => {
  it('默认回环 + 明文 + 8642', () => {
    expect(resolve({})).toEqual({
      ok: true,
      options: { hostname: '127.0.0.1', port: 8642, allowRemote: false },
    });
  });

  it('CLI 覆盖配置', () => {
    const result = resolve(
      { serve: { hostname: '127.0.0.2', port: 9000, allowRemote: true } },
      { hostname: '127.0.0.1', port: 7000, portExplicit: true },
    );
    expect(result).toEqual({
      ok: true,
      options: { hostname: '127.0.0.1', port: 7000, allowRemote: true },
    });
  });

  it('未显式给端口时回退 config.serve.port', () => {
    expect(resolve({ serve: { port: 9999 } })).toEqual({
      ok: true,
      options: { hostname: '127.0.0.1', port: 9999, allowRemote: false },
    });
  });

  it('非回环且未 allowRemote：拒绝', () => {
    const result = resolve({}, { hostname: '0.0.0.0' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('non-loopback');
  });

  it('非回环 + allowRemote（CLI 或配置）：允许', () => {
    expect(resolve({}, { hostname: '0.0.0.0', allowRemote: true }).ok).toBe(true);
    expect(resolve({ serve: { hostname: '0.0.0.0', allowRemote: true } }).ok).toBe(true);
  });

  it('非法 hostname：拒绝', () => {
    const result = resolve({}, { hostname: 'http://example.com/x' });
    expect(result.ok).toBe(false);
  });

  it('CLI TLS 优先于配置 TLS', () => {
    const result = resolve(
      { serve: { tls: { certFile: 'cfg-cert.pem', keyFile: 'cfg-key.pem' } } },
      { tlsCert: 'cli-cert.pem', tlsKey: 'cli-key.pem' },
    );
    expect(result).toEqual({
      ok: true,
      options: {
        hostname: '127.0.0.1',
        port: 8642,
        allowRemote: false,
        tls: { certFile: 'cli-cert.pem', keyFile: 'cli-key.pem' },
      },
    });
  });

  it('loopback + TLS 合法（TLS 与 allowRemote 独立）', () => {
    const result = resolve({
      serve: { hostname: '127.0.0.1', tls: { certFile: 'c.pem', keyFile: 'k.pem' } },
    });
    expect(result.ok).toBe(true);
  });

  it('配置 TLS 缺一半：拒绝', () => {
    const result = resolve({ serve: { tls: { certFile: 'c.pem' } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('cert_file and key_file');
  });

  it('CLI TLS 缺一半：防御性拒绝', () => {
    const result = resolve({}, { tlsCert: 'c.pem' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('must be provided together');
  });
});

describe('checkTlsFiles', () => {
  it('undefined 直接通过', () => {
    expect(checkTlsFiles(undefined)).toBeNull();
  });

  it('文件不存在 / 为空 / 正常', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-tls-'));
    try {
      const missing = path.join(dir, 'missing.pem');
      expect(checkTlsFiles({ certFile: missing, keyFile: missing })).toContain('not found');

      const empty = path.join(dir, 'empty.pem');
      fs.writeFileSync(empty, '');
      expect(checkTlsFiles({ certFile: empty, keyFile: empty })).toContain('is empty');

      const cert = path.join(dir, 'cert.pem');
      const key = path.join(dir, 'key.pem');
      fs.writeFileSync(cert, 'CERT');
      fs.writeFileSync(key, 'KEY');
      expect(checkTlsFiles({ certFile: cert, keyFile: key })).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
