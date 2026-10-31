import type { Dispatch, SetStateAction } from 'react';
import type { ToastApi } from '../components/ToastProvider';
import { t } from '../i18n';
import type { EventStore } from '../state/event-store';
import { useInteractionStore } from '../stores/interactionStore';
import type { ConnectionState, GatewayClient } from './client';
import { askFromEvent, interactionExpiredMessage, permissionFromEvent } from './interactions';
import { classifyCloseCode, nextReconnectDelay, probeThenConnect } from './reconnect';
import { planHelloSeq } from './seq-replay';
import type { HelloInfo, RunEvent } from './types';

interface Current<T> {
  current: T;
}

export interface ConnectionHandlerDeps {
  client: GatewayClient;
  token: string;
  targetTenantId: string | undefined;
  eventStore: EventStore;
  toast: ToastApi;
  settledRef: Current<Map<string, number>>;
  hydrationGenerationRef: Current<number>;
  tenantIdRef: Current<string | null>;
  recordSettled: (requestId: string) => void;
  reportConnectError: (error: unknown) => void;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setHello: Dispatch<SetStateAction<HelloInfo | null>>;
  setTenantId: Dispatch<SetStateAction<string | null>>;
  setReconnectAttempt: Dispatch<SetStateAction<number>>;
  setTokenError: Dispatch<SetStateAction<string | null>>;
  setGatewayError: Dispatch<SetStateAction<string | null>>;
  setLastError: Dispatch<SetStateAction<string | null>>;
  setTenantEpoch: Dispatch<SetStateAction<number>>;
  setEpoch: Dispatch<SetStateAction<number>>;
}

/**
 * 建立一次 WS 生命周期的订阅（事件 / hello / gap / state / close），并启动首个连接。
 * 返回的 dispose 与原 useEffect cleanup 完全一致：先解除订阅，再清定时器与连接。
 */
export function createConnectionHandlers(deps: ConnectionHandlerDeps): () => void {
  const {
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
  } = deps;

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
    useInteractionStore.getState().dispatch({ type: 'permission-request', request });
  };

  /** response / expired 事件：无论是否本端应答，都收起对应卡片。 */
  const removeByEvent = (event: RunEvent, expired: boolean) => {
    const data = event.data as { requestId?: unknown; request_id?: unknown };
    const requestId = data.requestId ?? data.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) return;
    const wasPending = useInteractionStore
      .getState()
      .permissions.some((item) => item.requestId === requestId);
    recordSettled(requestId);
    useInteractionStore.getState().dispatch({ type: 'settle', requestId });
    if (expired && wasPending) toast.info(interactionExpiredMessage());
  };

  const addAsk = (event: RunEvent) => {
    // session_id 由事件自带；缺失就保持 undefined，不反查、不发 RPC。
    const request = askFromEvent(event);
    if (!request) return;
    if (settledRef.current.has(request.requestId)) return;
    useInteractionStore.getState().dispatch({ type: 'ask-request', request });
  };

  /** 其他端应答（ask.user.answered）：静默收起对应卡片。 */
  const removeAskByEvent = (event: RunEvent) => {
    const data = event.data as { requestId?: unknown; request_id?: unknown };
    const requestId = data.requestId ?? data.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) return;
    recordSettled(requestId);
    useInteractionStore.getState().dispatch({ type: 'settle', requestId });
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
      const interactions = useInteractionStore.getState();
      for (const item of interactions.permissions) {
        if (item.runId === event.run_id) recordSettled(item.requestId);
      }
      for (const item of interactions.asks) {
        if (item.runId === event.run_id) recordSettled(item.requestId);
      }
      interactions.dispatch({ type: 'run-finished', runId: event.run_id });
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
      // 一次性提示走右下角 toast，不占顶部 banner 布局。
      if (seqPlan.notice) toast.info(seqPlan.notice);
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
      useInteractionStore.getState().reset();
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
    // 一次性提示走右下角 toast，不占顶部 banner 布局。
    toast.info(t('gateway.connection.gap', { from: gap.from_seq, to: gap.to_seq }));
    // 缺口里的终态事件（如 permission.response）已经丢了：按协议从 to_seq 重连，
    // 借 hello → epoch → hydrateInteractions 用服务端 pending 收敛本地卡片。
    void client
      .restart(token, gap.to_seq, tenantIdRef.current ?? targetTenantId)
      .catch(reportConnectError);
  });

  const offState = client.onState((state) => {
    if (!disposed) setConnectionState(state);
  });

  const offClose = client.onClose((code) => {
    if (disposed) return;
    const close = classifyCloseCode(code);
    if (close.kind === 'terminal') {
      if (close.tokenError !== undefined) setTokenError(close.tokenError);
      if (close.lastError !== undefined) setLastError(close.lastError);
      return;
    }
    // 1s 起指数退避，上限 30s，带 jitter。
    const delay = nextReconnectDelay(attempt);
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
  probeThenConnect(
    client,
    token,
    () => ({ since: 0, tenantId: targetTenantId }),
    reportConnectError,
  );

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
}
