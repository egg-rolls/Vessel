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
import { EventStore, type EventStoreSnapshot } from '../state/event-store';
import { useInteractionStore } from '../stores/interactionStore';
import { type ConnectionState, GatewayClient } from './client';
import {
  ConnectionContext,
  type ConnectionContextValue,
  type ConnectionOptions,
} from './connection-context';
import { createConnectionHandlers } from './connection-handlers';
import { computeInitialConnection } from './connection-initial';
import { SubmitGuard } from './interactions';
import type { HelloInfo } from './types';
import { useConnectionControls } from './use-connection-controls';
import { useInteractionHydration } from './use-interaction-hydration';
import { useInteractionResponses } from './use-interaction-responses';
import { useReportConnectError } from './use-report-connect-error';

export type { PermissionRequest, PermissionScope } from './types';
export type { ConnectionContextValue, ConnectionOptions };

const initialConnection = computeInitialConnection();
const initialSeed = initialConnection.seed;
const initialGateway = initialConnection.gateway;

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const eventStore = useMemo(() => new EventStore(), []);
  const [token, setToken] = useState(initialSeed.token);
  // 进程内常量：初始化后不再切换模式（切模式需要刷新页面）。
  const { devProxyAuth } = initialSeed;
  const [targetTenantId, setTargetTenantId] = useState<string | undefined>();
  const [gatewayUrl, setGatewayUrl] = useState(initialGateway.url);
  const [gatewayError, setGatewayError] = useState<string | null>(initialGateway.error);
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

  const client = useMemo(() => new GatewayClient(gatewayUrl), [gatewayUrl]);
  const tenantIdRef = useRef<string | null>(null);
  tenantIdRef.current = tenantId;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const hasToken = token.trim().length > 0;

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
    tokenRef,
    tenantIdRef,
    hydrationGenerationRef,
  });

  const reportConnectError = useReportConnectError(
    client,
    setConnectionState,
    setTokenError,
    setLastError,
  );

  // WS 生命周期：token / URL / 显式 connect 变化时重建订阅；断线指数退避。
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectSeq 是显式重连触发器
  useEffect(() => {
    if (!token.trim()) {
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
      token,
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
    token,
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
    token,
    gatewayUrl,
    connectionState,
    tokenRef,
    tenantIdRef,
    reportConnectError,
    setGatewayUrl,
    setGatewayError,
    setTokenError,
    setLastError,
    setTargetTenantId,
    setToken,
    setConnectSeq,
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
      gatewayUrl,
      token,
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
      gatewayUrl,
      token,
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
