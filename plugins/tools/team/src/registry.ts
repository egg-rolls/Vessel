/**
 * 0.16 成员注册表（DECISION-031 E1）。
 *
 * session 即成员：`spawn` 创建 session 并注册；只有注册成员能被 `agent.send` 寻址。
 * 注册表只记录身份与状态，不持有运行时对象；真正执行仍走 TeamHostPort。
 */

import type { Usage } from '@vessel-agent/core';
import type { MemberPermissionMode, MemberState, MemberStatus, MemberVisibility } from './host.js';

/** 注册表记录 */
export interface MemberRecord {
  id: string;
  sessionId: string;
  name?: string;
  parentId?: string;
  parentSessionId?: string;
  owner: string;
  visibility: MemberVisibility;
  permissionMode: MemberPermissionMode;
  tenantId?: string;
  state: MemberState;
  currentTool?: string;
  lastSeen?: number;
  usage?: Usage;
}

/** 成员状态视图（snake_case，E1 对外形状） */
export function toMemberStatus(record: MemberRecord): MemberStatus {
  return {
    id: record.id,
    session_id: record.sessionId,
    ...(record.name !== undefined ? { name: record.name } : {}),
    ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
    visibility: record.visibility,
    state: record.state,
    ...(record.currentTool !== undefined ? { current_tool: record.currentTool } : {}),
    ...(record.lastSeen !== undefined ? { last_seen: record.lastSeen } : {}),
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  };
}

/** 成员注册表 */
export class MemberRegistry {
  private readonly byId = new Map<string, MemberRecord>();
  private readonly bySession = new Map<string, string>();

  constructor(private readonly tenantId?: string) {}

  add(record: MemberRecord): void {
    this.byId.set(record.id, record);
    this.bySession.set(record.sessionId, record.id);
  }

  /** 成员 id 或 session_id 都可寻址 */
  resolve(idOrSession: string): MemberRecord | undefined {
    const byId = this.byId.get(idOrSession);
    if (byId) return byId;
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

  setState(id: string, state: MemberState, currentTool?: string): void {
    const record = this.byId.get(id);
    if (!record) return;
    record.state = state;
    record.lastSeen = Date.now();
    if (state === 'waiting_permission') {
      if (currentTool !== undefined) record.currentTool = currentTool;
    } else {
      record.currentTool = undefined;
    }
  }

  setUsage(id: string, usage: Usage): void {
    const record = this.byId.get(id);
    if (record) record.usage = usage;
  }

  list(): MemberRecord[] {
    return [...this.byId.values()];
  }

  /**
   * 寻址规则：同 tenant 才可见；`private` 仅 owner。
   * `team` / `tenant` 在本机同一 tenant 内等价，跨节点授权不在 Phase A 范围。
   */
  canAddress(target: MemberRecord, senderId: string): boolean {
    if (target.tenantId !== this.tenantId) return false;
    if (target.visibility === 'private') return senderId === target.owner;
    return true;
  }
}
