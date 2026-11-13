/**
 * 会话 / 交互域方法：sessions.*、interactions.*、permission / ask 应答。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import type { AskRespondOutcome } from '../ask-answers';
import type { ListedInteraction, ListedInteractionPage } from '../interaction-hydration';
import { permissionRespondParams } from '../interactions';
import type {
  AskUserAnswer,
  DeleteSessionResult,
  PermissionScope,
  RenameSessionResult,
  SessionActivateInput,
  SessionActivateResult,
  SessionCreateInput,
  SessionCreateResult,
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

  /**
   * 创建 session（CONTRACT-0.39-create §2）：
   * - 无 `from_session_id`：同 agent 的空 session；
   * - 有 `from_session_id`：从源 session 复制 / 压缩前缀（`keep_messages` 下标），
   *   新 session 成为 primary，**源 session 退役但保留**。
   */
  createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    return this.rpc<SessionCreateResult>('sessions.create', input);
  }

  /**
   * 切换 primary（CONTRACT-0.39-create §4）：目标 session 重新可跑，
   * 原 primary 退役进 `bindingHistory`；目标本来就是 primary 时 `noop: true`。
   */
  activateSession(input: SessionActivateInput): Promise<SessionActivateResult> {
    return this.rpc<SessionActivateResult>('sessions.activate', input);
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
   * 读取单个会话状态（messages 是连续窗口）。
   * WS `sessions.get` 优先；方法不可用/超时再回退 0.5 HTTP RPC。
   * not_found 是业务结果，不触发回退。
   *
   * `message_limit` / `before` 是 S1 additive 参数：不传时旧行为（全量）。
   * 旧 gateway 忽略未知参数，响应缺 `messages_total` / `next_before` 时调用方按
   * "本次 messages 即全量" 降级。
   */
  async getSession(
    sessionId: string,
    opts: { message_limit?: number; before?: string } = {},
  ): Promise<SessionDetail> {
    const params = {
      session_id: sessionId,
      ...(opts.message_limit !== undefined ? { message_limit: opts.message_limit } : {}),
      ...(opts.before !== undefined ? { before: opts.before } : {}),
    };
    if (this.state === 'open' && this.helloInfo) {
      try {
        const body = await this.request<{ session?: SessionDetail }>('sessions.get', params);
        const session = body.session;
        if (!session) throw new GatewayHttpError('not_found', 'Session not found');
        return { ...session, messages: normalizeMessages(session.messages) };
      } catch (error) {
        if (isNotFoundError(error)) throw error;
        // WS 不可用：继续走 HTTP RPC
      }
    }
    const body = await this.rpc<{ session?: SessionDetail }>('sessions.get', params);
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

  /**
   * 回答 ask；`answers: []` 表示取消。
   *
   * 返回体是服务端 `ask.respond` 的结果（additive）：分批提交时它带 `remaining_questions`
   * / `final`，调用方据此决定卡片收不收（`askRespondKeepsPending`）。旧 gateway 的返回体
   * 里没有这些键 —— 调用方一律按「收口」处理，行为与分批之前一致。
   */
  async respondAsk(
    requestId: string,
    answers: AskUserAnswer[],
    batchId?: string,
  ): Promise<AskRespondOutcome> {
    const body = await this.request<AskRespondOutcome>('ask.respond', {
      request_id: requestId,
      answers,
      // additive（0.52）：待批页一次提交的批次标记 —— 同批答案合成一条消息 + 一次 run。
      ...(batchId !== undefined && batchId !== '' ? { batch_id: batchId } : {}),
    });
    return body ?? {};
  }
}
