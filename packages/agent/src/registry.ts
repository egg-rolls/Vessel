/**
 * 内存成员注册表。
 *
 * 一个 registry 实例只服务一个 tenant（跨 tenant 不可见 / 不可寻址由构造边界保证）。
 * 一个 Agent 恰好一具 live Body（`body_id ≡ session_id`），唯一例外是 rotate 窗口：
 * 此时 `retiring` 暂存待退役的旧 Body。`bodyHistory` 是只追加的退役体记账（≤20 条）。
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
 * 0.28：`single` 取消后**不再有任何记录**因管理面身份而对 private 可见；
 * 保留常量是因为 `agents.list` 仍用它表达「管理面口径」，但 `canView` 不再
 * 给它旁路（private 一律只看 owner）。`*` 与 wildcard admin principal 同值。
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
  /** 第一具 Body 的 session（兼容旧数据；当前 Body 见 body） */
  sessionId: string;
  /**
   * 当前 Body（恰一具；0.28 起不再有 N 具）。回收 / close 后**保留记录**并标
   * `retiredAt`——`body_id ≡ session_id` 是续接历史的唯一钥匙，绝不删。
   * 只有 rotate 失败回滚这类中间态才短暂缺省。
   */
  body?: AgentBodyRecord;
  /**
   * rotate 窗口内待退役的旧 Body（`rotation === 'rotating'` 期间与新 Body 共存）。
   * 窗口结束即清空：退役后进 `bodyHistory`。
   */
  retiring?: AgentBodyRecord;
  /** 已退役 Body 的历史；只追加，最多 MAX_BODY_HISTORY 条 */
  bodyHistory: AgentBodyHistoryEntry[];
  name?: string;
  parentId?: string;
  /** 成员角色（v3 持久化） */
  role: AgentRole;
  /** 归属 principal；member = self，temporary = 雇佣者 */
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

/**
 * 所有 live Body（未退役）。
 *
 * 0.28 起正常情况至多一具；`rotation === 'rotating'` 期间是两具（新 + 待退役），
 * rotate 的回滚 / flush 依赖这一点，所以这里**保持**返回列表的语义不变。
 */
export function liveBodies(record: MemberRecord): AgentBodyRecord[] {
  const live: AgentBodyRecord[] = [];
  if (record.body !== undefined && record.body.retiredAt === undefined) live.push(record.body);
  if (record.retiring !== undefined && record.retiring.retiredAt === undefined) {
    live.push(record.retiring);
  }
  return live;
}

/** primary Body；缺省回落到唯一 live body / 兼容指针 */
export function primaryBody(record: MemberRecord): AgentBodyRecord | undefined {
  const live = liveBodies(record);
  return live.find((body) => body.primary) ?? live[0] ?? undefined;
}

/** 记录里该 id 的 Body 槽位（当前或 rotate 窗口内的待退役体；含已退役） */
function findBody(record: MemberRecord, bodyId: string): AgentBodyRecord | undefined {
  if (record.body?.bodyId === bodyId) return record.body;
  if (record.retiring?.bodyId === bodyId) return record.retiring;
  return undefined;
}

