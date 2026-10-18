import type { RpcDispatcher } from '../src/rpc';

/** 调用 dispatcher 并解包结果；失败抛错 */
export async function runDispatcher(
  dispatch: RpcDispatcher,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const response = await dispatch({
    v: 1,
    id: crypto.randomUUID(),
    method,
    ...(params !== undefined ? { params } : {}),
  });
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`);
  }
  return response.result as Record<string, unknown>;
}
