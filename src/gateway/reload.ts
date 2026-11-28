/**
 * `vessel gateway reload` 客户端（0.12 DECISION-023 §2.3）。
 *
 * 调用 web 新增的 canonical RPC `gateway.reload`：
 * `params { scopes?: string[] }` → `{ reloaded: string[], requires_restart: string[] }`。
 * 使用本地 HTTP RPC（token 来自配置，不经 URL）；web 尚未合入该方法时
 * 返回明确错误，不假装成功。
 *
 * P0-run-stops P1：同模块提供 `gateway.shutdown` 客户端（`shutdownGateway`）——
 * 停止侧在强杀前先请求进程内优雅退出（drain 写 resume 标记）；老服务端没有该方法
 * 时返回 `not_found`，调用方据此回退强杀，不假装成功。
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
        error.code === 'method_not_found'
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

export interface ShutdownGatewayOptions {
  record: GatewayPidRecord;
  token: string;
  /** gateway 是否启用 TLS（来自 config.node.tls） */
  tls?: boolean;
  /** RPC 路径（缺省 '/v1/rpc'；平台 entry 传 '/platform/rpc'，Q4-C additive 透传） */
  rpcPath?: string;
  requestTimeoutMs?: number;
  createClient?: (options: { baseUrl: string; token: string; timeoutMs: number }) => ReloadClient;
}

export type ShutdownGatewayResult = { ok: true } | { ok: false; error: string; code?: string };

/**
 * 调用 `gateway.shutdown`：只受理「退出序列已启动」（`{stopping:true}`），
 * **不等待进程退出**——等死由调用方按自己的预算轮询，超时回退强杀。
 */
export async function shutdownGateway(
  options: ShutdownGatewayOptions,
): Promise<ShutdownGatewayResult> {
  const baseUrl = gatewayBaseUrl(options.record, options.tls === true);
  const timeoutMs = options.requestTimeoutMs ?? 5_000;
  const client =
    options.createClient?.({ baseUrl, token: options.token, timeoutMs }) ??
    createHttpRpcClient({
      baseUrl,
      token: options.token,
      subscribe: false,
      requestTimeoutMs: timeoutMs,
      ...(options.rpcPath !== undefined ? { rpcPath: options.rpcPath } : {}),
    });

  try {
    const raw = await client.request('gateway.shutdown', {});
    if (!isRecord(raw) || raw.stopping !== true) {
      return {
        ok: false,
        error: 'gateway.shutdown returned an unexpected result shape',
        code: 'invalid_result',
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof RpcClientError) {
      // q-error-e1（D4）：只有 method_not_found 才说明该 build 未暴露 gateway.shutdown；
      // 资源 not_found 不再误报「版本过期」（也可能是打错目标）。
      const hint =
        error.code === 'method_not_found'
          ? ' (this gateway build does not expose gateway.shutdown yet)'
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
