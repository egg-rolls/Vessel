/**
 * Gateway PID 文件（0.12 DECISION-023 §2.1）。
 *
 * - 路径：`<dataDir>/gateway.pid`；JSON
 *   `{pid, started_at, host, port, version, node_id?}`；
 * - 原子写：同目录临时文件 0600 → rename；
 * - 存活判定：pid 存活**且**命令行匹配 gateway/serve 才算运行中；
 *   死 pid / 不可解析 / 命令行不匹配都按 stale 处理（可回收）。
 *
 * @module vessel/gateway/pid
 */

import * as fs from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** PID 文件内容（冻结字段；0.14 追加可选 instance） */
export interface GatewayPidRecord {
  pid: number;
  /** ISO-8601 */
  started_at: string;
  host: string;
  port: number;
  version: string;
  node_id?: string;
  /** 命名实例；缺省/旧文件视为 default（0.14） */
  instance?: string;
}

/** 读取 + 分类结果 */
export type GatewayPidState =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'stale'; reason: 'dead' | 'unreadable' | 'mismatch'; record: GatewayPidRecord }
  | { kind: 'running'; record: GatewayPidRecord };

/** 单个实例的 PID 发现结果（0.14） */
export interface GatewayPidEntry {
  instance: string;
  path: string;
  state: GatewayPidState;
}

/** 子进程命令结果（ps / powershell 探测用） */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 命令执行器（测试注入） */
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

/** 进程探测结果 */
export interface ProcessInfo {
  alive: boolean;
  /** 读不到命令行时为 undefined（按 stale 处理） */
  commandLine?: string;
}

/** 探测选项 */
export interface InspectProcessOptions {
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
  /** Linux /proc 读取注入 */
  readCmdline?: (pid: number) => Promise<string | undefined>;
}

/** PID 读取选项（0.14：instance） */
export interface ReadGatewayPidOptions extends InspectProcessOptions {
  /** 目标实例；缺省 default */
  instance?: string;
}

/** 默认实例名 */
export const DEFAULT_GATEWAY_INSTANCE = 'default';

/** 实例名字符集（不允许路径分隔符） */
const GATEWAY_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 是否为合法实例名 */
export function isValidGatewayInstance(value: string): boolean {
  return value === DEFAULT_GATEWAY_INSTANCE || GATEWAY_INSTANCE_RE.test(value);
}

/** 归一化实例名：空值 → default；非法抛错 */
export function normalizeGatewayInstance(instance?: string): string {
  if (instance === undefined || instance.trim() === '') return DEFAULT_GATEWAY_INSTANCE;
  const trimmed = instance.trim();
  if (!isValidGatewayInstance(trimmed)) {
    throw new Error(`invalid_instance: ${JSON.stringify(instance)}`);
  }
  return trimmed;
}

/** PID 文件名：default → gateway.pid；命名 → gateway-<instance>.pid */
export function gatewayPidFileName(instance?: string): string {
  const name = normalizeGatewayInstance(instance);
  return name === DEFAULT_GATEWAY_INSTANCE ? 'gateway.pid' : `gateway-${name}.pid`;
}

/** `<dataDir>/gateway.pid` 或 `<dataDir>/gateway-<instance>.pid` */
export function gatewayPidPath(dataDir: string, instance?: string): string {
  return path.join(dataDir, gatewayPidFileName(instance));
}

