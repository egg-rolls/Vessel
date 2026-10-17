import { describe, expect, it } from 'bun:test';
import { planFactoryPlugins } from '../factory-plugins';

describe('planFactoryPlugins', () => {
  it('默认（delegate 默认开启、team 关闭）零输出', () => {
    expect(planFactoryPlugins({}, false)).toEqual({
      delegate: { enabled: true, useHost: false },
      team: null,
      warnings: [],
    });
  });

  it('host 开启 + viaHost=true：delegate 共享 Host', () => {
    const plan = planFactoryPlugins({ delegate: { viaHost: true } }, true);
    expect(plan.delegate).toEqual({ enabled: true, useHost: true });
    expect(plan.warnings).toHaveLength(0);
  });

  it('host 关闭 + viaHost=true：告警并回落专用 Host', () => {
    const plan = planFactoryPlugins({ delegate: { viaHost: true } }, false);
    expect(plan.delegate).toEqual({ enabled: true, useHost: false });
    expect(plan.warnings[0]).toContain('delegate.viaHost is ignored');
  });

  it('delegate.enabled=false 时不注册', () => {
    expect(planFactoryPlugins({ delegate: { enabled: false } }, true).delegate).toBeNull();
  });

  it('team 开启 + host：共享 Host', () => {
    const plan = planFactoryPlugins({ team: { enabled: true } }, true);
    expect(plan.team).toEqual({ enabled: true, useHost: true });
    expect(plan.warnings).toHaveLength(0);
  });

  it('team 开启 + host 关闭：告警并使用内嵌 Host', () => {
    const plan = planFactoryPlugins({ team: { enabled: true } }, false);
    expect(plan.team).toEqual({ enabled: true, useHost: false });
    expect(plan.warnings[0]).toContain('embedded in-process host');
  });
});
