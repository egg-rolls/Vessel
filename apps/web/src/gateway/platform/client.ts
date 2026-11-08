/**
 * Platform Gateway 客户端（`POST /platform/rpc`）。
 *
 * 冻结边界（CONTRACT-0.49 §5.2，PLAN §7.9）：
 * - 本目录只连平台入口；**不 import** node 客户端目录，也不把 node 方法名透传过去。
 * - 平台只读 allowlist：whoami / nodes.list / nodes.credentials（health 备用）。
 * - token 只在内存里；不写 localStorage / URL / 日志。
 */

import type {
  PlatformNodeCredentials,
  PlatformNodeSummary,
  PlatformNodesListResult,
  PlatformWhoAmI,
} from '../types/platform';

export class PlatformRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PlatformRpcError';
  }
}

interface PlatformRpcEnvelope<T> {
  v?: number;
  id?: string;
  ok?: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

const RPC_TIMEOUT_MS = 10_000;

/**
 * 平台客户端。`baseUrl` 为空串表示页面同源（gateway 托管 dist）；
 * 非空 = `vessel.gateway-url` 保存的平台 origin。
 */
export class PlatformClient {
  constructor(
    private readonly baseUrl = '',
    private readonly token = '',
  ) {}

  private origin(): string {
    const trimmed = this.baseUrl.trim().replace(/\/+$/, '');
    return trimmed !== '' ? trimmed : window.location.origin;
  }

  async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.origin()}/platform/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token !== '' ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          v: 1,
          id: crypto.randomUUID(),
          method,
          ...(params !== undefined ? { params } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new PlatformRpcError(
        'network',
        error instanceof Error && error.name === 'AbortError'
          ? 'platform request timeout'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      window.clearTimeout(timer);
    }

    let body: PlatformRpcEnvelope<T> | null = null;
    try {
      body = (await response.json()) as PlatformRpcEnvelope<T>;
    } catch {
      body = null;
    }

    if (!response.ok) {
      throw new PlatformRpcError(
        body?.error?.code ?? `http_${response.status}`,
        body?.error?.message ?? `HTTP ${response.status}`,
        response.status,
      );
    }
    if (body?.ok !== true) {
      throw new PlatformRpcError(
        body?.error?.code ?? 'internal',
        body?.error?.message ?? `RPC failed: ${method}`,
      );
    }
    return body.result as T;
  }

  whoami(): Promise<PlatformWhoAmI> {
    return this.rpc<PlatformWhoAmI>('platform.whoami');
  }

  async listNodes(): Promise<PlatformNodeSummary[]> {
    const result = await this.rpc<PlatformNodesListResult>('platform.nodes.list');
    return Array.isArray(result?.nodes) ? result.nodes : [];
  }

  /**
   * `{node_id?}`：多节点时必须带选中节点；单节点时省略以保持 G1 兼容
   * （契约 §5：省略且多节点 → `invalid_params`）。
   */
  credentials(nodeId?: string): Promise<PlatformNodeCredentials> {
    return nodeId === undefined
      ? this.rpc<PlatformNodeCredentials>('platform.nodes.credentials')
      : this.rpc<PlatformNodeCredentials>('platform.nodes.credentials', { node_id: nodeId });
  }
}

export type PlatformProbe =
  | { kind: 'platform'; whoami: PlatformWhoAmI }
  | { kind: 'legacy' }
  | { kind: 'error'; error: PlatformRpcError };

/**
 * 平台入口不可用（页面由 legacy `--serve` 提供 / 旧 gateway 没有该路由）判定。
 * 只把“端点不存在 / 网络不可达”当作可回退；401/403/5xx 不静默回退。
 */
export function isPlatformUnavailable(error: PlatformRpcError): boolean {
  if (error.code === 'network') return true;
  return error.status === 404 || error.status === 405;
}

/** 探测平台入口；失败按可回退 / 需报错分类。 */
export async function probePlatform(client: PlatformClient): Promise<PlatformProbe> {
  try {
    return { kind: 'platform', whoami: await client.whoami() };
  } catch (error) {
    const rpcError =
      error instanceof PlatformRpcError
        ? error
        : new PlatformRpcError('internal', error instanceof Error ? error.message : String(error));
    return isPlatformUnavailable(rpcError)
      ? { kind: 'legacy' }
      : { kind: 'error', error: rpcError };
  }
}
