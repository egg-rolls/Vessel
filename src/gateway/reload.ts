/**
 * `vessel gateway reload` 客户端（0.12 DECISION-023 §2.3）。
 *
 * 调用 web 新增的 canonical RPC `gateway.reload`：
 * `params { scopes?: string[] }` → `{ reloaded: string[], requires_restart: string[] }`。
 * 使用本地 HTTP RPC（token 来自配置，不经 URL）；web 尚未合入该方法时
 * 返回明确错误，不假装成功。
 *
 * @module vessel/gateway/reload
 */

import { RpcClientError } from '../rpc';
import { createHttpRpcClient } from '../rpc/http-client';
import type { GatewayPidRecord } from './pid';

/** 冻结结果形状 */
export interface ReloadResult {
  reloaded: string[];
  requires_restart: string[];
}

/** 最小客户端形状（测试注入） */
export interface ReloadClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface ReloadGatewayOptions {
  record: GatewayPidRecord;
  token: string;
  scopes?: string[];
  /** gateway 是否启用 TLS（来自 config.serve.tls） */
  tls?: boolean;
  requestTimeoutMs?: number;
  createClient?: (options: { baseUrl: string; token: string; timeoutMs: number }) => ReloadClient;
}

export type ReloadGatewayResult =
  | { ok: true; result: ReloadResult }
  | { ok: false; error: string; code?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

/**
 * PID 记录 → 可连接的本地 base URL。
 * 通配绑定地址（0.0.0.0 / ::）归一到回环；IPv6 加方括号。
 */
export function gatewayBaseUrl(record: GatewayPidRecord, tls = false): string {
  let host = record.host.trim();
  if (host === '0.0.0.0') host = '127.0.0.1';
  else if (host === '::' || host === '[::]') host = '::1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  const scheme = tls ? 'https' : 'http';
  return `${scheme}://${host}:${record.port}`;
}

/** 校验 RPC 结果形状 */
export function parseReloadResult(value: unknown): ReloadResult | null {
  if (!isRecord(value)) return null;
  const reloaded = stringArray(value.reloaded);
  const requiresRestart = stringArray(value.requires_restart);
  if (!reloaded || !requiresRestart) return null;
  return { reloaded, requires_restart: requiresRestart };
}

/** 调用 `gateway.reload` */
export async function reloadGateway(options: ReloadGatewayOptions): Promise<ReloadGatewayResult> {
  const baseUrl = gatewayBaseUrl(options.record, options.tls === true);
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  const client =
    options.createClient?.({ baseUrl, token: options.token, timeoutMs }) ??
    createHttpRpcClient({
      baseUrl,
      token: options.token,
      subscribe: false,
      requestTimeoutMs: timeoutMs,
    });

  try {
    const raw = await client.request('gateway.reload', {
      ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
    });
    const parsed = parseReloadResult(raw);
    if (!parsed) {
      return {
        ok: false,
        error: 'gateway.reload returned an unexpected result shape',
        code: 'invalid_result',
      };
    }
    return { ok: true, result: parsed };
  } catch (error) {
    if (error instanceof RpcClientError) {
      const hint =
        error.code === 'not_found'
          ? ' (this gateway build does not expose gateway.reload yet)'
          : '';
      return { ok: false, error: `${error.code}: ${error.message}${hint}`, code: error.code };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'network',
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
