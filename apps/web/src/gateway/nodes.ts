/**
 * Web 多节点连接管理（S9.4）：节点元数据、sessionStorage 凭据与只读 RPC。
 *
 * 冻结约束：
 * - 每个节点使用显式人类 token（gateway / team token）；peer token 不能读取 attention。
 * - token 只写 sessionStorage（独立 key），绝不进入元数据 JSON / localStorage / URL / 日志 / React 返回值。
 * - hub 只用于发现；本模块不消费 hub 目录，也绝不经 hub 代理数据。
 * - 只复用既有 canonical RPC（interactions.list / health.get / teams.list），不新增方法。
 */
import type { ListedInteraction, ListedInteractionPage } from './interaction-hydration';
import type { TeamSummary } from './types';
import { checkGatewayUrl } from './url';

export const NODES_STORAGE_KEY = 'vessel.nodes';
export const NODE_TOKEN_PREFIX = 'vessel.node-token.';

/** 节点元数据；不含 token。 */
export interface NodeConfig {
  name: string;
  url: string;
  nodeId?: string;
}

/** 表单草稿；token 只在提交时出现，不进入元数据。 */
export interface NodeDraft {
  name: string;
  url: string;
  token: string;
}

export type NodeDraftError = 'name_required' | 'name_duplicate' | 'url_invalid' | 'token_required';

export interface NodeDraftValue {
  name: string;
  url: string;
  token: string;
}

export interface NodeDraftCheck {
  ok: boolean;
  value?: NodeDraftValue;
  error?: NodeDraftError;
  /** 来自 checkGatewayUrl 的具体原因；不算稳定错误码。 */
  detail?: string;
}

/** 节点 RPC 错误：稳定 code + HTTP status；message 永不包含 token。 */
export class NodeRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NodeRpcError';
  }
}

export function nodeTokenKey(name: string): string {
  return `${NODE_TOKEN_PREFIX}${name}`;
}

function pageProtocol(): string {
  return typeof window === 'undefined' ? 'http:' : window.location.protocol;
}

function sessionStore(): Storage | null {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

/** 名称非空且不与现有节点重复；返回稳定错误码。 */
export function checkNodeName(
  name: string,
  nodes: readonly Pick<NodeConfig, 'name'>[],
): NodeDraftError | null {
  const trimmed = name.trim();
  if (!trimmed) return 'name_required';
  if (nodes.some((node) => node.name === trimmed)) return 'name_duplicate';
  return null;
}

/** 校验表单：名称非空唯一、URL 走 checkGatewayUrl、token 非空。 */
export function validateNodeDraft(
  draft: NodeDraft,
  nodes: readonly Pick<NodeConfig, 'name'>[],
  protocol: string = pageProtocol(),
): NodeDraftCheck {
  const name = draft.name.trim();
  const nameError = checkNodeName(name, nodes);
  if (nameError) return { ok: false, error: nameError };

  const url = checkGatewayUrl(draft.url, protocol);
  if (!url.ok) {
    return { ok: false, error: 'url_invalid', ...(url.error ? { detail: url.error } : {}) };
  }

  const token = draft.token.trim();
  if (!token) return { ok: false, error: 'token_required' };

  return { ok: true, value: { name, url: url.value, token } };
}

/** 读取节点元数据；sessionStorage 不可用或内容损坏时返回空列表。 */
export function readStoredNodes(): NodeConfig[] {
  const store = sessionStore();
  if (!store) return [];
  try {
    const raw = store.getItem(NODES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const nodes: NodeConfig[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const name = (item as { name?: unknown }).name;
      const url = (item as { url?: unknown }).url;
      const nodeId = (item as { nodeId?: unknown }).nodeId;
      if (typeof name !== 'string' || !name.trim() || typeof url !== 'string') continue;
      if (seen.has(name)) continue;
      seen.add(name);
      nodes.push({
        name,
        url,
        ...(typeof nodeId === 'string' && nodeId ? { nodeId } : {}),
      });
    }
    return nodes;
  } catch {
    return [];
  }
}

/** 只写 name / url / nodeId；任何 token 字段都不会落进元数据 JSON。 */
export function writeStoredNodes(nodes: readonly NodeConfig[]): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.setItem(
      NODES_STORAGE_KEY,
      JSON.stringify(
        nodes.map((node) => ({
          name: node.name,
          url: node.url,
          ...(node.nodeId ? { nodeId: node.nodeId } : {}),
        })),
      ),
    );
  } catch {
    // 隐私模式 / 配额满：元数据只在当前页面内生效。
  }
}

