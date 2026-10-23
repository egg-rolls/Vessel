import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import {
  FileSessionBackend,
  MemoryEventStream,
  type RunEvent,
  resolveTenantPaths,
} from '../../packages/core/src/index';
import { resolveTenantPaths as asmTenantPaths } from '../data-paths';
import { resolveEvalsOutDir } from '../path-resolution';
import { resolveDurableOptions } from '../run-store-factory';
import { createSessionBackend } from '../session-factory';
import { installTrace, resolveTraceOptions } from '../trace-wiring';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-trace-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('session-factory (0.5)', () => {
  it('缺省 backend = file，并使用 tenant sessions 目录', () => {
    const backend = createSessionBackend(undefined, { tenantSessionsDir: '/tenant/sessions' });
    expect(backend).toBeInstanceOf(FileSessionBackend);
    expect((backend as unknown as { basePath: string }).basePath).toBe('/tenant/sessions');
  });

  it('显式 storagePath 优先于 tenant 目录', () => {
    const backend = createSessionBackend(
      { backend: 'file', storagePath: '/explicit/sessions' },
      { tenantSessionsDir: '/tenant/sessions' },
    );
    expect((backend as unknown as { basePath: string }).basePath).toBe('/explicit/sessions');
  });
});

describe('durable 默认路径 (0.5)', () => {
  it('显式 durable.path 优先，否则使用 tenant runs 目录', () => {
    expect(resolveDurableOptions({}, { tenantRunsDir: '/tenant/runs' }).path).toBe('/tenant/runs');
    expect(
      resolveDurableOptions(
        { durable: { path: '/explicit/runs' } },
        { tenantRunsDir: '/tenant/runs' },
      ).path,
    ).toBe('/explicit/runs');
  });
});

describe('evals tenant 最终路径 (0.5)', () => {
  it('缺省落到 tenant 目录，显式配置优先', () => {
    const tenantDir = path.resolve('/tenant/acme');
    expect(resolveEvalsOutDir({}, { tenantDir })).toBe(path.join(tenantDir, 'evals'));

    const customEvals = path.resolve('/custom/evals');
    expect(resolveEvalsOutDir({ evals: { outDir: customEvals } }, { tenantDir })).toBe(customEvals);
  });
});

