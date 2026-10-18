/**
 * 多租户执行面（0.5 A-6）：每 tenant 独立实例、事件桥接、锁与回滚。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { MemoryEventStream } from '../../packages/core/src/index';
import {
  createTenantRuntimeFactory,
  listActiveTenantIds,
  loadTenantRuntimeConfig,
} from '../tenant-runtime-factory';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-tenant-factory-'));
  dirs.push(dir);
  return dir;
}

function writeConfig(base: string, body: string): { base: string; configPath: string } {
  const configPath = path.join(base, 'vessel.yaml');
  fs.writeFileSync(configPath, body, 'utf8');
  return { base, configPath };
}

function twoTenantYaml(extraTenant?: string): string {
  return [
    'provider:',
    '  name: openai',
    '  model: gpt-4',
    'observability:',
    '  metrics: true',
    '  event_history: 100',
    'tenant:',
    '  default: acme',
    '  tenants:',
    '    acme:',
    '      status: active',
    extraTenant ? '      config:' : '      config: {}',
    ...(extraTenant ? extraTenant.split('\n').map((line) => `        ${line}`) : []),
    '    work:',
    '      status: active',
    '      config: {}',
  ].join('\n');
}

describe('listActiveTenantIds', () => {
  it('keeps active tenants, drops disabled, and includes the resolved default', () => {
    const config: VesselConfig = {
      tenant: {
        default: 'acme',
        tenants: {
          acme: { status: 'active' },
          work: { status: 'active' },
          old: { status: 'disabled' },
        },
      },
    };
    expect(listActiveTenantIds(config)).toEqual(['acme', 'work']);
  });

  it('adds the implicit default tenant when it is not configured', () => {
    const config: VesselConfig = {
      tenant: { tenants: { acme: { status: 'active' } } },
    };
    expect(listActiveTenantIds(config)).toEqual(['acme', 'default']);
  });
});

describe('createTenantRuntimeFactory', () => {
  it('builds isolated surfaces and bridges tenant events to the shared stream', async () => {
    const base = tmpDir();
    const { configPath } = writeConfig(base, twoTenantYaml());
    const config = (await loadTenantRuntimeConfig('acme', { configPath }))?.config;
    expect(config).toBeDefined();

    const shared = new MemoryEventStream();
    const factory = await createTenantRuntimeFactory({
      config: config as VesselConfig,
      configPath,
      dataDir: base,
      useMock: true,
      nodeId: 'node-test',
      sharedEvents: shared,
    });

    try {
      expect(factory.tenantIds().sort()).toEqual(['acme', 'work']);

      const acme = factory.bundleFor('acme');
      const work = factory.bundleFor('work');
      expect(acme).toBeDefined();
      expect(work).toBeDefined();

      // 执行面实例互不共享。
      expect(acme?.session).not.toBe(work?.session);
      expect(acme?.context).not.toBe(work?.context);
      expect(acme?.pluginHost).not.toBe(work?.pluginHost);
      expect(acme?.events).not.toBe(work?.events);
      expect(acme?.metrics).not.toBe(work?.metrics);
      expect(acme?.config).not.toBe(work?.config);
      expect(factory.runtimeFor('acme')).toBe(acme?.runtime);
      expect(factory.pluginsFor('acme')).toEqual(
        acme?.plugins.map((plugin) => ({ name: plugin.name, enabled: true })),
      );
      expect(factory.pluginsFor('missing')).toBeUndefined();

      // 每个 tenant 持有自己的 writer lock。
      expect(fs.existsSync(path.join(base, 'tenants', 'acme', '.lock'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'tenants', 'work', '.lock'))).toBe(true);

      // 事件先进入本 tenant 流，再桥接到共享流并补 tenant_id。
      acme?.events.publish({
        type: 'run.started',
        run_id: 'run-acme',
        data: { input: 'hi' },
        ts: 1,
      });

      expect(acme?.events.getHistory().some((event) => event.run_id === 'run-acme')).toBe(true);
      expect(work?.events.getHistory().some((event) => event.run_id === 'run-acme')).toBe(false);

      const bridged = shared.getHistory().find((event) => event.run_id === 'run-acme');
      expect(bridged?.tenant_id).toBe('acme');

      // metrics 只订阅本 tenant 流。
      expect(acme?.metrics?.snapshot().runs.started).toBe(1);
      expect(work?.metrics?.snapshot().runs.started).toBe(0);
    } finally {
      await factory.closeAll();
    }

    // shutdown 释放全部锁。
    expect(fs.existsSync(path.join(base, 'tenants', 'acme', '.lock'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'tenants', 'work', '.lock'))).toBe(false);
  });

  it('rejects a duplicate feishu app_id across tenants before building', async () => {
    const base = tmpDir();
    const { configPath } = writeConfig(
      base,
      [
        'provider:',
        '  name: openai',
        '  model: gpt-4',
        'feishu:',
        '  enabled: true',
        '  app_id: cli_same',
        '  app_secret_env: VESSEL_TEST_FEISHU_SECRET',
        'tenant:',
        '  default: acme',
        '  tenants:',
        '    acme:',
        '      status: active',
        '      config: {}',
        '    work:',
        '      status: active',
        '      config: {}',
      ].join('\n'),
    );

    const savedSecret = process.env.VESSEL_TEST_FEISHU_SECRET;
    const savedAppId = process.env.VESSEL_FEISHU_APP_ID;
    process.env.VESSEL_TEST_FEISHU_SECRET = 'base_secret';
    delete process.env.VESSEL_FEISHU_APP_ID;
    try {
      const loaded = await loadTenantRuntimeConfig('acme', { configPath });
      expect(loaded).toBeDefined();

      await expect(
        createTenantRuntimeFactory({
          config: loaded?.config as VesselConfig,
          configPath,
          dataDir: base,
          useMock: true,
          nodeId: 'node-test',
        }),
      ).rejects.toMatchObject({ code: 'feishu_duplicate_app_id' });
    } finally {
      if (savedSecret === undefined) delete process.env.VESSEL_TEST_FEISHU_SECRET;
      else process.env.VESSEL_TEST_FEISHU_SECRET = savedSecret;
      if (savedAppId === undefined) delete process.env.VESSEL_FEISHU_APP_ID;
      else process.env.VESSEL_FEISHU_APP_ID = savedAppId;
    }

    expect(fs.existsSync(path.join(base, 'tenants', 'acme', '.lock'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'tenants', 'work', '.lock'))).toBe(false);
  });

  it('rolls back already-built tenants when a later tenant fails', async () => {
    const base = tmpDir();
    const missingWorkflowDir = path.join(base, 'missing-workflows').replaceAll('\\', '/');
    const { configPath } = writeConfig(
      base,
      [
        'provider:',
        '  name: openai',
        '  model: gpt-4',
        'tenant:',
        '  default: acme',
        '  tenants:',
        '    acme:',
        '      status: active',
        '      config: {}',
        '    work:',
        '      status: active',
        '      config:',
        '        workflow:',
        '          enabled: true',
        `          dir: ${missingWorkflowDir}`,
      ].join('\n'),
    );
    const loaded = await loadTenantRuntimeConfig('acme', { configPath });
    expect(loaded).toBeDefined();

    await expect(
      createTenantRuntimeFactory({
        config: loaded?.config as VesselConfig,
        configPath,
        dataDir: base,
        useMock: true,
        nodeId: 'node-test',
      }),
    ).rejects.toMatchObject({ code: 'workflow_invalid' });

    // acme 已建成，但失败时必须释放它的锁。
    expect(fs.existsSync(path.join(base, 'tenants', 'acme', '.lock'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'tenants', 'work', '.lock'))).toBe(false);
  });
});
