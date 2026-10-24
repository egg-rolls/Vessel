/**
 * 多节点 attention 的节点选择与目标构造（S9.4）。
 *
 * 每个节点使用**自己**的 `tokenEnv` 读取人类 token；不读取 `connect.token` /
 * `serve.token` 等其它凭据，避免跨节点串用或把 peer token 当人类 token。
 * 错误消息只含节点名与环境变量名，永不包含 token。
 *
 * @module vessel/attention-nodes
 */

import type { AttentionNodeConfig, VesselConfig } from '../packages/config/src/index';
import type { ControlPlaneTarget } from './control-plane-target';
import { createHttpRpcClient, normalizeConnectUrl } from './rpc/http-client';

export type AttentionNodeToken = { ok: true; token: string } | { ok: false; error: string };

export type AttentionNodeSelection =
  | { ok: true; nodes: AttentionNodeConfig[] }
  | { ok: false; error: string; code: 'no_nodes' | 'unknown_node' };

export type AttentionNodeAddressMatch =
  | { kind: 'none' }
  | { kind: 'unique'; node: AttentionNodeConfig }
  | { kind: 'ambiguous'; names: string[] };

/** 配置中的节点列表；缺省为空。 */
export function configuredAttentionNodes(config: VesselConfig): AttentionNodeConfig[] {
  return config.attention?.nodes ?? [];
}

/**
 * 按 `--all-nodes` / `--node` 选择节点。
 * `--all-nodes` 至少需要一个节点；`--node` 必须命中。
 */
export function selectAttentionNodes(
  nodes: readonly AttentionNodeConfig[],
  selection: { all?: boolean; name?: string },
): AttentionNodeSelection {
  if (selection.all === true) {
    if (nodes.length === 0) {
      return {
        ok: false,
        code: 'no_nodes',
        error: 'No attention nodes configured; add attention.nodes to the config file.',
      };
    }
    return { ok: true, nodes: [...nodes] };
  }
  const name = selection.name;
  if (name === undefined) return { ok: true, nodes: [...nodes] };
  const match = nodes.find((node) => node.name === name);
  if (match === undefined) {
    return {
      ok: false,
      code: 'unknown_node',
      error: `Unknown attention node "${name}".`,
    };
  }
  return { ok: true, nodes: [match] };
}

/**
 * 只从该节点的 `tokenEnv` 读 token。
 *
 * 不回退 `connect.token` / `serve.token` / `VESSEL_CONNECT_TOKEN`：
 * 那些凭据属于别的节点或本机，跨节点复用会答错权限。
 */
export function resolveNodeToken(
  node: AttentionNodeConfig,
  env: Record<string, string | undefined>,
): AttentionNodeToken {
  const envName = node.tokenEnv;
  if (envName === undefined || envName.trim() === '') {
    return {
      ok: false,
      error: `attention node "${node.name}" requires tokenEnv (human gateway/team token).`,
    };
  }
  const raw = env[envName];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      error:
        `attention node "${node.name}" requires environment variable ${envName} ` +
        '(human gateway/team token; federation peer tokens are not accepted).',
    };
  }
  return { ok: true, token: raw };
}

/** `--to <principal>@<node>:<team>` → 唯一配置节点；name 与 nodeId 都可匹配。 */
export function findAttentionNodeByAddress(
  nodes: readonly AttentionNodeConfig[],
  nodeId: string,
): AttentionNodeAddressMatch {
  const matches = nodes.filter((node) => node.nodeId === nodeId || node.name === nodeId);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) {
    const node = matches[0];
    return node === undefined ? { kind: 'none' } : { kind: 'unique', node };
  }
  return { kind: 'ambiguous', names: matches.map((node) => node.name) };
}

async function readCa(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    const text = await Bun.file(path).text();
    return text.trim() === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * 构造单节点 HTTP RPC 目标。
 *
 * 直接复用 `createHttpRpcClient` 的 URL / token 校验；失败由调用方转成
 * 该节点自己的失败行，不中止其它节点。
 */
export async function createAttentionNodeTarget(
  node: AttentionNodeConfig,
  token: string,
  options: { caFile?: string; requestTimeoutMs?: number } = {},
): Promise<ControlPlaneTarget> {
  const baseUrl = normalizeConnectUrl(node.url);
  const ca = await readCa(node.caFile ?? options.caFile);
  const client = createHttpRpcClient({
    baseUrl,
    token,
    subscribe: false,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    ...(ca !== undefined ? { ca } : {}),
  });
  return {
    kind: 'remote',
    baseUrl,
    token,
    request: (method, params) => client.request(method, params),
    close: () => client.close(),
  };
}
