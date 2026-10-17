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
    expect(DEFAULT_TRANSPORT_OPTIONS).toEqual({
      kind: 'in-process',
      hostname: '127.0.0.1',
      peersDir: '~/.vessel/peers',
      heartbeatMs: 5000,
      peerTtlMs: 15000,
    });
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
  it('合法 loopback 配置', () => {
    expect(
      errorsOf({
        transport: {
          kind: 'loopback',
          hostname: '127.0.0.1',
          token: 'shared-token',
          peersDir: '/tmp/peers',
          heartbeatMs: 1000,
          peerTtlMs: 3000,
        },
      }),
    ).toHaveLength(0);
  });

  it('kind 非枚举报错', () => {
    expect(
      errorsOf({ transport: { kind: 'unix' as unknown as 'in-process' } }).map((e) => e.path),
    ).toContain('transport.kind');
  });

  it('只允许回环地址', () => {
    for (const hostname of ['0.0.0.0', '192.168.1.10', 'example.com']) {
      expect(errorsOf({ transport: { hostname } }).map((e) => e.path)).toContain(
        'transport.hostname',
      );
    }
    for (const hostname of ['127.0.0.1', 'localhost', '::1']) {
      expect(errorsOf({ transport: { hostname } })).toHaveLength(0);
    }
  });

  it('token / peersDir 必须非空', () => {
    expect(errorsOf({ transport: { token: ' ' } }).map((e) => e.path)).toContain('transport.token');
    expect(errorsOf({ transport: { peersDir: '' } }).map((e) => e.path)).toContain(
      'transport.peersDir',
    );
  });

  it('heartbeat / ttl 必须为正整数', () => {
    expect(errorsOf({ transport: { heartbeatMs: 0 } }).map((e) => e.path)).toContain(
      'transport.heartbeatMs',
    );
    expect(errorsOf({ transport: { peerTtlMs: -1 } }).map((e) => e.path)).toContain(
      'transport.peerTtlMs',
    );
  });

  it('peerTtlMs > heartbeatMs（含默认值补齐）', () => {
    expect(
      errorsOf({ transport: { heartbeatMs: 15000, peerTtlMs: 15000 } }).map((e) => e.path),
    ).toContain('transport.peerTtlMs');

    // 只写 heartbeat=20000，默认 ttl=15000 -> 交叉校验失败
    expect(errorsOf({ transport: { heartbeatMs: 20000 } }).map((e) => e.path)).toContain(
      'transport.peerTtlMs',
    );

    // 只写 heartbeat=1000，默认 ttl=15000 -> 合法
    expect(errorsOf({ transport: { heartbeatMs: 1000 } })).toHaveLength(0);
  });
});

describe('delegate.viaHost', () => {
  it('只接受 boolean', () => {
    expect(errorsOf({ delegate: { viaHost: true } })).toHaveLength(0);
    expect(
      errorsOf({ delegate: { viaHost: 'yes' as unknown as boolean } }).map((e) => e.path),
    ).toContain('delegate.viaHost');
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
  kind: loopback
  hostname: 127.0.0.1
  peers_dir: /tmp/peers
  heartbeat_ms: 1000
  peer_ttl_ms: 3000
delegate:
  via_host: true
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
    expect(config.transport).toEqual({
      kind: 'loopback',
      hostname: '127.0.0.1',
      peersDir: '/tmp/peers',
      heartbeatMs: 1000,
      peerTtlMs: 3000,
    });
    expect(config.delegate?.viaHost).toBe(true);
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
