import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useToast } from '../components/ToastProvider';
import { t } from '../i18n';
import { EventStore, type EventStoreSnapshot } from '../state/event-store';
import { useInteractionStore } from '../stores/interactionStore';
import { bootstrapPlatform } from './bootstrap';
import {
  ConnectionContext,
  type ConnectionContextValue,
  type ConnectionMode,
  type ConnectionOptions,
} from './connection-context';
import { createConnectionHandlers } from './connection-handlers';
import { computeInitialConnection, LEGACY_TOKEN_KEY } from './connection-initial';
import { SubmitGuard } from './interactions';
import { type ConnectionState, GatewayClient } from './node';
import { nodeTokenIdentity, storeNodeToken } from './nodes';
import { PlatformClient, type PlatformRpcError } from './platform';
import type { HelloInfo } from './types';
import { checkGatewayUrl } from './url';
import { useConnectionControls } from './use-connection-controls';
import { useInteractionHydration } from './use-interaction-hydration';
import { useInteractionResponses } from './use-interaction-responses';
import { useReportConnectError } from './use-report-connect-error';

export type { PermissionRequest, PermissionScope } from './types';
export type { ConnectionContextValue, ConnectionOptions };

/** token 消费必须在路由初始化前完成，所以放在模块加载期。 */
const initialConnection = computeInitialConnection();

/** node registry 的 `api_url` 归一化为 origin；服务端值可信，失败时原样使用。 */
function normalizeNodeOrigin(raw: string): string {
  const check = checkGatewayUrl(raw, window.location.protocol);
  return check.ok ? check.value : raw.trim().replace(/\/+$/, '');
}

function platformErrorMessage(error: PlatformRpcError): string {
  if (error.status === 401 || error.code === 'platform_unauthorized') {
    return t('gateway.platform.tokenRequired');
  }
  if (error.code === 'no_nodes') return t('gateway.platform.noNodes');
  if (error.code === 'network') {
    return t('gateway.connection.unreachable', { detail: error.message });
  }
  if (error.status === 403) {
    return t('gateway.connection.originRejected', { detail: error.message });
  }
  return error.message;
}

interface NodeIdentity {
  nodeId?: string;
  name?: string;
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const eventStore = useMemo(() => new EventStore(), []);

  // 平台槽：URL 语义 = 平台 origin（空串 = 页面同源）；token 只进 sessionStorage。
  const [platformUrl, setPlatformUrl] = useState(initialConnection.platformUrl);
  const [platformToken, setPlatformToken] = useState(initialConnection.platformToken);
  const [platformError, setPlatformError] = useState<string | null>(
    initialConnection.platformUrlError,
  );
  const [urlInvalid, setUrlInvalid] = useState(initialConnection.platformUrlError !== null);
  // node 槽：URL 来自平台 registry（或 legacy 同源）；token 来自 credentials / 手填。
  const [nodeUrl, setNodeUrl] = useState<string | null>(null);
  const [nodeToken, setNodeToken] = useState('');
  const [anonymousNode, setAnonymousNode] = useState(false);
  const [nodeIdentity, setNodeIdentity] = useState<NodeIdentity | null>(null);
  const [mode, setMode] = useState<ConnectionMode>('pending');
  const [bootstrapSeq, setBootstrapSeq] = useState(0);

  // 进程内常量：初始化后不再切换模式（切模式需要刷新页面）。
  const { devProxyAuth } = initialConnection;
  const [targetTenantId, setTargetTenantId] = useState<string | undefined>();
  const [gatewayError, setGatewayError] = useState<string | null>(
    initialConnection.platformUrlError,
  );
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [hello, setHello] = useState<HelloInfo | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [tenantEpoch, setTenantEpoch] = useState(0);
  // 交互的唯一真相源：本 Provider 只写 store，面板直接或经 context 读同一份数据。
  const permissions = useInteractionStore((state) => state.permissions);
  const asks = useInteractionStore((state) => state.asks);
  const responding = useInteractionStore((state) => state.responding);
  const [connectSeq, setConnectSeq] = useState(0);
  const submitGuard = useRef(new SubmitGuard());
  /** 已结算 id：应答成功 / 终态事件 / run 终态 / dismiss；有界 Map（上限 500）。 */
  const settledRef = useRef(new Map<string, number>());
  /** hydration 世代：只有最新一次请求能落地。 */
  const hydrationGenerationRef = useRef(0);
  /** legacy 回退候选 token：旧 `vessel.token` 槽。 */
  const legacyTokenRef = useRef(initialConnection.legacyNodeToken);
  /** 用户手填的 node token；平台 bootstrap 时优先于 credentials。 */
  const manualNodeTokenRef = useRef('');

