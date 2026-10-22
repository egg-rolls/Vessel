import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { extractTokenFromHash } from '../app/router';
import { useToast } from '../components/ToastProvider';
import { EventStore, type EventStoreSnapshot } from '../state/event-store';
import type { StoredEvent } from '../state/events';
import { type ConnectionState, GatewayClient, GatewayHttpError } from './client';
import {
  addDismissedId,
  buildHydrationSnapshot,
  emptyInteractionState,
  interactionReducer,
  type OrphanedInteraction,
  readDismissedIds,
} from './interaction-hydration';
import {
  askFromEvent,
  interactionExpiredMessage,
  interactionRunEndedMessage,
  isExpiredError,
  isNotFoundError,
  isRunEndedError,
  permissionFromEvent,
  SubmitGuard,
} from './interactions';
import { planHelloSeq } from './seq-replay';
import type {
  AskUserAnswer,
  AskUserRequest,
  HelloInfo,
  PermissionRequest,
  PermissionScope,
  RunEvent,
  RunStatus,
} from './types';
import { checkGatewayUrl, GATEWAY_URL_KEY, resolveInitialGatewayUrl } from './url';

export type { PermissionRequest, PermissionScope } from './types';

const TOKEN_KEY = 'vessel.token';

export interface ConnectionOptions {
  gatewayUrl: string;
  token: string;
  /** admin 切换租户时传；reconnect 会带 tenant_id。 */
  tenantId?: string;
}

