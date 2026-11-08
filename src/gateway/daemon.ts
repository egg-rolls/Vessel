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
  cleanupGatewayStateEntry,
  collectGatewayState,
  type GatewayPidRecord,
  type GatewayStateSnapshot,
  gatewayPidPath,
  isProcessAlive,
  normalizeGatewayInstance,
  readGatewayPidRecord,
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
  /**
   * 0.49 G1：前台子命令族。`gateway`（缺省）或 `node`；两者复用同一
   * PID/实例锁形状，`node` 只启动 Node API 监听。
   */
  command?: 'gateway' | 'node';
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
  /** 调用方已收集的状态快照；缺省自行 collect。 */
  state?: GatewayStateSnapshot;
}

export type StartDaemonResult =
  | { ok: true; record: GatewayPidRecord; logPath: string; unconfirmed?: true }
  | {
      ok: false;
      error: 'already_running' | 'state_unknown' | 'spawn_failed' | 'timeout' | 'exited';
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
  command?: 'gateway' | 'node';
}): string[] {
  return [
    options.execPath,
    options.entryPath,
    options.command ?? 'gateway',
    'start',
    // `node start` 只支持 `[--daemon]`；实例固定为 default（共享同一 PID/锁）。
    ...(options.instance !== undefined && (options.command ?? 'gateway') === 'gateway'
      ? ['--instance', options.instance]
      : []),
    ...(options.port !== undefined ? ['--port', String(options.port)] : []),
    ...(options.host !== undefined ? ['--host', options.host] : []),
  ];
}

/** 启动分离的 gateway 子进程并等待 PID 文件出现 */
export async function startGatewayDaemon(options: StartDaemonOptions): Promise<StartDaemonResult> {
  const instance = options.instance;
  const normalizedInstance = normalizeGatewayInstance(instance);
  const logPath = options.logPath ?? gatewayLogPath(options.dataDir, instance);

  if (options.checkDuplicate !== false) {
    // 消费统一状态视图：running/degraded/starting 拒绝且不删；stale 条件清理；
    // unknown/foreign-host 拒绝且不删。
    const state = options.state ?? (await collectGatewayState(options.dataDir));
    const entry = state.entries.find((item) => item.instance === normalizedInstance);
    if (entry !== undefined) {
      const pid = entry.record?.pid ?? entry.lock?.pid;
      if (entry.state === 'running' || entry.state === 'degraded' || entry.state === 'starting') {
        return {
          ok: false,
          error: 'already_running',
          message: `gateway is already running (pid ${pid ?? 0})`,
          logPath,
          ...(pid !== undefined ? { runningPid: pid } : {}),
        };
      }
      if (entry.state === 'unknown' || entry.state === 'foreign-host') {
        return {
          ok: false,
          error: 'state_unknown',
          message:
            entry.state === 'unknown'
              ? 'gateway state could not be confirmed; no files were deleted'
              : `gateway lock belongs to another host (${entry.lock?.host ?? 'unknown'}); no files were deleted`,
          logPath,
        };
      }
      if (entry.state === 'stale') {
        await cleanupGatewayStateEntry(options.dataDir, entry).catch(() => undefined);
      }
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
    ...(options.instance !== undefined ? { instance: options.instance } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.command !== undefined ? { command: options.command } : {}),
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

  // 超时后对账：PID 文件已出现且进程仍活 → 视为已启动但未确认，留给用户查看。
  const raced = await readGatewayPidRecord(options.dataDir, instance);
  if (raced !== null && raced.pid === child.pid && isProcessAlive(raced.pid)) {
    return { ok: true, record: raced, logPath, unconfirmed: true };
  }

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
