/** Gateway PID state files (0.35): atomic records, compare-and-delete, collectGatewayState. */
import * as fs from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isLoopbackHostname } from '../../packages/config/src/index';
import { createHttpRpcClient } from '../rpc/http-client';
export interface GatewayPidRecord {
  pid: number;
  started_at: string;
  host: string;
  port: number;
  version: string;
  node_id?: string;
  instance?: string;
}
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;
export interface ProcessInfo {
  alive: boolean;
  commandLine?: string;
}
export interface InspectProcessOptions {
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
  readCmdline?: (pid: number) => Promise<string | undefined>;
}
export const DEFAULT_GATEWAY_INSTANCE = 'default';
const GATEWAY_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function isValidGatewayInstance(value: string): boolean {
  return value === DEFAULT_GATEWAY_INSTANCE || GATEWAY_INSTANCE_RE.test(value);
}
export function normalizeGatewayInstance(instance?: string): string {
  if (instance === undefined || instance.trim() === '') return DEFAULT_GATEWAY_INSTANCE;
  const trimmed = instance.trim();
  if (!isValidGatewayInstance(trimmed)) {
    throw new Error(`invalid_instance: ${JSON.stringify(instance)}`);
  }
  return trimmed;
}
export function gatewayPidFileName(instance?: string): string {
  const name = normalizeGatewayInstance(instance);
  return name === DEFAULT_GATEWAY_INSTANCE ? 'gateway.pid' : `gateway-${name}.pid`;
}
export function gatewayPidPath(dataDir: string, instance?: string): string {
  return path.join(dataDir, gatewayPidFileName(instance));
}
export const COMMAND_TIMEOUT_MS = 3000;
export const PROCESS_PROBE_TIMEOUT_MS = 15_000;
export function createCommandRunner(timeoutMs: number = COMMAND_TIMEOUT_MS): CommandRunner {
  return async (argv) => {
    try {
      const proc = Bun.spawn(argv, {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.timeout(timeoutMs),
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
}
export const defaultCommandRunner: CommandRunner = createCommandRunner();
const defaultProcessProbeRunner: CommandRunner = createCommandRunner(PROCESS_PROBE_TIMEOUT_MS);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
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
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
export function isGatewayCommandLine(commandLine: string): boolean {
  if (commandLine.trim() === '') return false;
  const vessel = /(^|[\\/\s])vessel(\.cmd|\.exe|\.js)?\b|src[\\/]cli\.(ts|js)\b|\bcli\.(ts|js)\b/i;
  if (!vessel.test(commandLine)) return false;
  return /\bgateway\b[\s\S]*\bstart\b|(?:^|\s)--serve\b/i.test(commandLine);
}
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
export async function inspectProcess(
  pid: number,
  options: InspectProcessOptions = {},
): Promise<ProcessInfo> {
  if (!isProcessAlive(pid)) return { alive: false };
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultProcessProbeRunner;
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
  } catch {}
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  try {
    await chmod(filePath, 0o600);
  } catch {}
}
export type GatewayRecordState = 'running' | 'degraded' | 'stale' | 'unknown';
export interface GatewayRecordClassification {
  state: GatewayRecordState;
  reason?: string;
  record: GatewayPidRecord;
}
export interface GatewayHealthIdentity {
  pid: number;
  started_at: number;
  node_id?: string;
}
export type GatewayHealthProbe = (target: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}) => Promise<GatewayHealthIdentity | undefined>;
export interface ClassifyGatewayRecordOptions {
  token?: string;
  timeoutMs?: number;
  now?: number;
  bootTime?: number;
  probe?: GatewayHealthProbe;
  fetch?: typeof fetch;
}
function toEpochMs(value: string | number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
export function isBeforeBoot(
  startedAt: string | number,
  options: { bootTime?: number; toleranceMs?: number } = {},
): boolean {
  const startedMs = toEpochMs(startedAt);
  if (startedMs === undefined) return false;
  const bootTime = options.bootTime ?? Date.now() - os.uptime() * 1000;
  return startedMs < bootTime - (options.toleranceMs ?? 5000);
}
function resolveProbeHost(host: string): string | undefined {
  const normalized = host.trim().toLowerCase();
  if (normalized === '0.0.0.0') return '127.0.0.1';
  if (normalized === '::' || normalized === '[::]') return '[::1]';
  if (!isLoopbackHostname(normalized)) return undefined;
  return normalized === '::1' ? '[::1]' : normalized;
}
function createHealthProbe(fetchImpl?: typeof fetch): GatewayHealthProbe {
  return async (target) => {
    const client = createHttpRpcClient({
      baseUrl: target.baseUrl,
      token: target.token,
      subscribe: false,
      requestTimeoutMs: target.timeoutMs,
      ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    });
    try {
      const result = await client.request<unknown>('health.get', {});
      if (!isRecord(result) || !isRecord(result.node)) return undefined;
      const { pid, started_at, node_id } = result.node;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
      if (typeof started_at !== 'number' || !Number.isFinite(started_at)) return undefined;
      return {
        pid,
        started_at,
        ...(typeof node_id === 'string' && node_id !== '' ? { node_id } : {}),
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}
export async function classifyGatewayRecord(
  record: GatewayPidRecord,
  options: ClassifyGatewayRecordOptions = {},
): Promise<GatewayRecordClassification> {
  if (!isProcessAlive(record.pid)) return { state: 'stale', reason: 'dead', record };
  const now = options.now ?? Date.now();
  const bootTime = options.bootTime ?? now - os.uptime() * 1000;
  if (isBeforeBoot(record.started_at, { bootTime })) {
    return { state: 'stale', reason: 'pre-boot', record };
  }
  const probeHost = resolveProbeHost(record.host);
  if (probeHost === undefined) return { state: 'degraded', reason: 'non-loopback', record };
  const token = options.token;
  if (token === undefined || token === '') return { state: 'degraded', reason: 'no-token', record };
  let identity: GatewayHealthIdentity | undefined;
  try {
    identity = await (options.probe ?? createHealthProbe(options.fetch))({
      baseUrl: `http://${probeHost}:${record.port}`,
      token,
      timeoutMs: options.timeoutMs ?? 500,
    });
  } catch {
    return { state: 'degraded', reason: 'unreachable', record };
  }
  if (identity === undefined) return { state: 'degraded', reason: 'unreachable', record };
  const startedMs = toEpochMs(record.started_at);
  const matches =
    identity.pid === record.pid &&
    (record.node_id === undefined || identity.node_id === record.node_id) &&
    startedMs !== undefined &&
    Math.abs(identity.started_at - startedMs) <= 30_000;
  return matches ? { state: 'running', record } : { state: 'degraded', reason: 'mismatch', record };
}
export interface GatewayRecordIdentity {
  pid: number;
  started_at: string | number;
}
export async function deleteRecordIfOwned(
  filePath: string,
  expected: GatewayRecordIdentity,
  options: {
    quarantine?: boolean;
    now?: number;
    parse?: (raw: unknown) => GatewayRecordIdentity | null;
  } = {},
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  let record: GatewayRecordIdentity | null;
  try {
    record = (options.parse ?? parseGatewayPid)(parsed);
  } catch {
    return false;
  }
  const actual = record ? toEpochMs(record.started_at) : undefined;
  const wanted = toEpochMs(expected.started_at);
  if (!record || record.pid !== expected.pid || wanted === undefined || actual !== wanted) {
    return false;
  }
  const reclaimPath = `${filePath}.reclaim-${options.now ?? Date.now()}`;
  await rename(filePath, reclaimPath);
  if (options.quarantine !== true) await unlink(reclaimPath).catch(() => undefined);
  return true;
}
export async function quarantineCorruptRecordIfUnchanged(
  filePath: string,
  observedMtimeMs: number,
  options: { now?: number } = {},
): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (mtimeMs !== observedMtimeMs) return false;
  await rename(filePath, `${filePath}.reclaim-${options.now ?? Date.now()}`);
  return true;
}
export type GatewayStateFileSnapshot<T> =
  | { kind: 'absent' }
  | { kind: 'ok'; value: T; mtimeMs: number }
  | { kind: 'corrupt'; reason: string; mtimeMs: number; ageMs: number; reclaimable: boolean }
  | { kind: 'io-error'; error: Error };
export async function readGatewayStateFile<T = unknown>(
  filePath: string,
  options: { now?: number; graceMs?: number; parse?: (raw: unknown) => T | null } = {},
): Promise<GatewayStateFileSnapshot<T>> {
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'io-error', error: error instanceof Error ? error : new Error(String(error)) };
  }
  const corrupt = (reason: string): GatewayStateFileSnapshot<T> => {
    const ageMs = Math.max(0, (options.now ?? Date.now()) - mtimeMs);
    return {
      kind: 'corrupt',
      reason,
      mtimeMs,
      ageMs,
      reclaimable: ageMs > (options.graceMs ?? 5000),
    };
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corrupt('invalid JSON');
  }
  let value: T | null;
  try {
    value = (options.parse ?? ((input: unknown): T => input as T))(parsed);
  } catch {
    value = null;
  }
  return value === null ? corrupt('invalid fields') : { kind: 'ok', value, mtimeMs };
}
export interface GatewayStateEntry {
  instance: string;
  pidPath?: string;
  lockPath?: string;
  record?: GatewayPidRecord;
  lock?: GatewayStateLock;
  state: 'absent' | 'starting' | 'running' | 'degraded' | 'stale' | 'unknown' | 'foreign-host';
  reason?: string;
  owner?: GatewayStateOwner;
}
export type GatewayStateLock = { pid: number; started_at: number; host: string };
export type GatewayStateOwner = Pick<GatewayPidRecord, 'pid' | 'host' | 'port' | 'started_at'> &
  Record<'token' | 'tenant_id', string>;
export interface GatewayStateSnapshot {
  entries: GatewayStateEntry[];
  owners: GatewayStateOwner[];
  hub?: {
    path: string;
    state: 'running' | 'stale' | 'unknown';
    reason?: string;
    record?: { pid: number; started_at: number; url?: string };
  };
}
export interface CollectGatewayStateOptions extends ClassifyGatewayRecordOptions {
  hubDataDir?: string;
  hostname?: string;
  graceMs?: number;
  startingGraceMs?: number;
  reclaimRetentionMs?: number;
}
function parseEpochPid(raw: unknown): { pid: number; started_at: number } | null {
  if (!isRecord(raw)) return null;
  const { pid, started_at } = raw;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
  if (typeof started_at !== 'number' || !Number.isFinite(started_at)) return null;
  return { pid: pid as number, started_at };
}
function parseStateLock(raw: unknown): GatewayStateLock | null {
  const base = parseEpochPid(raw);
  if (base === null || !isRecord(raw) || typeof raw.host !== 'string') return null;
  return { ...base, host: raw.host };
}
function parseStateOwner(raw: unknown): GatewayStateOwner | null {
  if (!isRecord(raw)) return null;
  const { pid, host, port, token, started_at, tenant_id } = raw;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
  if (typeof host !== 'string' || !isLoopbackHostname(host.trim().toLowerCase())) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (typeof token !== 'string' || token === '') return null;
  if (typeof started_at !== 'string' || Number.isNaN(Date.parse(started_at))) return null;
  if (typeof tenant_id !== 'string' || tenant_id === '') return null;
  return { pid: pid as number, host, port, token, started_at, tenant_id };
}
function parseStateHub(raw: unknown): { pid: number; started_at: number; url?: string } | null {
  const base = parseEpochPid(raw);
  if (base === null || !isRecord(raw)) return null;
  return { ...base, ...(typeof raw.url === 'string' ? { url: raw.url } : {}) };
}
/** E6：win32 上 hostname 忽略大小写。 */
function sameHostName(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
/** 一次 readdir 构建统一状态视图；热路径不调用 inspectProcess/Get-CimInstance。 */
export async function collectGatewayState(
  dataDir: string,
  options: CollectGatewayStateOptions = {},
): Promise<GatewayStateSnapshot> {
  const now = options.now ?? Date.now();
  const bootTime = options.bootTime ?? now - os.uptime() * 1000;
  const beforeBoot = (t: number) => isBeforeBoot(t, { bootTime });
  const hostname = options.hostname ?? os.hostname();
  const graceMs = options.graceMs ?? 5000;
  const startingGraceMs = options.startingGraceMs ?? 60_000;
  const retentionMs = options.reclaimRetentionMs ?? 604_800_000;
  const names = await readdir(dataDir).catch(() => [] as string[]);
  const hubDataDir = options.hubDataDir ?? path.join(dataDir, 'hub');
  for (const dir of [dataDir, hubDataDir]) {
    const list = dir === dataDir ? names : await readdir(dir).catch(() => [] as string[]);
    for (const name of list) {
      if (!name.includes('.reclaim-')) continue;
      const target = path.join(dir, name);
      const stat = await fs.promises.stat(target).catch(() => undefined);
      if (stat !== undefined && now - stat.mtimeMs > retentionMs)
        await unlink(target).catch(() => undefined);
    }
  }
  const pids = new Map<string, string>();
  const locks = new Map<string, string>();
  for (const name of names) {
    if (name.startsWith('.') || name.includes('.reclaim-')) continue;
    if (name === 'gateway.pid') {
      pids.set('default', path.join(dataDir, name));
      continue;
    }
    const match = /^gateway-(.+)\.(pid|lock)$/.exec(name);
    if (match === null) continue;
    const instance = match[1] ?? '';
    if (!isValidGatewayInstance(instance)) continue;
    if (match[2] === 'lock') locks.set(instance, path.join(dataDir, name));
    else if (instance !== 'default') pids.set(instance, path.join(dataDir, name));
  }
  const instances = [...new Set([...pids.keys(), ...locks.keys()])].sort((a, b) =>
    a === 'default' ? -1 : b === 'default' ? 1 : a < b ? -1 : 1,
  );
  const read = <T>(p: string | undefined, parse: (raw: unknown) => T | null) =>
    p === undefined ? undefined : readGatewayStateFile<T>(p, { now, graceMs, parse });
  const entries: GatewayStateEntry[] = [];
  for (const instance of instances) {
    const pidPath = pids.get(instance),
      lockPath = locks.get(instance);
    const entry: GatewayStateEntry = { instance, pidPath, lockPath, state: 'absent' };
    const ps = await read(pidPath, parseGatewayPid);
    const ls = await read(lockPath, parseStateLock);
    if (ps?.kind === 'ok') entry.record = ps.value;
    if (ls?.kind === 'ok') entry.lock = ls.value;
    const lock = entry.lock;
    const lockAlive =
      lock !== undefined && isProcessAlive(lock.pid) && !beforeBoot(lock.started_at);
    if (ps?.kind === 'io-error' || ls?.kind === 'io-error') {
      Object.assign(entry, { state: 'unknown', reason: 'io-error' });
    } else if (lock !== undefined && !sameHostName(lock.host, hostname)) {
      Object.assign(entry, { state: 'foreign-host', reason: 'lock-host-mismatch' });
    } else if (entry.record !== undefined) {
      const c = await classifyGatewayRecord(entry.record, { ...options, now, bootTime });
      Object.assign(entry, { state: c.state, reason: c.reason });
      if (c.state !== 'stale' && lock !== undefined && lock.pid !== entry.record.pid) {
        Object.assign(entry, { state: 'unknown', reason: 'lock-pid-mismatch' });
      } else if (c.state !== 'stale' && ls?.kind === 'corrupt' && !ls.reclaimable) {
        Object.assign(entry, { state: 'unknown', reason: ls.reason });
      }
    } else if (ps?.kind === 'corrupt' && lockAlive && lock !== undefined) {
      const state = now - lock.started_at <= startingGraceMs ? 'starting' : 'degraded';
      Object.assign(entry, { state, reason: 'no-pid-record' });
    } else if (ps?.kind === 'corrupt' || (lock === undefined && ls?.kind === 'corrupt')) {
      const corrupt = ps?.kind === 'corrupt' ? ps : ls?.kind === 'corrupt' ? ls : undefined;
      const reason = corrupt?.kind === 'corrupt' ? corrupt.reason : undefined;
      entry.state = corrupt?.reclaimable === true ? 'stale' : 'unknown';
      entry.reason = corrupt?.reclaimable === true ? 'corrupt' : reason;
    } else if (lock !== undefined) {
      const staleReason = isProcessAlive(lock.pid) ? 'pre-boot' : 'dead';
      const state = !lockAlive
        ? 'stale'
        : now - lock.started_at <= startingGraceMs
          ? 'starting'
          : 'degraded';
      let reason: string | undefined;
      if (!lockAlive) reason = staleReason;
      else if (state === 'degraded') reason = 'no-pid-record';
      Object.assign(entry, { state, reason });
    }
    entries.push(entry);
  }
  const ownerSnap = await read(path.join(dataDir, 'agent-owner.json'), parseStateOwner);
  const owners: GatewayStateOwner[] = [];
  if (ownerSnap?.kind === 'ok') {
    const owner = ownerSnap.value;
    const target = entries.find((e) => e.record?.pid === owner.pid || e.lock?.pid === owner.pid);
    if (target === undefined) owners.push(owner);
    else target.owner = owner;
  }
  const hubPath = path.join(hubDataDir, 'hub.lock');
  const hs = await read(hubPath, parseStateHub);
  const record = hs?.kind === 'ok' ? hs.value : undefined;
  const alive = record !== undefined && isProcessAlive(record.pid);
  const running = record !== undefined && alive && !isBeforeBoot(record.started_at, { bootTime });
  const hubReason = running ? undefined : alive ? 'pre-boot' : 'dead';
  const hub: GatewayStateSnapshot['hub'] = record
    ? { path: hubPath, state: running ? 'running' : 'stale', reason: hubReason, record }
    : hs !== undefined && hs.kind !== 'absent'
      ? { path: hubPath, state: 'unknown', reason: hs.kind === 'corrupt' ? hs.reason : 'io-error' }
      : undefined;
  return { entries, owners, hub };
}
/** 同步 compare-and-delete（pid+started_at）；先 rename 再删除。 */
export function deleteRecordIfOwnedSync(
  filePath: string,
  expected: GatewayRecordIdentity,
  options: { parse?: (raw: unknown) => GatewayRecordIdentity | null; now?: number } = {},
): boolean {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const record = (options.parse ?? parseGatewayPid)(JSON.parse(raw));
    const actual = record === null ? undefined : toEpochMs(record.started_at);
    const wanted = toEpochMs(expected.started_at);
    if (record?.pid !== expected.pid || wanted === undefined || actual !== wanted) return false;
    const reclaim = `${filePath}.reclaim-${options.now ?? Date.now()}`;
    fs.renameSync(filePath, reclaim);
    fs.rmSync(reclaim, { force: true });
    return true;
  } catch {
    return false;
  }
}
/** 损坏文件过宽限后隔离（先复读 mtime，未变才 rename）。 */
async function quarantineIfCorrupt(filePath: string, now: number, graceMs: number): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => undefined);
  if (stat !== undefined && now - stat.mtimeMs > graceMs) {
    await quarantineCorruptRecordIfUnchanged(filePath, stat.mtimeMs, { now });
  }
}
/** 条件清理一个可回收 entry 的 pid/lock/owner；任一文件被改过则不删。 */
export async function cleanupGatewayStateEntry(
  dataDir: string,
  entry: GatewayStateEntry,
  options: { now?: number; bootTime?: number; graceMs?: number; hostname?: string } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const bootTime = options.bootTime ?? now - os.uptime() * 1000;
  const graceMs = options.graceMs ?? 5000;
  const hostname = options.hostname ?? os.hostname();
  const { pidPath, lockPath, record, lock, owner } = entry;
  if (pidPath !== undefined && record !== undefined) await deleteRecordIfOwned(pidPath, record);
  else if (pidPath !== undefined && entry.state === 'stale')
    await quarantineIfCorrupt(pidPath, now, graceMs);
  if (lockPath !== undefined && lock !== undefined) {
    if (
      sameHostName(lock.host, hostname) &&
      (!isProcessAlive(lock.pid) || isBeforeBoot(lock.started_at, { bootTime }))
    )
      await deleteRecordIfOwned(lockPath, lock, { parse: parseStateLock });
  } else if (lockPath !== undefined && entry.state === 'stale') {
    await quarantineIfCorrupt(lockPath, now, graceMs);
  }
  if (
    owner !== undefined &&
    (owner.pid === record?.pid || owner.pid === lock?.pid) &&
    (!isProcessAlive(owner.pid) || isBeforeBoot(owner.started_at, { bootTime }))
  ) {
    await deleteRecordIfOwned(path.join(dataDir, 'agent-owner.json'), owner, {
      parse: parseStateOwner,
    });
  }
}
