import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../cli-args';
import { acquireGatewayInstanceLock, GatewayInstanceLockedError } from '../gateway/instance-lock';
import {
  type CommandRunner,
  type GatewayPidRecord,
  gatewayPidFileName,
  gatewayPidPath,
  listGatewayPidStates,
  parseGatewayPid,
  writeGatewayPid,
} from '../gateway/pid';
import {
  deriveGatewayInstance,
  prepareForegroundGatewayStart,
  resolveGatewayTargets,
} from '../gateway-command';
import { getLocale, setLocale } from '../i18n';

let previousLocale: 'zh-CN' | 'en' = 'zh-CN';

beforeAll(() => {
  previousLocale = getLocale();
  setLocale('en');
});

afterAll(() => {
  setLocale(previousLocale);
});

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-gateway-multi-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const runningRunner: CommandRunner = async () => ({
  exitCode: 0,
  stdout: 'bun /repo/src/cli.ts gateway start --instance web',
  stderr: '',
});

const inspect = { platform: 'linux' as const, runCommand: runningRunner };

function record(overrides: Partial<GatewayPidRecord> = {}): GatewayPidRecord {
  return {
    pid: process.pid,
    started_at: new Date().toISOString(),
    host: '127.0.0.1',
    port: 8642,
    version: '0.14.0',
    ...overrides,
  };
}

function ok(argv: string[]) {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.args;
}

function err(argv: string[]) {
  const result = parseArgs(argv);
  if (result.ok) throw new Error('expected parse failure');
  return result.error;
}

describe('0.14 gateway PID layout', () => {
  it('default keeps gateway.pid; named uses gateway-<instance>.pid', () => {
    expect(gatewayPidFileName()).toBe('gateway.pid');
    expect(gatewayPidFileName('default')).toBe('gateway.pid');
    expect(gatewayPidFileName('web')).toBe('gateway-web.pid');
    expect(gatewayPidPath('/data')).toBe(path.join('/data', 'gateway.pid'));
    expect(gatewayPidPath('/data', 'web')).toBe(path.join('/data', 'gateway-web.pid'));
  });

  it('validates instance names and persists them', async () => {
    expect(parseGatewayPid(record({ instance: 'web' }))?.instance).toBe('web');
    expect(parseGatewayPid(record({ instance: '../x' }))).toBeNull();
    expect(parseGatewayPid(record({ instance: '' }))).toBeNull();

    const dir = tmpDir();
    await writeGatewayPid(dir, record({ port: 8643 }), 'web');
    const raw = JSON.parse(fs.readFileSync(gatewayPidPath(dir, 'web'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw.instance).toBe('web');
    expect(fs.existsSync(gatewayPidPath(dir))).toBe(false);
  });

  it('lists default + named instances and classifies them', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record({ port: 8642 }), 'default');
    await writeGatewayPid(dir, record({ port: 8643 }), 'web');
    fs.writeFileSync(path.join(dir, 'gateway-default.pid'), '{}');

    const entries = await listGatewayPidStates(dir, inspect);
    expect(entries.map((entry) => entry.instance)).toEqual(['default', 'web']);
    expect(entries.every((entry) => entry.state.kind === 'running')).toBe(true);
  });
});