/** 参与 session 寻址的 Body session：primary 优先，否则当前 Body，最后兼容 sessionId */
export function currentBodySession(record: MemberRecord): string {
  return primaryBody(record)?.bodyId ?? record.body?.bodyId ?? record.sessionId;
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
    epoch: primary?.epoch ?? record.body?.epoch ?? 0,
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
  // rotate 窗口内旧 Body 还挂在 `retiring` 上、尚未进 `bodyHistory`。若此刻落盘，
  // 旧 session id 会整体丢失（`bodies[]` 只写当前 Body）→ 崩溃后接不回去。
  // 所以窗口内也把待退役体记进 `body_history`（写完即退役，不影响 live 判定）。
  const history =
    record.retiring !== undefined && record.retiring.retiredAt === undefined
      ? [
          ...record.bodyHistory,
          {
            session_id: record.retiring.bodyId,
            epoch: record.retiring.epoch,
            started_at: record.retiring.createdAt,
            retired_at: record.retiring.lastActiveAt,
          },
        ]
      : record.bodyHistory;
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
    ...(history.length > 0 ? { body_history: history.slice(-MAX_BODY_HISTORY) } : {}),
    // 文件格式不变（v4 仍读 `bodies[]`），但 0.28 起恒写 1 项：当前 Body。
    // rotate 期间待退役的旧 Body 写在 `body_history`，不占 `bodies[]`。
    ...(record.body !== undefined ? { bodies: [toPersistedBody(record.body)] } : {}),
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
    role: record.role,
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
  /** live body session → agent id（rotate 窗口内含新旧两具） */
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
      if (liveBodies(record).some((body) => body.bodyId === idOrSession)) return record;
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
      if (liveBodies(record).some((body) => body.bodyId === sessionId)) return record;
    }
    return undefined;
  }

  /**
   * 该 session 是否是**已退役**的 Body（在 `bodyHistory` 或不 live 的 Body 里）。
   *
   * 用途是拒绝对历史 session 的重新准入：否则惰性 `createBody` 会把它复活成第二具
   * live Body，D2 不变量破且没有任何报错。复活必须走 `reinstate`（原地 unretire）。
   */
  isRetiredSession(sessionId: string): boolean {
    for (const record of this.byId.values()) {
      if (record.bodyHistory.some((entry) => entry.session_id === sessionId)) return true;
      if (record.body?.bodyId === sessionId && record.body.retiredAt !== undefined) return true;
      if (record.retiring?.bodyId === sessionId) return true;
    }
    return false;
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
    const body = findBody(record, bodyId);
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
   *
   * 单 body 模型下只有两种情形能走到这里：(a) 记录当前没有 live Body（首次 / 回收后
   * 已被 `reinstate` 清槽）；(b) rotate 窗口——旧 Body 先挪进 `retiring`，新 Body 占
   * `body`，窗口结束后旧 Body 由 `retireBody` 记入 `bodyHistory`。
   */
  addBody(id: string, body: AgentBodyRecord): void {
    const record = this.byId.get(id);
    if (!record) throw new AgentError('unknown_member', `unknown member: ${id}`);
    const existing = findBody(record, body.bodyId);
    if (existing !== undefined && existing.retiredAt === undefined) {
      throw new AgentError('invalid_input', `duplicate body: ${body.bodyId}`);
    }
    const owner = this.bySession.get(body.bodyId);
    if (owner !== undefined && owner !== id) {
      throw new AgentError('invalid_input', `duplicate body: ${body.bodyId}`);
    }
    const replaced = record.body;
    if (replaced !== undefined) {
      if (replaced.retiredAt === undefined) {
        // rotate：旧 Body 暂存到 retiring，等窗口结束再退役。
        record.retiring = replaced;
      } else {
        // 已退役的 Body 让位给新 Body：先进 history，绝不静默丢弃。
        this.pushBodyHistory(id, {
          session_id: replaced.bodyId,
          epoch: replaced.epoch,
          started_at: replaced.createdAt,
          retired_at: replaced.retiredAt,
        });
      }
    }
    record.body = body;
    this.bySession.set(body.bodyId, id);
    if (body.primary) this.setPrimaryBody(id, body.bodyId);
  }

  /**
   * 退役 Body：标 retiredAt、清 primary、从 session 索引移除、记入 `body_history`。
   *
   * body 记录**保留**（不删）：`body_id ≡ session_id` 是续接历史的唯一钥匙，
   * `reinstate` 靠原地 unretire 复活。
   */
  retireBody(id: string, bodyId: string, at: number = this.now()): AgentBodyRecord | undefined {
    const record = this.byId.get(id);
    if (!record) return undefined;
    const body = findBody(record, bodyId);
    if (body === undefined || body.retiredAt !== undefined) return body;
    body.retiredAt = at;
    body.primary = false;
    if (this.bySession.get(bodyId) === id) this.bySession.delete(bodyId);
    if (record.retiring === body) delete record.retiring;
    this.pushBodyHistory(id, {
      session_id: body.bodyId,
      epoch: body.epoch,
      started_at: body.createdAt,
      retired_at: at,
    });
    return body;
  }

  /**
   * 原地复活一个已退役的 Body（`reinstate` 用）：清 `retiredAt`、重设 primary、
   * 从 `body_history` 移除该 session（否则 DTO 同时显示 live 和已退役）。
   * 返回是否真的发生了复活。
   */
  unretireBody(id: string, bodyId?: string): boolean {
    const record = this.byId.get(id);
    if (!record) return false;
    const body = bodyId === undefined ? record.body : findBody(record, bodyId);
    if (body === undefined || body.retiredAt === undefined) return false;
    delete body.retiredAt;
    record.bodyHistory = record.bodyHistory.filter((entry) => entry.session_id !== body.bodyId);
    this.bySession.set(body.bodyId, id);
    this.setPrimaryBody(id, body.bodyId);
    return true;
  }

  /** 完全移除一个 Body（rotate 失败回滚用）；只用于从未提交的中间态 */
  removeBody(id: string, bodyId: string): void {
    const record = this.byId.get(id);
    if (!record) return;
    if (this.bySession.get(bodyId) === id) this.bySession.delete(bodyId);
    if (record.retiring?.bodyId === bodyId) {
      delete record.retiring;
      return;
    }
    if (record.body?.bodyId !== bodyId) return;
    const previous = record.retiring;
    if (previous === undefined) {
      delete record.body;
      return;
    }
    // 回滚：待退役的仍是当前 Body，primary 由它自己带着。
    delete record.retiring;
    record.body = previous;
    this.bySession.set(previous.bodyId, id);
  }

  /** 设置 primary（undefined = 清空）；live Body 的 primary 标记同步 */
  setPrimaryBody(id: string, bodyId: string | undefined): void {
    const record = this.byId.get(id);
    if (!record) return;
    const target =
      bodyId === undefined ? undefined : liveBodies(record).find((body) => body.bodyId === bodyId);
    if (bodyId !== undefined && target === undefined) return;
    for (const body of liveBodies(record)) body.primary = body === target;
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

  /** 按 name 查找（tenant 内可能重名：旧快照容忍重名，new 强制唯一） */
  findByName(name: string): MemberRecord[] {
    const matches: MemberRecord[] = [];
    for (const record of this.byId.values()) {
      if (record.name === name) matches.push(record);
    }
    return matches;
  }

  /**
   * private 仅 owner（member = self，temporary = 雇佣者）；缺失查看者不可见（fail-closed）；
   * team / tenant 对同 tenant 的任何查看者可见。
   *
   * 0.28 起没有 role 旁路：`single` 删除后，管理面 viewer（`*`）也不再额外看到
   * private 记录 —— 要看 private 成员就以它的 owner 身份看。
   */
  canView(record: MemberRecord, viewer?: string): boolean {
    if (record.visibility !== 'private') return true;
    if (viewer === undefined) return false;
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
