/**
 * 多节点上下文（S9.4，只读聚合）。
 *
 * 当前 WS 连接作为「当前节点」，与 sessionStorage 中的额外节点合并展示。
 * `nodes` 只含 name / url / nodeId / current，永不携带 token；
 * token 只存在于当前连接状态与 sessionStorage，按调用时刻解析。
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useConnection } from './ConnectionProvider';
import type { ListedInteractionPage } from './interaction-hydration';
import {
  fetchAllNodeAttention,
  fetchNodeAttention,
  fetchNodeRpc,
  fetchNodeTeams,
  type NodeAttentionParams,
  type NodeAttentionResult,
  type NodeConfig,
  type NodeDraft,
  type NodeDraftCheck,
  type NodeDraftError,
  readNodeToken,
  readStoredNodes,
  removeNodeToken,
  storeNodeToken,
  validateNodeDraft,
  writeStoredNodes,
} from './nodes';
import type { HealthResponse, TeamSummary } from './types';
import { displayGatewayUrl } from './url';

export interface NodeView extends NodeConfig {
  /** 是否为当前 WS 连接节点（只有它能在本页跳转会话）。 */
  current: boolean;
}

/** addNode 只回报结果，不回传 token。 */
export interface NodeAddResult {
  ok: boolean;
  error?: NodeDraftError;
}

export interface NodeContextValue {
  /** 当前节点（有 token 时）+ 额外节点；不含 token。 */
  nodes: readonly NodeView[];
  extras: readonly NodeView[];
  current: NodeView | null;
  addNode: (draft: NodeDraft) => NodeAddResult;
  removeNode: (name: string) => void;
  /** 重新从 sessionStorage 读取额外节点。 */
  refresh: () => void;
  fetchAttention: (node: NodeView, params?: NodeAttentionParams) => Promise<ListedInteractionPage>;
  fetchAllAttention: (params?: NodeAttentionParams) => Promise<NodeAttentionResult[]>;
  fetchHealth: (node: NodeView) => Promise<HealthResponse>;
  fetchTeams: (node: NodeView) => Promise<TeamSummary[]>;
}

const NodeContext = createContext<NodeContextValue | null>(null);

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function pageProtocol(): string {
  return typeof window === 'undefined' ? 'http:' : window.location.protocol;
}

export function NodeProvider({ children }: { children: ReactNode }) {
  const { token, gatewayUrl, hello, hasToken } = useConnection();
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const [extras, setExtras] = useState<NodeConfig[]>(() => readStoredNodes());
  const extrasRef = useRef(extras);
  extrasRef.current = extras;

  const current = useMemo<NodeView | null>(() => {
    if (!hasToken) return null;
    const info = hello?.node;
    const name = info?.name?.trim() || info?.node_id || displayGatewayUrl(gatewayUrl, pageOrigin());
    return {
      name,
      url: gatewayUrl,
      ...(info?.node_id ? { nodeId: info.node_id } : {}),
      current: true,
    };
  }, [hasToken, hello, gatewayUrl]);

  const extraViews = useMemo<NodeView[]>(
    () => extras.map((node) => ({ ...node, current: false })),
    [extras],
  );

  const nodes = useMemo<readonly NodeView[]>(
    () => (current ? [current, ...extraViews] : extraViews),
    [current, extraViews],
  );

  /** 当前节点用实时连接 token；额外节点读各自的 sessionStorage key。 */
  const tokenFor = useCallback((node: NodeConfig): string | undefined => {
    if ((node as NodeView).current) return tokenRef.current;
    return readNodeToken(node.name) ?? undefined;
  }, []);

  const refresh = useCallback(() => {
    setExtras(readStoredNodes());
  }, []);

  const addNode = useCallback(
    (draft: NodeDraft): NodeAddResult => {
      const check: NodeDraftCheck = validateNodeDraft(draft, nodes, pageProtocol());
      if (!check.ok || !check.value) {
        return { ok: false, ...(check.error ? { error: check.error } : {}) };
      }
      const config: NodeConfig = { name: check.value.name, url: check.value.url };
      const next = [...extrasRef.current.filter((node) => node.name !== config.name), config];
      writeStoredNodes(next);
      storeNodeToken(config.name, check.value.token);
      setExtras(next);
      return { ok: true };
    },
    [nodes],
  );

  const removeNode = useCallback((name: string) => {
    removeNodeToken(name);
    const next = extrasRef.current.filter((node) => node.name !== name);
    writeStoredNodes(next);
    setExtras(next);
  }, []);

  const fetchAttention = useCallback(
    (node: NodeView, params: NodeAttentionParams = {}) =>
      fetchNodeAttention(node, params, tokenFor(node)),
    [tokenFor],
  );

  const fetchAllAttention = useCallback(
    (params: NodeAttentionParams = {}) => fetchAllNodeAttention(nodes, params, tokenFor),
    [nodes, tokenFor],
  );

  const fetchHealth = useCallback(
    (node: NodeView) => fetchNodeRpc<HealthResponse>(node, 'health.get', {}, tokenFor(node)),
    [tokenFor],
  );

  const fetchTeams = useCallback(
    (node: NodeView) => fetchNodeTeams(node, tokenFor(node)),
    [tokenFor],
  );

  const value = useMemo<NodeContextValue>(
    () => ({
      nodes,
      extras: extraViews,
      current,
      addNode,
      removeNode,
      refresh,
      fetchAttention,
      fetchAllAttention,
      fetchHealth,
      fetchTeams,
    }),
    [
      nodes,
      extraViews,
      current,
      addNode,
      removeNode,
      refresh,
      fetchAttention,
      fetchAllAttention,
      fetchHealth,
      fetchTeams,
    ],
  );

  return <NodeContext.Provider value={value}>{children}</NodeContext.Provider>;
}

export function useNodes(): NodeContextValue {
  const value = useContext(NodeContext);
  if (!value) throw new Error('useNodes must be used inside <NodeProvider>');
  return value;
}
