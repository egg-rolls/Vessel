/**
 * 内存成员注册表。
 *
 * 一个 registry 实例只服务一个 tenant（跨 tenant 不可见 / 不可寻址由构造边界保证）。
 * 一个 Agent 可以有多个 Body（`body_id ≡ session_id`）；`bodies[]` 是唯一真相，
 * `primaryBodyId` 是缺省投递目标，`currentBody` / `bodyHistory` 是兼容视图。
 *
 * @module @vessel-agent/agent
 */

import type { Usage } from '@vessel-agent/core';
import {
  type AgentBodyHistoryEntry,
  type AgentBodyPointer,
  AgentError,
  type AgentRole,
  type BodyStatus,
  type ListFilter,
  MAX_BODY_HISTORY,
  MAX_RETIRED_BODIES,
  type MemberMembership,
  type MemberPresence,
  type MemberRotation,
  type MemberRuntimeMember,
  type MemberState,
  type MemberStatus,
  type MemberVisibility,
  type PersistedAgentRecord,
  type PersistedBodyRecord,
} from './types.js';

/**
 * 管理面 viewer（tenant admin / human principal）。
 *
 * 只用于列表：放行 private `single`；private `member` / `temporary` 仍按 owner
 * 判定，不因管理面身份放开。`*` 与 wildcard admin principal 的语义一致。
 */
export const ADMIN_VIEWER = '*';

/** 注册表内部 Body 记录（camelCase；对外经 toMemberStatus 转 snake_case） */
export interface AgentBodyRecord {
  bodyId: string;
  epoch: number;
  createdAt: number;
  lastActiveAt: number;
  retiredAt?: number;
  primary: boolean;
}

/** 注册表内部记录（camelCase；对外经 toMemberStatus 转 snake_case） */
export interface MemberRecord {
  id: string;
  /** 第一具 Body 的 session（兼容旧数据；primary 见 primaryBodyId） */
  sessionId: string;
  /** 0.27：全部 Body（含已退役，退役保留 ≤50）；唯一真相 */
  bodies: AgentBodyRecord[];
  /** 0.27：primary body id（缺省投递目标） */
  primaryBodyId?: string;
  /** 兼容视图：primary 指针 */
  currentBody?: AgentBodyPointer;
  /** 已退役 primary 的历史；只追加，最多 MAX_BODY_HISTORY 条 */
  bodyHistory: AgentBodyHistoryEntry[];
  name?: string;
  parentId?: string;
  /** 成员角色（v3 持久化） */
  role: AgentRole;
  /** 归属 principal；single / member = self，temporary = 雇佣者 */
  owner: string;
  visibility: MemberVisibility;
  model?: string;
  systemPrompt?: string;
  state: MemberState;
  /** 进程内 presence；不持久化 */
  presence: MemberPresence;
  /** 归属；持久化 */
  membership: MemberMembership;
  /** 所属 Team（0.19 S3）；unbound 时缺省，持久化 */
  teamId?: string;
  /** Body 轮换相位；不持久化 */
  rotation: MemberRotation;
  forkedFrom?: string;
  currentTool?: string;
  lastSeen?: number;
  usage?: Usage;
}

/** 允许的状态转移；stale 不再写入（仅保留 read-only legacy 键以维持类型完整性） */
const TRANSITIONS: Readonly<Record<MemberState, readonly MemberState[]>> = {
  created: ['idle', 'closed'],
  idle: ['running', 'closed'],
  running: ['waiting_permission', 'completed', 'failed', 'cancelled', 'idle', 'closed'],
  // 0.27：多 body 聚合时「一个 body 退出等待、另一个仍在跑」需要 waiting → running；
  // 无 body 在跑则回 idle。
  waiting_permission: ['running', 'idle', 'failed', 'cancelled', 'closed'],
  completed: ['idle', 'closed'],
  failed: ['idle', 'closed'],
  cancelled: ['idle', 'closed'],
  closed: [],
  // legacy read-only：旧数据里可能仍有 stale 状态；不再有写入者，只允许 close
  stale: ['closed'],
};

