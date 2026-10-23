/**
 * 内存成员注册表。
 *
 * 一个 registry 实例只服务一个 tenant（跨 tenant 不可见 / 不可寻址由构造边界保证）。
 * session 即成员：id 与 session_id 都参与唯一性检查，两个都能寻址。
 *
 * @module @vessel-agent/agent
 */

import type { Usage } from '@vessel-agent/core';
import {
  type AgentBodyPointer,
  AgentError,
  type ListFilter,
  type MemberMembership,
  type MemberPresence,
  type MemberRotation,
  type MemberRuntimeMember,
  type MemberState,
  type MemberStatus,
  type MemberVisibility,
  type PersistedAgentRecord,
} from './types.js';

/** 注册表内部记录（camelCase；对外经 toMemberStatus 转 snake_case） */
export interface MemberRecord {
  id: string;
  /** 第一具 Body 的 session（currentBody 存在时其 session_id 才是当前 Body） */
  sessionId: string;
  name?: string;
  parentId?: string;
  owner: string;
  visibility: MemberVisibility;
  model?: string;
  systemPrompt?: string;
  state: MemberState;
  /** 进程内 presence；不持久化 */
  presence: MemberPresence;
  /** 归属；持久化 */
  membership: MemberMembership;
  /** Body 轮换相位；不持久化 */
  rotation: MemberRotation;
  currentBody?: AgentBodyPointer;
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
  waiting_permission: ['running', 'failed', 'cancelled', 'closed'],
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

/** 注册表记录 → 对外状态 */
export function toMemberStatus(record: MemberRecord): MemberStatus {
  return {
    id: record.id,
    session_id: record.sessionId,
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
    owner: record.owner,
    visibility: record.visibility,
    state: record.state,
    presence: record.presence,
    membership: record.membership,
    epoch: record.currentBody?.epoch ?? 0,
    ...(record.currentTool !== undefined ? { current_tool: record.currentTool } : {}),
    ...(record.lastSeen !== undefined ? { last_seen: record.lastSeen } : {}),
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  };
}

/** 注册表记录 → 快照持久化记录（不落 presence / rotation） */
export function toPersistedRecord(record: MemberRecord): PersistedAgentRecord {
  return {
    id: record.id,
    session_id: record.sessionId,
    owner: record.owner,
    visibility: record.visibility,
    state: record.state,
    membership: record.membership,
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.systemPrompt !== undefined ? { system_prompt: record.systemPrompt } : {}),
    ...(record.currentBody !== undefined ? { current_body: record.currentBody } : {}),
    ...(record.forkedFrom !== undefined ? { forked_from: record.forkedFrom } : {}),
    ...(record.currentTool !== undefined ? { current_tool: record.currentTool } : {}),
    ...(record.lastSeen !== undefined ? { last_seen: record.lastSeen } : {}),
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  };
}

/** 注册表记录 → 执行内核身份 */
export function toRuntimeMember(record: MemberRecord): MemberRuntimeMember {
  return {
    id: record.id,
    session_id: record.currentBody?.session_id ?? record.sessionId,
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
    owner: record.owner,
    visibility: record.visibility,
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.systemPrompt !== undefined ? { system_prompt: record.systemPrompt } : {}),
  };
}

/** 成员注册表 */
export class MemberRegistry {
  private readonly byId = new Map<string, MemberRecord>();
  private readonly bySession = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 新增；id / session_id 重复直接拒绝，不覆盖旧记录 */
  add(record: MemberRecord): void {
    if (this.byId.has(record.id) || this.bySession.has(record.sessionId)) {
      throw new AgentError('invalid_input', `duplicate member id: ${record.id}`);
    }
    this.byId.set(record.id, record);
    this.bySession.set(record.sessionId, record.id);
  }

  /** 成员 id 或 session_id 寻址 */
  resolve(idOrSession: string): MemberRecord | undefined {
    const direct = this.byId.get(idOrSession);
    if (direct) return direct;
    const id = this.bySession.get(idOrSession);
    return id !== undefined ? this.byId.get(id) : undefined;
  }

  get(id: string): MemberRecord | undefined {
    return this.byId.get(id);
  }

  remove(id: string): void {
    const record = this.byId.get(id);
    if (!record) return;
    this.byId.delete(id);
    this.bySession.delete(record.sessionId);
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

  /** 更新 root owner 的 session / visibility；新 session 与其它成员冲突时拒绝 */
  updateIdentity(
    id: string,
    updates: { sessionId?: string; visibility?: MemberVisibility },
  ): MemberRecord {
    const record = this.byId.get(id);
    if (!record) throw new AgentError('unknown_member', `unknown_member: ${id}`);
    if (updates.sessionId !== undefined && updates.sessionId !== record.sessionId) {
      const owner = this.bySession.get(updates.sessionId);
      if (owner !== undefined && owner !== id) {
        throw new AgentError('invalid_input', `duplicate session id: ${updates.sessionId}`);
      }
      this.bySession.delete(record.sessionId);
      record.sessionId = updates.sessionId;
      this.bySession.set(updates.sessionId, id);
    }
    if (updates.visibility !== undefined) record.visibility = updates.visibility;
    record.lastSeen = this.now();
    return record;
  }

  /** 只刷新 last_seen（入队等非状态变化） */
  touch(id: string): void {
    const record = this.byId.get(id);
    if (record) record.lastSeen = this.now();
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

  /** 当前 Body 指针；不改变第一具 Body 的 sessionId */
  setCurrentBody(id: string, body: AgentBodyPointer): void {
    const record = this.byId.get(id);
    if (record) record.currentBody = body;
  }

  /** 按 name 查找（tenant 内可能重名：旧快照容忍重名，new 强制唯一） */
  findByName(name: string): MemberRecord[] {
    const matches: MemberRecord[] = [];
    for (const record of this.byId.values()) {
      if (record.name === name) matches.push(record);
    }
    return matches;
  }

  /** private 仅 owner；team / tenant 对同 tenant 的任何查看者可见 */
  canView(record: MemberRecord, viewer?: string): boolean {
    if (record.visibility === 'private') return viewer !== undefined && viewer === record.owner;
    return true;
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
