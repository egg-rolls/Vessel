/**
 * RPC / REST 传输：canonical `/v1/rpc`、REST 兜底与回退判定。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import { t } from '../../i18n';
import type { GatewayErrorBody, Message, RpcResponseEnvelope } from '../types';
import { GatewayHttpError, ProtocolClient } from './protocol';

export abstract class RpcClient extends ProtocolClient {
  /** 统一 RPC 入口；失败抛 GatewayHttpError（携带冻结 code） */
  async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await this.httpJson<RpcResponseEnvelope<T>>('/v1/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    });
    if (!response.ok) {
      throw new GatewayHttpError(
        response.error?.code ?? 'internal',
        response.error?.message ?? `RPC failed: ${method}`,
      );
    }
    return response.result as T;
  }

  protected async httpJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.token;
    if (!token) {
      throw new GatewayHttpError('unauthorized', t('gateway.client.tokenRequiredHttp'));
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);

    let res: Response;
    try {
      res = await fetch(`${this.httpBase()}${path}`, { ...init, headers });
    } catch (error) {
      throw new GatewayHttpError('network', error instanceof Error ? error.message : String(error));
    }
    if (!res.ok) {
      let code = 'internal';
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as GatewayErrorBody;
        if (body?.error?.code) {
          code = body.error.code;
          message = body.error.message || message;
        }
      } catch {
        // 非 JSON 错误体：保留 HTTP 状态
      }
      throw new GatewayHttpError(code, message, res.status);
    }
    return (await res.json()) as T;
  }
}

/** 兼容 WS 错误（`code: message`）与 HTTP GatewayHttpError 两种形状 */
export function isNotFoundError(error: unknown): boolean {
  if (error instanceof GatewayHttpError) return error.code === 'not_found';
  return error instanceof Error && error.message.startsWith('not_found:');
}

/** 旧 gateway 没有 /v1/rpc 或 runs.* 时回退到 WS legacy 方法；业务错误不回退。 */
export function canFallbackToLegacyRuns(error: unknown): boolean {
  if (!(error instanceof GatewayHttpError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  return error.code === 'method_not_allowed';
}

/** 旧 gateway 没有 canonical RPC 时回退到既有 REST 读接口。 */
export function canFallbackToRest(error: unknown): boolean {
  if (!(error instanceof GatewayHttpError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  return error.code === 'method_not_allowed' || error.code === 'not_found';
}

/** 服务端返回的 messages 可能是旧数据/空值；统一成前端可渲染的形状 */
export function normalizeMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is Message =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as Message).role === 'string' &&
      typeof (item as Message).content === 'string',
  );
}
