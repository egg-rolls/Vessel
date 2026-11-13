import type { Dispatch, SetStateAction } from 'react';
import type { ToastApi } from '../components/ToastProvider';
import type { EventStore } from '../state/event-store';
import { useInteractionStore } from '../stores/interactionStore';
import type { ConnectionState, GatewayClient } from './client';
import { askFromEvent, interactionExpiredMessage, permissionFromEvent } from './interactions';
import { classifyCloseCode, nextReconnectDelay, probeThenConnect } from './reconnect';
import type { SubscriptionController } from './subscription';
import type { HelloInfo, RunEvent } from './types';

interface Current<T> {
  current: T;
}

/**
 * gap / 历史改写后的数据层恢复钩子。
 * 职责留在 Provider：它才有 sessionStore / hydration 的入口。
 */
export interface ConnectionRecoveryHooks {
  /** gap：当前路由的权威快照已过期（§3），页面重新拉取；不重连。 */
  invalidateRouteSnapshot: () => void;
  /** gap：pending 权限 / ask 必须重新走 interactions.list，不能只靠连接 epoch。 */
  hydrateInteractions: () => void;
  /** session.rewound / message.compaction：丢弃该会话更早页并重取尾页。 */
  onSessionHistoryChanged: (sessionId: string) => void;
}

export interface ConnectionHandlerDeps {
  client: GatewayClient;
  token: string;
  eventStore: EventStore;
  toast: ToastApi;
  subscription: SubscriptionController;
  recovery: ConnectionRecoveryHooks;
  settledRef: Current<Map<string, number>>;
  recordSettled: (requestId: string) => void;
  reportConnectError: (error: unknown) => void;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setHello: Dispatch<SetStateAction<HelloInfo | null>>;
  setReconnectAttempt: Dispatch<SetStateAction<number>>;
  setTokenError: Dispatch<SetStateAction<string | null>>;
  setGatewayError: Dispatch<SetStateAction<string | null>>;
  setLastError: Dispatch<SetStateAction<string | null>>;
  setEpoch: Dispatch<SetStateAction<number>>;
}

