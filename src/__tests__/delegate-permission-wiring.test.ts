/**
 * 0.8.2 Wave 2B1：delegate 工厂插件继承父 runtime 的 resolved 权限。
 *
 * 通过 mock 捕获 `createDelegateTaskPlugin` 的 options，验证装配层传入的
 * `permission.default` 与 `autoApprove` 和 runtime 一致（不再固定 allow）。
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { resolveTenantPaths } from '../../packages/core/src/index';

interface CapturedDelegateOptions {
  permission?: { default?: 'allow' | 'ask'; autoApprove?: string[] };
}

const captured: CapturedDelegateOptions[] = [];

mock.module('../../plugins/tools/delegate-task/src/index', () => ({
  createDelegateTaskPlugin: (options: CapturedDelegateOptions) => {
    captured.push(options);
    return {
      name: 'delegate-task',
      version: 'test',
      description: 'captured fake',
      install() {},
    };
  },
  default: () => {
    throw new Error('default export unused');
  },
}));

const { buildTenantRuntime } = await import('../tenant-runtime-factory');

const dirs: string[] = [];

afterEach(() => {
  captured.length = 0;
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-delegate-perm-'));
  dirs.push(dir);
  return dir;
}

async function buildWith(overrides: { headless?: boolean }): Promise<void> {
  const base = tmpDir();
  const config: VesselConfig = {
    delegate: { enabled: true },
    permission: { autoApprove: ['configured_tool'] },
  };
  const bundle = await buildTenantRuntime({
    tenantId: 'default',
    config,
    tenantPaths: resolveTenantPaths(base, 'default'),
    useMock: true,
    nodeId: 'node-test',
    ...(overrides.headless !== undefined ? { headless: overrides.headless } : {}),
  });
  try {
    expect(captured).toHaveLength(1);
  } finally {
    await bundle.close();
  }
}

describe('delegate task permission wiring', () => {
  it('passes the resolved interactive permission (ask + configured autoApprove)', async () => {
    await buildWith({});
    expect(captured[0]?.permission).toEqual({
      default: 'ask',
      autoApprove: ['configured_tool', 'ask_user'],
    });
  });

  it('passes the headless allow default', async () => {
    await buildWith({ headless: true });
    expect(captured[0]?.permission).toEqual({
      default: 'allow',
      autoApprove: ['configured_tool', 'ask_user'],
    });
  });
});
