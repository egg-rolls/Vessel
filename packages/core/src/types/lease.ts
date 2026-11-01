/**
 * 两级租约端口（Stage 3 / ADR-098 C2）。
 *
 * - BindingLease：key = binding_id，保护 Agent ↔ Session 绑定归属与节点保活；
 * - SessionLease：key = session_id，保护同一 Session 的独占与 append fencing。
 *
 * 获取顺序 binding → session；释放逆序。读路径不需要租约。
 * LeaseService 是单节点本地服务，租约带 tenant 标签；Run 不接触本端口。
 *
 * @module @vessel-agent/core/types/lease
 */

/** 租约种类 */
export type LeaseKind = 'binding' | 'session';

/** 一次成功获取/续租的凭据 */
export interface LeaseGrant {
  leaseId: string;
  kind: LeaseKind;
  /** binding_id 或 session_id */
  key: string;
  tenantId: string;
  /** 单调递增；写 SessionEventLog / RunRecord 时作为 fencing token */
  fencingToken: number;
  /** epoch 毫秒；过期后可被其他持有者接管 */
  expiresAt: number;
}

/** 获取/续租参数 */
export interface LeaseOptions {
  /** 缺省用 LeaseService 的配置 ttlMs */
  ttlMs?: number;
  /**
   * 新租约的最低 fencing token（compactFork 用）。
   * 实际 token = max(该 key 上一次 fence + 1, minFence)；保证新 primary 的 token
   * 高于旧 primary 释放前的 token。
   */
  minFence?: number;
}

/**
 * 租约服务端口：只被 ControlPlane 与 ExecutionUnit 引用。
 * 实现位于装配层（单节点本地文件租约）。
 */
export interface LeaseServicePort {
  /** 建议续租间隔（毫秒）；可选，ExecutionUnit 定时器优先使用，缺省按 TTL/3 */
  readonly renewMs?: number;
  acquire(kind: LeaseKind, key: string, opts?: LeaseOptions): Promise<LeaseGrant>;
  renew(leaseId: string): Promise<LeaseGrant>;
  release(leaseId: string): Promise<void>;
  /** 租约仍有效（未释放、未过期、token 未变） */
  validate(leaseId: string): Promise<boolean>;
  /** 当前 key 已颁发的最大 fencing token；用于 append 校验 */
  fenceOf(kind: LeaseKind, key: string): Promise<number>;
}

/** 同 key 已有未过期租约（RPC 主码 conflict） */
export class LeaseConflictError extends Error {
  readonly code = 'conflict' as const;
  readonly reason: 'binding_locked' | 'session_locked';
  readonly kind: LeaseKind;
  readonly key: string;

  constructor(kind: LeaseKind, key: string) {
    super(
      `${kind === 'binding' ? 'binding_locked' : 'session_locked'}: ${key} is held by another lease`,
    );
    this.name = 'LeaseConflictError';
    this.kind = kind;
    this.key = key;
    this.reason = kind === 'binding' ? 'binding_locked' : 'session_locked';
  }
}

/** 租约已过期/已释放，或 fencing token 过旧（RPC 主码 conflict） */
export class LeaseExpiredError extends Error {
  readonly code = 'conflict' as const;
  readonly reason: 'lease_expired' | 'stale_fence';
  readonly leaseId?: string;

  constructor(reason: 'lease_expired' | 'stale_fence', leaseId?: string) {
    super(
      reason === 'lease_expired'
        ? 'lease_expired'
        : 'stale_fence: fencing token is older than the current lease',
    );
    this.name = 'LeaseExpiredError';
    this.reason = reason;
    if (leaseId !== undefined) this.leaseId = leaseId;
  }
}
