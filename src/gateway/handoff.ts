/**
 * 平台层 handoff（0.52）：`gateway restart`（缺省）与 `gateway stop --keep-nodes`
 * 不终止本平台进程 spawn 的 node（与 hub），让新平台启动时按**既有 adopt 判据**
 * 接管（`node-supervisor.ts` 的 `gateway.pid` 三元组 / hub lock），从而「改平台层 /
 * Web / registry」不打断节点上在跑的 run。
 *
 * 为什么需要 marker：被终止的旧平台进程跑着旧代码，它无法从 argv / env 得知
 * 「这一次要保留」，而它的 shutdown 分支原本无条件 `supervisor.stop()`。所以交接
 * 经 `<dataDir>/platform-handoff[-<instance>].json` 传递：
 * - 停止方（CLI）在 `terminateProcess` **之前**写入 marker，pid 指向目标平台进程；
 * - 旧平台在 shutdown 分支读取并**消费**（读后即删）：pid 命中且未过期才
 *   `supervisor.stop({ keep: true })`；
 * - 任何非 handoff 停止**先删掉**残留 marker，避免「真停」被一次陈旧 marker 变成假停。
 *
 * 边界：marker 只是本进程族的运行时状态，不进契约、不改 adopt 判据、不改
 * `gateway.pid` 的写法与语义；过期（TTL）后等同于不存在，最坏情况退化为 0.51 的
 * 「重启连 node 一起停」。
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_GATEWAY_INSTANCE, normalizeGatewayInstance } from './pid';

/** marker 只在「刚写完就终止」这个窗口内有效，超时视为陈旧（不保留 node）。 */
export const HANDOFF_MARKER_TTL_MS = 120_000;
/** 允许的时钟回拨余量（marker 时间戳来自写入方进程，可能比读取方稍快）。 */
const HANDOFF_CLOCK_SKEW_MS = 5_000;

export interface HandoffMarker {
  v: 1;
  /** 期望消费该 marker 的平台进程 pid。 */
  platform_pid: number;
  requested_at_ms: number;
}

export function handoffMarkerFileName(instance?: string): string {
  const name = normalizeGatewayInstance(instance);
  return name === DEFAULT_GATEWAY_INSTANCE
    ? 'platform-handoff.json'
    : `platform-handoff-${name}.json`;
}

export function handoffMarkerPath(dataDir: string, instance?: string): string {
  return path.join(dataDir, handoffMarkerFileName(instance));
}

/** 严格解析；任何字段不合法都返回 undefined（当作没有 marker）。 */
export function parseHandoffMarker(raw: unknown): HandoffMarker | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const platformPid = record.platform_pid;
  const requestedAt = record.requested_at_ms;
  if (record.v !== 1) return undefined;
  if (typeof platformPid !== 'number' || !Number.isInteger(platformPid) || platformPid <= 0) {
    return undefined;
  }
  if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) return undefined;
  return { v: 1, platform_pid: platformPid, requested_at_ms: requestedAt };
}

/** 写入 marker（原子写；语义见文件头注释）。 */
export async function writeHandoffMarker(
  dataDir: string,
  instance: string | undefined,
  platformPid: number,
  now: number = Date.now(),
): Promise<void> {
  const name = normalizeGatewayInstance(instance);
  const filePath = handoffMarkerPath(dataDir, name);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${handoffMarkerFileName(name)}.${process.pid}.${Date.now()}.tmp`);
  const marker: HandoffMarker = { v: 1, platform_pid: platformPid, requested_at_ms: now };
  await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
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

/** 删除 marker（非 handoff 停止前清理陈旧残留；不存在时静默）。 */
export async function clearHandoffMarker(dataDir: string, instance?: string): Promise<void> {
  await unlink(handoffMarkerPath(dataDir, instance)).catch(() => undefined);
}

/**
 * 读取并**消费** marker：命中（pid 一致 + 未过期）返回 true，其余一律 false。
 * 读后必删（无论命中与否），所以同一份 marker 只会影响一次 shutdown。
 */
export async function consumeHandoffMarker(
  dataDir: string,
  instance: string | undefined,
  platformPid: number,
  now: number = Date.now(),
): Promise<boolean> {
  const filePath = handoffMarkerPath(dataDir, instance);
  let body: string;
  try {
    body = await readFile(filePath, 'utf8');
  } catch {
    return false;
  }
  await unlink(filePath).catch(() => undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const marker = parseHandoffMarker(parsed);
  if (marker === undefined) return false;
  if (marker.platform_pid !== platformPid) return false;
  const age = now - marker.requested_at_ms;
  if (age < -HANDOFF_CLOCK_SKEW_MS) return false;
  if (age > HANDOFF_MARKER_TTL_MS) return false;
  return true;
}

