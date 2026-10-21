import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  enqueueInteraction,
  enqueuePermission,
  expireInteractions,
  interactionExpiredMessage,
  interactionExpiresAt,
  interactionRunEndedMessage,
  isExpiredError,
  isNotFoundError,
  isRunEndedError,
  permissionFromEvent,
  removeInteraction,
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
  /** 正在提交应答的 requestId；UI 据此禁用按钮，避免双击重复提交。 */
  responding: ReadonlySet<string>;
  now: number;
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
  const [permissions, setPermissions] = useState<readonly PermissionRequest[]>([]);
  const [asks, setAsks] = useState<readonly AskUserRequest[]>([]);
  const [responding, setResponding] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [connectSeq, setConnectSeq] = useState(0);
  const submitGuard = useRef(new SubmitGuard());
  const permissionsRef = useRef<readonly PermissionRequest[]>(permissions);
  permissionsRef.current = permissions;

  const client = useMemo(() => new GatewayClient(gatewayUrl), [gatewayUrl]);
  const tenantIdRef = useRef<string | null>(null);
  tenantIdRef.current = tenantId;
  const tokenRef = useRef(token);
  tokenRef.current = token;

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
      setPermissions([]);
      setAsks([]);
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
      // 权限不按时间过期；刷新/重连时靠事件重放重建（Addendum A §4）。
      setPermissions((prev) => enqueuePermission(prev, request));
    };

    /** response / expired 事件：无论是否本端应答，都收起对应卡片。 */
    const removeByEvent = (event: RunEvent, expired: boolean) => {
      const data = event.data as { requestId?: unknown; request_id?: unknown };
      const requestId = data.requestId ?? data.request_id;
      if (typeof requestId !== 'string' || requestId.length === 0) return;
      const wasPending = permissionsRef.current.some((item) => item.requestId === requestId);
      setPermissions((prev) => removeInteraction(prev, requestId));
      if (expired && wasPending) toast.info(interactionExpiredMessage());
    };

    const addAsk = (event: RunEvent) => {
      const d = event.data as { requestId?: unknown; questions?: unknown };
      if (typeof d.requestId !== 'string' || !Array.isArray(d.questions)) return;
      const requestId = d.requestId;
      const questions = d.questions.filter(
        (item): item is AskUserRequest['questions'][number] =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as { question?: unknown }).question === 'string',
      );
      if (questions.length === 0) return;
      const expiresAt = interactionExpiresAt(event.ts);
      // ask 事件本身不带 session_id：从同一批事件里的 run.started 反查归属会话，
      // 供跨 session 待处理条跳转；查不到时退化为运行详情。
      const sessionId = sessionIdForRun(eventStore.getSnapshot().entries, event.run_id);
      setAsks((prev) =>
        enqueueInteraction(
          prev,
          {
            requestId,
            questions,
            runId: event.run_id,
            expiresAt,
            ...(sessionId ? { sessionId } : {}),
          },
          Date.now(),
        ),
      );
    };

    /** 其他端应答（ask.user.answered）：静默收起对应卡片。 */
    const removeAskByEvent = (event: RunEvent) => {
      const data = event.data as { requestId?: unknown; request_id?: unknown };
      const requestId = data.requestId ?? data.request_id;
      if (typeof requestId !== 'string' || requestId.length === 0) return;
      setAsks((prev) => removeInteraction(prev, requestId));
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
        setPermissions((prev) => prev.filter((item) => item.runId !== event.run_id));
        setAsks((prev) => prev.filter((item) => item.runId !== event.run_id));
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
        // 切租户：旧事件/选择绝不能带到新租户。
        eventStore.reset(0);
        setPermissions([]);
        setAsks([]);
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
  }, [client, token, connectSeq, targetTenantId, eventStore, reportConnectError, toast]);

  // ask 的倒计时/超时保留；权限请求默认无限等待（Addendum A）。
  useEffect(() => {
    if (asks.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [asks.length]);

  useEffect(() => {
    if (!asks.some((item) => item.expiresAt <= now)) return;
    toast.info('提问请求已超时，run 可能已失败；请检查时间线或重新发送。');
    setAsks((prev) => expireInteractions(prev, now));
  }, [now, asks, toast]);

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
        setPermissions((prev) => removeInteraction(prev, requestId));
      } catch (error) {
        if (isRunEndedError(error)) {
          // 点击允许时 run 已结束：明确提示，不显示“未允许”。
          setPermissions((prev) => removeInteraction(prev, requestId));
          toast.info(interactionRunEndedMessage());
          return;
        }
        if (isNotFoundError(error) || isExpiredError(error)) {
          // 服务端已丢弃 / 已过期：移除卡片并提示，不重试。
          setPermissions((prev) => removeInteraction(prev, requestId));
          toast.info(interactionExpiredMessage());
          return;
        }
        toast.error(errorMessage(error));
      } finally {
        submitGuard.current.end(requestId);
        updateResponding(requestId, false);
      }
    },
    [client, toast, updateResponding],
  );

  const respondAsk = useCallback(
    async (requestId: string, answers: AskUserAnswer[]) => {
      if (!submitGuard.current.begin(requestId)) return;
      updateResponding(requestId, true);
      try {
        await client.respondAsk(requestId, answers);
        setAsks((prev) => removeInteraction(prev, requestId));
      } catch (error) {
        if (isRunEndedError(error)) {
          // run 已结束：卡片失效，明确语义而不是“未作答”。
          setAsks((prev) => removeInteraction(prev, requestId));
          toast.info(interactionRunEndedMessage());
          return;
        }
        if (isNotFoundError(error) || isExpiredError(error)) {
          setAsks((prev) => removeInteraction(prev, requestId));
          toast.info(interactionExpiredMessage());
          return;
        }
        toast.error(errorMessage(error));
      } finally {
        submitGuard.current.end(requestId);
        updateResponding(requestId, false);
      }
    },
    [client, toast, updateResponding],
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
      hasToken: token.trim().length > 0,
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
      responding,
      now,
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
      gatewayError,
      tokenError,
      lastError,
      gapNotice,
      reconnectAttempt,
      epoch,
      tenantEpoch,
      permissions,
      asks,
      responding,
      now,
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
