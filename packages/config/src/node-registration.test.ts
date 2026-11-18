import { describe, expect, test } from 'bun:test';
import {
  addressKey,
  classifyHost,
  classifyOrigin,
  deriveTrustedOrigins,
  MAX_DERIVED_ORIGINS,
  normalizeEntryOrigin,
  parseOrigin,
  validateNodeRegistration,
} from './node-registration.js';

describe('parseOrigin', () => {
  test('接受裸 origin 并归一（去尾斜杠、省略默认端口、host 小写）', () => {
    expect(parseOrigin('http://127.0.0.1:8642')?.origin).toBe('http://127.0.0.1:8642');
    expect(parseOrigin('http://127.0.0.1:8642/')?.origin).toBe('http://127.0.0.1:8642');
    expect(parseOrigin('https://Node.Example.com:443')?.origin).toBe('https://node.example.com');
    expect(parseOrigin('http://127.0.0.1:80')?.origin).toBe('http://127.0.0.1');
    expect(parseOrigin('  http://127.0.0.1:8642  ')?.origin).toBe('http://127.0.0.1:8642');
  });

  test('IPv6 带方括号与 zone id', () => {
    expect(parseOrigin('http://[::1]:8642')?.origin).toBe('http://[::1]:8642');
    expect(parseOrigin('http://[fe80::1%25en0]:8642')?.host).toBe('fe80::1');
    expect(parseOrigin('http://[fe80::1%en0]:8642')?.origin).toBe('http://[fe80::1]:8642');
  });

  test('拒绝带 path / query / 凭据 / 非 http(s) / 非法端口 / 非 origin', () => {
    expect(parseOrigin('http://127.0.0.1:8642/v1/rpc')).toBeNull();
    expect(parseOrigin('http://127.0.0.1:8642/?x=1')).toBeNull();
    expect(parseOrigin('http://user:pass@127.0.0.1:8642')).toBeNull();
    expect(parseOrigin('ws://127.0.0.1:8642')).toBeNull();
    expect(parseOrigin('http://127.0.0.1:0')).toBeNull();
    expect(parseOrigin('http://127.0.0.1:70000')).toBeNull();
    expect(parseOrigin('http://[example.com]')).toBeNull();
    expect(parseOrigin('')).toBeNull();
    expect(parseOrigin(undefined)).toBeNull();
    expect(parseOrigin('127.0.0.1:8642')).toBeNull();
  });
});

