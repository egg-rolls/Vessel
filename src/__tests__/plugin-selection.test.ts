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

  it('空数组表示不加载任何插件，不回退默认集', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(resolvePluginNames(loader, [], false)).toEqual([]);
  });

  it('全 enabled:false 不回退为全部插件', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(
      resolvePluginNames(
        loader,
        [
          { name: 'basic-tools', enabled: false },
          { name: 'tool-policy', enabled: false },
        ],
        false,
      ),
    ).toEqual([]);
  });

  it('声明式条目在默认集上追加插件', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(resolvePluginNames(loader, undefined, false, [{ name: 'guardrail-pii' }])).toEqual([
      'basic-tools',
      'tool-policy',
      'guardrail-pii',
    ]);
  });

  it('显式 plugins 项优先于声明式 enabled:false', () => {
    const loader = fakeLoader([]);
    expect(
      resolvePluginNames(loader, [{ name: 'tool-policy', enabled: true }], false, [
        { name: 'tool-policy', enabled: false },
      ]),
    ).toEqual(['tool-policy']);
  });

  it('显式 enabled:false 不被声明式条目重新启用', () => {
    const loader = fakeLoader([]);
    expect(
      resolvePluginNames(loader, [{ name: 'tool-policy', enabled: false }], false, [
        { name: 'tool-policy' },
      ]),
    ).toEqual([]);
  });

  it('空 plugins 数组不回退默认集，但声明式条目仍可 opt-in', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(resolvePluginNames(loader, [], false, [{ name: 'tool-policy' }])).toEqual([
      'tool-policy',
    ]);
  });
});
