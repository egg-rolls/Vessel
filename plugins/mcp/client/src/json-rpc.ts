/**
 * JSON-RPC 2.0 基础类型与错误。
 *
 * MCP 的两种传输都复用这里的消息形状与错误映射；不引入外部依赖。
 */

/** 出站请求 */
export interface JsonRpcRequestMessage {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** 出站通知 */
export interface JsonRpcNotificationMessage {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** 错误对象 */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** 入站响应 */
export interface JsonRpcResponseMessage {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

/** 入站请求（服务端 -> 客户端；0.3 不支持，收到即丢弃） */
export interface JsonRpcServerRequestMessage {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 级错误 */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method: string;

  constructor(method: string, error: JsonRpcErrorObject) {
    super(`MCP ${method} failed: ${error.message} (code ${error.code})`);
    this.name = 'JsonRpcError';
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

/** 传输级错误类别 */
export type McpTransportErrorKind = 'timeout' | 'aborted' | 'closed' | 'io' | 'protocol';

/** 传输级错误 */
export class McpTransportError extends Error {
  readonly kind: McpTransportErrorKind;

  constructor(kind: McpTransportErrorKind, message: string) {
    super(message);
    this.name = 'McpTransportError';
    this.kind = kind;
  }
}

/** 对象守卫 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 是否为 JSON-RPC 响应（有 id，且 result/error 至少一个） */
export function isResponse(value: unknown): value is JsonRpcResponseMessage {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return false;
  if (!('id' in value)) return false;
  return 'result' in value || 'error' in value;
}

/** 是否为 JSON-RPC 服务端请求（有 id + method） */
export function isServerRequest(value: unknown): value is JsonRpcServerRequestMessage {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return false;
  return typeof value.method === 'string' && 'id' in value;
}

/** 解析一行 JSON；失败返回 undefined（由调用方告警） */
export function parseJsonRpcLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** 错误文本 */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
