import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyGatewayPid,
  type GatewayPidRecord,
  gatewayPidPath,
  isGatewayCommandLine,
  isProcessAlive,
  parseGatewayPid,
  readGatewayPidRecord,
  readGatewayPidState,
  removeGatewayPidIfOwnedSync,
  writeGatewayPid,
} from '../gateway/pid';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-gateway-pid-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const DEAD_PID = 2_147_483_647;

function record(overrides: Partial<GatewayPidRecord> = {}): GatewayPidRecord {
  return {
    pid: process.pid,
    started_at: new Date().toISOString(),
    host: '127.0.0.1',
    port: 8642,
    version: '0.12.0',
    ...overrides,
  };
}

describe('parseGatewayPid', () => {
  it('接受合法记录', () => {
    const input = record();
    expect(parseGatewayPid(input)).toEqual(input);
    expect(parseGatewayPid({ ...input, node_id: 'node-1' })?.node_id).toBe('node-1');
  });

  it('拒绝非法字段', () => {
    expect(parseGatewayPid(null)).toBeNull();
    expect(parseGatewayPid({})).toBeNull();
    expect(parseGatewayPid({ ...record(), pid: 0 })).toBeNull();
    expect(parseGatewayPid({ ...record(), pid: 1.5 })).toBeNull();
    expect(parseGatewayPid({ ...record(), started_at: 'nope' })).toBeNull();
    expect(parseGatewayPid({ ...record(), host: '' })).toBeNull();
    expect(parseGatewayPid({ ...record(), port: 70_000 })).toBeNull();
    expect(parseGatewayPid({ ...record(), version: '' })).toBeNull();
    expect(parseGatewayPid({ ...record(), node_id: 1 })).toBeNull();
  });
});

describe('PID 文件读写', () => {
  it('原子写 JSON 且 0600（POSIX）', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record({ pid: 4321, node_id: 'n1' }));

    const filePath = gatewayPidPath(dir);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as GatewayPidRecord;
    expect(parsed.pid).toBe(4321);
    expect(parsed.node_id).toBe('n1');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('覆盖写与只读记录', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record({ pid: 1 }));
    await writeGatewayPid(dir, record({ pid: 2 }));
    expect((await readGatewayPidRecord(dir))?.pid).toBe(2);
  });

  it('缺失/损坏文件', async () => {
    const dir = tmpDir();
    expect(await readGatewayPidRecord(dir)).toBeNull();
    expect((await readGatewayPidState(dir)).kind).toBe('absent');

    fs.writeFileSync(gatewayPidPath(dir), '{not json');
    expect((await readGatewayPidState(dir)).kind).toBe('invalid');
  });
});

describe('进程分类', () => {
  it('存活 + 命令行匹配 = running', () => {
    const state = classifyGatewayPid(record(), {
      alive: true,
      commandLine: 'bun /repo/src/cli.ts gateway start --port 8642',
    });
    expect(state.kind).toBe('running');
  });

  it('死 pid = stale/dead', () => {
    const input = record({ pid: DEAD_PID });
    const state = classifyGatewayPid(input, { alive: false });
    expect(state).toEqual({ kind: 'stale', reason: 'dead', record: input });
  });

  it('读不到命令行 = stale/unreadable（契约：不可解析自动回收）', () => {
    const state = classifyGatewayPid(record(), { alive: true });
    expect(state.kind).toBe('stale');
    if (state.kind === 'stale') expect(state.reason).toBe('unreadable');
  });

  it('PID 被其它进程复用 = stale/mismatch', () => {
    const state = classifyGatewayPid(record(), {
      alive: true,
      commandLine: 'node /usr/lib/other-service.js',
    });
    expect(state.kind).toBe('stale');
    if (state.kind === 'stale') expect(state.reason).toBe('mismatch');
  });

  it('命令行识别 gateway start / --serve', () => {
    expect(isGatewayCommandLine('/usr/local/bin/vessel gateway start')).toBe(true);
    expect(isGatewayCommandLine('bun /repo/src/cli.ts gateway start --daemon')).toBe(true);
    expect(isGatewayCommandLine('bun /repo/src/cli.ts --serve 8642')).toBe(true);
    expect(isGatewayCommandLine('C:\\bin\\vessel.cmd gateway start')).toBe(true);
    expect(isGatewayCommandLine('node /usr/lib/other-service.js')).toBe(false);
    expect(isGatewayCommandLine('')).toBe(false);
    expect(isGatewayCommandLine('vessel doctor')).toBe(false);
  });
});

describe('readGatewayPidState', () => {
  it('存活进程 + 可读命令行 → running（注入 /proc 读取）', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record({ pid: process.pid }));
    const state = await readGatewayPidState(dir, {
      platform: 'linux',
      readCmdline: async () => 'bun /repo/src/cli.ts gateway start',
    });
    expect(state.kind).toBe('running');
  });

  it('死 pid → stale/dead', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record({ pid: DEAD_PID }));
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    const state = await readGatewayPidState(dir, { platform: 'linux' });
    expect(state.kind).toBe('stale');
    if (state.kind === 'stale') expect(state.reason).toBe('dead');
  });
});

describe('removeGatewayPidIfOwnedSync', () => {
  it('只删除本进程持有的 PID 文件', async () => {
    const dir = tmpDir();
    await writeGatewayPid(dir, record({ pid: process.pid }));
    removeGatewayPidIfOwnedSync(dir, process.pid);
    expect(fs.existsSync(gatewayPidPath(dir))).toBe(false);

    await writeGatewayPid(dir, record({ pid: process.pid + 1 }));
    removeGatewayPidIfOwnedSync(dir, process.pid);
    expect(fs.existsSync(gatewayPidPath(dir))).toBe(true);
  });
});
