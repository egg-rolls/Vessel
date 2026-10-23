/**
 * Hub control 协议 `vessel.hub/1`（S5）。
 *
 * 只承载节点 / Team / Agent 元数据与指针；不承载 RunEvent、消息正文、
 * 工具参数或权限输入。
 *
 * 方向无关：帧显式带 `dialer: 'hub' | 'node'`。S5 只实现 hub 拨号 node；
 * node 拨号 hub 是 S5.1。
 *
 * @module @vessel-agent/serve/hub-protocol
 */

import type { HubAgentMeta, HubPointerReason, HubTeamMeta } from './hub-control.js';

export const HUB_PROTOCOL = 'vessel.hub/1' as const;

/** 节点出站（S5.1）的入站端点。 */
export const HUB_NODE_CONTROL_PATH = '/v1/hub/node-control' as const;

export type HubDialer = 'hub' | 'node';

/** client → server */
export interface HubAuthFrame {
  v: 1;
  kind: 'auth';
  protocol: typeof HUB_PROTOCOL;
  dialer: HubDialer;
  token: string;
  hub_id: string;
  /** dialer === 'node' 时必填；hub dialer 保持缺省。 */
  node_id?: string;
  /** dialer === 'node' 时必填。 */
  tenant_id?: string;
  /** dialer === 'node' 时必填；节点进程代际。 */
  incarnation?: string;
}

export interface HubPongFrame {
  v: 1;
  kind: 'pong';
  protocol: typeof HUB_PROTOCOL;
  dialer: HubDialer;
}

export type HubClientFrame = HubAuthFrame | HubPongFrame;

/** server → client（acceptor 的身份回执） */
export interface HubHelloFrame {
  v: 1;
  kind: 'hello';
  protocol: typeof HUB_PROTOCOL;
  dialer: HubDialer;
  /** hub 作为 acceptor 时回显 node；node 作为 acceptor 时必填。 */
  node_id?: string;
  hub_id: string;
  /** node 进程代际；仅 node acceptor 提供。 */
  incarnation?: string;
  /** node 目录 revision；仅 node acceptor 提供。 */
  revision?: number;
  tenant_id?: string;
}

export interface HubSnapshotFrame {
  v: 1;
  kind: 'snapshot';
  protocol: typeof HUB_PROTOCOL;
  dialer: HubDialer;
  node_id: string;
  hub_id: string;
  incarnation: string;
  /** 单节点、单次进程内单调；重启由 incarnation 区分。 */
  revision: number;
  observed_at: number;
  truncated: boolean;
  counts: { teams: number; agents: number; live_agents: number };
  teams: HubTeamMeta[];
  agents: HubAgentMeta[];
}

export interface HubPointerFrame {
  v: 1;
  kind: 'pointer';
  protocol: typeof HUB_PROTOCOL;
  dialer: HubDialer;
  node_id: string;
  hub_id: string;
  team_id: string;
  request_id?: string;
  reason: HubPointerReason;
  ts: number;
}

export interface HubPingFrame {
  v: 1;
  kind: 'ping';
  protocol: typeof HUB_PROTOCOL;
  dialer: HubDialer;
  ts: number;
}

export type HubServerFrame = HubHelloFrame | HubSnapshotFrame | HubPointerFrame | HubPingFrame;

const POINTER_REASONS = new Set<HubPointerReason>([
  'team.message',
  'team.roster',
  'agent.state',
  'permission.request',
  'directory.changed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 解析 Team 元数据；只接受白名单字段。 */
export function parseHubTeamMeta(value: unknown): HubTeamMeta | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.team_id) || !nonEmptyString(value.name)) return null;
  if (
    typeof value.member_count !== 'number' ||
    !Number.isFinite(value.member_count) ||
    value.member_count < 0 ||
    typeof value.agent_count !== 'number' ||
    !Number.isFinite(value.agent_count) ||
    value.agent_count < 0
  ) {
    return null;
  }
  return {
    team_id: value.team_id,
    name: value.name,
    member_count: Math.floor(value.member_count),
    agent_count: Math.floor(value.agent_count),
    ...(finiteNumber(value.online_count) && value.online_count >= 0
      ? { online_count: Math.floor(value.online_count) }
      : {}),
    ...(finiteNumber(value.last_active) ? { last_active: value.last_active } : {}),
  };
}

/** 解析 Agent 元数据；只接受白名单字段。 */
export function parseHubAgentMeta(value: unknown): HubAgentMeta | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.agent_id) || !nonEmptyString(value.team_id)) return null;
  const membership = value.membership;
  const presence = value.presence;
  if (membership !== 'present' && membership !== 'left') return null;
  if (presence !== 'live' && presence !== 'gone') return null;
  return {
    agent_id: value.agent_id,
    ...(nonEmptyString(value.name) ? { name: value.name } : {}),
    team_id: value.team_id,
    membership,
    presence,
    ...(typeof value.epoch === 'number' && Number.isFinite(value.epoch)
      ? { epoch: Math.floor(value.epoch) }
      : {}),
  };
}

/** 解析指针；拒绝未知 reason / 缺失字段。 */
export function parseHubPointerReason(value: unknown): HubPointerReason | null {
  return typeof value === 'string' && POINTER_REASONS.has(value as HubPointerReason)
    ? (value as HubPointerReason)
    : null;
}

export function isHubProtocol(value: unknown): value is typeof HUB_PROTOCOL {
  return value === HUB_PROTOCOL;
}

export function isHubDialer(value: unknown): value is HubDialer {
  return value === 'hub' || value === 'node';
}