/** 默认命令执行器：Bun.spawn + 3s 超时 */
export const defaultCommandRunner: CommandRunner = async (argv) => {
  try {
    const proc = Bun.spawn(argv, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(3000),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch {
    return { exitCode: 1, stdout: '', stderr: '' };
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并解析 PID 记录；字段非法返回 null */
export function parseGatewayPid(raw: unknown): GatewayPidRecord | null {
  if (!isRecord(raw)) return null;
  const { pid, started_at, host, port, version, node_id, instance } = raw;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof started_at !== 'string' || Number.isNaN(Date.parse(started_at))) return null;
  if (typeof host !== 'string' || host.trim() === '') return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (typeof version !== 'string' || version === '') return null;
  if (node_id !== undefined && (typeof node_id !== 'string' || node_id === '')) return null;
  if (instance !== undefined) {
    if (typeof instance !== 'string' || !isValidGatewayInstance(instance)) return null;
  }
  return {
    pid,
    started_at,
    host,
    port,
    version,
    ...(node_id !== undefined ? { node_id } : {}),
    ...(instance !== undefined ? { instance } : {}),
  };
}

/** 进程是否存活（EPERM 视为存活） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 命令行是否像 Vessel gateway/serve（进程复用 PID 的保护） */
export function isGatewayCommandLine(commandLine: string): boolean {
  if (commandLine.trim() === '') return false;
  const vessel = /(^|[\\/\s])vessel(\.cmd|\.exe|\.js)?\b|src[\\/]cli\.(ts|js)\b|\bcli\.(ts|js)\b/i;
  if (!vessel.test(commandLine)) return false;
  return /\bgateway\b[\s\S]*\bstart\b|(?:^|\s)--serve\b/i.test(commandLine);
}

/** 读取 Linux /proc/<pid>/cmdline（NUL 分隔）；失败返回 undefined */
async function readLinuxCmdline(pid: number): Promise<string | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const text = raw
      .split('\0')
      .filter((part) => part !== '')
      .join(' ')
      .trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/** 探测进程存活与命令行 */
export async function inspectProcess(
  pid: number,
  options: InspectProcessOptions = {},
): Promise<ProcessInfo> {
  if (!isProcessAlive(pid)) return { alive: false };

  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultCommandRunner;
  let commandLine: string | undefined;

  if (platform === 'linux') {
    commandLine = await (options.readCmdline ?? readLinuxCmdline)(pid);
    if (commandLine === undefined) {
      const result = await runCommand(['ps', '-p', String(pid), '-o', 'command=']);
      commandLine = result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
    }
  } else if (platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
    const result = await runCommand([
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    commandLine = result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
  } else {
    const result = await runCommand(['ps', '-p', String(pid), '-o', 'command=']);
    commandLine = result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
  }

  return { alive: true, ...(commandLine !== undefined ? { commandLine } : {}) };
}

/** 按进程信息给 PID 记录分类 */
export function classifyGatewayPid(record: GatewayPidRecord, info: ProcessInfo): GatewayPidState {
  if (!info.alive) return { kind: 'stale', reason: 'dead', record };
  if (info.commandLine === undefined || info.commandLine.trim() === '') {
    return { kind: 'stale', reason: 'unreadable', record };
  }
  if (!isGatewayCommandLine(info.commandLine)) {
    return { kind: 'stale', reason: 'mismatch', record };
  }
  return { kind: 'running', record };
}

/** 只读取 PID 记录（不探测进程）；文件缺失/损坏返回 null */
export async function readGatewayPidRecord(
  dataDir: string,
  instance?: string,
): Promise<GatewayPidRecord | null> {
  try {
    const raw = await readFile(gatewayPidPath(dataDir, instance), 'utf8');
    return parseGatewayPid(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 读取指定路径并分类（内部；列表用） */
async function readGatewayPidStateAtPath(
  filePath: string,
  options: InspectProcessOptions = {},
): Promise<GatewayPidState> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'invalid JSON' };
  }
  const record = parseGatewayPid(parsed);
  if (!record) return { kind: 'invalid', reason: 'invalid pid file fields' };

  const info = await inspectProcess(record.pid, options);
  return classifyGatewayPid(record, info);
}

/** 读取并分类 PID 文件；文件不存在 → absent */
export async function readGatewayPidState(
  dataDir: string,
  options: ReadGatewayPidOptions = {},
): Promise<GatewayPidState> {
  const filePath = gatewayPidPath(dataDir, options.instance);
  return readGatewayPidStateAtPath(filePath, options);
}

/**
 * 列出 `<dataDir>` 下全部实例 PID（`gateway.pid` + `gateway-<instance>.pid`）。
 * 非规范文件名（如 `gateway-default.pid`）忽略；按 default 优先、实例名排序。
 */
export async function listGatewayPidStates(
  dataDir: string,
  options: InspectProcessOptions = {},
): Promise<GatewayPidEntry[]> {
  let names: string[];
  try {
    names = await readdir(dataDir);
  } catch {
    return [];
  }

  const found = new Map<string, string>();
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.pid')) continue;
    let instance: string | undefined;
    if (name === 'gateway.pid') {
      instance = DEFAULT_GATEWAY_INSTANCE;
    } else {
      const match = /^gateway-(.+)\.pid$/.exec(name);
      if (!match) continue;
      const candidate = match[1] ?? '';
      if (!isValidGatewayInstance(candidate)) continue;
      // `gateway-default.pid` 不是规范路径（default 固定 gateway.pid）。
      if (candidate === DEFAULT_GATEWAY_INSTANCE) continue;
      instance = candidate;
    }
    if (instance !== undefined && !found.has(instance)) {
      found.set(instance, path.join(dataDir, name));
    }
  }

  const entries: GatewayPidEntry[] = [];
  for (const [instance, filePath] of found) {
    entries.push({
      instance,
      path: filePath,
      state: await readGatewayPidStateAtPath(filePath, options),
    });
  }
  entries.sort((a, b) => {
    if (a.instance === b.instance) return 0;
    if (a.instance === DEFAULT_GATEWAY_INSTANCE) return -1;
    if (b.instance === DEFAULT_GATEWAY_INSTANCE) return 1;
    return a.instance < b.instance ? -1 : 1;
  });
  return entries;
}

/** 原子写 PID 文件（0600，同目录临时文件 + rename） */
export async function writeGatewayPid(
  dataDir: string,
  record: GatewayPidRecord,
  instance?: string,
): Promise<void> {
  const name = normalizeGatewayInstance(instance ?? record.instance);
  const filePath = gatewayPidPath(dataDir, name);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${gatewayPidFileName(name)}.${process.pid}.${Date.now()}.tmp`);
  const base: GatewayPidRecord = {
    pid: record.pid,
    started_at: record.started_at,
    host: record.host,
    port: record.port,
    version: record.version,
    ...(record.node_id !== undefined ? { node_id: record.node_id } : {}),
  };
  const stored: GatewayPidRecord =
    name === DEFAULT_GATEWAY_INSTANCE ? base : { ...base, instance: name };
  const body = `${JSON.stringify(stored, null, 2)}\n`;

  await writeFile(tmp, body, { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    // Windows 上 chmod 只影响 readonly 位；忽略
  }
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  try {
    await chmod(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/** 删除 PID 文件（不存在视为成功） */
export async function removeGatewayPid(dataDir: string, instance?: string): Promise<void> {
  try {
    await unlink(gatewayPidPath(dataDir, instance));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** 同步删除：仅当文件属于 `pid`（process 'exit' 钩子用） */
export function removeGatewayPidIfOwnedSync(dataDir: string, pid: number, instance?: string): void {
  try {
    const filePath = gatewayPidPath(dataDir, instance);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { pid?: unknown };
    if (parsed.pid === pid) fs.unlinkSync(filePath);
  } catch {
    // 文件不存在 / 损坏 / 实例名非法 / 无权限：退出路径不抛错
  }
}
