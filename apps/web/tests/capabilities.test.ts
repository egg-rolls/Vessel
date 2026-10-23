import { describe, expect, test } from 'bun:test';
import type { CapabilityManifest } from '../src/gateway/types';
import {
  CAPABILITY_TABS,
  capabilityCounts,
  capabilityTabLabel,
  filterCapabilities,
  groupMethodsByPermission,
} from '../src/state/capabilities';

const MANIFEST: CapabilityManifest = {
  version: '0.6.0',
  config_schema_version: 3,
  methods: [
    { name: 'sessions.list', permission: 'read' },
    { name: 'runs.start', permission: 'write' },
    { name: 'tenants.list', permission: 'admin' },
    { name: 'sessions.get', permission: 'read' },
  ],
  tools: [
    { name: 'bash', description: 'Run a shell command' },
    { name: 'read', description: 'Read a file' },
  ],
  plugins: [
    { name: 'evals', enabled: true },
    { name: 'feishu', enabled: false },
  ],
};

describe('capabilityCounts', () => {
  test('counts methods, tools, plugins and permissions', () => {
    expect(capabilityCounts(MANIFEST)).toEqual({
      methods: 4,
      tools: 2,
      plugins: 2,
      enabledPlugins: 1,
      read: 2,
      write: 1,
      admin: 1,
    });
  });

  test('tab labels expose counts', () => {
    const counts = capabilityCounts(MANIFEST);
    expect(capabilityTabLabel('methods', counts)).toBe('方法 · 4');
    expect(capabilityTabLabel('plugins', counts)).toBe('插件 · 1/2');
    expect(CAPABILITY_TABS.map((tab) => tab.id)).toEqual(['methods', 'tools', 'plugins']);
  });
});

describe('filterCapabilities', () => {
  test('only returns the selected tab', () => {
    const result = filterCapabilities(MANIFEST, { tab: 'methods' });
    expect(result.methods).toHaveLength(4);
    expect(result.tools).toEqual([]);
    expect(result.plugins).toEqual([]);
  });

  test('search matches method names, tool descriptions and plugin names', () => {
    expect(
      filterCapabilities(MANIFEST, { tab: 'methods', query: 'sessions.' }).methods.map(
        (method) => method.name,
      ),
    ).toEqual(['sessions.list', 'sessions.get']);
    expect(
      filterCapabilities(MANIFEST, { tab: 'tools', query: 'file' }).tools.map((tool) => tool.name),
    ).toEqual(['read']);
    expect(
      filterCapabilities(MANIFEST, { tab: 'plugins', query: 'EVA' }).plugins.map(
        (plugin) => plugin.name,
      ),
    ).toEqual(['evals']);
  });

  test('empty result is representable', () => {
    const result = filterCapabilities(MANIFEST, { tab: 'tools', query: 'zzz' });
    expect(result.tools).toEqual([]);
  });
});

describe('groupMethodsByPermission', () => {
  test('orders read → write → admin and sorts names', () => {
    const groups = groupMethodsByPermission(MANIFEST.methods);
    expect(groups.map((group) => group.permission)).toEqual(['read', 'write', 'admin']);
    expect(groups[0]?.methods.map((method) => method.name)).toEqual([
      'sessions.get',
      'sessions.list',
    ]);
  });
});
