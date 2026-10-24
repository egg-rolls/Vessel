/**
 * `vessel.hub/1` 帧解析 / 构造（S5 / S5.1）。
 *
 * 只处理元数据帧；不解析 RunEvent、消息正文或工具参数。这里集中放纯函数，
 * 让 hub → node 与 node → hub 两个方向共用同一套校验，避免接受逻辑漂移。
 *
 * 方向规则（`dialer` = 连接发起方）：
 * - `auth` / `pong` 由 dialer 发；
 * - `hello` / `ping` 由 acceptor 发；
 * - `snapshot` / `pointer` 由 node（元数据生产者）发。
 *
 * @module @vessel-agent/serve/hub-frames
 */

import type { HubNodeSnapshotInput, HubTeamMeta } from './hub-control.js';
import {
  HUB_PROTOCOL,
  type HubAuthFrame,
  type HubDialer,
  type HubHelloFrame,
  type HubPingFrame,
  type HubPointerFrame,
  type HubPongFrame,
  type HubSnapshotFrame,
  isHubDialer,
  isHubProtocol,
  parseHubAgentMeta,
  parseHubPointerReason,
  parseHubTeamMeta,
} from './hub-protocol.js';

/** 解析结果；调用方按 reason 映射自己的关闭码 / 日志。 */
export type HubFrameParse<T> =
  | { ok: true; frame: T }
  | { ok: false; reason: 'invalid' | 'unsupported' | 'identity_mismatch' };

/** 接收方期望的身份字段；未提供的字段不比较。 */
export interface HubFrameIdentity {
  hub_id?: string;
  node_id?: string;
  tenant_id?: string;
}

export interface HubEnvelope {
  frame: Record<string, unknown>;
  dialer: HubDialer;
}

