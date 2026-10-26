/**
 * 多节点上下文（S9.4）：ConnectionProvider 之上的只读聚合。
 *
 * Node data now lives in `nodeStore` (nodes / current / per-node health); this
 * provider is the bridge that feeds the connection state and sessionStorage
 * extras in, and exposes token-bound control helpers. Tokens never enter the
 * store: `nodes` only contains name / url / nodeId / current.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useNodeStore } from '../stores/nodeStore';
import { usePolledAction } from '../stores/usePolledAction';
import { useConnection } from './ConnectionProvider';
import type { ListedInteractionPage } from './interaction-hydration';
import {
  fetchAllNodeAttention,
  fetchNodeAttention,
  fetchNodeRpc,
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
import { createRemoteTeamControl, type TeamControl } from './team-control';
import type { HealthResponse, TeamSummary } from './types';

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
  /** 该节点的 Team 读写控制面；当前节点复用 GatewayClient。 */
  teamControl: (node: NodeView) => TeamControl;
  /** 该节点是否已有可用人类 token（写操作前置）。 */
  hasTokenFor: (node: NodeView) => boolean;
}

const NodeContext = createContext<NodeContextValue | null>(null);

function pageProtocol(): string {
  return typeof window === 'undefined' ? 'http:' : window.location.protocol;
}

const NODE_HEALTH_POLL_MS = 15_000;

export function NodeProvider({ children }: { children: ReactNode }) {
  const { client, token, gatewayUrl, hello, hasToken, epoch } = useConnection();
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const extras = useNodeStore((state) => state.extras);
  const nodes = useNodeStore((state) => state.nodes);
  const current = useNodeStore((state) => state.current);
  const loadHealth = useNodeStore((state) => state.loadHealth);

  // Persisted extras are read once; connection identity is mirrored on change.
  useEffect(() => {
    useNodeStore.getState().setExtras(readStoredNodes());
  }, []);

  useEffect(() => {
    useNodeStore.getState().setConnection({ hasToken, hello, gatewayUrl });
  }, [hasToken, hello, gatewayUrl]);

  /** 当前节点用实时连接 token；额外节点读各自的 sessionStorage key。 */
  const tokenFor = useCallback((node: NodeConfig): string | undefined => {
    if ((node as NodeView).current) return tokenRef.current;
    return readNodeToken(node.name) ?? undefined;
  }, []);

  const fetchHealth = useCallback(
    (node: NodeView) => fetchNodeRpc<HealthResponse>(node, 'health.get', {}, tokenFor(node)),
    [tokenFor],
  );

  const nodeKeys = nodes.map((node) => node.nodeId ?? node.name).join(',');
  usePolledAction(
    () => {
      if (nodes.length > 0) void loadHealth(nodes, fetchHealth);
    },
    {
      enabled: nodes.length > 0,
      pollMs: NODE_HEALTH_POLL_MS,
      deps: [epoch, hasToken, nodeKeys],
    },
  );

  const refresh = useCallback(() => {
    useNodeStore.getState().setExtras(readStoredNodes());
  }, []);

  const addNode = useCallback(
    (draft: NodeDraft): NodeAddResult => {
      const check: NodeDraftCheck = validateNodeDraft(draft, nodes, pageProtocol());
      if (!check.ok || !check.value) {
        return { ok: false, ...(check.error ? { error: check.error } : {}) };
      }
      const config: NodeConfig = { name: check.value.name, url: check.value.url };
      const next = [...readStoredNodes().filter((node) => node.name !== config.name), config];
      writeStoredNodes(next);
      storeNodeToken(config.name, check.value.token);
      useNodeStore.getState().addExtra(config);
      return { ok: true };
    },
    [nodes],
  );

  const removeNode = useCallback((name: string) => {
    removeNodeToken(name);
    const next = readStoredNodes().filter((node) => node.name !== name);
    writeStoredNodes(next);
    useNodeStore.getState().removeExtra(name);
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

  const teamControl = useCallback(
    (node: NodeView): TeamControl => {
      if (node.current) return client;
      return createRemoteTeamControl(node, () => readNodeToken(node.name) ?? undefined);
    },
    [client],
  );

  const hasTokenFor = useCallback(
    (node: NodeView): boolean => (node.current ? hasToken : readNodeToken(node.name) !== null),
    [hasToken],
  );

  const fetchTeams = useCallback((node: NodeView) => teamControl(node).listTeams(), [teamControl]);

  const value = useMemo<NodeContextValue>(
    () => ({
      nodes,
      extras,
      current,
      addNode,
      removeNode,
      refresh,
      fetchAttention,
      fetchAllAttention,
      fetchHealth,
      fetchTeams,
      teamControl,
      hasTokenFor,
    }),
    [
      nodes,
      extras,
      current,
      addNode,
      removeNode,
      refresh,
      fetchAttention,
      fetchAllAttention,
      fetchHealth,
      fetchTeams,
      teamControl,
      hasTokenFor,
    ],
  );

  return <NodeContext.Provider value={value}>{children}</NodeContext.Provider>;
}

export function useNodes(): NodeContextValue {
  const value = useContext(NodeContext);
  if (!value) throw new Error('useNodes must be used inside <NodeProvider>');
  return value;
}
