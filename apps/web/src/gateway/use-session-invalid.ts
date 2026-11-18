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
import { notifyAuthRequired } from '../auth/auth-client';
import { type GatewayRpcBlock, rpcBlockTracker, setSessionReauthHandler } from './session-invalid';

setSessionReauthHandler(notifyAuthRequired);

export interface SessionInvalidState {
  /** 最近一次被拒的 RPC 事实；null = 当前没有（或已经恢复）。 */
  block: GatewayRpcBlock | null;
  /** 走既有通道重新鉴权（AuthProvider 会重新探测会话，必要时回登录页）。 */
  relogin: () => void;
}

export function useSessionInvalid(): SessionInvalidState {
  const snapshot = useSyncExternalStore(
    rpcBlockTracker.subscribe,
    rpcBlockTracker.snapshot,
    rpcBlockTracker.snapshot,
  );
  const relogin = useCallback(() => {
    // 先清掉本地事实再走通道：重新探测会给出新的权威结论（成功 ⇒ 不再提示；
    // 仍然 401 ⇒ 下一次 RPC 会把它记回来）。
    rpcBlockTracker.clear();
    notifyAuthRequired();
  }, []);
  return { block: snapshot.block, relogin };
}
