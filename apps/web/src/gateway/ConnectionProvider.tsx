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
import { type ConnectionState, GatewayClient, GatewayHttpError } from './client';
import type { AskUserAnswer, AskUserRequest, HelloInfo, RunEvent } from './types';
import { checkGatewayUrl, GATEWAY_URL_KEY, resolveInitialGatewayUrl } from './url';

export interface PermissionRequest {
  requestId: string;
  tool: string;
  input: unknown;
  runId: string;
  expiresAt: number;
}

const TOKEN_KEY = 'vessel.token';
const INTERACTION_TTL_MS = 120_000;

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
  permissions: PermissionRequest[];
  asks: AskUserRequest[];
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
    remember?: boolean,
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
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [asks, setAsks] = useState<AskUserRequest[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [connectSeq, setConnectSeq] = useState(0);

  const client = useMemo(() => new GatewayClient(gatewayUrl), [gatewayUrl]);
  const tenantIdRef = useRef<string | null>(null);
  tenantIdRef.current = tenantId;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const reportConnectError = useCallback(
    (error: unknown) => {
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
      const d = event.data as { requestId?: unknown; tool?: unknown; input?: unknown };
      if (typeof d.requestId !== 'string') return;
      const requestId = d.requestId;
      setPermissions((prev) =>
        prev.some((item) => item.requestId === requestId)
          ? prev
          : [
              ...prev,
              {
                requestId,
                tool: typeof d.tool === 'string' ? d.tool : 'tool',
                input: d.input,
                runId: event.run_id,
                expiresAt: Date.now() + INTERACTION_TTL_MS,
              },
            ],
      );
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
      setAsks((prev) =>
        prev.some((item) => item.requestId === requestId)
          ? prev
          : [
              ...prev,
              {
                requestId,
                questions,
                runId: event.run_id,
                expiresAt: Date.now() + INTERACTION_TTL_MS,
              },
            ],
      );
    };

    const offEvent = client.onEvent((event, meta) => {
      if (!eventStore.push(event, meta)) return;
      if (event.type === 'tool.permission.request') addPermission(event);
      if (event.type === 'ask.user.requested') addAsk(event);
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
      // gateway 重启后 seq 从 1 重新计数；旧 seq 会永久丢弃新事件。
      if (info.latest_seq < eventStore.currentSeq) {
        const reset = eventStore.currentSeq > 0;
        eventStore.reset(info.latest_seq);
        if (reset) setGapNotice('gateway 已重启，事件序号已重置，已重新同步');
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
  }, [client, token, connectSeq, targetTenantId, eventStore, reportConnectError]);

  // 交互相应倒计时（仅在有等待确认时）。
  useEffect(() => {
    if (permissions.length === 0 && asks.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [permissions.length, asks.length]);

  useEffect(() => {
    const expiredPermission = permissions.some((item) => item.expiresAt <= now);
    const expiredAsk = asks.some((item) => item.expiresAt <= now);
    if (!expiredPermission && !expiredAsk) return;
    toast.info(
      expiredPermission
        ? '权限请求已超时，run 可能已失败；请检查时间线或重新发送。'
        : '提问请求已超时，run 可能已失败；请检查时间线或重新发送。',
    );
    setPermissions((prev) => prev.filter((item) => item.expiresAt > now));
    setAsks((prev) => prev.filter((item) => item.expiresAt > now));
  }, [now, permissions, asks, toast]);

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

  const respondPermission = useCallback(
    async (requestId: string, decision: 'allow' | 'deny', remember = false) => {
      try {
        await client.respondPermission(requestId, decision, remember);
        setPermissions((prev) => prev.filter((item) => item.requestId !== requestId));
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [client, toast],
  );

  const respondAsk = useCallback(
    async (requestId: string, answers: AskUserAnswer[]) => {
      try {
        await client.respondAsk(requestId, answers);
        setAsks((prev) => prev.filter((item) => item.requestId !== requestId));
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [client, toast],
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
      permissions,
      asks,
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
