import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergeConfig, type VesselConfig } from '../../packages/config/src/index';
import { buildCliConfigOverrides, type CliConfigOverridesInput } from '../cli-overrides';
import { checkTlsFiles, resolveServeOptions } from '../serve-config';

/**
 * 模拟生产路径：CLI flag 先经 loader 的 CLI 层合并，再交给 serve resolver。
 * 这里用 mergeConfig 做同样的合并（deepMerge 语义与 loader 一致）。
 */
function resolve(config: VesselConfig, overrides: CliConfigOverridesInput = {}) {
  return resolveServeOptions(mergeConfig(config, buildCliConfigOverrides(overrides)));
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
      { serveHost: '127.0.0.1', servePort: 7000, servePortExplicit: true },
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
    const result = resolve({}, { serveHost: '0.0.0.0' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('non-loopback');
  });

  it('非回环 + allowRemote（CLI 或配置）：允许', () => {
    expect(resolve({}, { serveHost: '0.0.0.0', allowRemote: true }).ok).toBe(true);
    expect(resolve({ serve: { hostname: '0.0.0.0', allowRemote: true } }).ok).toBe(true);
  });

  it('非法 hostname：拒绝', () => {
    const result = resolve({}, { serveHost: 'http://example.com/x' });
    expect(result.ok).toBe(false);
  });

  it('未显式给端口时 --serve 的默认值不进入 CLI 层', () => {
    const overrides = buildCliConfigOverrides({
      servePort: 8642,
      servePortExplicit: false,
    });
    expect(overrides.serve?.port).toBeUndefined();
  });

  it('--allowed-origin 整体替换 config 列表', () => {
    const result = resolve(
      { serve: { allowedOrigins: ['https://old.example.com'] } },
      { allowedOrigins: ['https://new.example.com'] },
    );
    expect(result.ok).toBe(true);
    // resolver 不消费 allowedOrigins；由 loader 合并结果直接交给 gateway。
    const merged = mergeConfig(
      { serve: { allowedOrigins: ['https://old.example.com'] } },
      buildCliConfigOverrides({ allowedOrigins: ['https://new.example.com'] }),
    );
    expect(merged.serve?.allowedOrigins).toEqual(['https://new.example.com']);
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

  it('CLI TLS 缺一半：不生成 tls 层（cli-args 已在解析期拦截）', () => {
    expect(buildCliConfigOverrides({ tlsCert: 'c.pem' })).toEqual({});
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
