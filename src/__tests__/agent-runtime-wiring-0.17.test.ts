/**
 * 0.17 A4 执行面装配：任何入口都不再构造 team / delegate 插件。
 *
 * 故障形态：serve / headless 仍装配旧 team_* / delegate_task（模型看到与
 * AgentService 重复的生命周期工具）。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { resolveTenantPaths } from '../../packages/core/src/index';
import { buildTenantRuntime, type TenantRuntimeBundle } from '../tenant-runtime-factory';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-agent-wiring-'));
  dirs.push(dir);
  return dir;
}

async function buildBundle(config: VesselConfig, headless: boolean): Promise<TenantRuntimeBundle> {
  return buildTenantRuntime({
    tenantId: 'default',
    config: { plugins: [], ...config },
    tenantPaths: resolveTenantPaths(tmpDir(), 'default'),
    useMock: true,
    headless,
    nodeId: 'node-test',
  });
}

function pluginNames(bundle: TenantRuntimeBundle): string[] {
  return bundle.plugins.map((plugin) => plugin.name);
}

function hookNames(bundle: TenantRuntimeBundle): string[] {
  return bundle.pluginHost.getHooks().map((hook) => hook.name);
}

function toolNames(bundle: TenantRuntimeBundle): string[] {
  return bundle.pluginHost.listTools().map((tool) => tool.name);
}

describe('agent runtime wiring 0.17', () => {
  it('does not construct team/delegate plugins with agent.enabled', async () => {
    const bundle = await buildBundle({ agent: { enabled: true } }, false);
    try {
      expect(pluginNames(bundle)).not.toContain('team');
      expect(pluginNames(bundle)).not.toContain('delegate-task');
      expect(hookNames(bundle)).not.toContain('agent-reply-injection');
      expect(toolNames(bundle)).toEqual([]);
    } finally {
      await bundle.close();
    }
  });

  it('does not construct team/delegate plugins for interactive serve', async () => {
    const bundle = await buildBundle({}, false);
    try {
      expect(pluginNames(bundle)).not.toContain('team');
      expect(pluginNames(bundle)).not.toContain('delegate-task');
      expect(toolNames(bundle)).toEqual([]);
    } finally {
      await bundle.close();
    }
  });

  it('does not construct team/delegate plugins for headless', async () => {
    const bundle = await buildBundle({}, true);
    try {
      expect(pluginNames(bundle)).not.toContain('team');
      expect(pluginNames(bundle)).not.toContain('delegate-task');
      expect(toolNames(bundle)).toEqual([]);
    } finally {
      await bundle.close();
    }
  });
});
