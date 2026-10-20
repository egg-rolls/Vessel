/**
 * Session 命名空间（D3）
 *
 * Host 共享一个 SessionBackend 时，按 `${agentId}/` 前缀隔离成员的会话；
 * 成员内的 sessionId 保持原样，读写时自动加/去前缀。
 * 这是 Host 内部实现，不新增公开接口。
 *
 * @module @vessel-agent/core/kernel
 */

import type { RunState, SessionBackend, SessionInfo } from '../types/session.js';

/** 按 agentId 隔离共享 SessionBackend */
export class AgentSessionScope implements SessionBackend {
  private readonly prefix: string;

  constructor(
    private readonly backend: SessionBackend,
    agentId: string,
  ) {
    this.prefix = `${agentId}/`;
  }

  private scoped(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  private unscoped(sessionId: string): string {
    return sessionId.slice(this.prefix.length);
  }

  async load(sessionId: string): Promise<RunState | null> {
    return this.backend.load(this.scoped(sessionId));
  }

  async save(state: RunState): Promise<void> {
    await this.backend.save({ ...state, session_id: this.scoped(state.session_id) });
  }

  async delete(sessionId: string): Promise<void> {
    await this.backend.delete(this.scoped(sessionId));
  }

  async list(): Promise<string[]> {
    const ids = await this.backend.list();
    return ids.filter((id) => id.startsWith(this.prefix)).map((id) => this.unscoped(id));
  }

  async listRich(): Promise<SessionInfo[]> {
    const infos = await this.backend.listRich();
    return infos
      .filter((info) => info.session_id.startsWith(this.prefix))
      .map((info) => ({ ...info, session_id: this.unscoped(info.session_id) }));
  }
}
