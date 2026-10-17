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

  it('host 开启：delegate 共享 Host', () => {
    const plan = planFactoryPlugins({ delegate: {} }, true);
    expect(plan.delegate).toEqual({ enabled: true, useHost: true });
    expect(plan.warnings).toHaveLength(0);
  });

  it('host 关闭：delegate 用专用 Host，且不再有 viaHost 告警', () => {
    const plan = planFactoryPlugins({ delegate: {} }, false);
    expect(plan.delegate).toEqual({ enabled: true, useHost: false });
    expect(plan.warnings).toHaveLength(0);
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