/** 事件自报的会话归属：顶层或 `data.session_id`；缺失返回 undefined。 */
function eventSessionId(event: RunEvent): string | undefined {
  const topLevel = (event as { session_id?: unknown }).session_id;
  if (typeof topLevel === 'string' && topLevel.length > 0) return topLevel;
  const value = (event.data as { session_id?: unknown }).session_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 建立一次 WS 生命周期的订阅（事件 / hello / gap / state / close），并启动首个连接。
 * 返回的 dispose 与原 useEffect cleanup 完全一致：先解除订阅，再清定时器与连接。
 */
export function createConnectionHandlers(deps: ConnectionHandlerDeps): () => void {
  const {
    client,
    token,
    eventStore,
    toast,
    subscription,
    recovery,
    settledRef,
    recordSettled,
    reportConnectError,
    setConnectionState,
    setHello,
    setReconnectAttempt,
    setTokenError,
    setGatewayError,
    setLastError,
    setEpoch,
  } = deps;

  let disposed = false;
  let retryTimer: number | undefined;
  let attempt = 0;
  // 新的连接目标（token / URL / 显式重连）：旧缓冲属于上一个连接，清空。
  eventStore.clear();
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

  /**
   * 其他端应答（ask.user.answered）：静默收起对应卡片。
   *
   * **分批**：`final === false` 的事件只带来其中几题的答案 —— 请求仍是 pending，
   * 卡片不能收，更不能 `recordSettled`（那个集合会让下一次 hydration 把它当成
   * 「本端已结算」而不补回，等于未答的题被这条事件永久带走）。缺省（旧事件 /
   * 旧 gateway 不带这个键）= 整条请求答完，行为与分批之前一字不差。
   */
  const removeAskByEvent = (event: RunEvent) => {
    const data = event.data as {
      requestId?: unknown;
      request_id?: unknown;
      final?: unknown;
    };
    if (data.final === false) return;
    const requestId = data.requestId ?? data.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) return;
    recordSettled(requestId);
    useInteractionStore.getState().dispatch({ type: 'settle', requestId });
  };

  const offEvent = client.onEvent((event, meta) => {
    if (!eventStore.push(event, meta)) return;
    if (event.type === 'session.rewound') {
      // 历史已删除：立即丢掉该会话的缓冲事件（含刚 push 的 marker 本身）。
      const sessionId = eventSessionId(event);
      if (sessionId !== undefined) {
        eventStore.dropSession(sessionId);
        recovery.onSessionHistoryChanged(sessionId);
      }
    }
    // compaction 替换前缀：更早页的游标锚点大概率失效，主动重取尾页。
    if (event.type === 'message.compaction') {
      const sessionId = eventSessionId(event);
      if (sessionId !== undefined) recovery.onSessionHistoryChanged(sessionId);
    }
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
        // 0.52：async ask 不随 run 终态结算（它的 run 早就结束，请求仍然待批）。
        if (item.mode === 'async') continue;
        // 分批：部分已答的 ask 也不结算 —— 剩下那几题还在等服务端，卡片必须留着。
        if ((item.answeredQuestionIds?.length ?? 0) > 0) continue;
        if (item.runId === event.run_id) recordSettled(item.requestId);
      }
      interactions.dispatch({ type: 'run-finished', runId: event.run_id });
    }
  });

  const offHello = client.onHello((info) => {
    // 订阅 epoch：服务端每次成功 subscribe 都先发 hello；它只重置本地事件库，
    // 不 bump 连接 epoch（否则切路由会无谓重拉 session / team 详情）。
    //
    // 三种 hello：连接级 / 订阅 epoch / 回填页。回填页是控制器为补更早区间自己发的
    // `until_seq` 订阅，它既不改游标也不该 reset 连接态（那一段的游标归回填管）。
    const helloKind = subscription.consumeHello(info);
    if (helloKind === 'page') return;
    // hello 是本地事件 epoch 的唯一边界：从本次实际首条 seq 之前重置。
    // 有界回放会从窗口首条开始；被跳过的区间由随后的 gap 告知（chat 订阅另有回填）。
    // 只截断到本次 epoch 的首条之前：已有条目留在屏上，回放再把窗口补回来
    // （旧的「先清空」会让整条时间线消失一帧 —— 整页闪烁 + 跳底）。
    // 回填期间是空操作：游标已经由 `EventStore#beginBackfill` 退到订阅起点。
    eventStore.truncateAfter(Math.max(0, info.from_seq - 1));
    setTokenError(null);
    setGatewayError(null);
    setLastError(null);
    if (helloKind === 'subscribe') return;
    attempt = 0;
    setReconnectAttempt(0);
    setHello(info);
    setEpoch((value) => value + 1);
    // 重连后服务端回到无过滤连接：按当前路由重新收敛。
    subscription.onConnectionHello(info.latest_seq);
  });

  const offGap = client.onGap((gap) => {
    // gap = 该区间无法从实时流恢复；静默处理，不重连、不提示。
    // 页面感知不到截断：正文由 sessions.get / teams.get 的权威快照补回。
    //
    // 两种 gap 不能一视同仁：
    // - 实时缺口（背压丢帧）：`to_seq` 在当前游标之上，退游标是对的；
    // - 回填页/旧区间的缺口：`to_seq` 低于当前游标，退回去只会把已经收到的更新内容
    //   截掉（刷新后尤其致命），忽略即可 —— 那一段由回填循环按 hello.from_seq 继续往
    //   更早拉，拉不到就是环形缓冲已经淘汰。
    if (eventStore.backfilling) return;
    if (gap.to_seq < eventStore.currentSeq) return;
    // 同作用域内的游标重对齐：保留 ≤ to_seq 的条目，不做整表清空。
    eventStore.truncateAfter(gap.to_seq);
    recovery.invalidateRouteSnapshot();
    // pending 权限 / ask 不能只依赖连接级 epoch：gap 不重连，必须显式补 hydration。
    recovery.hydrateInteractions();
  });

  const offState = client.onState((state) => {
    if (!disposed) setConnectionState(state);
  });

  const offClose = client.onClose((code) => {
    if (disposed) return;
    subscription.onDisconnect();
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
      // 重连仍用本地当前 seq 作为 since；hello 会重新对齐 epoch。
      void client.connect(token, eventStore.currentSeq).catch(reportConnectError);
    }, delay);
  });

  // 先探 /health：Origin 403 / TLS / 网络错误在 WS 之前给出可诊断提示。
  probeThenConnect(client, token, () => ({ since: 0 }), reportConnectError);

  return () => {
    disposed = true;
    subscription.onDisconnect();
    offEvent();
    offHello();
    offGap();
    offState();
    offClose();
    window.clearTimeout(retryTimer);
    client.close();
  };
}