export interface ConnectionContextValue {
  client: GatewayClient;
  eventStore: EventStore;
  connectionState: ConnectionState;
  hello: HelloInfo | null;
  tenantId: string | null;
  features: string[];
  nodeLabel: string;
  gatewayUrl: string;
  token: string;
  hasToken: boolean;
  gatewayError: string | null;
  tokenError: string | null;
  lastError: string | null;
  gapNotice: string | null;
  reconnectAttempt: number;
  /** 每次成功 hello 递增；资源用它作为刷新依赖。 */
  epoch: number;
  /** tenant 变化递增；Chat 用它清空选择。 */
  tenantEpoch: number;
  stale: boolean;
  /** 最近一次 WS close code（诊断用；重连开始时清空）。 */
  closeCode: number | null;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  /** 已失效（run 结束 / 进程重启）的交互；只用于提示，不可应答。 */
  orphaned: readonly OrphanedInteraction[];
  /** 从 `interactions.list` 补回 pending / orphaned；失败静默，不阻塞聊天。 */
  hydrateInteractions: () => Promise<void>;
  /** 关闭失效提示并写入本 tenant 的 dismiss 集合。 */
  dismissOrphaned: (requestId: string) => void;
  /** 正在提交应答的 requestId；UI 据此禁用按钮，避免双击重复提交。 */
  responding: ReadonlySet<string>;
  connect: (options: ConnectionOptions) => boolean;
  disconnect: () => void;
  clearToken: () => void;
  retry: () => void;
  dismissError: () => void;
  dismissGap: () => void;
  clearTokenError: () => void;
  respondPermission: (
    requestId: string,
    decision: 'allow' | 'deny',
    scope?: PermissionScope,
  ) => Promise<void>;
  respondAsk: (requestId: string, answers: AskUserAnswer[]) => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** localStorage 在隐私模式下访问也可能抛错：读写都由 hydration 模块 try/catch 兜底。 */
function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 首次 token：先处理 `#token=`，再读 sessionStorage。该函数必须在路由初始化前调用。 */
function consumeInitialToken(): string {
  const { token, restHash } = extractTokenFromHash(window.location.hash);
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${restHash}`,
    );
    return token;
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

function initialGatewayUrl(): { url: string; error: string | null } {
  const resolved = resolveInitialGatewayUrl(
    localStorage.getItem(GATEWAY_URL_KEY),
    import.meta.env.VITE_GATEWAY_URL as string | undefined,
    window.location.protocol,
  );
  return resolved.ok
    ? { url: resolved.value, error: null }
    : { url: '', error: resolved.error ?? '无效的 gateway 地址' };
}

const initialTokenValue = consumeInitialToken();
const initialGateway = initialGatewayUrl();

/** 从已接收事件里反查 run 归属的 session（ask 事件不带 session_id）。 */
function sessionIdForRun(entries: readonly StoredEvent[], runId: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event;
    if (!event || event.run_id !== runId || event.type !== 'run.started') continue;
    const sessionId = (event.data as { session_id?: unknown }).session_id;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
  }
  return undefined;
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const eventStore = useMemo(() => new EventStore(), []);
  const [token, setToken] = useState(initialTokenValue);
  const [targetTenantId, setTargetTenantId] = useState<string | undefined>();
  const [gatewayUrl, setGatewayUrl] = useState(initialGateway.url);
  const [gatewayError, setGatewayError] = useState<string | null>(initialGateway.error);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [gapNotice, setGapNotice] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [hello, setHello] = useState<HelloInfo | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [tenantEpoch, setTenantEpoch] = useState(0);
  const [interactions, dispatchInteraction] = useReducer(interactionReducer, emptyInteractionState);
  const { permissions, asks, orphaned } = interactions;
  const interactionsRef = useRef(interactions);
  interactionsRef.current = interactions;
  const [responding, setResponding] = useState<ReadonlySet<string>>(() => new Set());
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

  /**
   * 从 `interactions.list` 补回刷新 / 重连 / 选会话后丢失的卡片。
   *
   * 并行拉 pending + orphaned（都显式带 hello tenant）；只有 pending 仍缺 session
   * 时才再调 `runs.list`。任何失败都只影响本轮 hydration，不 toast、不阻塞。
   */
  const hydrateInteractions = useCallback(async (): Promise<void> => {
    if (client.connectionState !== 'open') return;
    const tokenAtStart = tokenRef.current;
    if (!tokenAtStart.trim()) return;
    const tenantAtStart = tenantIdRef.current ?? undefined;
    const clientAtStart = client;
    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    const stillCurrent = () =>
      hydrationGenerationRef.current === generation &&
      client === clientAtStart &&
      tokenRef.current === tokenAtStart &&
      (tenantIdRef.current ?? undefined) === tenantAtStart;
    const tenantParam = tenantAtStart !== undefined ? { tenant_id: tenantAtStart } : {};

    const [pendingResult, orphanedResult] = await Promise.allSettled([
      client.listInteractions({ status: 'pending', limit: 100, ...tenantParam }),
      client.listInteractions({ status: 'orphaned', limit: 100, ...tenantParam }),
    ]);
    if (!stillCurrent()) return;

    // 旧 gateway（method_not_allowed / not_found）与其他失败都按空结果处理。
    const pending = pendingResult.status === 'fulfilled' ? pendingResult.value : [];
    const orphanedListed = orphanedResult.status === 'fulfilled' ? orphanedResult.value : [];
    const sessionForRun = (runId: string) =>
      sessionIdForRun(eventStore.getSnapshot().entries, runId);

    let runs: RunStatus[] = [];
    if (pending.some((item) => !item.session_id && !sessionForRun(item.run_id))) {
      try {
        runs = await client.listRuns(tenantParam);
      } catch {
        runs = [];
      }
      if (!stillCurrent()) return;
    }

    const settled = new Set(settledRef.current.keys());
    const snapshot = buildHydrationSnapshot({
      pending,
      orphaned: orphanedListed,
      runs,
      sessionForRun,
      settled,
      dismissed: readDismissedIds(browserStorage(), tenantAtStart ?? 'default'),
    });
    if (!stillCurrent()) return;
    dispatchInteraction({
      type: 'hydrate',
      snapshot,
      settled: new Set(settledRef.current.keys()),
    });
  }, [client, eventStore]);

  const reportConnectError = useCallback(
    (error: unknown) => {
      // probe/connect 失败可能发生在 WS close 之前；显式落到 error，
      // 避免 UI 一直停在「正在连接」。
      setConnectionState('error');
      if (client.closedWithCode === 4401) {
        setTokenError('鉴权失败：token 错误或已失效');
        return;
      }
      if (error instanceof GatewayHttpError) {
        if (
          error.status === 403 ||
          error.code === 'forbidden_origin' ||
          error.code === 'invalid_host'
        ) {
          setLastError(
            `gateway 拒绝该 Origin/Host：${error.message}。` +
              '跨 Origin 部署需把本站加入 serve.allowed_origins。',
          );
          return;
        }
        if (error.status === 401 || error.code === 'unauthorized') {
          setTokenError('鉴权失败：token 错误或已失效');
          return;
        }
        if (error.code === 'network') {
          setLastError(
            `无法连接 gateway（检查地址/TLS/网络）：${error.message}。` +
              '跨 Origin 时还需配置 serve.allowed_origins。',
          );
          return;
        }
        setLastError(error.message);
        return;
      }
      setLastError(errorMessage(error));
    },
    [client],
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
      dispatchInteraction({ type: 'reset' });
      settledRef.current.clear();
      hydrationGenerationRef.current += 1;
      setReconnectAttempt(0);
      return;
    }

    let disposed = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    eventStore.reset(0);
    setHello(null);
    setConnectionState('connecting');
    setReconnectAttempt(0);

    const addPermission = (event: RunEvent) => {
      const request = permissionFromEvent(event);
      if (!request) return;
      // 权限不按时间过期；刷新/重连时靠事件重放 + interactions.list 重建。
      if (settledRef.current.has(request.requestId)) return;
      dispatchInteraction({ type: 'permission-request', request });
    };

    /** response / expired 事件：无论是否本端应答，都收起对应卡片。 */
    const removeByEvent = (event: RunEvent, expired: boolean) => {
      const data = event.data as { requestId?: unknown; request_id?: unknown };
      const requestId = data.requestId ?? data.request_id;
      if (typeof requestId !== 'string' || requestId.length === 0) return;
      const wasPending = interactionsRef.current.permissions.some(
        (item) => item.requestId === requestId,
      );
      recordSettled(requestId);
      dispatchInteraction({ type: 'settle', requestId });
      if (expired && wasPending) toast.info(interactionExpiredMessage());
    };

    const addAsk = (event: RunEvent) => {
      // ask 事件本身不带 session_id：从同一批事件里的 run.started 反查归属会话，
      // 供跨 session 待处理条跳转；查不到时退化为运行详情。
      const sessionId = sessionIdForRun(eventStore.getSnapshot().entries, event.run_id);
      const request = askFromEvent(event, sessionId);
      if (!request) return;
      if (settledRef.current.has(request.requestId)) return;
      dispatchInteraction({ type: 'ask-request', request });
    };

    /** 其他端应答（ask.user.answered）：静默收起对应卡片。 */
    const removeAskByEvent = (event: RunEvent) => {
      const data = event.data as { requestId?: unknown; request_id?: unknown };
      const requestId = data.requestId ?? data.request_id;
      if (typeof requestId !== 'string' || requestId.length === 0) return;
      recordSettled(requestId);
      dispatchInteraction({ type: 'settle', requestId });
    };

    const offEvent = client.onEvent((event, meta) => {
      if (!eventStore.push(event, meta)) return;
      if (event.type === 'tool.permission.request') addPermission(event);
      if (event.type === 'tool.permission.response') removeByEvent(event, false);
      if (event.type === 'tool.permission.expired') removeByEvent(event, true);
      if (event.type === 'ask.user.requested') addAsk(event);
      if (event.type === 'ask.user.answered') removeAskByEvent(event);
      if (
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.cancelled'
      ) {
        // run 终态：同 run 的 pending 一律结算，避免 hydration 把它们复活。
        for (const item of interactionsRef.current.permissions) {
          if (item.runId === event.run_id) recordSettled(item.requestId);
        }
        for (const item of interactionsRef.current.asks) {
          if (item.runId === event.run_id) recordSettled(item.requestId);
        }
        dispatchInteraction({ type: 'run-finished', runId: event.run_id });
      }
    });

    const offHello = client.onHello((info) => {
      attempt = 0;
      setReconnectAttempt(0);
      // gateway 重启后 seq 从 1 重新计数；旧 seq 会让重放事件被永久丢弃。
      // 不能只 reset(latest_seq) 后继续用当前连接：必须断开并以 since=0 重放。
      const seqPlan = planHelloSeq(info.latest_seq, eventStore.currentSeq);
      if (seqPlan.replay) {
        eventStore.reset(seqPlan.resetTo ?? 0);
        if (seqPlan.notice) setGapNotice(seqPlan.notice);
        setTokenError(null);
        setGatewayError(null);
        setLastError(null);
        // 旧连接的在途帧由 client 的 socket identity 检查丢弃。
        void client
          .restart(token, seqPlan.since, tenantIdRef.current ?? targetTenantId)
          .catch(reportConnectError);
        return;
      }
      const previousTenant = tenantIdRef.current;
      const nextTenant = info.tenant_id ?? previousTenant;
      setHello(info);
      setTenantId(nextTenant ?? null);
      if (previousTenant && nextTenant && previousTenant !== nextTenant) {
        // 切租户：旧事件 / 交互 / settled / 在途 hydration 绝不能带到新租户。
        eventStore.reset(0);
        dispatchInteraction({ type: 'reset' });
        settledRef.current.clear();
        hydrationGenerationRef.current += 1;
        setTenantEpoch((value) => value + 1);
      }
      setTokenError(null);
      setGatewayError(null);
      setLastError(null);
      setEpoch((value) => value + 1);
    });

    const offGap = client.onGap((gap) => {
      eventStore.reset(gap.to_seq);
      setGapNotice(`历史事件已截断（${gap.from_seq}–${gap.to_seq}），已重新同步`);
    });

    const offState = client.onState((state) => {
      if (!disposed) setConnectionState(state);
    });

    const offClose = client.onClose((code) => {
      if (disposed) return;
      if (code === 4400 || code === 4401 || code === 4403) {
        if (code === 4401) setTokenError('鉴权失败：token 错误或已失效');
        else if (code === 4403) setLastError('无权访问该 tenant（需要 admin token）');
        else setLastError('协议版本不兼容（需要 vessel.gateway/1）');
        return;
      }
      // 1s 起指数退避，上限 30s，带 jitter。
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      attempt += 1;
      setReconnectAttempt(attempt);
      setConnectionState('reconnecting');
      retryTimer = window.setTimeout(() => {
        if (disposed) return;
        void client
          .connect(token, eventStore.currentSeq, tenantIdRef.current ?? undefined)
          .catch(reportConnectError);
      }, delay);
    });

    // 先探 /health：Origin 403 / TLS / 网络错误在 WS 之前给出可诊断提示。
    void client
      .probeHealth()
      .then(() => client.connect(token, 0, targetTenantId))
      .catch(reportConnectError);

    return () => {
      disposed = true;
      offEvent();
      offHello();
      offGap();
      offState();
      offClose();
      window.clearTimeout(retryTimer);
      client.close();
    };
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

  // 连接 / 刷新 / 重连成功后补回 pending / orphaned（epoch 只在 hello 后递增）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch 是 hello 后的显式刷新触发器
  useEffect(() => {
    if (!hasToken) return;
    void hydrateInteractions();
  }, [epoch, hasToken, hydrateInteractions]);

  const connect = useCallback(
    (options: ConnectionOptions): boolean => {
      const urlCheck = checkGatewayUrl(options.gatewayUrl, window.location.protocol);
      if (!urlCheck.ok) {
        setGatewayError(urlCheck.error ?? '无效的 gateway 地址');
        return false;
      }
      const nextToken = options.token.trim();
      if (!nextToken) {
        setTokenError('请输入 gateway token');
        return false;
      }
      setGatewayError(null);
      if (urlCheck.value) localStorage.setItem(GATEWAY_URL_KEY, urlCheck.value);
      else localStorage.removeItem(GATEWAY_URL_KEY);
      sessionStorage.setItem(TOKEN_KEY, nextToken);
      setTokenError(null);
      setLastError(null);
      setTargetTenantId(options.tenantId);

      const sameTarget =
        urlCheck.value === gatewayUrl && nextToken === token && options.tenantId === undefined;
      if (sameTarget && connectionState === 'open') return true;

      if (urlCheck.value !== gatewayUrl) setGatewayUrl(urlCheck.value);
      setToken(nextToken);
      setConnectSeq((value) => value + 1);
      return true;
    },
    [connectionState, gatewayUrl, token],
  );

  const disconnect = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setTargetTenantId(undefined);
    client.close();
    eventStore.reset(0);
  }, [client, eventStore]);

  const retry = useCallback(() => {
    const tk = tokenRef.current.trim();
    if (!tk) return;
    setLastError(null);
    void client
      .probeHealth()
      .then(() => client.connect(tk, eventStore.currentSeq, tenantIdRef.current ?? undefined))
      .catch(reportConnectError);
  }, [client, eventStore, reportConnectError]);

  const updateResponding = useCallback((requestId: string, active: boolean) => {
    setResponding((prev) => {
      if (active) {
        if (prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.add(requestId);
        return next;
      }
      if (!prev.has(requestId)) return prev;
      const next = new Set(prev);
      next.delete(requestId);
      return next;
    });
  }, []);

  const respondPermission = useCallback(
    async (requestId: string, decision: 'allow' | 'deny', scope: PermissionScope = 'once') => {
      // 同一 requestId 只允许一次在途提交（双击/连点）。
      if (!submitGuard.current.begin(requestId)) return;
      updateResponding(requestId, true);
      try {
        await client.respondPermission(requestId, decision, scope);
        recordSettled(requestId);
        dispatchInteraction({ type: 'settle', requestId });
      } catch (error) {
        if (isRunEndedError(error)) {
          // 点击允许时 run 已结束：明确提示，不显示“未允许”。
          recordSettled(requestId);
          dispatchInteraction({ type: 'settle', requestId });
          toast.info(interactionRunEndedMessage());
          return;
        }
        if (isNotFoundError(error) || isExpiredError(error)) {
          // 服务端已丢弃 / 已过期：移除卡片并提示，不重试。
          recordSettled(requestId);
          dispatchInteraction({ type: 'settle', requestId });
          toast.info(interactionExpiredMessage());
          return;
        }
        toast.error(errorMessage(error));
      } finally {
        submitGuard.current.end(requestId);
        updateResponding(requestId, false);
      }
    },
    [client, recordSettled, toast, updateResponding],
  );

  const respondAsk = useCallback(
    async (requestId: string, answers: AskUserAnswer[]) => {
      if (!submitGuard.current.begin(requestId)) return;
      updateResponding(requestId, true);
      try {
        await client.respondAsk(requestId, answers);
        recordSettled(requestId);
        dispatchInteraction({ type: 'settle', requestId });
      } catch (error) {
        if (isRunEndedError(error)) {
          // run 已结束：卡片失效，明确语义而不是“未作答”。
          recordSettled(requestId);
          dispatchInteraction({ type: 'settle', requestId });
          toast.info(interactionRunEndedMessage());
          return;
        }
        if (isNotFoundError(error) || isExpiredError(error)) {
          recordSettled(requestId);
          dispatchInteraction({ type: 'settle', requestId });
          toast.info(interactionExpiredMessage());
          return;
        }
        toast.error(errorMessage(error));
      } finally {
        submitGuard.current.end(requestId);
        updateResponding(requestId, false);
      }
    },
    [client, recordSettled, toast, updateResponding],
  );

  const dismissOrphaned = useCallback(
    (requestId: string) => {
      if (!requestId) return;
      recordSettled(requestId);
      dispatchInteraction({ type: 'dismiss-orphaned', requestId });
      addDismissedId(browserStorage(), tenantIdRef.current ?? 'default', requestId);
    },
    [recordSettled],
  );

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
      gatewayError,
      tokenError,
      lastError,
      gapNotice,
      reconnectAttempt,
      epoch,
      tenantEpoch,
      stale: hello !== null && connectionState !== 'open',
      closeCode: client.closedWithCode,
      permissions,
      asks,
      orphaned,
      hydrateInteractions,
      dismissOrphaned,
      responding,
      connect,
      disconnect,
      clearToken: disconnect,
      retry,
      dismissError: () => setLastError(null),
      dismissGap: () => setGapNotice(null),
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
      gapNotice,
      reconnectAttempt,
      epoch,
      tenantEpoch,
      permissions,
      asks,
      orphaned,
      hydrateInteractions,
      dismissOrphaned,
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
