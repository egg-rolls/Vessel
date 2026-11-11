import { useRef } from 'react';

const NOTHING = (): boolean => false;

interface EnteringState {
  /** 这批列表的身份（换会话 / 换团队 / detail 到达）：变了就重新认「首屏」。 */
  reset: string | null;
  /**
   * 首屏那一批的 key。`null` = 还没见过非空的一屏（重置后列表可能先空一帧再灌数据，
   * 那一帧不算首屏，否则整屏历史都成了「新追加」）。
   */
  initial: Set<string> | null;
}

/**
 * 入场动画的触发判定：`isEntering(key)` 为 true 的项才挂 `.msg-enter`。
 *
 * 为什么不是「挂载就播」：React 对稳定 key 复用 DOM 节点，所以无条件的 CSS animation
 * 本来也不会在重渲染时重播（`.message-chip` 就是这个用法）。问题在另一头 ——
 * **挂载 ≠ 追加**：换团队、detail 到达、首次拉起列表都会一次性挂上整屏历史，那不是入场，
 * 几十上百行同时渐显只会变成整屏闪一下。所以这里按列表身份记一次「首屏那一批」，
 * 只有之后才出现的 key 算追加。
 *
 * 记账写在渲染期（`Set` 只增不改、幂等）：被 React 丢弃的渲染不会跑 effect，写在 effect
 * 里会让那批 key 在下一帧仍算「新追加」；而写在渲染期最坏只是多标一个 key（它本来就新）。
 * 判定一旦为 true 就永远为 true —— 类名中途被摘掉会把播到一半的动画掐断，反而更闪，
 * 这也是 `.msg-enter` 可以留在节点上的原因（动画按节点播，不会重播）。
 */
export function useEnteringItemKeys<T>(
  list: readonly T[],
  keyOf: (item: T) => string,
  reset: string | null,
): (key: string) => boolean {
  const store = useRef<EnteringState | null>(null);

  let state = store.current;
  if (state === null || state.reset !== reset) {
    state = { reset, initial: list.length === 0 ? null : keysOf(list, keyOf) };
    store.current = state;
  } else if (state.initial === null && list.length > 0) {
    // 重置后的第一屏整屏铺开：只记账，不播入场。
    state.initial = keysOf(list, keyOf);
  }

  const initial = state.initial;
  if (initial === null) return NOTHING;
  return (key: string) => !initial.has(key);
}

function keysOf<T>(list: readonly T[], keyOf: (item: T) => string): Set<string> {
  const keys = new Set<string>();
  for (const item of list) keys.add(keyOf(item));
  return keys;
}
