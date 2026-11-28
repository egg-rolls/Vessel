/**
 * agent 源读侧（q-sub-unify-p1：键空间 + 目标校验 + 活动快照读侧）。
 *
 * 照抄 health.ts 范式：插件拥有订阅语义，宿主 agent-activity-watch 落活动快照，
 * 插件 observe 读快照取签名 rev。目标语法与 health 同族（字面量副本，
 * 生产侧真相在 src/federation/federation-address.ts 与 node-registry NODE_ID_RE，
 * 改任一侧人工对拍）：
 * - 本机 agent_id：`[A-Za-z0-9_-]{1,64}`（覆盖 UUID）；
 * - 远程联邦地址：`<principal>@<node_id>:<team_id>`（三段；P1 只收语法，远端探测 P3）。
 *
 * 变化签名（rev）：`state:presence:last_run_ts:role`（'-' 占位；与宿主
 * agent-activity-watch agentActivitySignature 逐字同口径，改任一侧人工对拍）。
 * - state/presence 翻转、role 变更、run 终态（last_run_ts）⇒ 签名变 ⇒ 通知；
 * - checked_at / last_event_ts **不**进签名（每事件刷新，进签名会每 run 误报）。
 * 快照缺失（watcher 尚未落 / 未装配 / private fail-closed）⇒ 无观察，游标不动。
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/** 宿主写入的 agent 活动快照（防御解析；未知键忽略） */
export interface AgentSnapshot {
  v: 1;
  /** 订阅目标（agent_id 或联邦地址） */
  target: string;
  /** 成员 id（本地分支 = target） */
  agent_id: string;
  /** 展示名（缺省 = 未知） */
  name?: string;
  /** 所属 team（缺省 = unbound） */
  team_id?: string;
  /** 可见性（快照只收 team/tenant；private 永不落盘） */
  visibility?: string;
  /** 成员状态（idle/running/…） */
  state?: string;
  /** 进程内 presence（here/gone/…） */
  presence?: string;
  /** 成员角色 */
  role?: string;
  /** 最近一次 run 终态时间（Unix ms；活动签名主键） */
  last_run_ts?: number;
  /** 最近一次白名单事件类型（诊断用） */
  last_event_type?: string;
  /** 最近一次白名单事件时间（Unix ms；**不**进签名） */
  last_event_ts?: number;
  /** 最近一次落盘时间（Unix ms；**不**进签名） */
  checked_at: number;
  /** 探测途径（诊断用；P1 恒 local） */
  via?: 'local' | 'federation';
}

/** 本机 agent_id 语法（node_id 同族字面量副本） */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 联邦地址三段语法（federation-address.ts 的字面量副本） */
const FEDERATION_ADDRESS_RE = /^[A-Za-z0-9_-]{1,64}@[A-Za-z0-9_-]{1,64}:[a-z0-9][a-z0-9-]{0,63}$/;

/** 目标是否合法（本机 agent_id 或三段联邦地址） */
export function isValidAgentTarget(target: string): boolean {
  return AGENT_ID_RE.test(target) || FEDERATION_ADDRESS_RE.test(target);
}

/** agent 条目的状态键（与文件/health/script 键空间隔离） */
export function agentSubscriptionKey(target: string): string {
  return `agent:${target}`;
}

/** 快照文件路径（与宿主 agent-activity-watch 的写端逐字同口径） */
export function agentSnapshotPath(stateDir: string, target: string): string {
  return path.join(stateDir, 'agents', `${encodeURIComponent(target)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 读活动快照（防御解析；缺失 / 损坏 / 身份不符 ⇒ undefined）。 */
export async function readAgentSnapshot(
  stateDir: string,
  target: string,
): Promise<AgentSnapshot | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(agentSnapshotPath(stateDir, target), 'utf-8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return undefined;
  if (optionalString(parsed, 'target') !== target) return undefined;
  const agentId = optionalString(parsed, 'agent_id');
  if (agentId === undefined) return undefined;
  const checkedAt = optionalNumber(parsed, 'checked_at');
  if (checkedAt === undefined) return undefined;
  const snapshot: AgentSnapshot = { v: 1, target, agent_id: agentId, checked_at: checkedAt };
  const name = optionalString(parsed, 'name');
  if (name !== undefined) snapshot.name = name;
  const teamId = optionalString(parsed, 'team_id');
  if (teamId !== undefined) snapshot.team_id = teamId;
  const visibility = optionalString(parsed, 'visibility');
  if (visibility !== undefined) snapshot.visibility = visibility;
  const state = optionalString(parsed, 'state');
  if (state !== undefined) snapshot.state = state;
  const presence = optionalString(parsed, 'presence');
  if (presence !== undefined) snapshot.presence = presence;
  const role = optionalString(parsed, 'role');
  if (role !== undefined) snapshot.role = role;
  const lastRunTs = optionalNumber(parsed, 'last_run_ts');
  if (lastRunTs !== undefined) snapshot.last_run_ts = lastRunTs;
  const lastEventType = optionalString(parsed, 'last_event_type');
  if (lastEventType !== undefined) snapshot.last_event_type = lastEventType;
  const lastEventTs = optionalNumber(parsed, 'last_event_ts');
  if (lastEventTs !== undefined) snapshot.last_event_ts = lastEventTs;
  if (parsed.via === 'local' || parsed.via === 'federation') snapshot.via = parsed.via;
  return snapshot;
}

/** 活动签名（与宿主 agentActivitySignature 逐字同口径）。 */
export function agentSignature(snapshot: AgentSnapshot): string {
  return [
    snapshot.state ?? '-',
    snapshot.presence ?? '-',
    snapshot.last_run_ts ?? '-',
    snapshot.role ?? '-',
  ].join(':');
}

/** rev 的短展示形态（list / inspect 用；与 health describeHealthRev 同族）。 */
export function describeAgentRev(rev: string): string {
  if (rev === '') return 'never';
  const [state, presence, lastRunTs, role] = rev.split(':');
  const run = lastRunTs !== undefined && lastRunTs !== '-' ? lastRunTs : '?';
  return `${state ?? '?'}/${presence ?? '?'}(run:${run},role:${role ?? '?'})`;
}
