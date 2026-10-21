/**
 * 多租户执行面（0.5 A-6）：每 tenant 独立实例、事件桥接、锁与回滚。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type { EventStream, TraceRedactor } from '../../packages/core/src/index';
import { createGatewayEventHub } from '../../packages/serve/src/index';
import { bootstrap } from '../bootstrap';
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

/** 只识别 GitHub token 的 fake ext redactor（core 默认不认识 ghp_）。 */
const FAKE_GITHUB_MASK = '[REDACTED_GITHUB_TOKEN]';
const fakeGithubRedactor: TraceRedactor = {
  redact(event) {
    return { ...event, data: maskGithubToken(event.data) as Record<string, unknown> };
  },
};

function maskGithubToken(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/ghp_[A-Za-z0-9]+/g, FAKE_GITHUB_MASK);
  }
  if (Array.isArray(value)) return value.map(maskGithubToken);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        maskGithubToken(entry),
      ]),
    );
  }
  return value;
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

    const hub = createGatewayEventHub();
    const factory = await createTenantRuntimeFactory({
      config: config as VesselConfig,
      configPath,
      dataDir: base,
      useMock: true,
      nodeId: 'node-test',
      hub,
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

      // file 后端默认 shared：每个 tenant 在 .members/ 下各有一个租约。
      expect(fs.readdirSync(path.join(base, 'tenants', 'acme', '.members'))).toHaveLength(1);
      expect(fs.readdirSync(path.join(base, 'tenants', 'work', '.members'))).toHaveLength(1);

      // 事件先进入本 tenant 流，再扇入 hub 并补 tenant_id。
      acme?.events.publish({
        type: 'run.started',
        run_id: 'run-acme',
        data: { input: 'hi' },
        ts: 1,
      });

      expect(acme?.events.getHistory().some((event) => event.run_id === 'run-acme')).toBe(true);
      expect(work?.events.getHistory().some((event) => event.run_id === 'run-acme')).toBe(false);

      const fannedIn = hub.since(0).find((item) => item.event.run_id === 'run-acme');
      expect(fannedIn?.event.tenant_id).toBe('acme');
      expect(hub.streamFor('acme')).toBe(acme?.events);
      expect(hub.streamFor('work')).toBe(work?.events);

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

  it('live hub 对 ext 才能识别的 GitHub token 脱敏——事件里不出现 ghp_', async () => {
    const base = tmpDir();
    const { configPath } = writeConfig(base, twoTenantYaml());
    const loaded = await loadTenantRuntimeConfig('acme', { configPath });
    expect(loaded).toBeDefined();

    const factory = await createTenantRuntimeFactory({
      config: loaded?.config as VesselConfig,
      configPath,
      dataDir: base,
      useMock: true,
      nodeId: 'node-test',
      redactor: fakeGithubRedactor,
    });

    try {
      const bundle = factory.bundleFor('acme');
      expect(bundle).toBeDefined();
      const hub = createGatewayEventHub({
        streams: [{ tenantId: 'acme', stream: bundle?.events as EventStream }],
        redactor: bundle?.redactor,
      });
      try {
        bundle?.events.publish({
          type: 'run.started',
          run_id: 'run-ghp',
          data: { input: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
          ts: 1,
        });

        const item = hub.since(0).find((entry) => entry.event.run_id === 'run-ghp');
        expect(item).toBeDefined();
        const serialized = JSON.stringify(item?.event);
        expect(serialized).not.toContain('ghp_');
        expect(serialized).toContain(FAKE_GITHUB_MASK);
      } finally {
        hub.close();
      }
    } finally {
      await factory.closeAll();
    }
  });

  it('所有 tenant 的 trace 与 live 使用同一 ext redactor 实例', async () => {
    const base = tmpDir();
    const { configPath } = writeConfig(base, twoTenantYaml());
    const loaded = await loadTenantRuntimeConfig('acme', { configPath });
    expect(loaded).toBeDefined();

    const factory = await createTenantRuntimeFactory({
      config: loaded?.config as VesselConfig,
      configPath,
      dataDir: base,
      useMock: true,
      nodeId: 'node-test',
      redactor: fakeGithubRedactor,
    });

    try {
      const bundles = ['acme', 'work'].map((tenantId) => factory.bundleFor(tenantId));
      for (const bundle of bundles) {
        expect(bundle).toBeDefined();
        expect(bundle?.extRedactor).toBe(fakeGithubRedactor);
        const redacted = bundle?.redactor.redact({
          type: 'run.started',
          run_id: 'run-shared-ext',
          data: { input: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
          ts: 1,
        });
        const serialized = JSON.stringify(redacted);
        expect(serialized).not.toContain('ghp_');
        expect(serialized).toContain(FAKE_GITHUB_MASK);
      }

      const work = factory.bundleFor('work');
      const hub = createGatewayEventHub({
        streams: [{ tenantId: 'work', stream: work?.events as EventStream }],
        redactor: work?.redactor,
      });
      try {
        work?.events.publish({
          type: 'run.started',
          run_id: 'run-work-ghp',
          data: { input: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
          ts: 1,
        });
        const item = hub.since(0).find((entry) => entry.event.run_id === 'run-work-ghp');
        expect(item).toBeDefined();
        const serialized = JSON.stringify(item?.event);
        expect(serialized).not.toContain('ghp_');
        expect(serialized).toContain(FAKE_GITHUB_MASK);
      } finally {
        hub.close();
      }
    } finally {
      await factory.closeAll();
    }
  });

  it('reuses a bootstrap-seeded tenant without rebuilding or closing it', async () => {
    const base = tmpDir();
    const { configPath } = writeConfig(base, twoTenantYaml());
    const result = await bootstrap({
      useMock: true,
      headless: true,
      configPath,
      tenantId: 'acme',
      dataDir: base,
      acquireLock: true,
    });
    expect(result.bundle).toBeDefined();

    const factory = await createTenantRuntimeFactory({
      config: result.config,
      configPath,
      dataDir: base,
      useMock: true,
      nodeId: 'node-test',
      seededTenants: [result.bundle as NonNullable<typeof result.bundle>],
    });

    try {
      expect(factory.tenantIds().sort()).toEqual(['acme', 'work']);
      expect(factory.runtimeFor('acme')).toBe(result.runtime);
      expect(fs.readdirSync(path.join(base, 'tenants', 'acme', '.members'))).toHaveLength(1);

      // work 由工厂构建并持 shared 租约；acme 的租约仍归 bootstrap。
      expect(fs.readdirSync(path.join(base, 'tenants', 'work', '.members'))).toHaveLength(1);
    } finally {
      await factory.closeAll();
    }

    expect(fs.readdirSync(path.join(base, 'tenants', 'work', '.members'))).toEqual([]);
    expect(fs.readdirSync(path.join(base, 'tenants', 'acme', '.members'))).toHaveLength(1);

    await result.shutdown();
    expect(fs.existsSync(path.join(base, 'tenants', 'acme', '.lock'))).toBe(false);
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
