/**
 * tenant 工具策略纯函数（0.18，DECISION-032 §1）。
 *
 * 故障形态：策略被解析但不执行；deny 被 allow 覆盖；空 allow 被当成不限制。
 * 期望值来自 DECISION-032，不复制实现。
 */

import { describe, expect, it } from 'bun:test';
import {
  isTenantToolAllowed,
  resolveTenantToolPolicy,
  type TenantToolPolicy,
} from '../../packages/config/src/index';

describe('tenant tool policy', () => {
  it('deny wins over allow for the same tool name', () => {
    const policy: TenantToolPolicy = { allow: ['bash', 'read'], deny: ['bash'] };
    expect(isTenantToolAllowed('bash', policy)).toBe(false);
    expect(isTenantToolAllowed('read', policy)).toBe(true);
    // allow 是白名单：未列出即拒绝。
    expect(isTenantToolAllowed('edit', policy)).toBe(false);
  });

  it('empty allow allows no tools', () => {
    const policy = resolveTenantToolPolicy(
      { tenant: { tenants: { acme: { tools: { allow: [] } } } } },
      'acme',
    );
    expect(policy).toEqual({ allow: [] });
    expect(isTenantToolAllowed('bash', policy)).toBe(false);
    expect(isTenantToolAllowed('read', policy)).toBe(false);
  });

  it('absent allow leaves tools unrestricted', () => {
    expect(
      resolveTenantToolPolicy({ tenant: { tenants: { acme: { status: 'active' } } } }, 'acme'),
    ).toBeUndefined();
    expect(isTenantToolAllowed('anything', resolveTenantToolPolicy({}, 'acme'))).toBe(true);

    const denyOnly: TenantToolPolicy = { deny: [] };
    expect(isTenantToolAllowed('bash', denyOnly)).toBe(true);
    expect(isTenantToolAllowed('mcp__server__tool', denyOnly)).toBe(true);
  });
});