export function storeNodeToken(name: string, token: string): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.setItem(nodeTokenKey(name), token);
  } catch {
    // 忽略存储失败；token 不会退回 localStorage。
  }
}

export function readNodeToken(name: string): string | null {
  const store = sessionStore();
  if (!store) return null;
  try {
    const token = store.getItem(nodeTokenKey(name));
    return token?.trim() ? token : null;
  } catch {
    return null;
  }
}

export function removeNodeToken(name: string): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.removeItem(nodeTokenKey(name));
  } catch {
    // 忽略存储失败。
  }
}

function baseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed !== '') return trimmed;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function errorCodeForStatus(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'internal';
}

interface NodeRpcEnvelope<T> {
  ok?: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

/**
 * 单节点 JSON-RPC（POST /v1/rpc + Bearer）。
 * `token` 由调用方注入当前连接 token；缺省读该节点的 sessionStorage token。
 */
export async function fetchNodeRpc<T = unknown>(
  node: NodeConfig,
  method: string,
  params?: unknown,
  token?: string,
): Promise<T> {
  const bearer = token?.trim() || readNodeToken(node.name) || '';
  if (!bearer) throw new NodeRpcError('unauthorized', 'missing node token');

  let response: Response;
  try {
    response = await fetch(`${baseUrl(node.url)}/v1/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    });
  } catch (error) {
    throw new NodeRpcError('network', error instanceof Error ? error.message : String(error));
  }

  let body: NodeRpcEnvelope<T> | null = null;
  try {
    body = (await response.json()) as NodeRpcEnvelope<T>;
  } catch {
    body = null;
  }

  if (!response.ok || !body || body.ok !== true) {
    const code = body?.error?.code ?? errorCodeForStatus(response.status);
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new NodeRpcError(code, message, response.status);
  }
  return body.result as T;
}

export interface NodeAttentionParams {
  session_id?: string;
  run_id?: string;
  team_id?: string;
  status?: 'pending' | 'answered' | 'orphaned';
  limit?: number;
  order?: 'oldest' | 'newest';
  cursor?: string;
  tenant_id?: string;
}

/** `interactions.list` 只读分页；返回形状与 GatewayClient 一致。 */
export async function fetchNodeAttention(
  node: NodeConfig,
  params: NodeAttentionParams = {},
  token?: string,
): Promise<ListedInteractionPage> {
  const body = await fetchNodeRpc<{
    interactions?: ListedInteraction[];
    total?: number;
    next_cursor?: string;
  }>(node, 'interactions.list', params, token);
  const interactions = Array.isArray(body?.interactions) ? body.interactions : [];
  return {
    interactions,
    total: typeof body?.total === 'number' ? body.total : interactions.length,
    ...(typeof body?.next_cursor === 'string' && body.next_cursor.length > 0
      ? { next_cursor: body.next_cursor }
      : {}),
  };
}

export type NodeAttentionResult =
  | { node: NodeConfig; ok: true; page: ListedInteractionPage }
  | { node: NodeConfig; ok: false; error: NodeRpcError };

function asNodeRpcError(error: unknown): NodeRpcError {
  if (error instanceof NodeRpcError) return error;
  return new NodeRpcError('internal', error instanceof Error ? error.message : String(error));
}

/**
 * 逐节点独立拉取 attention：一个节点 401 / 网络失败只体现在自己的结果里，
 * 不会拒绝整体 Promise，也不影响其它节点。
 */
export async function fetchAllNodeAttention(
  nodes: readonly NodeConfig[],
  params: NodeAttentionParams = {},
  tokenFor?: (node: NodeConfig) => string | undefined,
): Promise<NodeAttentionResult[]> {
  return Promise.all(
    nodes.map(async (node): Promise<NodeAttentionResult> => {
      try {
        const page = await fetchNodeAttention(node, params, tokenFor?.(node));
        return { node, ok: true, page };
      } catch (error) {
        return { node, ok: false, error: asNodeRpcError(error) };
      }
    }),
  );
}

/** 只读 Team 列表：用该节点的人类 token 调 `teams.list`（不用 federation team-info）。 */
export async function fetchNodeTeams(node: NodeConfig, token?: string): Promise<TeamSummary[]> {
  const body = await fetchNodeRpc<{ teams?: TeamSummary[] }>(node, 'teams.list', {}, token);
  return Array.isArray(body?.teams) ? body.teams : [];
}