export type HubEnvelopeResult =
  | { ok: true; value: HubEnvelope }
  | { ok: false; reason: 'invalid' | 'unsupported' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** JSON 解码；失败返回 null，不抛错。 */
export function decodeHubFrame(raw: string | Buffer | Uint8Array): unknown | null {
  const text =
    typeof raw === 'string'
      ? raw
      : new TextDecoder().decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * 校验公共信封（`v` / `protocol` / `dialer`）。
 * `expectedDialer` 提供时，方向不匹配按 `unsupported` 处理。
 */
export function readHubEnvelope(value: unknown, expectedDialer?: HubDialer): HubEnvelopeResult {
  if (!isRecord(value)) return { ok: false, reason: 'invalid' };
  if (value.v !== 1 || !isHubProtocol(value.protocol) || !isHubDialer(value.dialer)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (expectedDialer !== undefined && value.dialer !== expectedDialer) {
    return { ok: false, reason: 'unsupported' };
  }
  return { ok: true, value: { frame: value, dialer: value.dialer } };
}

/** counts 必须是三个有限、非负数字；向下取整。 */
export function parseHubCounts(value: unknown): HubSnapshotFrame['counts'] | null {
  if (!isRecord(value)) return null;
  const { teams, agents, live_agents: live } = value;
  if (!finiteNumber(teams) || !finiteNumber(agents) || !finiteNumber(live)) return null;
  if (teams < 0 || agents < 0 || live < 0) return null;
  return {
    teams: Math.floor(teams),
    agents: Math.floor(agents),
    live_agents: Math.floor(live),
  };
}

function identityMatches(
  frame: Record<string, unknown>,
  expect: HubFrameIdentity | undefined,
): boolean {
  if (expect === undefined) return true;
  if (expect.hub_id !== undefined && frame.hub_id !== expect.hub_id) return false;
  if (expect.node_id !== undefined && frame.node_id !== expect.node_id) return false;
  if (expect.tenant_id !== undefined && frame.tenant_id !== expect.tenant_id) return false;
  return true;
}

/** `auth`：dialer → acceptor。 */
export function parseHubAuthFrame(
  value: unknown,
  expectedDialer?: HubDialer,
): HubFrameParse<HubAuthFrame> {
  const envelope = readHubEnvelope(value, expectedDialer);
  if (!envelope.ok) return envelope;
  const frame = envelope.value.frame;
  if (frame.kind !== 'auth') return { ok: false, reason: 'invalid' };
  if (!nonEmptyString(frame.token) || !nonEmptyString(frame.hub_id)) {
    return { ok: false, reason: 'invalid' };
  }
  const parsed: HubAuthFrame = {
    v: 1,
    kind: 'auth',
    protocol: HUB_PROTOCOL,
    dialer: envelope.value.dialer,
    token: frame.token,
    hub_id: frame.hub_id,
  };
  if (nonEmptyString(frame.node_id)) parsed.node_id = frame.node_id;
  if (nonEmptyString(frame.tenant_id)) parsed.tenant_id = frame.tenant_id;
  if (nonEmptyString(frame.incarnation)) parsed.incarnation = frame.incarnation;
  // node dialer 必须自带身份，否则 hub 无法绑定 pairing。
  if (parsed.dialer === 'node') {
    if (parsed.node_id === undefined || parsed.tenant_id === undefined) {
      return { ok: false, reason: 'invalid' };
    }
  }
  return { ok: true, frame: parsed };
}

/** `hello`：acceptor → dialer。 */
export function parseHubHelloFrame(
  value: unknown,
  expect?: HubFrameIdentity,
  expectedDialer?: HubDialer,
): HubFrameParse<HubHelloFrame> {
  const envelope = readHubEnvelope(value, expectedDialer);
  if (!envelope.ok) return envelope;
  const frame = envelope.value.frame;
  if (frame.kind !== 'hello') return { ok: false, reason: 'invalid' };
  if (!nonEmptyString(frame.hub_id)) return { ok: false, reason: 'invalid' };
  if (!identityMatches(frame, expect)) return { ok: false, reason: 'identity_mismatch' };

  const parsed: HubHelloFrame = {
    v: 1,
    kind: 'hello',
    protocol: HUB_PROTOCOL,
    dialer: envelope.value.dialer,
    hub_id: frame.hub_id,
  };
  if (nonEmptyString(frame.node_id)) parsed.node_id = frame.node_id;
  if (nonEmptyString(frame.incarnation)) parsed.incarnation = frame.incarnation;
  if (finiteNumber(frame.revision) && frame.revision >= 0) {
    parsed.revision = Math.floor(frame.revision);
  }
  if (nonEmptyString(frame.tenant_id)) parsed.tenant_id = frame.tenant_id;
  return { ok: true, frame: parsed };
}

/** `snapshot`：node → hub。只白名单字段；坏 team / agent 条目单独丢弃。 */
export function parseHubSnapshotFrame(
  value: unknown,
  expect?: HubFrameIdentity,
  expectedDialer?: HubDialer,
): HubFrameParse<HubSnapshotFrame> {
  const envelope = readHubEnvelope(value, expectedDialer);
  if (!envelope.ok) return envelope;
  const frame = envelope.value.frame;
  if (frame.kind !== 'snapshot') return { ok: false, reason: 'invalid' };
  if (!nonEmptyString(frame.node_id) || !nonEmptyString(frame.hub_id)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!identityMatches(frame, expect)) return { ok: false, reason: 'identity_mismatch' };

  const revision = frame.revision;
  if (!finiteNumber(revision) || revision < 0) return { ok: false, reason: 'invalid' };
  const counts = parseHubCounts(frame.counts);
  if (counts === null) return { ok: false, reason: 'invalid' };
  if (typeof frame.truncated !== 'boolean') return { ok: false, reason: 'invalid' };

  const teams: HubTeamMeta[] = [];
  if (Array.isArray(frame.teams)) {
    for (const item of frame.teams) {
      const team = parseHubTeamMeta(item);
      if (team !== null) teams.push(team);
    }
  }
  const agents: HubSnapshotFrame['agents'] = [];
  if (Array.isArray(frame.agents)) {
    for (const item of frame.agents) {
      const agent = parseHubAgentMeta(item);
      if (agent !== null) agents.push(agent);
    }
  }

  return {
    ok: true,
    frame: {
      v: 1,
      kind: 'snapshot',
      protocol: HUB_PROTOCOL,
      dialer: envelope.value.dialer,
      node_id: frame.node_id,
      ...(nonEmptyString(frame.name) ? { name: frame.name } : {}),
      hub_id: frame.hub_id,
      incarnation: typeof frame.incarnation === 'string' ? frame.incarnation : '',
      revision: Math.floor(revision),
      observed_at: finiteNumber(frame.observed_at) ? frame.observed_at : 0,
      truncated: frame.truncated,
      counts,
      teams,
      agents,
    },
  };
}

/** `pointer`：node → hub。 */
export function parseHubPointerFrame(
  value: unknown,
  expect?: HubFrameIdentity,
  expectedDialer?: HubDialer,
): HubFrameParse<HubPointerFrame> {
  const envelope = readHubEnvelope(value, expectedDialer);
  if (!envelope.ok) return envelope;
  const frame = envelope.value.frame;
  if (frame.kind !== 'pointer') return { ok: false, reason: 'invalid' };
  if (!nonEmptyString(frame.node_id) || !nonEmptyString(frame.hub_id)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!identityMatches(frame, expect)) return { ok: false, reason: 'identity_mismatch' };
  if (!nonEmptyString(frame.team_id)) return { ok: false, reason: 'invalid' };
  const reason = parseHubPointerReason(frame.reason);
  if (reason === null) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    frame: {
      v: 1,
      kind: 'pointer',
      protocol: HUB_PROTOCOL,
      dialer: envelope.value.dialer,
      node_id: frame.node_id,
      hub_id: frame.hub_id,
      team_id: frame.team_id,
      ...(nonEmptyString(frame.request_id) ? { request_id: frame.request_id } : {}),
      reason,
      ts: finiteNumber(frame.ts) ? frame.ts : 0,
    },
  };
}

/** `ping`：acceptor → dialer。 */
export function parseHubPingFrame(
  value: unknown,
  expectedDialer?: HubDialer,
): HubFrameParse<HubPingFrame> {
  const envelope = readHubEnvelope(value, expectedDialer);
  if (!envelope.ok) return envelope;
  const frame = envelope.value.frame;
  if (frame.kind !== 'ping') return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    frame: {
      v: 1,
      kind: 'ping',
      protocol: HUB_PROTOCOL,
      dialer: envelope.value.dialer,
      ts: finiteNumber(frame.ts) ? frame.ts : 0,
    },
  };
}

/** `pong`：dialer → acceptor。 */
export function parseHubPongFrame(
  value: unknown,
  expectedDialer?: HubDialer,
): HubFrameParse<HubPongFrame> {
  const envelope = readHubEnvelope(value, expectedDialer);
  if (!envelope.ok) return envelope;
  const frame = envelope.value.frame;
  if (frame.kind !== 'pong') return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    frame: {
      v: 1,
      kind: 'pong',
      protocol: HUB_PROTOCOL,
      dialer: envelope.value.dialer,
    },
  };
}