/** 状态转移是否合法 */
export function canTransition(from: MemberState, to: MemberState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 所有 live Body（未退役） */
export function liveBodies(record: MemberRecord): AgentBodyRecord[] {
  return record.bodies.filter((body) => body.retiredAt === undefined);
}

/** primary Body；缺省回落到第一具 live body / 兼容指针 */
export function primaryBody(record: MemberRecord): AgentBodyRecord | undefined {
  const byId =
    record.primaryBodyId === undefined
      ? undefined
      : record.bodies.find((body) => body.bodyId === record.primaryBodyId);
  if (byId !== undefined && byId.retiredAt === undefined) return byId;
  return liveBodies(record).find((body) => body.primary) ?? liveBodies(record)[0] ?? undefined;
}

/** 参与 session 寻址的 Body session：primary 优先，否则第一具 Body */
export function currentBodySession(record: MemberRecord): string {
  return primaryBody(record)?.bodyId ?? record.currentBody?.session_id ?? record.sessionId;
}

/** 注册表记录 → 对外状态 */
export function toMemberStatus(record: MemberRecord): MemberStatus {
  const primary = primaryBody(record);
  const bodies: BodyStatus[] = liveBodies(record)
    .sort((left, right) => Number(right.primary) - Number(left.primary))
    .map((body) => ({
      session_id: body.bodyId,
      epoch: body.epoch,
      state: 'idle',
      primary: body.primary,
      created_at: body.createdAt,
      last_active_at: body.lastActiveAt,
    }));
  return {
    id: record.id,
    session_id: currentBodySession(record),
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
    role: record.role,
    owner: record.owner,
    visibility: record.visibility,
    state: record.state,
    presence: record.presence,
    membership: record.membership,
    ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
    epoch: primary?.epoch ?? record.currentBody?.epoch ?? 0,
    ...(record.bodyHistory.length > 0 ? { body_history: record.bodyHistory } : {}),
    ...(bodies.length > 0 ? { bodies } : {}),
    ...(record.currentTool !== undefined ? { current_tool: record.currentTool } : {}),
    ...(record.lastSeen !== undefined ? { last_seen: record.lastSeen } : {}),
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  };
}

/** 内部 Body → 持久化形状（snake_case） */
export function toPersistedBody(body: AgentBodyRecord): PersistedBodyRecord {
  return {
    body_id: body.bodyId,
    epoch: body.epoch,
    created_at: body.createdAt,
    last_active_at: body.lastActiveAt,
    ...(body.retiredAt !== undefined ? { retired_at: body.retiredAt } : {}),
    ...(body.primary ? { primary: true } : {}),
  };
}

/** 注册表记录 → 快照持久化记录（不落 presence / rotation） */
export function toPersistedRecord(record: MemberRecord): PersistedAgentRecord {
  const primary = primaryBody(record);
  return {
    id: record.id,
    session_id: record.sessionId,
    owner: record.owner,
    role: record.role,
    visibility: record.visibility,
    state: record.state,
    membership: record.membership,
    ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.systemPrompt !== undefined ? { system_prompt: record.systemPrompt } : {}),
    ...(primary !== undefined
      ? {
          current_body: {
            session_id: primary.bodyId,
            epoch: primary.epoch,
            started_at: primary.createdAt,
          },
        }
      : {}),
    ...(record.bodyHistory.length > 0
      ? { body_history: record.bodyHistory.slice(-MAX_BODY_HISTORY) }
      : {}),
    bodies: record.bodies.map(toPersistedBody),
    ...(primary !== undefined ? { primary_body_id: primary.bodyId } : {}),
    ...(record.forkedFrom !== undefined ? { forked_from: record.forkedFrom } : {}),
    ...(record.currentTool !== undefined ? { current_tool: record.currentTool } : {}),
    ...(record.lastSeen !== undefined ? { last_seen: record.lastSeen } : {}),
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  };
}

/** 注册表记录 → 执行内核身份（primary body；per-body 由 service 覆盖 session_id） */
export function toRuntimeMember(record: MemberRecord): MemberRuntimeMember {
  return {
    id: record.id,
    session_id: currentBodySession(record),
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
    ...(record.owner !== undefined ? { owner: record.owner } : {}),
    visibility: record.visibility,
    ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.systemPrompt !== undefined ? { system_prompt: record.systemPrompt } : {}),
  };
}

/** 成员注册表 */
export class MemberRegistry {
  private readonly byId = new Map<string, MemberRecord>();
  /** live body session → agent id（含所有 live Body，不只 primary） */
  private readonly bySession = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 新增；id / 任一 live body session 重复直接拒绝，不覆盖旧记录 */
  add(record: MemberRecord): void {
    if (this.byId.has(record.id)) {
      throw new AgentError('invalid_input', `duplicate member id: ${record.id}`);
    }
    for (const body of liveBodies(record)) {
      const owner = this.bySession.get(body.bodyId);
      if (owner !== undefined && owner !== record.id) {
        throw new AgentError('invalid_input', `duplicate member id: ${record.id}`);
      }
    }
    this.byId.set(record.id, record);
    for (const body of liveBodies(record)) this.bySession.set(body.bodyId, record.id);
  }

  /** 成员 id、任一 live body session 寻址 */
  resolve(idOrSession: string): MemberRecord | undefined {
    const direct = this.byId.get(idOrSession);
    if (direct) return direct;
    const id = this.bySession.get(idOrSession);
    if (id !== undefined) return this.byId.get(id);
    for (const record of this.byId.values()) {
      if (
        record.bodies.some((body) => body.retiredAt === undefined && body.bodyId === idOrSession)
      ) {
        return record;
      }
    }
    return undefined;
  }

