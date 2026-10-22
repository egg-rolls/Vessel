/**
 * 0.8.2 Wave 2B1：runtime resolved 权限。
 *
 * 只测纯函数，不 mock 模块。
 */

import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { resolveRuntimePermission } from '../tenant-runtime-factory';

const config: VesselConfig = {
  permission: { autoApprove: ['configured_tool'] },
};

describe('resolveRuntimePermission', () => {
  it('interactive: ask + configured autoApprove + ask_user', () => {
    expect(resolveRuntimePermission(config, false)).toEqual({
      default: 'ask',
      autoApprove: ['configured_tool', 'ask_user'],
    });
  });

  it('headless: allow + same autoApprove', () => {
    expect(resolveRuntimePermission(config, true)).toEqual({
      default: 'allow',
      autoApprove: ['configured_tool', 'ask_user'],
    });
  });

  it('does not duplicate an explicitly configured ask_user', () => {
    const permission = resolveRuntimePermission(
      { permission: { autoApprove: ['custom', 'ask_user'] } },
      false,
    );
    expect(permission.autoApprove).toEqual(['custom', 'ask_user']);
  });
});