/** 构造 `auth`。 */
export function buildHubAuthFrame(input: {
  dialer: HubDialer;
  token: string;
  hubId: string;
  nodeId?: string;
  tenantId?: string;
  incarnation?: string;
}): HubAuthFrame {
  const frame: HubAuthFrame = {
    v: 1,
    kind: 'auth',
    protocol: HUB_PROTOCOL,
    dialer: input.dialer,
    token: input.token,
    hub_id: input.hubId,
  };
  if (input.nodeId !== undefined) frame.node_id = input.nodeId;
  if (input.tenantId !== undefined) frame.tenant_id = input.tenantId;
  if (input.incarnation !== undefined) frame.incarnation = input.incarnation;
  return frame;
}

/** 构造 `hello`（acceptor）。 */
export function buildHubHelloFrame(input: {
  dialer: HubDialer;
  hubId: string;
  nodeId?: string;
  incarnation?: string;
  revision?: number;
  tenantId?: string;
}): HubHelloFrame {
  const frame: HubHelloFrame = {
    v: 1,
    kind: 'hello',
    protocol: HUB_PROTOCOL,
    dialer: input.dialer,
    hub_id: input.hubId,
  };
  if (input.nodeId !== undefined) frame.node_id = input.nodeId;
  if (input.incarnation !== undefined) frame.incarnation = input.incarnation;
  if (input.revision !== undefined) frame.revision = input.revision;
  if (input.tenantId !== undefined) frame.tenant_id = input.tenantId;
  return frame;
}

