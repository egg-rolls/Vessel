/**
 * 连接引导（组合层）：平台探测 → whoami → nodes.list → credentials。
 *
 * 这是唯一同时引用平台客户端与“连接选择”的模块；平台客户端本身与
 * `./node/**` 互不 import。legacy 回退也在这里选择：
 * 页面由 legacy `--serve` 提供、`/platform/rpc` 不存在时，返回 `kind: 'legacy'`，
 * 由 ConnectionProvider 走同源 node 连接（旧 token 流程）。
 */

import { type NodeSelectionFallback, resolvePlatformNodeSelection } from './node-selection';
import { type PlatformClient, PlatformRpcError, probePlatform } from './platform';
import type { PlatformNodeSummary, PlatformWhoAmI } from './types/platform';

/** 单个节点的 credentials 结果；`error` 只属于该节点，不影响整个引导。 */
export interface PlatformNodeCredential {
  node_id: string;
  /** 空串 = 该节点无生效 token（`mode:'none'` 或失败）。 */
  token: string;
  anonymous: boolean;
  error: PlatformRpcError | null;
}

export interface PlatformConnection {
  whoami: PlatformWhoAmI;
  node: PlatformNodeSummary;
  /** `platform.nodes.list` 全量投影（平台模式唯一节点来源）。 */
  nodes: PlatformNodeSummary[];
  /** 每个节点的生效凭据（平行于 `nodes`，仅内存；由调用方按 node_id 落 sessionStorage）。 */
  nodeCredentials: PlatformNodeCredential[];
  /** 选中节点的生效 token；空串 = node 回环匿名语义。 */
  nodeToken: string;
  /** 选中节点 credentials 返回 `mode: 'none'`。 */
  anonymous: boolean;
  /** 选中节点 credentials 失败时为错误；调用方可让用户手填 node token。 */
  credentialsError: PlatformRpcError | null;
  /** 选择结果：`fallback` 非空表示持久化节点失效后的回退。 */
  selection: {
    preferredNodeId: string | null;
    fallback: NodeSelectionFallback | null;
  };
}

export interface PlatformBootstrapOptions {
  /** 持久化或用户显式选择的 `node_id`。 */
  preferredNodeId?: string | null;
  /** true = 期望节点必须 up 才采用（刷新恢复规则）；显式切换传 false。 */
  requirePreferredUp?: boolean;
  /** 用户手填 node token（覆盖 credentials）。 */
  manualNodeToken?: string;
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
 * 平台模式启动顺序（契约 §5.2）：whoami → nodes.list → 选择节点 → credentials。
 *
 * 选择规则见 `node-selection.ts`（持久化 node_id → first up → first）；
 * `nodes.list` 是平台模式唯一节点来源，不再取 `nodes[0]`。多节点时
 * credentials 必带选中的 `node_id`，单节点时省略以保持 G1 兼容。
 * `manualNodeToken` 非空时优先于 credentials（用户手填覆盖）。
 */
export async function bootstrapPlatform(
  client: PlatformClient,
  options: PlatformBootstrapOptions = {},
): Promise<PlatformBootstrapResult> {
  const probe = await probePlatform(client);
  if (probe.kind !== 'platform') return probe;

  let nodes: PlatformNodeSummary[];
  try {
    nodes = await client.listNodes();
  } catch (error) {
    return { kind: 'error', error: asPlatformError(error) };
  }

  const preferredNodeId = options.preferredNodeId ?? null;
  const selection = resolvePlatformNodeSelection(
    nodes,
    preferredNodeId,
    options.requirePreferredUp ?? true,
  );
  if (selection === null) {
    return {
      kind: 'error',
      error: new PlatformRpcError('no_nodes', 'Platform returned no nodes'),
    };
  }
  const node = selection.node;

  // 平台模式的多节点数据面直连各 Node API，需要每个节点的凭据（不只选中节点）。
  // 单节点时省略 node_id 保持 G1 兼容；多节点时逐个带 node_id。并行取，
  // 单节点失败只记录在该条目上，不拒绝整个引导。
  const withNodeId = nodes.length > 1;
  const nodeCredentials = await Promise.all(
    nodes.map(async (candidate): Promise<PlatformNodeCredential> => {
      try {
        const credentials = withNodeId
          ? await client.credentials(candidate.node_id)
          : await client.credentials();
        const token =
          credentials.mode === 'token' && typeof credentials.token === 'string'
            ? credentials.token
            : '';
        return {
          node_id: candidate.node_id,
          token,
          anonymous: credentials.mode === 'none',
          error: null,
        };
      } catch (error) {
        return {
          node_id: candidate.node_id,
          token: '',
          anonymous: false,
          error: asPlatformError(error),
        };
      }
    }),
  );

  const selectedCredentials = nodeCredentials.find((entry) => entry.node_id === node.node_id);
  const credentialsError = selectedCredentials?.error ?? null;
  const anonymous = selectedCredentials?.anonymous ?? false;
  const credentialToken = selectedCredentials?.token ?? '';

  const manual = (options.manualNodeToken ?? '').trim();
  const nodeToken = manual !== '' ? manual : anonymous ? '' : credentialToken;

  return {
    kind: 'platform',
    connection: {
      whoami: probe.whoami,
      node,
      nodes,
      nodeCredentials,
      nodeToken,
      anonymous,
      credentialsError,
      selection: {
        preferredNodeId,
        fallback: selection.fallback,
      },
    },
  };
}
