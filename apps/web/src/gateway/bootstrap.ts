/**
 * 连接引导（组合层）：平台探测 → whoami → nodes.list → credentials。
 *
 * 这是唯一同时引用平台客户端与“连接选择”的模块；平台客户端本身与
 * `./node/**` 互不 import。legacy 回退也在这里选择：
 * 页面由 legacy `--serve` 提供、`/platform/rpc` 不存在时，返回 `kind: 'legacy'`，
 * 由 ConnectionProvider 走同源 node 连接（旧 token 流程）。
 */

import { type PlatformClient, PlatformRpcError, probePlatform } from './platform';
import type { PlatformNodeSummary, PlatformWhoAmI } from './types/platform';

export interface PlatformConnection {
  whoami: PlatformWhoAmI;
  node: PlatformNodeSummary;
  /** 生效 node token；空串 = node 回环匿名语义。 */
  nodeToken: string;
  /** credentials 返回 `mode: 'none'`。 */
  anonymous: boolean;
  /** credentials 端点失败时为错误；调用方可让用户手填 node token。 */
  credentialsError: PlatformRpcError | null;
}

export type PlatformBootstrapResult =
  | { kind: 'platform'; connection: PlatformConnection }
  | { kind: 'legacy' }
  | { kind: 'error'; error: PlatformRpcError };

function asPlatformError(error: unknown): PlatformRpcError {
  return error instanceof PlatformRpcError
    ? error
    : new PlatformRpcError('internal', error instanceof Error ? error.message : String(error));
}

/**
 * 平台模式启动顺序（契约 §5.2）：whoami → nodes.list → credentials。
 *
 * G1 只有一个 co-located node：取 `nodes.list` 第一项。`manualNodeToken`
 * 非空时优先于 credentials（用户手填覆盖）。
 */
export async function bootstrapPlatform(
  client: PlatformClient,
  manualNodeToken = '',
): Promise<PlatformBootstrapResult> {
  const probe = await probePlatform(client);
  if (probe.kind !== 'platform') return probe;

  let nodes: PlatformNodeSummary[];
  try {
    nodes = await client.listNodes();
  } catch (error) {
    return { kind: 'error', error: asPlatformError(error) };
  }
  const node = nodes[0];
  if (node === undefined) {
    return {
      kind: 'error',
      error: new PlatformRpcError('no_nodes', 'Platform returned no nodes'),
    };
  }

  let credentialsError: PlatformRpcError | null = null;
  let credentialToken = '';
  let anonymous = false;
  try {
    const credentials = await client.credentials();
    anonymous = credentials.mode === 'none';
    if (credentials.mode === 'token' && typeof credentials.token === 'string') {
      credentialToken = credentials.token;
    }
  } catch (error) {
    credentialsError = asPlatformError(error);
  }

  const manual = manualNodeToken.trim();
  const nodeToken = manual !== '' ? manual : anonymous ? '' : credentialToken;

  return {
    kind: 'platform',
    connection: {
      whoami: probe.whoami,
      node,
      nodeToken,
      anonymous,
      credentialsError,
    },
  };
}