  get(id: string): MemberRecord | undefined {
    return this.byId.get(id);
  }

  /** 只按 live body session 直查，不走 id 兜底 */
  getBySession(sessionId: string): MemberRecord | undefined {
    const id = this.bySession.get(sessionId);
    if (id !== undefined) return this.byId.get(id);
    for (const record of this.byId.values()) {
      if (record.bodies.some((body) => body.retiredAt === undefined && body.bodyId === sessionId)) {
        return record;
      }
    }
    return undefined;
  }

  remove(id: string): void {
    const record = this.byId.get(id);
    if (!record) return;
    this.byId.delete(id);
    for (const body of liveBodies(record)) {
      if (this.bySession.get(body.bodyId) === id) this.bySession.delete(body.bodyId);
    }
    if (this.bySession.get(currentBodySession(record)) === id) {
      this.bySession.delete(currentBodySession(record));
    }
  }

  /** 状态转移；非法转移抛 invalid_state_transition，缺失成员抛 unknown_member */
  setState(id: string, state: MemberState, currentTool?: string): MemberRecord {
    const record = this.byId.get(id);
    if (!record) throw new AgentError('unknown_member', `unknown member: ${id}`);
    if (record.state === state) {
      if (state === 'waiting_permission' && currentTool !== undefined) {
        record.currentTool = currentTool;
      }
      return record;
    }
    if (!canTransition(record.state, state)) {
      throw new AgentError(
        'invalid_state_transition',
        `invalid_state_transition: ${id} ${record.state} -> ${state}`,
      );
    }
    record.state = state;
    record.lastSeen = this.now();
    if (state === 'waiting_permission') {
      if (currentTool !== undefined) record.currentTool = currentTool;
    } else {
      record.currentTool = undefined;
    }
    return record;
  }

  /** 只刷新 last_seen（入队等非状态变化） */
  touch(id: string): void {
    const record = this.byId.get(id);
    if (record) record.lastSeen = this.now();
  }

  /** 刷新指定 Body 的 last_active_at（body 域活动） */
  touchBody(id: string, bodyId: string, at: number = this.now()): void {
    const record = this.byId.get(id);
    if (!record) return;
    const body = record.bodies.find((entry) => entry.bodyId === bodyId);
    if (body === undefined) return;
    body.lastActiveAt = at;
    record.lastSeen = at;
  }

  setUsage(id: string, usage: Usage): void {
    const record = this.byId.get(id);
    if (record) record.usage = usage;
  }

  /** 进程内 presence；缺失成员静默忽略（close 与 dispose 可能竞争） */
  setPresence(id: string, presence: MemberPresence): void {
    const record = this.byId.get(id);
    if (record) record.presence = presence;
  }

  /** 所属 Team；缺失成员静默忽略（与 setPresence 一致） */
  setTeamId(id: string, teamId: string | undefined): void {
    const record = this.byId.get(id);
    if (!record) return;
    if (teamId === undefined) delete record.teamId;
    else record.teamId = teamId;
  }

  /** 归属；缺失成员静默忽略（reinstate 用，绕过 closed: [] 状态机） */
  setMembership(id: string, membership: MemberMembership): void {
    const record = this.byId.get(id);
    if (record) record.membership = membership;
  }

  /**
   * 新增 live Body 并迁移 session 寻址键。
   * `primary` 为 true 时同步 primaryBodyId / currentBody。
   */
  addBody(id: string, body: AgentBodyRecord): void {
    const record = this.byId.get(id);
    if (!record) throw new AgentError('unknown_member', `unknown member: ${id}`);
    const existing = record.bodies.find((entry) => entry.bodyId === body.bodyId);
    if (existing !== undefined && existing.retiredAt === undefined) {
      throw new AgentError('invalid_input', `duplicate body: ${body.bodyId}`);
    }
    const owner = this.bySession.get(body.bodyId);
    if (owner !== undefined && owner !== id) {
      throw new AgentError('invalid_input', `duplicate body: ${body.bodyId}`);
    }
    record.bodies.push(body);
    this.bySession.set(body.bodyId, id);
    if (body.primary) this.setPrimaryBody(id, body.bodyId);
  }

  /** 退役 Body：标 retiredAt、清 primary、从 session 索引移除、修剪退役条数 */
  retireBody(id: string, bodyId: string, at: number = this.now()): AgentBodyRecord | undefined {
    const record = this.byId.get(id);
    if (!record) return undefined;
    const body = record.bodies.find((entry) => entry.bodyId === bodyId);
    if (body === undefined || body.retiredAt !== undefined) return body;
    body.retiredAt = at;
    body.primary = false;
    if (this.bySession.get(bodyId) === id) this.bySession.delete(bodyId);
    if (record.primaryBodyId === bodyId) {
      delete record.primaryBodyId;
      delete record.currentBody;
    }
    this.trimRetiredBodies(record);
    return body;
  }