describe('classifyOrigin / classifyHost', () => {
  test('回环', () => {
    expect(classifyOrigin('http://127.0.0.1:8642')).toBe('loopback');
    expect(classifyOrigin('http://127.9.9.9')).toBe('loopback');
    expect(classifyOrigin('http://localhost:8642')).toBe('loopback');
    expect(classifyOrigin('http://app.localhost')).toBe('loopback');
    expect(classifyOrigin('http://[::1]:8642')).toBe('loopback');
  });

  test('IPv4 映射的 IPv6 必须还原成 IPv4 再分类', () => {
    // WHATWG 会把 ::ffff:127.0.0.1 序列化成 ::ffff:7f00:1；这一条是真实环境的形状。
    expect(classifyOrigin('http://[::ffff:127.0.0.1]:8642')).toBe('loopback');
    expect(classifyOrigin('http://[::ffff:7f00:1]:8642')).toBe('loopback');
    expect(classifyOrigin('http://[::ffff:192.168.1.5]:8642')).toBe('private');
    expect(classifyOrigin('http://[::ffff:c0a8:105]:8642')).toBe('private');
    expect(classifyOrigin('http://[::ffff:8.8.8.8]:8642')).toBe('public');
  });

  test('私网（含 CGNAT、ULA、链路本地、zone id）', () => {
    expect(classifyOrigin('http://10.1.2.3:8642')).toBe('private');
    expect(classifyOrigin('http://172.16.0.1:8642')).toBe('private');
    expect(classifyOrigin('http://172.31.255.254:8642')).toBe('private');
    expect(classifyOrigin('http://192.168.1.5:8642')).toBe('private');
    expect(classifyOrigin('http://169.254.1.1:8642')).toBe('private');
    expect(classifyOrigin('http://100.64.0.1:8642')).toBe('private');
    expect(classifyOrigin('http://[fd00::1]:8642')).toBe('private');
    expect(classifyOrigin('http://[fe80::1%25eth0]:8642')).toBe('private');
  });

  test('公网：域名、公网 IP、私网边界的邻居', () => {
    expect(classifyOrigin('https://node.example.com')).toBe('public');
    expect(classifyOrigin('https://foo.local')).toBe('public');
    expect(classifyOrigin('http://172.32.0.1:8642')).toBe('public');
    expect(classifyOrigin('http://8.8.8.8')).toBe('public');
    expect(classifyOrigin('http://[2001:4860:4860::8888]')).toBe('public');
    expect(classifyOrigin('http://0.0.0.0:8642')).toBe('public');
  });

  test('非法输入返回 null', () => {
    expect(classifyOrigin('not an origin')).toBeNull();
    expect(classifyOrigin('http://exa mple.com')).toBeNull();
    expect(classifyHost('')).toBeNull();
    expect(classifyHost('bad host!')).toBeNull();
  });

  test('addressKey 让同一地址的不同写法相等', () => {
    expect(addressKey('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(addressKey('::ffff:c0a8:105')).toBe('192.168.1.5');
    expect(addressKey('fe80::1%eth0')).toBe(addressKey('fe80::1'));
    expect(addressKey('[::1]')).toBe('::1');
  });

  test('normalizeEntryOrigin 与 parseOrigin 同口径', () => {
    expect(normalizeEntryOrigin('https://Node.Example.com:443/')).toBe('https://node.example.com');
    expect(normalizeEntryOrigin('http://127.0.0.1:8642/v1')).toBeNull();
  });
});

describe('validateNodeRegistration', () => {
  const minimal = {
    node_id: 'node-1',
    entries: [{ kind: 'loopback', url: 'http://127.0.0.1:8642' }],
  };

  test('最小合法载荷', () => {
    const result = validateNodeRegistration(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.node_id).toBe('node-1');
    expect(result.value.entries).toEqual([{ kind: 'loopback', url: 'http://127.0.0.1:8642' }]);
    expect(result.value.capabilities).toEqual([]);
  });

  test('完整载荷 + 未知键丢弃', () => {
    const result = validateNodeRegistration({
      ...minimal,
      alias: '工作站',
      version: '0.61.0',
      incarnation: 'inc-1',
      capabilities: ['gateway.rpc', 'web.ui', 'gateway.rpc', 'nope'],
      unknown_future_field: { anything: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.capabilities).toEqual(['gateway.rpc', 'web.ui']);
    expect(result.value.version).toBe('0.61.0');
    expect(result.value.alias).toBe('工作站');
  });

  test('声明 kind 与地址事实不一致必须拒绝（声明不可信）', () => {
    const result = validateNodeRegistration({
      node_id: 'node-1',
      entries: [{ kind: 'loopback', url: 'https://node.example.com' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('entry_kind_mismatch');
  });

  test('public 入口必须 https', () => {
    const result = validateNodeRegistration({
      node_id: 'node-1',
      entries: [{ kind: 'public', url: 'http://node.example.com' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_entries');
  });

  test('入口超过 3 条拒绝', () => {
    const result = validateNodeRegistration({
      node_id: 'node-1',
      entries: [
        { kind: 'loopback', url: 'http://127.0.0.1:1' },
        { kind: 'loopback', url: 'http://127.0.0.1:2' },
        { kind: 'loopback', url: 'http://127.0.0.1:3' },
        { kind: 'loopback', url: 'http://127.0.0.1:4' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_entries');
  });

  test('旧字段 public_url 保留「浏览器可达」语义（LAN http 允许，公网必须 https）', () => {
    const lan = validateNodeRegistration({
      node_id: 'node-1',
      public_url: 'http://192.168.1.5:8642',
    });
    expect(lan.ok).toBe(true);
    if (lan.ok) expect(lan.value.public_url).toBe('http://192.168.1.5:8642');

    const publicHttp = validateNodeRegistration({
      node_id: 'node-1',
      public_url: 'http://node.example.com',
    });
    expect(publicHttp.ok).toBe(false);
    if (publicHttp.ok) return;
    expect(publicHttp.code).toBe('invalid_entries');

    const publicHttps = validateNodeRegistration({
      node_id: 'node-1',
      public_url: 'https://node.example.com/',
    });
    expect(publicHttps.ok).toBe(true);
    if (publicHttps.ok) expect(publicHttps.value.public_url).toBe('https://node.example.com');
  });

  test('public_url 必须是裸 origin', () => {
    const result = validateNodeRegistration({
      node_id: 'node-1',
      public_url: 'https://node.example.com/v1/rpc',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_request');
  });

  test('非法 node_id / alias / version / capabilities', () => {
    expect(validateNodeRegistration({ node_id: '' }).ok).toBe(false);
    expect(validateNodeRegistration({ node_id: 'a\nb' }).ok).toBe(false);
    expect(validateNodeRegistration({ node_id: 'n', alias: 'x'.repeat(121) }).ok).toBe(false);
    expect(validateNodeRegistration({ node_id: 'n', version: 'v1' }).ok).toBe(false);
    expect(validateNodeRegistration({ node_id: 'n', capabilities: 'web.ui' }).ok).toBe(false);
    expect(validateNodeRegistration({ node_id: 'n', entries: 'nope' }).ok).toBe(false);
    expect(validateNodeRegistration(null).ok).toBe(false);
  });
});

describe('deriveTrustedOrigins', () => {
  const localAddresses = ['127.0.0.1', '::1', '192.168.1.5', 'fe80::1%eth0'];

  test('回环无条件进；本机私网进；公网永不进', () => {
    const result = deriveTrustedOrigins({
      localAddresses,
      nodes: [
        {
          node_id: 'a',
          entries: [
            { kind: 'loopback', url: 'http://127.0.0.1:8642' },
            { kind: 'private', url: 'http://192.168.1.5:8642' },
            { kind: 'public', url: 'https://node.example.com' },
          ],
        },
      ],
    });
    expect(result.origins).toEqual(['http://127.0.0.1:8642', 'http://192.168.1.5:8642']);
    expect(result.loopback).toBe(1);
    expect(result.private).toBe(1);
    expect(result.skipped_public).toBe(1);
    expect(result.skipped_hosts).toContain('node.example.com');
  });

  test('私网地址不在本机网卡列表里就不进（声明不可信）', () => {
    const result = deriveTrustedOrigins({
      localAddresses,
      nodes: [{ node_id: 'a', entries: [{ kind: 'private', url: 'http://192.168.9.9:8642' }] }],
    });
    expect(result.origins).toEqual([]);
    expect(result.skipped_private).toBe(1);
  });

  test('allowPrivate=false 时只剩回环', () => {
    const result = deriveTrustedOrigins({
      localAddresses,
      allowPrivate: false,
      nodes: [
        {
          node_id: 'a',
          entries: [
            { kind: 'loopback', url: 'http://127.0.0.1:8642' },
            { kind: 'private', url: 'http://192.168.1.5:8642' },
          ],
        },
      ],
    });
    expect(result.origins).toEqual(['http://127.0.0.1:8642']);
    expect(result.skipped_private).toBe(1);
  });

  test('没有网卡信息时不做私网自动', () => {
    const result = deriveTrustedOrigins({
      nodes: [{ node_id: 'a', entries: [{ kind: 'private', url: 'http://192.168.1.5:8642' }] }],
    });
    expect(result.origins).toEqual([]);
  });

  test('兼容旧字段 url / public_url，去重且顺序稳定', () => {
    const result = deriveTrustedOrigins({
      localAddresses,
      nodes: [
        { node_id: 'a', url: 'http://127.0.0.1:9000' },
        { node_id: 'a', entries: [{ kind: 'loopback', url: 'http://127.0.0.1:9001' }] },
        // 同一个 origin 被第二个 node 也声明：去重保留首次声明（顺序稳定）。
        { node_id: 'b', url: 'http://127.0.0.1:9000', public_url: 'https://b.example.com' },
      ],
    });
    expect(result.origins).toEqual(['http://127.0.0.1:9000', 'http://127.0.0.1:9001']);
  });

  test('上限截断', () => {
    const nodes = Array.from({ length: MAX_DERIVED_ORIGINS + 5 }, (_, index) => ({
      node_id: `node-${index}`,
      entries: [{ kind: 'loopback', url: `http://127.0.0.1:${9000 + index}` }],
    }));
    expect(deriveTrustedOrigins({ localAddresses, nodes }).origins).toHaveLength(
      MAX_DERIVED_ORIGINS,
    );
  });

  test('空输入与坏条目 fail-closed', () => {
    expect(deriveTrustedOrigins({ nodes: [] }).origins).toEqual([]);
    const result = deriveTrustedOrigins({
      localAddresses,
      nodes: [{ node_id: 'a', entries: [{ url: 'not-an-origin' }] }],
    });
    expect(result.origins).toEqual([]);
    expect(result.invalid).toBe(1);
  });
});
