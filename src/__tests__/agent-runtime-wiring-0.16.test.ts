/**
 * 0.16 装配面：agent 开关必须真的改变注册结果。
 *
 * 故障形态：纯函数判定正确，但 buildTenantRuntime 忘了注册回复注入 hook
 * 或仍构造 delegate_task，导致交互入口看不到回复 / 模型看到两个 schema。
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
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
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

describe('agent runtime wiring', () => {
  it('interactive: exposes one agent schema, hides team_*, injects replies', async () => {
    const bundle = await buildBundle({}, false);
    try {
      const tools = toolNames(bundle);
      expect(tools).toHaveLength(1);
      expect(tools).toEqual(['agent']);
      expect(tools).not.toContain('delegate_task');
      expect(pluginNames(bundle)).toContain('team');
      expect(pluginNames(bundle)).not.toContain('delegate-task');
      expect(hookNames(bundle)).toContain('agent-reply-injection');
    } finally {
      await bundle.close();
    }
  });

  it('interactive with legacyTools=true: restores every team_* tool', async () => {
    const bundle = await buildBundle({ team: { legacyTools: true } }, false);
    try {
      const tools = toolNames(bundle);
      expect(tools).toHaveLength(6);
      expect(tools).toContain('agent');
      expect(tools.filter((name) => name.startsWith('team_'))).toHaveLength(5);
      expect(tools).not.toContain('delegate_task');
    } finally {
      await bundle.close();
    }
  });

  it('headless default: keeps delegate_task and does not register reply injection', async () => {
    const bundle = await buildBundle({}, true);
    try {
      expect(toolNames(bundle)).toHaveLength(1);
      expect(toolNames(bundle)).toContain('delegate_task');
      expect(toolNames(bundle)).not.toContain('agent');
      expect(pluginNames(bundle)).toContain('delegate-task');
      expect(pluginNames(bundle)).not.toContain('team');
      expect(hookNames(bundle)).not.toContain('agent-reply-injection');
    } finally {
      await bundle.close();
    }
  });

  it('headless with team.enabled: keeps only agent, never delegate_task', async () => {
    const bundle = await buildBundle({ team: { enabled: true } }, true);
    try {
      const tools = toolNames(bundle);
      expect(tools).toHaveLength(1);
      expect(tools).toEqual(['agent']);
      expect(tools).not.toContain('delegate_task');
      expect(pluginNames(bundle)).not.toContain('delegate-task');
      expect(hookNames(bundle)).toContain('agent-reply-injection');
    } finally {
      await bundle.close();
    }
  });

  it('headless with agent.enabled: swaps delegate_task for agent and enables injection', async () => {
    const bundle = await buildBundle({ agent: { enabled: true } }, true);
    try {
      expect(toolNames(bundle)).toHaveLength(1);
      expect(toolNames(bundle)).toEqual(['agent']);
      expect(toolNames(bundle)).not.toContain('delegate_task');
      expect(pluginNames(bundle)).toContain('team');
      expect(pluginNames(bundle)).not.toContain('delegate-task');
      expect(hookNames(bundle)).toContain('agent-reply-injection');
    } finally {
      await bundle.close();
    }
  });
});
