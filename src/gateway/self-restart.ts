/**
 * 自重启 Option A 的编排者交接文件（runlost-graceful-restart-audit §4.2 件 2）。
 *
 * `vessel restart --self` 受理时写 `<dataDir>/self-restart-handoff.json`，
 * detached 编排者（`vessel restart --orchestrate`）读它拿到：触发者 run / 会话、
 * 等待预算、stop/start 目标。仿 platform-handoff.json：原子写 + TTL + 读后即删。
 *
 * 留痕意义：新进程 / 运维可核对「这次重启是谁编排的」；编排者崩溃 ⇒ 文件残留
 * 但 TTL 过期 ⇒ 下次启动 / 下次预约视为陈旧，不永等。
 *
 * @module vessel/self-restart
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 交接文件缺省 TTL：编排者正常几分钟内完成；过期即陈旧。 */
export const SELF_RESTART_HANDOFF_TTL_MS = 10 * 60_000;

/** 编排者等触发者 run 终态的缺省预算（审计 §4.2：有界，超时不重启）。 */
export const SELF_RESTART_WAIT_MS = 120_000;

export interface SelfRestartHandoff {
  kind: 'self-restart';
  /** 预约时刻（epoch ms）。 */
  requested_at: number;
  ttl_ms: number;
  /** 触发者会话 / run（续作标记同口径）。 */
  session_id: string;
  run_id: string;
  /** 续作嘱托（已写进 continuation 标记；这里留档供编排者日志核对）。 */
  prompt: string;
  /** 编排者等触发者 run 终态的预算（毫秒）。 */
  wait_timeout_ms: number;
  /** 触发者 node（等待阶段轮询它的 runs.get）。 */
  node: { data_dir: string; pid: number };
  /** stop/start 目标（平台实例；stop 段按 instance 重新清点归属）。 */
  targets: Array<{ instance: string; port?: number; host?: string }>;
  /** 编排者 pid（spawn 后回填；归属复核 / 留痕）。 */
  orchestrator_pid?: number;
}

export function selfRestartHandoffPath(dataDir: string): string {
  return path.join(dataDir, 'self-restart-handoff.json');
}

/** 形状校验（宽松进、严格出：缺关键字段一律视为无效）。 */
export function parseSelfRestartHandoff(raw: unknown): SelfRestartHandoff | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (record.kind !== 'self-restart') return undefined;
  if (typeof record.requested_at !== 'number' || !Number.isFinite(record.requested_at)) {
    return undefined;
  }
  if (typeof record.session_id !== 'string' || record.session_id === '') return undefined;
  if (typeof record.run_id !== 'string' || record.run_id === '') return undefined;
  if (typeof record.prompt !== 'string') return undefined;
  const node = record.node;
  if (node === null || typeof node !== 'object') return undefined;
  const nodeRecord = node as Record<string, unknown>;
  if (typeof nodeRecord.data_dir !== 'string' || nodeRecord.data_dir === '') return undefined;
  if (typeof nodeRecord.pid !== 'number') return undefined;
  if (!Array.isArray(record.targets)) return undefined;
  const targets: SelfRestartHandoff['targets'] = [];
  for (const item of record.targets) {
    if (item === null || typeof item !== 'object') return undefined;
    const target = item as Record<string, unknown>;
    if (typeof target.instance !== 'string') return undefined;
    targets.push({
      instance: target.instance,
      ...(typeof target.port === 'number' ? { port: target.port } : {}),
      ...(typeof target.host === 'string' ? { host: target.host } : {}),
    });
  }
  return {
    kind: 'self-restart',
    requested_at: record.requested_at,
    ttl_ms: typeof record.ttl_ms === 'number' ? record.ttl_ms : SELF_RESTART_HANDOFF_TTL_MS,
    session_id: record.session_id,
    run_id: record.run_id,
    prompt: record.prompt,
    wait_timeout_ms:
      typeof record.wait_timeout_ms === 'number' ? record.wait_timeout_ms : SELF_RESTART_WAIT_MS,
    node: { data_dir: nodeRecord.data_dir, pid: nodeRecord.pid },
    targets,
    ...(typeof record.orchestrator_pid === 'number'
      ? { orchestrator_pid: record.orchestrator_pid }
      : {}),
  };
}

/** 原子写（tmp + rename，与 handoff.ts 同口径）。 */
export async function writeSelfRestartHandoff(
  dataDir: string,
  handoff: SelfRestartHandoff,
): Promise<void> {
  const filePath = selfRestartHandoffPath(dataDir);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.self-restart-handoff.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    // 平台不支持 chmod 时不阻断（Windows）。
  }
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/** 读交接文件；缺失 / 损坏 / 形状非法 ⇒ null（调用方如实报错）。 */
export async function readSelfRestartHandoff(dataDir: string): Promise<SelfRestartHandoff | null> {
  let raw: string;
  try {
    raw = await readFile(selfRestartHandoffPath(dataDir), 'utf8');
  } catch {
    return null;
  }
  try {
    return parseSelfRestartHandoff(JSON.parse(raw)) ?? null;
  } catch {
    return null;
  }
}

/** TTL 判定：过期 = 陈旧（编排者可能已崩溃），不得据此永等。 */
export function isSelfRestartHandoffStale(handoff: SelfRestartHandoff, now = Date.now()): boolean {
  return now - handoff.requested_at > Math.max(0, handoff.ttl_ms);
}

export async function clearSelfRestartHandoff(dataDir: string): Promise<void> {
  await unlink(selfRestartHandoffPath(dataDir)).catch(() => undefined);
}
