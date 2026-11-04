/**
 * 内存成员注册表。
 *
 * 一个 registry 实例只服务一个 tenant（跨 tenant 不可见 / 不可寻址由构造边界保证）。
 * 0.39 起一个 Agent 有**恰好一个 primary** live Binding 与 0..N 个 live sibling
 * （`body_id ≡ session_id`）。`binding` 仍是 primary 槽位，`siblings` 存其余 live
 * sibling；rotate 窗口内 `retiringBinding` 暂存待退役的旧 Binding。`bindingHistory`
 * 是只追加的退役体记账（≤20 条）。
 *
 * @module @vessel-agent/agent
 */

import type { Usage } from '@vessel-agent/core';
import {
  AgentError,
  type AgentRole,
  type BindingHistoryEntry,
  type BindingPointer,
  type ExecutionUnitStatus,
  type ListFilter,
  MAX_BINDING_HISTORY,
  type MemberExecutionMember,
  type MemberMembership,
  type MemberPresence,
  type MemberRotation,
  type MemberState,
  type MemberStatus,
  type MemberVisibility,
  type PersistedAgentRecord,
  type PersistedBindingRecord,
} from './types.js';

/**
 * 管理面 viewer（tenant admin / human principal）。
 *
 * 0.28：`single` 取消后**不再有任何记录**因管理面身份而对 private 可见；
 * 保留常量是因为 `agents.list` 仍用它表达「管理面口径」，但 `canView` 不再
 * 给它旁路（private 一律只看 owner）。`*` 与 wildcard admin principal 同值。
 */
export const ADMIN_VIEWER = '*';

/** 注册表内部 Binding 记录（camelCase；对外经 toMemberStatus 转 snake_case） */
export interface BindingRecord {
  bindingId: string;
  epoch: number;
  createdAt: number;
  lastActiveAt: number;
  retiredAt?: number;
  primary: boolean;
}

