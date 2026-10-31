/**
 * 会话 / 交互域方法：sessions.*、interactions.*、permission / ask 应答。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import type { ListedInteraction, ListedInteractionPage } from '../interaction-hydration';
import { permissionRespondParams } from '../interactions';
import type {
  AskUserAnswer,
  DeleteSessionResult,
  PermissionScope,
  RenameSessionResult,
  SessionDetail,
  SessionInfo,
  SessionSearchHit,
} from '../types';
import { GatewayHttpError } from './protocol';
import { canFallbackToRest, isNotFoundError, normalizeMessages, RpcClient } from './rpc';

export abstract class SessionsClient extends RpcClient {
  /**
   * 会话列表：canonical RPC 优先（HTTP + token，断线重连时仍可读），
   * 旧 gateway 回退 WS legacy `sessions.list`。
   */
  async listSessions(): Promise<SessionInfo[]> {
    try {
      const body = await this.rpc<{ sessions?: SessionInfo[] }>('sessions.list');
      return body.sessions ?? [];
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const body = await this.request<{ sessions?: SessionInfo[] }>('sessions.list');
      return body.sessions ?? [];
    }
  }

  /**
   * 会话内容搜索（canonical `sessions.search`）。
   * 旧 gateway 没有该方法时返回 null，由调用方回退到本地 title/preview/id 过滤。
   */
  async searchSessions(query: string, limit?: number): Promise<SessionSearchHit[] | null> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    try {
      const body = await this.rpc<{ sessions?: SessionSearchHit[] }>('sessions.search', {
        query: trimmed,
        ...(limit !== undefined ? { limit } : {}),
      });
      return body.sessions ?? [];
    } catch {
      return null;
    }
  }

  /** 删除会话及其持久历史、关联 runs 与事件；返回级联计数。 */
  deleteSession(sessionId: string): Promise<DeleteSessionResult> {
    return this.rpc<DeleteSessionResult>('sessions.delete', { session_id: sessionId });
  }

  /** 重命名会话；后端会更新 updated_at，列表按倒序会自然跳到顶部。 */
  renameSession(sessionId: string, title: string): Promise<RenameSessionResult> {
    return this.rpc<RenameSessionResult>('sessions.rename', {
      session_id: sessionId,
      title,
    });
  }

  /**
   * 0.18：读取 pending / answered / orphaned 交互（旧 gateway 无此方法时由调用方处理）。
   * 只是分页版本的兼容包装：返回数组，不改变 hydration 的调用契约。
   */
  async listInteractions(
    params: {
      session_id?: string;
      run_id?: string;
      status?: 'pending' | 'answered' | 'orphaned';
      limit?: number;
      tenant_id?: string;
    } = {},
  ): Promise<ListedInteraction[]> {
    const page = await this.listInteractionsPage(params);
    return page.interactions;
  }

  /**
   * DECISION-038 §2.2：`interactions.list` 分页（order / cursor / total additive）。
   * 旧 gateway 忽略未知参数；返回形状缺失时按空页处理。
   */
  async listInteractionsPage(
    params: {
      session_id?: string;
      run_id?: string;
      team_id?: string;
      status?: 'pending' | 'answered' | 'orphaned';
      limit?: number;
      order?: 'oldest' | 'newest';
      cursor?: string;
      tenant_id?: string;
    } = {},
  ): Promise<ListedInteractionPage> {
    const body = await this.rpc<{
      interactions?: ListedInteraction[];
      total?: number;
      next_cursor?: string;
    }>('interactions.list', params);
    const interactions = body.interactions ?? [];
    return {
      interactions,
      total: typeof body.total === 'number' ? body.total : interactions.length,
      ...(typeof body.next_cursor === 'string' && body.next_cursor.length > 0
        ? { next_cursor: body.next_cursor }
        : {}),
    };
  }

  /**
   * 读取单个会话的完整状态（含 messages）。
   * WS `sessions.get` 优先；方法不可用/超时再回退 0.5 HTTP RPC。
   * not_found 是业务结果，不触发回退。
   */
  async getSession(sessionId: string): Promise<SessionDetail> {
    if (this.state === 'open' && this.helloInfo) {
      try {
        const body = await this.request<{ session?: SessionDetail }>('sessions.get', {
          session_id: sessionId,
        });
        const session = body.session;
        if (!session) throw new GatewayHttpError('not_found', 'Session not found');
        return { ...session, messages: normalizeMessages(session.messages) };
      } catch (error) {
        if (isNotFoundError(error)) throw error;
        // WS 不可用：继续走 HTTP RPC
      }
    }
    const body = await this.rpc<{ session?: SessionDetail }>('sessions.get', {
      session_id: sessionId,
    });
    const session = body.session;
    if (!session) throw new GatewayHttpError('not_found', 'Session not found');
    return { ...session, messages: normalizeMessages(session.messages) };
  }

  async respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    scope: PermissionScope = 'once',
  ): Promise<void> {
    await this.request('permission.respond', {
      request_id: requestId,
      ...permissionRespondParams(decision, scope),
    });
  }

  /** 回答 ask_user；answers=[] 表示取消 */
  async respondAsk(requestId: string, answers: AskUserAnswer[]): Promise<void> {
    await this.request('ask.respond', { request_id: requestId, answers });
  }
}
