import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG,
  DEFAULT_SCHEDULER_OPTIONS,
  DEFAULT_TRANSPORT_OPTIONS,
} from '../src/defaults';
import { loadConfig } from '../src/loader';
import type { VesselConfig } from '../src/types';
import { validateConfig } from '../src/validator';

// 隔离 VESSEL_* 环境变量
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('VESSEL_')) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});

function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-02-cfg-'));
  const file = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function missingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-02-missing-'));
  return path.join(dir, 'does-not-exist.yaml');
}

/** 直接校验一个 config 片段 */
function errorsOf(config: VesselConfig) {
  return validateConfig(config).errors;
}

describe('0.2 默认值（保持 0.1 行为）', () => {
  it('DEFAULT_CONFIG 不注入 host/scheduler/transport', () => {
    expect(DEFAULT_CONFIG.host).toBeUndefined();
    expect(DEFAULT_CONFIG.scheduler).toBeUndefined();
    expect(DEFAULT_CONFIG.transport).toBeUndefined();
  });

  it('scheduler / transport 常量固定', () => {
    expect(DEFAULT_SCHEDULER_OPTIONS).toEqual({
      maxConcurrency: 1,
      maxQueueSize: 100,
      perAgentSerial: true,
    });
    expect(DEFAULT_TRANSPORT_OPTIONS).toEqual({ kind: 'in-process' });
  });

  it('全缺省加载：新键为 undefined，校验无 error', async () => {
    const { config, validation } = await loadConfig({
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });
    expect(config.host).toBeUndefined();
    expect(config.scheduler).toBeUndefined();
    expect(config.transport).toBeUndefined();
    expect(validation.errors).toHaveLength(0);
  });
});

describe('host', () => {
  it('合法 host', () => {
    expect(
      errorsOf({
        host: { enabled: true, nodeId: 'node-a', limits: { requestLimit: 10 } },
      }),
    ).toHaveLength(0);
  });

  it('enabled 非 boolean 报错', () => {
    expect(
      errorsOf({ host: { enabled: 'yes' as unknown as boolean } }).map((e) => e.path),
    ).toContain('host.enabled');
  });

  it('nodeId 字符集与长度', () => {
    for (const nodeId of ['', 'a:b', 'bad space', 'x'.repeat(65)]) {
      expect(errorsOf({ host: { nodeId } }).map((e) => e.path)).toContain('host.nodeId');
    }
    expect(errorsOf({ host: { nodeId: 'node_1-A' } })).toHaveLength(0);
  });

  it('host.limits 非负', () => {
    expect(errorsOf({ host: { limits: { requestLimit: -1 } } }).map((e) => e.path)).toContain(
      'host.limits.requestLimit',
    );
  });
});

describe('scheduler', () => {
  it('合法 scheduler', () => {
    expect(
      errorsOf({ scheduler: { maxConcurrency: 2, maxQueueSize: 50, perAgentSerial: false } }),
    ).toHaveLength(0);
  });

  it('非正整数报错', () => {
    expect(errorsOf({ scheduler: { maxConcurrency: 0 } }).map((e) => e.path)).toContain(
      'scheduler.maxConcurrency',
    );
    expect(errorsOf({ scheduler: { maxQueueSize: 1.5 } }).map((e) => e.path)).toContain(
      'scheduler.maxQueueSize',
    );
    expect(
      errorsOf({ scheduler: { perAgentSerial: 'yes' as unknown as boolean } }).map((e) => e.path),
    ).toContain('scheduler.perAgentSerial');
  });
});

describe('transport', () => {
  it('只接受 in-process', () => {
    expect(errorsOf({ transport: { kind: 'in-process' } })).toHaveLength(0);
    for (const kind of ['loopback', 'remote', 'unix']) {
      expect(
        errorsOf({ transport: { kind: kind as unknown as 'in-process' } }).map((e) => e.path),
      ).toContain('transport.kind');
    }
  });

  it('token 必须非空', () => {
    expect(errorsOf({ transport: { token: ' ' } }).map((e) => e.path)).toContain('transport.token');
  });
});

describe('YAML 映射与未知键', () => {
  it('snake_case 映射到 camelCase', async () => {
    const configPath = tmpYaml(`
host:
  enabled: true
  node_id: node-a
scheduler:
  max_concurrency: 2
  max_queue_size: 50
  per_agent_serial: false
transport:
  kind: in-process
`);
    const { config, validation } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
    });
    expect(validation.errors).toHaveLength(0);
    expect(config.host).toEqual({ enabled: true, nodeId: 'node-a' });
    expect(config.scheduler).toEqual({
      maxConcurrency: 2,
      maxQueueSize: 50,
      perAgentSerial: false,
    });
    expect(config.transport).toEqual({ kind: 'in-process' });
  });

  it('未知顶层键报错并给建议', async () => {
    const configPath = tmpYaml('hostt:\n  enabled: true\n');
    const { validation } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
    });
    const error = validation.errors.find((e) => e.path === 'hostt');
    expect(error).toBeDefined();
    expect(error?.message).toContain('Did you mean "host"');
  });
});