describe('0.14 gateway selectors', () => {
  it('derives instance from explicit instance or port', () => {
    expect(deriveGatewayInstance()).toBe('default');
    expect(deriveGatewayInstance('web')).toBe('web');
    expect(deriveGatewayInstance(undefined, 8643)).toBe('8643');
    expect(deriveGatewayInstance('web', 0)).toBe('web');
  });

  it('requires an explicit instance for --port 0', () => {
    expect(err(['gateway', 'start', '--port', '0'])).toContain('requires --instance');
    expect(ok(['gateway', 'start', '--port', '0', '--instance', 'web']).gateway).toEqual({
      kind: 'start',
      daemon: false,
      port: 0,
      instance: 'web',
    });
  });

  it('parses stop/list/restart/reload selectors', () => {
    expect(ok(['gateway', 'stop', '--instance', 'web']).gateway).toEqual({
      kind: 'stop',
      timeoutMs: 10_000,
      instance: 'web',
    });
    expect(ok(['gateway', 'stop', '--all']).gateway).toMatchObject({ kind: 'stop', all: true });
    expect(ok(['gateway', 'list', '--json']).gateway).toEqual({ kind: 'list', json: true });
    expect(err(['gateway', 'stop', '--instance', 'web', '--all'])).toContain('only one of');
    expect(err(['gateway', 'restart', '--all'])).toContain('requires --daemon');
    expect(err(['gateway', 'reload', '--port', '0'])).toContain('Invalid --port');
  });

  it('reports multiple_instances without a selector', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record({ port: 8642 }), 'default');
    await writeGatewayPid(dir, record({ port: 8643 }), 'web');

    const multiple = await resolveGatewayTargets(dir, {}, inspect);
    expect(multiple.ok).toBe(false);
    if (!multiple.ok) {
      expect(multiple.code).toBe('multiple_instances');
      expect(multiple.error).toContain('default');
      expect(multiple.error).toContain('web');
    }

    const byInstance = await resolveGatewayTargets(dir, { instance: 'web' }, inspect);
    expect(byInstance.ok).toBe(true);
    if (byInstance.ok) {
      expect(byInstance.entries.map((entry) => entry.instance)).toEqual(['web']);
    }

    const byPort = await resolveGatewayTargets(dir, { port: 8643 }, inspect);
    expect(byPort.ok).toBe(true);
    if (byPort.ok) {
      expect(byPort.entries.map((entry) => entry.instance)).toEqual(['web']);
    }

    const all = await resolveGatewayTargets(dir, { all: true }, inspect);
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.entries).toHaveLength(2);
  });
});

describe('0.14 instance lock', () => {
  it('rejects a second holder and allows re-acquire after release', async () => {
    const dir = tmpDir();
    const first = await acquireGatewayInstanceLock({
      dataDir: dir,
      instance: 'web',
      pid: 111,
      isPidAlive: () => true,
    });
    await expect(
      acquireGatewayInstanceLock({
        dataDir: dir,
        instance: 'web',
        pid: 222,
        isPidAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(GatewayInstanceLockedError);
    await first.release();

    const second = await acquireGatewayInstanceLock({
      dataDir: dir,
      instance: 'web',
      pid: 333,
      isPidAlive: () => true,
    });
    await second.release();
  });

  it('reclaims a dead-pid lock', async () => {
    const dir = tmpDir();
    await acquireGatewayInstanceLock({ dataDir: dir, pid: 111, isPidAlive: () => true });
    const reclaimed = await acquireGatewayInstanceLock({
      dataDir: dir,
      pid: 222,
      isPidAlive: () => false,
    });
    await reclaimed.release();
  });
});

describe('0.14 foreground prepare', () => {
  it('acquires the instance lock for --serve/default', async () => {
    const dir = tmpDir();
    const prepared = await prepareForegroundGatewayStart({
      dataDir: dir,
      instance: 'default',
      config: {},
      platform: 'linux',
      runCommand: runningRunner,
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) await prepared.lock.release();
  });

  it('refuses a running default instead of overwriting its PID', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record({ pid: process.pid }), 'default');
    const prepared = await prepareForegroundGatewayStart({
      dataDir: dir,
      instance: 'default',
      config: {},
      platform: 'linux',
      runCommand: runningRunner,
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error).toContain('already running');
  });

  it('rejects a duplicate explicit node_id on another running instance', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record({ node_id: 'node-1' }), 'web');
    const prepared = await prepareForegroundGatewayStart({
      dataDir: dir,
      instance: 'default',
      config: { host: { nodeId: 'node-1' } },
      platform: 'linux',
      runCommand: runningRunner,
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error).toContain('duplicate_node_id');
  });
});
