import { describe, expect, it } from 'bun:test';
import type { PluginLoader } from '../plugin-loader';
import { resolvePluginNames } from '../plugin-selection';

/** 只用到 getAvailablePlugins 的结构化假 loader */
function fakeLoader(available: string[]): PluginLoader {
  return { getAvailablePlugins: () => available } as unknown as PluginLoader;
}

describe('resolvePluginNames', () => {
  it('默认集排除 hook-logging 与工厂式插件', () => {
    const loader = fakeLoader(['basic-tools', 'team', 'delegate-task', 'tool-policy']);
    expect(resolvePluginNames(loader, undefined, false)).toEqual(['basic-tools', 'tool-policy']);
  });

  it('VESSEL_DEBUG 时加入 hook-logging', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(resolvePluginNames(loader, undefined, true)).toEqual([
      'basic-tools',
      'tool-policy',
      'hook-logging',
    ]);
  });

  it('显式 plugins 列表会过滤掉工厂式插件（由 bootstrap 专用配置构造）', () => {
    const loader = fakeLoader([]);
    expect(
      resolvePluginNames(
        loader,
        [{ name: 'basic-tools' }, { name: 'team' }, { name: 'delegate-task' }],
        false,
      ),
    ).toEqual(['basic-tools']);
  });
});
