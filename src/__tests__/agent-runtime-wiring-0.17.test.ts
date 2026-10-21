/**
 * 0.17 装配面：入口决定是否构造旧 team / delegate 插件。
 *
 * 守：bootstrap 已经由 AgentService 接管后仍然构造 team 插件（模型看到重复的
 * agent / team_* schema）；或反过来把 serve 的旧装配提前拆掉（A3c 之前 gateway 失去工具）。
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

async function buildBundle(
  config: VesselConfig,
  headless: boolean,
  legacyAgentPlugins?: boolean,
): Promise<TenantRuntimeBundle> {
  return buildTenantRuntime({
    tenantId: 'default',
    config: { plugins: [], ...config },
    tenantPaths: resolveTenantPaths(tmpDir(), 'default'),
    useMock: true,
    headless,
    nodeId: 'node-test',
    ...(legacyAgentPlugins !== undefined ? { legacyAgentPlugins } : {}),
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
  it('bootstrap-style bundle does not construct team/delegate plugins', async () => {
    const bundle = await buildBundle({ agent: { enabled: true } }, false, false);
    try {
      expect(pluginNames(bundle)).not.toContain('team');
      expect(pluginNames(bundle)).not.toContain('delegate-task');
      expect(hookNames(bundle)).not.toContain('agent-reply-injection');
      expect(toolNames(bundle)).toEqual([]);
    } finally {
      await bundle.close();
    }
  });

  it('serve-style bundle keeps the legacy team assembly until A3c', async () => {
    const bundle = await buildBundle({}, false);
    try {
      expect(toolNames(bundle)).toEqual(['agent']);
      expect(pluginNames(bundle)).toContain('team');
      expect(hookNames(bundle)).toContain('agent-reply-injection');
    } finally {
      await bundle.close();
    }
  });

  it('serve-style headless bundle keeps delegate_task until A4', async () => {
    const bundle = await buildBundle({}, true);
    try {
      expect(toolNames(bundle)).toEqual(['delegate_task']);
      expect(pluginNames(bundle)).toContain('delegate-task');
    } finally {
      await bundle.close();
    }
  });
});