  const client = useMemo(() => new GatewayClient(nodeUrl ?? ''), [nodeUrl]);
  const tenantIdRef = useRef<string | null>(null);
  tenantIdRef.current = tenantId;
  const nodeTokenRef = useRef(nodeToken);
  nodeTokenRef.current = nodeToken;
  const canConnect = nodeUrl !== null && (nodeToken.trim() !== '' || anonymousNode);
  const hasToken = canConnect;

  /**
   * 平台引导（契约 §5.2）：whoami → nodes.list → credentials → node 直连。
   * `/platform/rpc` 不存在（legacy `--serve` 页面）时回退同源 node 连接；
   * 401 等鉴权错误不静默回退，必须让用户输入平台 token。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrapSeq 是显式重新引导触发器
  useEffect(() => {
    if (urlInvalid) {
      setMode('platform');
      setConnectionState('error');
      return;
    }
    // dev relay 只代理 node 侧（`/v1`、`/health`）；代理模式下不探测平台，
    // 直接走同源 node + 占位 token 的旧流程。
    if (initialConnection.devProxyAuth) {
      setMode('legacy');
      setNodeIdentity(null);
      setNodeUrl(platformUrl);
      setNodeToken(legacyTokenRef.current);
      setAnonymousNode(false);
      setPlatformError(null);
      return;
    }
    let cancelled = false;
    setConnectionState('connecting');
    setPlatformError(null);
    const platformClient = new PlatformClient(platformUrl, platformToken);
    void bootstrapPlatform(platformClient, manualNodeTokenRef.current)
      .then((result) => {
        if (cancelled) return;
        if (result.kind === 'legacy') {
          // 旧 token 流程：显式输入的平台 token 在 legacy 页面等价于 node token。
          const explicit = platformToken.trim();
          const legacyToken = explicit !== '' ? explicit : legacyTokenRef.current;
          if (explicit !== '') {
            sessionStorage.setItem(LEGACY_TOKEN_KEY, explicit);
            legacyTokenRef.current = explicit;
          }
          setMode('legacy');
          setNodeIdentity(null);
          setNodeUrl(platformUrl);
          setNodeToken(legacyToken);
          setAnonymousNode(false);
          setPlatformError(null);
          return;
        }
        if (result.kind === 'error') {
          setMode('platform');
          setNodeUrl(null);
          setPlatformError(platformErrorMessage(result.error));
          setConnectionState('error');
          return;
        }

        const { connection } = result;
        const identity: NodeIdentity = {
          nodeId: connection.node.node_id,
          name: connection.node.name,
        };
        if (connection.nodeToken !== '') {
          storeNodeToken(
            nodeTokenIdentity({ name: connection.node.name, nodeId: connection.node.node_id }),
            connection.nodeToken,
          );
        }
        setMode('platform');
        setNodeIdentity(identity);
        setNodeUrl(normalizeNodeOrigin(connection.node.api_url));
        setNodeToken(connection.nodeToken);
        setAnonymousNode(connection.anonymous);
        setPlatformError(
          connection.credentialsError !== null && connection.nodeToken === ''
            ? t('gateway.platform.credentialsUnavailable')
            : null,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMode('platform');
        setNodeUrl(null);
        setPlatformError(error instanceof Error ? error.message : String(error));
        setConnectionState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [platformUrl, platformToken, bootstrapSeq, urlInvalid]);

  const recordSettled = useCallback((requestId: string) => {
    if (!requestId) return;
    const settled = settledRef.current;
    // delete 再 set：让重放 / 重复结算的 id 也保持在 Map 尾部的“最新”位置。
    settled.delete(requestId);
    settled.set(requestId, Date.now());
    while (settled.size > 500) {
      const oldest = settled.keys().next().value;
      if (oldest === undefined) break;
      settled.delete(oldest);
    }
  }, []);

  const hydrateInteractions = useInteractionHydration({
    client,
    recordSettled,
    settledRef,
    tokenRef: nodeTokenRef,
    tenantIdRef,
    hydrationGenerationRef,
  });

  const reportConnectError = useReportConnectError(
    client,
    setConnectionState,
    setTokenError,
    setLastError,
  );

  // WS 生命周期：node URL / token / 显式 connect 变化时重建订阅；断线指数退避。
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectSeq 是显式重连触发器
  useEffect(() => {
    if (!canConnect) {
      client.close();
      eventStore.reset(0);
      setConnectionState('idle');
      setHello(null);
      setTenantId(null);
      useInteractionStore.getState().reset();
      settledRef.current.clear();
      hydrationGenerationRef.current += 1;
      setReconnectAttempt(0);
      return;
    }

    return createConnectionHandlers({
      client,
      token: nodeToken,
      targetTenantId,
      eventStore,
      toast,
      settledRef,
      hydrationGenerationRef,
      tenantIdRef,
      recordSettled,
      reportConnectError,
      setConnectionState,
      setHello,
      setTenantId,
      setReconnectAttempt,
      setTokenError,
      setGatewayError,
      setLastError,
      setTenantEpoch,
      setEpoch,
    });
  }, [
    client,
    nodeToken,
    canConnect,
    connectSeq,
    targetTenantId,
    eventStore,
    reportConnectError,
    recordSettled,
    toast,
  ]);

  // 连接 / 刷新 / 重连成功后补回 pending / 终态 orphaned（epoch 只在 hello 后递增）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch 是 hello 后的显式刷新触发器
  useEffect(() => {
    if (!hasToken) return;
    void hydrateInteractions();
  }, [epoch, hasToken, hydrateInteractions]);

  const { connect, disconnect, retry } = useConnectionControls({
    client,
    eventStore,
    nodeToken,
    mode,
    nodeIdentity,
    canConnect,
    tenantIdRef,
    reportConnectError,
    setPlatformUrl,
    setPlatformToken,
    setGatewayError,
    setPlatformError,
    setUrlInvalid,
    setBootstrapSeq,
    setNodeToken,
    setAnonymousNode,
    setTokenError,
    setLastError,
    setTargetTenantId,
    setConnectSeq,
    manualNodeTokenRef,
    legacyTokenRef,
  });

  const { respondPermission, respondAsk } = useInteractionResponses({
    client,
    hydrateInteractions,
    recordSettled,
    toast,
    submitGuard,
  });

  const value = useMemo<ConnectionContextValue>(
    () => ({
      client,
      eventStore,
      connectionState,
      hello,
      tenantId,
      features: hello?.protocol.features ?? [],
      nodeLabel: hello?.node.name ?? hello?.node.node_id?.slice(0, 12) ?? '',
      platformUrl,
      nodeUrl: nodeUrl ?? '',
      platformToken,
      nodeToken,
      mode,
      platformError,
      hasToken,
      devProxyAuth,
      gatewayError,
      tokenError,
      lastError,
      reconnectAttempt,
      epoch,
      tenantEpoch,
      stale: hello !== null && connectionState !== 'open',
      closeCode: client.closedWithCode,
      permissions,
      asks,
      hydrateInteractions,
      responding,
      connect,
      disconnect,
      clearToken: disconnect,
      retry,
      dismissError: () => setLastError(null),
      clearTokenError: () => setTokenError(null),
      respondPermission,
      respondAsk,
    }),
    [
      client,
      eventStore,
      connectionState,
      hello,
      tenantId,
      platformUrl,
      nodeUrl,
      platformToken,
      nodeToken,
      mode,
      platformError,
      hasToken,
      gatewayError,
      tokenError,
      lastError,
      reconnectAttempt,
      epoch,
      tenantEpoch,
      permissions,
      asks,
      hydrateInteractions,
      responding,
      connect,
      disconnect,
      retry,
      respondPermission,
      respondAsk,
    ],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error('useConnection must be used inside <ConnectionProvider>');
  return value;
}

/** 订阅有界事件缓冲（50ms 合批）。 */
export function useEventSnapshot(): EventStoreSnapshot {
  const { eventStore } = useConnection();
  return useSyncExternalStore(eventStore.subscribe, eventStore.getSnapshot, eventStore.getSnapshot);
}