describe('trace-wiring (0.5)', () => {
  function setup(level: 'full' | 'metadata' = 'full') {
    const dataDir = tempDir();
    const tenantPaths = asmTenantPaths(dataDir, 'acme');
    expect(tenantPaths).toEqual(resolveTenantPaths(dataDir, 'acme'));

    const events = new MemoryEventStream();
    const config: VesselConfig = { trace: { enabled: true, level } };
    const control = installTrace({ events, config, tenantPaths, tenantId: 'acme' });
    if (!control) throw new Error('trace control should be installed');
    return { tenantPaths, events, config, control };
  }

  function readLines(file: string): RunEvent[] {
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as RunEvent);
  }

  it('disabled / off 返回 undefined，零副作用', () => {
    const dataDir = tempDir();
    const tenantPaths = asmTenantPaths(dataDir, 'acme');
    const events = new MemoryEventStream();

    expect(
      installTrace({
        events,
        config: { trace: { enabled: false } },
        tenantPaths,
        tenantId: 'acme',
      }),
    ).toBeUndefined();
    expect(
      installTrace({
        events,
        config: { trace: { level: 'off' } },
        tenantPaths,
        tenantId: 'acme',
      }),
    ).toBeUndefined();
    expect(fs.existsSync(tenantPaths.events_dir)).toBe(false);
  });

  it('full 档落盘：seq 单调、tenant_id 补齐、密钥脱敏', async () => {
    const { tenantPaths, events, control } = setup('full');

    events.publish({
      type: 'run.started',
      run_id: 'run-1',
      data: { input: 'hi', api_key: 'sk-secret-value' },
      ts: 1000,
    });
    events.publish({
      type: 'run.completed',
      run_id: 'run-1',
      data: { status: 'ok' },
      ts: 1001,
    });

    await control.flush('run-1');
    const file = path.join(tenantPaths.events_dir, 'run-1.jsonl');
    const lines = readLines(file);

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.seq)).toEqual([1, 2]);
    expect(lines.every((line) => line.tenant_id === 'acme')).toBe(true);
    expect(lines[0]?.data.api_key).toBe('***');

    await control.close();
  });

  it('metadata 档只保留白名单字段', async () => {
    const { tenantPaths, events, control } = setup('metadata');

    events.publish({
      type: 'run.completed',
      run_id: 'run-meta',
      data: {
        status: 'ok',
        content: 'full message must be dropped',
        usage: { prompt_tokens: 3, total_tokens: 5 },
        error: 'boom',
      },
      ts: 2000,
    });

    await control.flush('run-meta');
    const [line] = readLines(path.join(tenantPaths.events_dir, 'run-meta.jsonl'));

    expect(line?.data.status).toBe('ok');
    expect(line?.data.content).toBeUndefined();
    expect(line?.data.usage).toEqual({ prompt_tokens: 3, total_tokens: 5 });
    expect(line?.data.error).toBe('boom');

    await control.close();
  });

  it('自定义 factory：wiring 负责 tenant_id、脱敏与终态 flush', async () => {
    const dataDir = tempDir();
    const tenantPaths = asmTenantPaths(dataDir, 'acme');
    const events = new MemoryEventStream();
    const appended: RunEvent[] = [];
    let flushes = 0;
    let factoryLevel = '';

    const control = installTrace({
      events,
      config: { trace: { enabled: true, level: 'full' } },
      tenantPaths,
      tenantId: 'acme',
      factory: ({ dir, level }) => {
        expect(dir).toBe(tenantPaths.events_dir);
        factoryLevel = level;
        return {
          append: (event) => appended.push(event),
          flush: async () => {
            flushes += 1;
          },
          close: async () => {},
        };
      },
    });

    expect(control).toBeDefined();
    events.publish({
      type: 'run.started',
      run_id: 'run-custom',
      data: { api_key: 'sk-custom-secret' },
      ts: 3000,
    });
    await Promise.resolve();

    expect(factoryLevel).toBe('full');
    expect(appended).toHaveLength(1);
    expect(appended[0]?.tenant_id).toBe('acme');
    expect(appended[0]?.data.api_key).toBe('***');

    events.publish({
      type: 'run.completed',
      run_id: 'run-custom',
      data: {},
      ts: 3001,
    });
    await Promise.resolve();
    expect(flushes).toBe(1);

    await control?.close();
  });

  it('prune 支持 dry-run：原文件保留，计数与真实删除一致', async () => {
    const dataDir = tempDir();
    const tenantPaths = asmTenantPaths(dataDir, 'acme');
    fs.mkdirSync(tenantPaths.events_dir, { recursive: true });

    const oldTs = Date.now() - 3 * 86_400_000;
    const oldFile = path.join(tenantPaths.events_dir, 'old.jsonl');
    const newFile = path.join(tenantPaths.events_dir, 'new.jsonl');
    fs.writeFileSync(
      oldFile,
      `${JSON.stringify({ type: 'run.completed', run_id: 'old', data: {}, ts: oldTs })}\n`,
    );
    fs.writeFileSync(
      newFile,
      `${JSON.stringify({
        type: 'run.completed',
        run_id: 'new',
        data: {},
        ts: Date.now(),
      })}\n`,
    );

    const events = new MemoryEventStream();
    const config: VesselConfig = { trace: { enabled: true, retentionDays: 1 } };
    expect(resolveTraceOptions(config).maxRuns).toBe(1000);

    const control = installTrace({ events, config, tenantPaths, tenantId: 'acme' });
    expect(control).toBeDefined();

    const dry = await control?.prune({ dryRun: true });
    expect(dry?.deleted_runs).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.existsSync(newFile)).toBe(true);

    const real = await control?.prune();
    expect(real?.deleted_runs).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);

    await control?.close();
  });
});
