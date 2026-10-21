/**
 * 0.8.2 Wave 2B1：delegate 工厂插件继承父 runtime 的 resolved 权限。
 *
 * 只测纯函数，不 mock 模块：Bun 的 `mock.module` 是进程级，
 * 会污染并发执行的 delegate 插件测试。
 */

import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { MemoryLLMProvider, type RuntimeHost } from '../../packages/core/src/index';
import { buildDelegateTaskOptions, resolveRuntimePermission } from '../tenant-runtime-factory';

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

describe('buildDelegateTaskOptions', () => {
  it('passes the resolved permission and keeps the bridge default', () => {
    const permission = resolveRuntimePermission(config, false);
    const options = buildDelegateTaskOptions({
      config,
      providerFactory: () => new MemoryLLMProvider(),
      tenantId: 'acme',
      providerModel: 'mock-model',
      headless: false,
      permission,
    });

    expect(options.permission).toEqual({
      default: 'ask',
      autoApprove: ['configured_tool', 'ask_user'],
    });
    expect(options.permissionMode).toBe('bridge');
  });

  it('keeps an explicit permissionMode and runtimeHost passthrough', () => {
    const runtimeHost = { id: 'host' } as unknown as RuntimeHost;
    const options = buildDelegateTaskOptions({
      config: { ...config, delegate: { permissionMode: 'deny' } },
      providerFactory: () => new MemoryLLMProvider(),
      tenantId: 'acme',
      providerModel: 'mock-model',
      headless: true,
      permission: resolveRuntimePermission(config, true),
      runtimeHost,
    });

    expect(options.permissionMode).toBe('deny');
    expect(options.runtimeHost).toBe(runtimeHost);
  });

  it('maps allowNested / maxDescendants with safe defaults', () => {
    const defaults = buildDelegateTaskOptions({
      config,
      providerFactory: () => new MemoryLLMProvider(),
      tenantId: 'acme',
      providerModel: 'mock-model',
      headless: false,
      permission: resolveRuntimePermission(config, false),
    });
    expect(defaults.allowNested).toBe(false);
    expect(defaults.maxDescendants).toBe(16);

    const configured = buildDelegateTaskOptions({
      config: {
        ...config,
        delegate: { allowNested: true, maxDescendants: 3 },
        context: { maxTokens: 12_345 },
      },
      providerFactory: () => new MemoryLLMProvider(),
      tenantId: 'acme',
      providerModel: 'mock-model',
      headless: false,
      permission: resolveRuntimePermission(config, false),
    });
    expect(configured.allowNested).toBe(true);
    expect(configured.maxDescendants).toBe(3);
    expect(configured.contextMaxTokens).toBe(12_345);
  });
});