/** 注册表内部记录（camelCase；对外经 toMemberStatus 转 snake_case） */
export interface MemberRecord {
  id: string;
  /** 第一具 Binding 的 session（兼容旧数据；当前 Binding 见 binding） */
  sessionId: string;
  /**
   * primary Binding（恰一具 live）。回收 / close 后**保留记录**并标 `retiredAt`——
   * `body_id ≡ session_id` 是续接历史的唯一钥匙，绝不删。
   * 只有 rotate 失败回滚这类中间态才短暂缺省。
   */
  binding?: BindingRecord;
  /**
   * 其余 live Binding（`primary:false`）；primary 不变，sibling 只能按自己的
   * `bindingId` / session_id 寻址。0.39 起由 fork / sibling 创建使用。
   */
  siblings?: BindingRecord[];
  /**
   * rotate 窗口内待退役的旧 Binding（`rotation === 'rotating'` 期间与新 Binding 共存）。
   * 窗口结束即清空：退役后进 `bindingHistory`。
   */
  retiringBinding?: BindingRecord;
  /** 已退役 Binding 的历史；只追加，最多 MAX_BINDING_HISTORY 条 */
  bindingHistory: BindingHistoryEntry[];
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
  /** Binding 轮换相位；不持久化 */
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
 * 所有 live Binding（未退役）：primary + siblings + rotate 窗口内的 retiring。
 *
 * 返回顺序固定为 primary 槽位 → siblings → retiring；按 `bindingId` 去重。
 * rotate 的回滚 / flush 依赖 retiring 也出现在列表里，所以这里**保持**该语义。
 */
export function liveBindings(record: MemberRecord): BindingRecord[] {
  const live: BindingRecord[] = [];
  const seen = new Set<string>();
  for (const body of [record.binding, ...(record.siblings ?? []), record.retiringBinding]) {
    if (body === undefined || body.retiredAt !== undefined || seen.has(body.bindingId)) continue;
    seen.add(body.bindingId);
    live.push(body);
  }
  return live;
}

/** primary Binding；缺省回落到唯一 live body / 兼容指针 */
export function primaryBinding(record: MemberRecord): BindingRecord | undefined {
  const live = liveBindings(record);
  return live.find((body) => body.primary) ?? live[0] ?? undefined;
}

/** 记录里该 id 的 Binding 槽位（primary / sibling / rotate 待退役体；含已退役） */
export function findBinding(record: MemberRecord, bindingId: string): BindingRecord | undefined {
  if (record.binding?.bindingId === bindingId) return record.binding;
  const sibling = record.siblings?.find((body) => body.bindingId === bindingId);
  if (sibling !== undefined) return sibling;
  if (record.retiringBinding?.bindingId === bindingId) return record.retiringBinding;
  return undefined;
}

/** 参与 session 寻址的 Binding session：primary 优先，否则当前 Binding，最后兼容 sessionId */
export function currentBindingSession(record: MemberRecord): string {
  return primaryBinding(record)?.bindingId ?? record.binding?.bindingId ?? record.sessionId;
}

/** 注册表记录 → 对外状态 */
export function toMemberStatus(record: MemberRecord): MemberStatus {
  const primary = primaryBinding(record);
  const bodies: ExecutionUnitStatus[] = liveBindings(record)
    .sort((left, right) => Number(right.primary) - Number(left.primary))
    .map((body) => ({
      session_id: body.bindingId,
      epoch: body.epoch,
      state: 'idle',
      primary: body.primary,
      created_at: body.createdAt,
      last_active_at: body.lastActiveAt,
    }));
  return {
    id: record.id,
    session_id: currentBindingSession(record),
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
    role: record.role,
    owner: record.owner,
    visibility: record.visibility,
    state: record.state,
    presence: record.presence,
    membership: record.membership,
    ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
    epoch: primary?.epoch ?? record.binding?.epoch ?? 0,
    ...(record.bindingHistory.length > 0 ? { body_history: record.bindingHistory } : {}),
    ...(bodies.length > 0 ? { bodies } : {}),
    ...(record.currentTool !== undefined ? { current_tool: record.currentTool } : {}),
    ...(record.lastSeen !== undefined ? { last_seen: record.lastSeen } : {}),
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  };
}

/** 内部 Binding → 持久化形状（snake_case） */
export function toPersistedBinding(body: BindingRecord): PersistedBindingRecord {
  return {
    body_id: body.bindingId,
    epoch: body.epoch,
    created_at: body.createdAt,
    last_active_at: body.lastActiveAt,
    ...(body.retiredAt !== undefined ? { retired_at: body.retiredAt } : {}),
    ...(body.primary ? { primary: true } : {}),
  };
}

/** 注册表记录 → 快照持久化记录（不落 presence / rotation） */
export function toPersistedRecord(record: MemberRecord): PersistedAgentRecord {
  const primary = primaryBinding(record);
  // rotate 窗口内旧 Binding 还挂在 `retiringBinding` 上、尚未进 `bindingHistory`。若此刻落盘，
  // 旧 session id 会整体丢失（`bodies[]` 只写当前 Binding）→ 崩溃后接不回去。
  // 所以窗口内也把待退役体记进 `body_history`（写完即退役，不影响 live 判定）。
  const history =
    record.retiringBinding !== undefined && record.retiringBinding.retiredAt === undefined
      ? [
          ...record.bindingHistory,
          {
            session_id: record.retiringBinding.bindingId,
            epoch: record.retiringBinding.epoch,
            started_at: record.retiringBinding.createdAt,
            retired_at: record.retiringBinding.lastActiveAt,
          },
        ]
      : record.bindingHistory;
  // 0.39：`bodies[]` 写 primary + 所有 live sibling。
  // - primary 槽位即使已退役（close / TTL 后）也要写：loader 的 `bodies[]` 为空时
  //   会按 session_id 造一具 live body，等于把已关闭成员复活；带 `retired_at` 的
  //   记录才能保住退役状态。
  // - rotate 窗口内的 retiring 仍按旧行为只进 body_history，避免崩溃后被 loader
  //   复活成 sibling。
  const persistedBodies = new Map<string, BindingRecord>();
  if (record.binding !== undefined) persistedBodies.set(record.binding.bindingId, record.binding);
  for (const sibling of record.siblings ?? []) {
    if (sibling.retiredAt === undefined) persistedBodies.set(sibling.bindingId, sibling);
  }
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
            session_id: primary.bindingId,
            epoch: primary.epoch,
            started_at: primary.createdAt,
          },
        }
      : {}),
    ...(history.length > 0 ? { body_history: history.slice(-MAX_BINDING_HISTORY) } : {}),
    // 文件格式不变（v4 仍读 `bodies[]`）：写全部 live binding（primary + siblings）。
    // rotate 期间待退役的旧 Binding 写在 `body_history`，不占 `bodies[]`。
    ...(persistedBodies.size > 0
      ? { bodies: [...persistedBodies.values()].map(toPersistedBinding) }
      : {}),
    ...(primary !== undefined ? { primary_body_id: primary.bindingId } : {}),
    ...(record.forkedFrom !== undefined ? { forked_from: record.forkedFrom } : {}),
    ...(record.currentTool !== undefined ? { current_tool: record.currentTool } : {}),
    ...(record.lastSeen !== undefined ? { last_seen: record.lastSeen } : {}),
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  };
}

