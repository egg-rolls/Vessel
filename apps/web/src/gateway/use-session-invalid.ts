/**
 * 「RPC 被拒」状态的 React 接线（0.59）。
 *
 * 两件事：
 * 1. 把 `rpcBlockTracker`（传输层写的纯状态）接到 `useSyncExternalStore`，界面只读快照；
 * 2. 把**既有的** `notifyAuthRequired()` 通道注册成「该重新鉴权了」的唯一动作出口 ——
 *    不新造通道：`auth/AuthProvider` 已经在监听那条事件并重新探测 `/auth/status`。
 *
 * 为什么注册放在模块加载期而不是 `useEffect`：401 可能发生在**挂载期**的 RPC 上
 * （bootstrap / credentials / 首次 hydration）。晚一个 effect 注册就会漏掉第一次 ——
 * 而那一次恰恰是最该说话的一次（界面刚打开，用户什么都不知道）。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { notifyAuthRequired } from '../auth/auth-client';
import { type GatewayRpcBlock, rpcBlockTracker, setSessionReauthHandler } from './session-invalid';

setSessionReauthHandler(notifyAuthRequired);

/**
 * 本部署里「重新登录」到底有没有目标。
 *
 * `disabled`（没配任何 auth backend）与 `unknown`（`/auth/status` 打不通：老 gateway /
 * 离线）两种情况下 `AuthProvider.refresh()` 不会把界面切到登录页 —— 于是那颗按钮
 * 点下去像没反应。这时降级成「打开连接设置」，并且留一条可观测标记（见 relogin）。
 */
function canReloginFrom(phase: string): boolean {
  return phase !== 'disabled' && phase !== 'unknown';
}

/** 跳过重新登录时的可观测标记：以后同样的现象不必再靠人开 DevTools 才发现。 */
function logReloginSkipped(phase: string): void {
  console.info(`[vessel] auth.relogin skipped: auth_${phase}`);
}

export interface SessionInvalidState {
  /** 最近一次被拒的 RPC 事实；null = 当前没有（或已经恢复）。 */
  block: GatewayRpcBlock | null;
  /** 走既有通道重新鉴权（AuthProvider 会重新探测会话，必要时回登录页）。 */
  relogin: () => void;
  /** 「重新登录」在当前部署里是否有目标；false ⇒ 界面应降级成「打开连接设置」。 */
  canRelogin: boolean;
}

export function useSessionInvalid(): SessionInvalidState {
  const snapshot = useSyncExternalStore(
    rpcBlockTracker.subscribe,
    rpcBlockTracker.snapshot,
    rpcBlockTracker.snapshot,
  );
  const { phase } = useAuth();
  const canRelogin = canReloginFrom(phase);
  const relogin = useCallback(() => {
    // 顺序是「先 notify 再 clear」：重新鉴权被跳过时提示条必须留在原地，
    // 否则观感是「点了就没了，什么也没发生」（0.59 真机预研发现的坏形状）。
    if (!canReloginFrom(phase)) {
      logReloginSkipped(phase);
      return;
    }
    notifyAuthRequired();
    // notify 之后再清：重新探测会给出新的权威结论（仍然 401 ⇒ 下一次 RPC 会记回来）。
    rpcBlockTracker.clear();
  }, [phase]);
  return { block: snapshot.block, relogin, canRelogin };
}
