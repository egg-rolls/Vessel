import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import type { RuntimePermissionConfig } from '../../packages/core/src/index';
import { MemoryPluginHost } from '../../packages/core/src/index';
import {
  assemblePluginTools,
  collectPermissionTargets,
  permissionConfigFor,
  registerRuntimeNoticeHook,
  resolveAgentRuntime,
} from '../hot-apply-assembly';
import { createRuntimeNoticeBus } from '../runtime-notice';
import { RUNTIME_NOTICE_HOOK } from '../runtime-notice-hook';

describe('permissionConfigFor（与 bootstrap 启动语义一致）', () => {
  it('交互 = ask，headless = allow', () => {
    const config = { permission: {} } as VesselConfig;
    expect(permissionConfigFor(config, false).default).toBe('ask');
    expect(permissionConfigFor(config, true).default).toBe('allow');
  });

  it('ask_user 始终免确认；agent.close 缺省 always ask', () => {
    const config = { permission: { autoApprove: ['bash'] } } as VesselConfig;
    const resolved = permissionConfigFor(config, false);
    expect(resolved.autoApprove).toEqual(['bash', 'ask_user']);
    expect(resolved.neverAutoApprove).toEqual(['agent.close']);
  });

  it('用户显式配置 neverAutoApprove 时以其值为准', () => {
    const config = {
      permission: { neverAutoApprove: ['bash'] },
    } as VesselConfig;
    expect(permissionConfigFor(config, false).neverAutoApprove).toEqual(['bash']);
  });
});

describe('resolveAgentRuntime', () => {
  function fakeRuntime(id: string) {
    const applied: RuntimePermissionConfig[] = [];
    return {
      id,
      applied,
      applyPermissionRules(rules: RuntimePermissionConfig) {
        applied.push(rules);
      },
    };
  }

  it('直接命中 AgentRuntime', () => {
    const runtime = fakeRuntime('main');
    expect(resolveAgentRuntime(runtime)).toBe(runtime);
  });

  it('穿透 OwnerRuntimeFacade 的 handle', () => {
    const inner = fakeRuntime('main');
    const facade = { handle: inner, run: async () => '' };
    expect(resolveAgentRuntime(facade)).toBe(inner);
  });

  it('穿透 withSessionWriteLock 这类包装（inner）', () => {
    const inner = fakeRuntime('main');
    expect(resolveAgentRuntime({ inner, run: async () => '' })).toBe(inner);
  });

  it('RuntimeHost：按 ownerId 取 handle 后继续下探', () => {
    const inner = fakeRuntime('main');
    const host = {
      ownerId: 'main',
      get: (id: string) => (id === 'main' ? { handle: inner } : undefined),
    };
    expect(resolveAgentRuntime(host)).toBe(inner);
  });

  it('找不到时返回 undefined（不抛错）', () => {
    expect(resolveAgentRuntime(undefined)).toBeUndefined();
    expect(resolveAgentRuntime({})).toBeUndefined();
    expect(resolveAgentRuntime(null)).toBeUndefined();
  });
});

describe('collectPermissionTargets', () => {
  it('按 id 去重：同一 runtime 经多条路径出现只算一个', () => {
    const applied: string[] = [];
    const inner = {
      id: 'main',
      applyPermissionRules: () => applied.push('main'),
    };
    const facade = { handle: inner, run: async () => '' };

    const targets = collectPermissionTargets({
      runtime: facade,
      bundleRuntime: inner,
      tenantRuntimes: () => [facade, inner],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(inner);
  });

  it('收集多个不同 runtime', () => {
    const a = { id: 'a', applyPermissionRules: () => {} };
    const b = { id: 'b', applyPermissionRules: () => {} };
    expect(
      collectPermissionTargets({ runtime: a, tenantRuntimes: () => [b] }).map(
        (target) => target.id,
      ),
    ).toEqual(['a', 'b']);
  });
});

describe('assemblePluginTools', () => {
  it('插件工具在旁路 host 上装配，不触碰真实宿主', async () => {
    const assembled = await assemblePluginTools({
      config: { plugins: [] } as VesselConfig,
      tenantId: 'default',
    });
    expect(Array.isArray(assembled.tools)).toBe(true);
    expect(assembled.names).toEqual([]);
  });
});

describe('registerRuntimeNoticeHook', () => {
  it('注册一次，重复调用幂等', () => {
    const host = new MemoryPluginHost();
    const bus = createRuntimeNoticeBus();
    registerRuntimeNoticeHook(host, bus);
    registerRuntimeNoticeHook(host, bus);
    expect(host.getHooks().filter((hook) => hook.name === RUNTIME_NOTICE_HOOK)).toHaveLength(1);
  });
});