/** 注册表记录 → 执行内核身份（primary binding；per-body 由 service 覆盖 session_id） */
export function toRuntimeMember(record: MemberRecord): MemberExecutionMember {
  return {
    id: record.id,
    session_id: currentBindingSession(record),
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
    for (const body of liveBindings(record)) {
      const owner = this.bySession.get(body.bindingId);
      if (owner !== undefined && owner !== record.id) {
        throw new AgentError('invalid_input', `duplicate member id: ${record.id}`);
      }
    }
    this.byId.set(record.id, record);
    for (const body of liveBindings(record)) this.bySession.set(body.bindingId, record.id);
  }

  /** 成员 id、任一 live body session 寻址 */
  resolve(idOrSession: string): MemberRecord | undefined {
    const direct = this.byId.get(idOrSession);
    if (direct) return direct;
    const id = this.bySession.get(idOrSession);
    if (id !== undefined) return this.byId.get(id);
    for (const record of this.byId.values()) {
      if (liveBindings(record).some((body) => body.bindingId === idOrSession)) return record;
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
      if (liveBindings(record).some((body) => body.bindingId === sessionId)) return record;
    }
    return undefined;
  }

  /**
   * 该 session 是否是**已退役**的 Binding（在 `bindingHistory` 或不 live 的 Binding 里）。
   *
   * 用途是拒绝对历史 session 的重新准入：否则惰性 `createBinding` 会把它复活成第二具
   * live Binding，D2 不变量破且没有任何报错。复活必须走 `reinstate`（原地 unretire）。
   */
  isRetiredSession(sessionId: string): boolean {
    for (const record of this.byId.values()) {
      if (record.bindingHistory.some((entry) => entry.session_id === sessionId)) return true;
      if (record.binding?.bindingId === sessionId && record.binding.retiredAt !== undefined)
        return true;
      if (
        record.siblings?.some(
          (body) => body.bindingId === sessionId && body.retiredAt !== undefined,
        )
      ) {
        return true;
      }
      if (record.retiringBinding?.bindingId === sessionId) return true;
    }
    return false;
  }

  remove(id: string): void {
    const record = this.byId.get(id);
    if (!record) return;
    this.byId.delete(id);
    for (const body of liveBindings(record)) {
      if (this.bySession.get(body.bindingId) === id) this.bySession.delete(body.bindingId);
    }
    if (this.bySession.get(currentBindingSession(record)) === id) {
      this.bySession.delete(currentBindingSession(record));
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

  /** 刷新指定 Binding 的 last_active_at（body 域活动） */
  touchBinding(id: string, bindingId: string, at: number = this.now()): void {
    const record = this.byId.get(id);
    if (!record) return;
    const body = findBinding(record, bindingId);
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
   * 新增 live Binding 并迁移 session 寻址键。
   *
   * 单 body 模型下只有两种情形能走到这里：(a) 记录当前没有 live Binding（首次 / 回收后
   * 已被 `reinstate` 清槽）；(b) rotate 窗口——旧 Binding 先挪进 `retiringBinding`，新 Binding 占
   * `binding`，窗口结束后旧 Binding 由 `retireBinding` 记入 `bindingHistory`。
   */
  addBinding(id: string, body: BindingRecord): void {
    const record = this.byId.get(id);
    if (!record) throw new AgentError('unknown_member', `unknown member: ${id}`);
    const existing = findBinding(record, body.bindingId);
    if (existing !== undefined && existing.retiredAt === undefined) {
      throw new AgentError('invalid_input', `duplicate body: ${body.bindingId}`);
    }
    const owner = this.bySession.get(body.bindingId);
    if (owner !== undefined && owner !== id) {
      throw new AgentError('invalid_input', `duplicate body: ${body.bindingId}`);
    }
    const replaced = record.binding;
    if (replaced !== undefined) {
      if (replaced.retiredAt === undefined) {
        // rotate：旧 Binding 暂存到 retiringBinding，等窗口结束再退役。
        record.retiringBinding = replaced;
      } else {
        // 已退役的 Binding 让位给新 Binding：先进 history，绝不静默丢弃。
        this.pushBindingHistory(id, {
          session_id: replaced.bindingId,
          epoch: replaced.epoch,
          started_at: replaced.createdAt,
          retired_at: replaced.retiredAt,
        });
      }
    }
    record.binding = body;
    this.bySession.set(body.bindingId, id);
    if (body.primary) this.setPrimaryBinding(id, body.bindingId);
  }

  /**
   * 新增一个 live sibling（内部；供后续 `forkSession` 使用）。
   *
   * 校验：`primary:false`、bindingId 未占用且未退役。**不经过 `body_limit`**，
   * 也不改变 primary / lease / epoch。primary 位置只能由 `addBinding` 持有。
   */
  addSiblingBinding(id: string, body: BindingRecord): void {
    const record = this.byId.get(id);
    if (!record) throw new AgentError('unknown_member', `unknown member: ${id}`);
    if (body.primary) {
      throw new AgentError(
        'invalid_input',
        `sibling binding must not be primary: ${body.bindingId}`,
      );
    }
    if (body.retiredAt !== undefined) {
      throw new AgentError('invalid_input', `sibling binding is retired: ${body.bindingId}`);
    }
    if (findBinding(record, body.bindingId) !== undefined) {
      throw new AgentError('invalid_input', `duplicate body: ${body.bindingId}`);
    }
    if (this.bySession.get(body.bindingId) !== undefined) {
      throw new AgentError('invalid_input', `duplicate body: ${body.bindingId}`);
    }
    if (record.bindingHistory.some((entry) => entry.session_id === body.bindingId)) {
      throw new AgentError('invalid_input', `sibling binding is retired: ${body.bindingId}`);
    }
    record.siblings = [...(record.siblings ?? []), body];
    this.bySession.set(body.bindingId, id);
  }

  /**
   * 退役 Binding：标 retiredAt、清 primary、从 session 索引移除、记入 `body_history`。
   *
   * body 记录**保留**（不删）：`body_id ≡ session_id` 是续接历史的唯一钥匙，
   * `reinstate` 靠原地 unretire 复活。
   *
   * 0.39：sibling 退役只把自己移出 `siblings`；primary 退役时若仍有 live sibling，
   * 本切片没有定义 primary 迁移语义，直接抛 `multi_session`，由 `retireAllLive`
   * （close / TTL / delete）统一处理。
   */
  retireBinding(id: string, bindingId: string, at: number = this.now()): BindingRecord | undefined {
    const record = this.byId.get(id);
    if (!record) return undefined;
    const body = findBinding(record, bindingId);
    if (body === undefined || body.retiredAt !== undefined) return body;
    const isPrimary = body.primary || record.binding === body;
    if (isPrimary && (record.siblings ?? []).some((sibling) => sibling.retiredAt === undefined)) {
      throw new AgentError(
        'multi_session',
        `multi_session: cannot retire primary ${bindingId} while live siblings exist: ${record.id}`,
      );
    }
    body.retiredAt = at;
    body.primary = false;
    if (this.bySession.get(bindingId) === id) this.bySession.delete(bindingId);
    if (record.retiringBinding === body) delete record.retiringBinding;
    record.siblings = (record.siblings ?? []).filter((sibling) => sibling.bindingId !== bindingId);
    this.pushBindingHistory(id, {
      session_id: body.bindingId,
      epoch: body.epoch,
      started_at: body.createdAt,
      retired_at: at,
    });
    return body;
  }

  /**
   * 退役**所有** live Binding（close / TTL / delete 专用）。
   *
   * 顺序：siblings / retiring 先退役，primary 最后——这样 `retireBinding` 的
   * `multi_session` 守卫不会在收口路径上误触发。退役后 `siblings` 清空、
   * `primaryBinding` 返回 undefined；`binding` 记录保留并标 `retiredAt`（续接 /
   * reinstate 的唯一钥匙）。
   */
  retireAllLive(id: string, at: number = this.now()): BindingRecord[] {
    const record = this.byId.get(id);
    if (!record) return [];
    const all = liveBindings(record);
    const primary = all.find((body) => body.primary) ?? record.binding;
    const ordered = [...all].sort(
      (left, right) => Number(left === primary) - Number(right === primary),
    );
    for (const body of ordered) this.retireBinding(id, body.bindingId, at);
    record.siblings = [];
    return all;
  }

  /**
   * 原地复活一个已退役的 Binding（`reinstate` 用）：清 `retiredAt`、重设 primary、
   * 从 `body_history` 移除该 session（否则 DTO 同时显示 live 和已退役）。
   * 返回是否真的发生了复活。
   */
  unretireBinding(id: string, bindingId?: string): boolean {
    const record = this.byId.get(id);
    if (!record) return false;
    const body = bindingId === undefined ? record.binding : findBinding(record, bindingId);
    if (body === undefined || body.retiredAt === undefined) return false;
    delete body.retiredAt;
    record.bindingHistory = record.bindingHistory.filter(
      (entry) => entry.session_id !== body.bindingId,
    );
    this.bySession.set(body.bindingId, id);
    this.setPrimaryBinding(id, body.bindingId);
    return true;
  }

  /** 完全移除一个 Binding（rotate 失败回滚用）；只用于从未提交的中间态 */
  removeBinding(id: string, bindingId: string): void {
    const record = this.byId.get(id);
    if (!record) return;
    if (this.bySession.get(bindingId) === id) this.bySession.delete(bindingId);
    if (record.retiringBinding?.bindingId === bindingId) {
      delete record.retiringBinding;
      return;
    }
    if (record.siblings?.some((body) => body.bindingId === bindingId)) {
      record.siblings = record.siblings.filter((body) => body.bindingId !== bindingId);
      return;
    }
    if (record.binding?.bindingId !== bindingId) return;
    const previous = record.retiringBinding;
    if (previous === undefined) {
      delete record.binding;
      return;
    }
    // 回滚：待退役的仍是当前 Binding，primary 由它自己带着。
    delete record.retiringBinding;
    record.binding = previous;
    this.bySession.set(previous.bindingId, id);
  }

  /** 设置 primary（undefined = 清空）；live Binding 的 primary 标记同步 */
  setPrimaryBinding(id: string, bindingId: string | undefined): void {
    const record = this.byId.get(id);
    if (!record) return;
    const target =
      bindingId === undefined
        ? undefined
        : liveBindings(record).find((body) => body.bindingId === bindingId);
    if (bindingId !== undefined && target === undefined) return;
    for (const body of liveBindings(record)) body.primary = body === target;
  }

  /** 兼容旧调用：把指针设为 primary binding（同步 bodies）。 */
  setCurrentBinding(id: string, body: BindingPointer): void {
    this.setPrimaryBinding(id, body.session_id);
  }

  /** Binding 轮换相位（进程内，不持久化） */
  setRotation(id: string, rotation: MemberRotation): void {
    const record = this.byId.get(id);
    if (record) record.rotation = rotation;
  }

  /** 追加退役 Binding；超过 MAX_BINDING_HISTORY 时丢弃最旧条目 */
  pushBindingHistory(id: string, entry: BindingHistoryEntry): void {
    const record = this.byId.get(id);
    if (!record) return;
    record.bindingHistory.push(entry);
    if (record.bindingHistory.length > MAX_BINDING_HISTORY) {
      record.bindingHistory.splice(0, record.bindingHistory.length - MAX_BINDING_HISTORY);
    }
  }

  /** 整组覆盖 binding history（rotate 失败回滚用） */
  setBindingHistory(id: string, entries: readonly BindingHistoryEntry[]): void {
    const record = this.byId.get(id);
    if (record) record.bindingHistory = [...entries];
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