/** 构造 `snapshot`（node）；provider 的额外字段一律不透传。 */
export function buildHubSnapshotFrame(
  input: HubNodeSnapshotInput,
  meta: {
    dialer: HubDialer;
    nodeId: string;
    hubId: string;
    incarnation: string;
    revision: number;
    observedAt: number;
  },
): HubSnapshotFrame {
  const teams: HubTeamMeta[] = [];
  for (const item of Array.isArray(input.teams) ? input.teams : []) {
    const team = parseHubTeamMeta(item);
    if (team !== null) teams.push(team);
  }
  const agents: HubSnapshotFrame['agents'] = [];
  for (const item of Array.isArray(input.agents) ? input.agents : []) {
    const agent = parseHubAgentMeta(item);
    if (agent !== null) agents.push(agent);
  }
  return {
    v: 1,
    kind: 'snapshot',
    protocol: HUB_PROTOCOL,
    dialer: meta.dialer,
    node_id: meta.nodeId,
    ...(nonEmptyString(input.name) ? { name: input.name } : {}),
    hub_id: meta.hubId,
    incarnation: meta.incarnation,
    revision: Math.floor(meta.revision),
    observed_at: meta.observedAt,
    truncated: input.truncated === true,
    counts: {
      teams: Math.max(0, Math.floor(input.counts?.teams ?? 0)),
      agents: Math.max(0, Math.floor(input.counts?.agents ?? 0)),
      live_agents: Math.max(0, Math.floor(input.counts?.live_agents ?? 0)),
    },
    teams,
    agents,
  };
}

/** 构造 `pointer`（node）；未知 reason / 空 team_id 返回 null。 */
export function buildHubPointerFrame(
  pointer: unknown,
  meta: { dialer: HubDialer; nodeId: string; hubId: string; now: number },
): HubPointerFrame | null {
  if (!isRecord(pointer)) return null;
  if (!nonEmptyString(pointer.team_id)) return null;
  const reason = parseHubPointerReason(pointer.reason);
  if (reason === null) return null;
  const ts = finiteNumber(pointer.ts) ? pointer.ts : meta.now;
  return {
    v: 1,
    kind: 'pointer',
    protocol: HUB_PROTOCOL,
    dialer: meta.dialer,
    node_id: meta.nodeId,
    hub_id: meta.hubId,
    team_id: pointer.team_id,
    ...(nonEmptyString(pointer.request_id) ? { request_id: pointer.request_id } : {}),
    reason,
    ts,
  };
}

/** 构造 `ping`（acceptor）。 */
export function buildHubPingFrame(input: { dialer: HubDialer; ts: number }): HubPingFrame {
  return {
    v: 1,
    kind: 'ping',
    protocol: HUB_PROTOCOL,
    dialer: input.dialer,
    ts: input.ts,
  };
}

/** 构造 `pong`（dialer）。 */
export function buildHubPongFrame(input: { dialer: HubDialer }): HubPongFrame {
  return {
    v: 1,
    kind: 'pong',
    protocol: HUB_PROTOCOL,
    dialer: input.dialer,
  };
}
