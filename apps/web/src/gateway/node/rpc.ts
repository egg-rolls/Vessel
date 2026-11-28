/**
 * RPC / REST 传输：canonical `/v1/rpc`、REST 兜底与回退判定。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import { t } from '../../i18n';
import { noteRpcFailure, noteRpcNetworkFailure, noteRpcSuccess } from '../session-invalid';
import type { GatewayErrorBody, Message, RpcResponseEnvelope } from '../types';
import { joinBaseUrl } from '../url';
import { GatewayHttpError, ProtocolClient } from './protocol';

export abstract class RpcClient extends ProtocolClient {
  /** 统一 RPC 入口；失败抛 GatewayHttpError（携带冻结 code） */
  async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await this.httpJson<RpcResponseEnvelope<T>>(
      '/v1/rpc',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          id: crypto.randomUUID(),
          method,
          ...(params !== undefined ? { params } : {}),
        }),
      },
      // 方法名进「被拒」状态：顶部提示能说清是哪一类请求被挡住的。
      method,
    );
    if (!response.ok) {
      throw new GatewayHttpError(
        response.error?.code ?? 'internal',
        response.error?.message ?? `RPC failed: ${method}`,
      );
    }
    return response.result as T;
  }

  protected async httpJson<T>(
    path: string,
    init: RequestInit = {},
    /** 诊断标签（RPC 方法名）；缺省用路径。 */
    label?: string,
  ): Promise<T> {
    const token = this.token;
    if (!token && !this.proxyMode) {
      throw new GatewayHttpError('unauthorized', t('gateway.client.tokenRequiredHttp'));
    }
    const headers = new Headers(init.headers);
    // 0.58：代理模式下鉴权是平台会话（cookie 同源自动带上）；浏览器不再持有 node token。
    if (token) headers.set('Authorization', `Bearer ${token}`);

    let res: Response;
    try {
      // S4 单实现：与插件资产 URL 同一 joinBaseUrl（保留代理前缀 /nodes/<id>）。
      res = await fetch(joinBaseUrl(this.httpBase(), path), {
        ...init,
        headers,
        ...(this.proxyMode ? { credentials: 'same-origin' as const } : {}),
      });
    } catch (error) {
      const failure = new GatewayHttpError(
        'network',
        error instanceof Error ? error.message : String(error),
      );
      // 0.59：连响应都没拿到也是**被拒**的一种 —— 真跨源被挡时浏览器只抛 TypeError，
      // 没有 401/403 可分类（CORS 不回 ACAO 就连 status 都读不到）。按连接 epoch 计数，
      // 攒够阈值且本 epoch 从未成功过 ⇒ 抬一条「连不上」提示（不触发重新登录）。
      noteRpcNetworkFailure(failure, label ?? path);
      throw failure;
    }
    if (!res.ok) {
      let code = 'internal';
      let message = `HTTP ${res.status}`;
      let details: unknown;
      try {
        const body = (await res.json()) as GatewayErrorBody;
        if (body?.error?.code) {
          code = body.error.code;
          message = body.error.message || message;
        }
        details = body?.error?.details;
      } catch {
        // 非 JSON 错误体：保留 HTTP 状态
      }
      const error = new GatewayHttpError(code, message, res.status, details);
      // 0.59：401 / Origin 被拒**不许静默** —— 记进全局「被拒」状态（顶部提示 + 重新登录
      // 入口都读它）。这就是「待批权限卡永远拿不到、界面毫无表示」那条 bug 的收口点。
      noteRpcFailure(error, label ?? path);
      throw error;
    }
    // 能拿到响应 = 会话 / Origin 都通了：清掉失效状态（幂等，平时是一次 null 判断）。
    noteRpcSuccess();
    return (await res.json()) as T;
  }
}

/** 兼容 WS 错误（`code: message`）与 HTTP GatewayHttpError 两种形状 */
export function isNotFoundError(error: unknown): boolean {
  if (error instanceof GatewayHttpError) return error.code === 'not_found';
  return error instanceof Error && error.message.startsWith('not_found:');
}

/** 旧 gateway 没有 /v1/rpc 或 runs.* 时回退到 WS legacy 方法；业务错误不回退。
 * q-error-e1（D4）：只认方法级信号（method_not_found/method_not_allowed/404/405）。 */
export function canFallbackToLegacyRuns(error: unknown): boolean {
  if (!(error instanceof GatewayHttpError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  return error.code === 'method_not_allowed' || error.code === 'method_not_found';
}

/** 旧 gateway 没有 canonical RPC 时回退到既有 REST 读接口。
 * q-error-e1（D4）：资源 not_found 不再触发回退空结果——只认方法级信号。 */
export function canFallbackToRest(error: unknown): boolean {
  if (!(error instanceof GatewayHttpError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  return error.code === 'method_not_allowed' || error.code === 'method_not_found';
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
