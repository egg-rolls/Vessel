/**
 * RPC 客户端入口（0.5 E16）
 * @module vessel/rpc
 */

export {
  createHttpRpcClient,
  type HttpRpcClient,
  type HttpRpcClientOptions,
  isLoopbackBaseUrl,
  normalizeConnectUrl,
  parseGatewayFrame,
  type RpcHelloInfo,
  type WebSocketFactory,
  type WebSocketLike,
  type WebSocketMessageEvent,
} from './http-client';
export {
  createLocalRpcClient,
  type LocalRpcClientOptions,
} from './local-client';
export {
  isRpcResponse,
  type RpcClient,
  RpcClientError,
  type RpcDispatcher,
  type RpcErrorCode,
  type RpcErrorResponse,
  type RpcEventNotification,
  type RpcRequest,
  type RpcResponse,
  type RpcSuccessResponse,
  unwrapRpcResponse,
} from './types';
