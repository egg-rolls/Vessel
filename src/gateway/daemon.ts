/**
 * Gateway daemon 启动（0.12 DECISION-023 §2.1）。
 *
 * 父进程用 `Bun.spawn` 分离一个 `vessel gateway start` 前台子进程：
 * - stdio 追加到 `<dataDir>/logs/gateway.log`（0600）；
 * - 子进程自己写 `<dataDir>/gateway.pid`（实际端口）；
 * - 父进程只轮询 PID 文件，成功即退出；超时/子进程退出返回失败并 tail 日志。
 *
 * @module vessel/gateway/daemon
 */

import { type FileHandle, mkdir, open, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  type CommandRunner,
  type GatewayPidRecord,
  gatewayPidPath,
  isProcessAlive,
  readGatewayPidRecord,
  readGatewayPidState,
  removeGatewayPid,
} from './pid';

/** daemon 启动选项 */
export interface StartDaemonOptions {
  dataDir: string;
  /** 实例名；缺省 default（0.14） */
  instance?: string;
  /** `--log`；缺省 `<dataDir>/logs/gateway.log`（命名实例 gateway-<instance>.log） */
  logPath?: string;
  port?: number;
  host?: string;
  /** 等待子进程写 pid 的上限；缺省 15000ms */
  waitMs?: number;
  /** 测试注入 */
  spawn?: typeof Bun.spawn;
  sleep?: (ms: number) => Promise<void>;
  entryPath?: string;
  execPath?: string;
  /** 重复启动检查（缺省 true） */
  checkDuplicate?: boolean;
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
}

export type StartDaemonResult =
  | { ok: true; record: GatewayPidRecord; logPath: string }
  | {
      ok: false;
      error: 'already_running' | 'spawn_failed' | 'timeout' | 'exited';
      message: string;
      logPath: string;
      pid?: number;
      runningPid?: number;
    };

/** 默认日志路径：default → gateway.log；命名 → gateway-<instance>.log */
export function gatewayLogPath(dataDir: string, instance?: string): string {
  const name = instance === undefined || instance === '' ? 'default' : instance;
  return path.join(dataDir, 'logs', name === 'default' ? 'gateway.log' : `gateway-${name}.log`);
}

const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 100;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读日志尾部（缺省最后 4KB / 10 行），用于失败提示 */
export async function tailLog(logPath: string, maxLines = 10): Promise<string> {
  try {
    const raw = await readFile(logPath, 'utf8');
    const lines = raw.slice(-4000).split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/** 构造前台子进程 argv（去掉 --daemon，保留 port/host） */
export function buildDaemonArgv(options: {
  execPath: string;
  entryPath: string;
  instance?: string;
  port?: number;
  host?: string;
}): string[] {
  return [
    options.execPath,
    options.entryPath,
    'gateway',
    'start',
    ...(options.instance !== undefined ? ['--instance', options.instance] : []),
    ...(options.port !== undefined ? ['--port', String(options.port)] : []),
    ...(options.host !== undefined ? ['--host', options.host] : []),
  ];
}

/** 启动分离的 gateway 子进程并等待 PID 文件出现 */
export async function startGatewayDaemon(options: StartDaemonOptions): Promise<StartDaemonResult> {
  const instance = options.instance;
  const logPath = options.logPath ?? gatewayLogPath(options.dataDir, instance);

  if (options.checkDuplicate !== false) {
    // 存活 + 命令行匹配才算重复；死 pid / 不可解析 / PID 复用都回收。
    const state = await readGatewayPidState(options.dataDir, {
      ...(instance !== undefined ? { instance } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
    });
    if (state.kind === 'running') {
      return {
        ok: false,
        error: 'already_running',
        message: `gateway is already running (pid ${state.record.pid})`,
        logPath,
        runningPid: state.record.pid,
      };
    }
    if (state.kind !== 'absent') {
      await removeGatewayPid(options.dataDir, instance).catch(() => undefined);
    }
  }

  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  let handle: FileHandle;
  try {
    handle = await open(logPath, 'a', 0o600);
  } catch (error) {
    return {
      ok: false,
      error: 'spawn_failed',
      message: `failed to open log ${logPath}: ${error instanceof Error ? error.message : String(error)}`,
      logPath,
    };
  }

  const execPath = options.execPath ?? process.execPath;
  const entryPath = options.entryPath ?? process.argv[1];
  if (!entryPath) {
    await handle.close().catch(() => undefined);
    return {
      ok: false,
      error: 'spawn_failed',
      message: 'cannot resolve the vessel entry script (process.argv[1] is empty)',
      logPath,
    };
  }

  const argv = buildDaemonArgv({
    execPath,
    entryPath,
    ...(instance !== undefined ? { instance } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
  });
  const spawn = options.spawn ?? Bun.spawn;
  const sleep = options.sleep ?? defaultSleep;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(argv, {
      stdin: 'ignore',
      stdout: handle.fd,
      stderr: handle.fd,
      detached: true,
      env: process.env,
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    return {
      ok: false,
      error: 'spawn_failed',
      message: error instanceof Error ? error.message : String(error),
      logPath,
    };
  }
  child.unref?.();

  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  while (Date.now() < deadline) {
    const record = await readGatewayPidRecord(options.dataDir, instance);
    if (record && record.pid === child.pid && isProcessAlive(record.pid)) {
      await handle.close().catch(() => undefined);
      return { ok: true, record, logPath };
    }
    if (child.exitCode !== null) {
      await handle.close().catch(() => undefined);
      const tail = await tailLog(logPath);
      return {
        ok: false,
        error: 'exited',
        message: `gateway exited during startup (code ${child.exitCode})${tail ? `\n${tail}` : ''}`,
        logPath,
        pid: child.pid,
      };
    }
    await sleep(POLL_MS);
  }

  try {
    child.kill();
  } catch {
    // 已经退出
  }
  await handle.close().catch(() => undefined);
  const tail = await tailLog(logPath);
  return {
    ok: false,
    error: 'timeout',
    message:
      `gateway did not write ${gatewayPidPath(options.dataDir, instance)} within ` +
      `${options.waitMs ?? DEFAULT_WAIT_MS}ms` +
      (tail ? `\n${tail}` : ''),
    logPath,
    pid: child.pid,
  };
}