  /** 完全移除一个 Body（rotate 失败回滚用）；live / 退役都可移除 */
  removeBody(id: string, bodyId: string): void {
    const record = this.byId.get(id);
    if (!record) return;
    record.bodies = record.bodies.filter((entry) => entry.bodyId !== bodyId);
    if (this.bySession.get(bodyId) === id) this.bySession.delete(bodyId);
    if (record.primaryBodyId === bodyId) {
      delete record.primaryBodyId;
      delete record.currentBody;
    }
  }

  /** 设置 primary（undefined = 清空）；bodies[].primary 同步 */
  setPrimaryBody(id: string, bodyId: string | undefined): void {
    const record = this.byId.get(id);
    if (!record) return;
    const target =
      bodyId === undefined
        ? undefined
        : record.bodies.find((entry) => entry.bodyId === bodyId && entry.retiredAt === undefined);
    if (bodyId !== undefined && target === undefined) return;
    for (const body of record.bodies) body.primary = body === target;
    if (target === undefined) {
      delete record.primaryBodyId;
      delete record.currentBody;
      return;
    }
    record.primaryBodyId = target.bodyId;
    record.currentBody = {
      session_id: target.bodyId,
      epoch: target.epoch,
      started_at: target.createdAt,
    };
  }

  /** 兼容旧调用：把指针设为 primary body（同步 bodies）。 */
  setCurrentBody(id: string, body: AgentBodyPointer): void {
    this.setPrimaryBody(id, body.session_id);
  }

  /** Body 轮换相位（进程内，不持久化） */
  setRotation(id: string, rotation: MemberRotation): void {
    const record = this.byId.get(id);
    if (record) record.rotation = rotation;
  }

  /** 追加退役 Body；超过 MAX_BODY_HISTORY 时丢弃最旧条目 */
  pushBodyHistory(id: string, entry: AgentBodyHistoryEntry): void {
    const record = this.byId.get(id);
    if (!record) return;
    record.bodyHistory.push(entry);
    if (record.bodyHistory.length > MAX_BODY_HISTORY) {
      record.bodyHistory.splice(0, record.bodyHistory.length - MAX_BODY_HISTORY);
    }
  }

  /** 整组覆盖 body history（rotate 失败回滚用） */
  setBodyHistory(id: string, entries: readonly AgentBodyHistoryEntry[]): void {
    const record = this.byId.get(id);
    if (record) record.bodyHistory = [...entries];
  }

  /** 退役 Body 最多保留 MAX_RETIRED_BODIES 条（最旧淘汰）；live 全保留 */
  private trimRetiredBodies(record: MemberRecord): void {
    const retired = record.bodies.filter((body) => body.retiredAt !== undefined);
    if (retired.length <= MAX_RETIRED_BODIES) return;
    const drop = new Set(
      retired.slice(0, retired.length - MAX_RETIRED_BODIES).map((body) => body.bodyId),
    );
    record.bodies = record.bodies.filter((body) => !drop.has(body.bodyId));
  }

  /** 按 name 查找（tenant 内可能重名：旧快照容忍重名，new 强制唯一） */
  findByName(name: string): MemberRecord[] {
    const matches: MemberRecord[] = [];
    for (const record of this.byId.values()) {
      if (record.name === name) matches.push(record);
    }
    return matches;
  }

  /**
   * private 仅 owner（single = self，temporary = 雇佣者）；缺失查看者不可见（fail-closed）；
   * team / tenant 对同 tenant 的任何查看者可见。
   *
   * 管理面 viewer（`*`）额外可见 private single（管理面列表），但 private
   * member / temporary 仍只对 owner 可见。
   */
  canView(record: MemberRecord, viewer?: string): boolean {
    if (record.visibility !== 'private') return true;
    if (viewer === undefined) return false;
    if (record.role === 'single') return viewer === record.id || viewer === ADMIN_VIEWER;
    return viewer === record.owner;
  }

  /** 列表过滤；不触发任何 run / 状态变化 */
  list(filter: ListFilter = {}): MemberRecord[] {
    const states: readonly MemberState[] | undefined =
      filter.state === undefined
        ? undefined
        : typeof filter.state === 'string'
          ? [filter.state]
          : filter.state;
    const records: MemberRecord[] = [];
    for (const record of this.byId.values()) {
      if (!this.canView(record, filter.viewer)) continue;
      if (filter.visibility !== undefined && record.visibility !== filter.visibility) continue;
      if (states !== undefined && !states.includes(record.state)) continue;
      if (filter.parentId !== undefined && record.parentId !== filter.parentId) continue;
      records.push(record);
    }
    return records;
  }

  all(): MemberRecord[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}
