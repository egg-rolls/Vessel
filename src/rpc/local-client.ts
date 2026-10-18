/**
 * LocalRpcClient（0.5 E16 / PLAN §6.3）
 *
 * 进程内 dispatcher 适配为 RpcClient；id 由客户端生成，响应必须回显。
 * 未设置 --connect 时 CLI/TUI 走本实现并获得 tenant 写锁（A-4 §11.6）。
 *
 * @module vessel/rpc
 */

import {
  type RpcClient,
  RpcClientError,
  type RpcDispatcher,
  type RpcEventNotification,
  type RpcRequest,
  unwrapRpcResponse,
} from './types';

/** LocalRpcClient 选项 */
export interface LocalRpcClientOptions {
  dispatch: RpcDispatcher;
  /** 事件源；缺省返回 no-op unsubscribe */
  onEvent?: (handler: (notification: RpcEventNotification) => void) => () => void;
}

/** 创建进程内 RPC 客户端 */
export function createLocalRpcClient(options: LocalRpcClientOptions): RpcClient {
  return {
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      const request: RpcRequest = {
        v: 1,
        id: crypto.randomUUID(),
        method,
        ...(params !== undefined ? { params } : {}),
      };

      let response: unknown;
      try {
        response = await options.dispatch(request);
      } catch (error) {
        throw new RpcClientError(
          'internal',
          error instanceof Error ? error.message : String(error),
        );
      }

      return unwrapRpcResponse<T>(response, request.id);
    },

    subscribe(handler: (notification: RpcEventNotification) => void): () => void {
      if (!options.onEvent) return () => {};
      return options.onEvent(handler);
    },
  };
}
