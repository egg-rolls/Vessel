/**
 * 0.62：`gateway.proxy_nodes: false` × 「启用了 WebUI 登录」的告警测试。
 *
 * 为什么值得一条测试：这个组合**不会让服务起不来**，只会让浏览器永远拿不到 node token
 * （`platform.nodes.credentials` 只发给 `mode === 'token'` 的客户端），症状是「登录之后
 * 所有数据面请求 401」。不告警的话，用户会以为是鉴权坏了 —— 那正是 0.62 现场排了半天的坑。
 *
 * 同时钉住两条**不该**告警的情形，避免噪音：没配 `auth.backends`、或没关代理。
 *
 * @module @vessel-agent/config/validator-proxy-nodes.test
 */

import { describe, expect, test } from 'bun:test';
import type { VesselConfig } from './types.js';
import { validateConfig } from './validator.js';

const BACKEND = {
  kind: 'github_oauth',
  clientId: 'cid',
  clientSecretEnv: 'SECRET_ENV',
  allowUserIds: [174765587],
};
const ORIGINS = { publicOrigins: ['http://127.0.0.1:8642'] };

function check(config: Record<string, unknown>): {
  valid: boolean;
  proxyWarnings: { path: string; message: string }[];
} {
  const result = validateConfig(config as unknown as VesselConfig);
  return {
    valid: result.valid,
    proxyWarnings: result.warnings.filter((warning) => warning.path === 'gateway.proxyNodes'),
  };
}

describe('gateway.proxyNodes: false × auth.backends', () => {
  test('关代理 + 配了登录后端 ⇒ 一条告警（不是错误）', () => {
    const { valid, proxyWarnings } = check({
      gateway: { proxyNodes: false },
      auth: { enabled: true, ...ORIGINS, backends: [BACKEND] },
    });
    expect(valid).toBe(true);
    expect(proxyWarnings).toHaveLength(1);
    const message = proxyWarnings[0]?.message ?? '';
    // 说清代价与出路，且指到正确的入口前缀。
    expect(message).toContain('平台代理');
    expect(message).toContain('node token');
    expect(message).toContain('401');
    expect(message).toContain('/nodes/<node_id>/');
    // 不给命令行。
    expect(message).not.toContain('curl');
    expect(message).not.toContain('$ ');
    expect(message).not.toContain('bun ');
  });

  test('关代理但没有登录后端 ⇒ 不告警', () => {
    const { proxyWarnings } = check({ gateway: { proxyNodes: false } });
    expect(proxyWarnings).toHaveLength(0);
  });

  test('auth.enabled: false ⇒ 不告警（登录本来就没开）', () => {
    const { proxyWarnings } = check({
      gateway: { proxyNodes: false },
      auth: { enabled: false, ...ORIGINS, backends: [BACKEND] },
    });
    expect(proxyWarnings).toHaveLength(0);
  });

  test('缺省（不写 proxyNodes）+ 配了登录后端 ⇒ 不告警（缺省是开代理）', () => {
    const { proxyWarnings } = check({
      auth: { enabled: true, ...ORIGINS, backends: [BACKEND] },
    });
    expect(proxyWarnings).toHaveLength(0);
  });

  test('proxyNodes: true ⇒ 不告警', () => {
    const { proxyWarnings } = check({
      gateway: { proxyNodes: true },
      auth: { enabled: true, ...ORIGINS, backends: [BACKEND] },
    });
    expect(proxyWarnings).toHaveLength(0);
  });
});
