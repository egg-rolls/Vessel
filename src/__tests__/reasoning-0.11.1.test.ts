/**
 * 思考流接线（0.11.1 DECISION-022 §2.3）：
 * `ui.showReasoning` → `AgentRuntime.create({ includeReasoning })`。
 *
 * core 尚未合并该字段，这里只验证装配层把配置原样传下去（结构化类型）。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { AgentRuntime, resolveTenantPaths } from '../../packages/core/src/index';
import { includeReasoningFor, withReasoning } from '../reasoning';
import { buildTenantRuntime, type TenantRuntimeBundle } from '../tenant-runtime-factory';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-reasoning-'));
  dirs.push(dir);
  return dir;
}

describe('withReasoning（0.11.1）', () => {
  it('只有显式 true 才开启', () => {
    expect(includeReasoningFor({})).toBe(false);
    expect(includeReasoningFor({ ui: {} })).toBe(false);
    expect(includeReasoningFor({ ui: { showReasoning: false } })).toBe(false);
    expect(includeReasoningFor({ ui: { showReasoning: true } })).toBe(true);
  });

  it('保留原选项并补 includeReasoning', () => {
    expect(withReasoning({}, { model: 'm' })).toEqual({ model: 'm', includeReasoning: false });
    expect(withReasoning({ ui: { showReasoning: true } }, { model: 'm' })).toEqual({
      model: 'm',
      includeReasoning: true,
    });
  });
});

describe('buildTenantRuntime 注入 includeReasoning（0.11.1）', () => {
  async function captureRuntimeOptions(
    config: VesselConfig,
  ): Promise<Array<Record<string, unknown>>> {
    const captured: Array<Record<string, unknown>> = [];
    const originalCreate = AgentRuntime.create;
    AgentRuntime.create = (async (options: Parameters<typeof originalCreate>[0]) => {
      captured.push(options as unknown as Record<string, unknown>);
      return originalCreate.call(AgentRuntime, options);
    }) as typeof AgentRuntime.create;

    let bundle: TenantRuntimeBundle | undefined;
    try {
      const base = tmpDir();
      bundle = await buildTenantRuntime({
        tenantId: 'default',
        config: { plugins: [], ...config },
        tenantPaths: resolveTenantPaths(base, 'default'),
        useMock: true,
        nodeId: 'node-test',
      });
    } finally {
      AgentRuntime.create = originalCreate;
      await bundle?.close();
    }
    return captured;
  }

  it('ui.showReasoning=true 时传 includeReasoning=true', async () => {
    const captured = await captureRuntimeOptions({ ui: { showReasoning: true } });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.includeReasoning).toBe(true);
  });

  it('未配置 showReasoning 时传 false（0.11.0 行为）', async () => {
    const captured = await captureRuntimeOptions({});
    expect(captured).toHaveLength(1);
    expect(captured[0]?.includeReasoning).toBe(false);
  });
});
