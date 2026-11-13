/**
 * ask 浏览位的容器：内存 store + sessionStorage 镜像（切页 / 刷新 / 重连都不丢）。
 *
 * 与草稿（`ask-draft-store.ts`）同一套取舍，理由也同一份：sessionStorage 只在当前标签页
 * 这次会话有效，关掉即清；刷新读回正好是我们要的那点。区别只有一个 —— **不做 debounce**：
 * 浏览位只在「上一题 / 下一题」时写一次，频率是人点按钮的频率，同步写一小段 JSON 足够，
 * 反倒省掉了一套 flush 生命周期（草稿要 debounce 是因为它在每次按键时都变）。
 *
 * 清理跟草稿同源：`useAskCursorPrune` 在请求消失时按差集删；提交成功由调用方 drop。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { browserSessionStorage } from '../chat/session-selection';
import {
  type AskCursors,
  askCursorOf,
  dropAskCursors,
  EMPTY_ASK_CURSORS,
  parseAskCursors,
  pruneAskCursors,
  rememberAskCursor,
  resolveAskCursorIndex,
  serializeAskCursors,
} from './ask-cursor';

/** 落盘键：一个键装所有浏览位（形状见 ask-cursor.ts 的 PersistedAskCursors）。 */
const STORAGE_KEY = 'vessel.askCursor.v1';

let hydrated = false;

interface AskCursorState {
  cursors: AskCursors;
}

export const useAskCursorStore = create<AskCursorState>(() => ({ cursors: EMPTY_ASK_CURSORS }));

function persist(cursors: AskCursors): void {
  try {
    const storage = browserSessionStorage();
    if (storage === null) return;
    storage.setItem(STORAGE_KEY, serializeAskCursors(cursors));
  } catch {
    // 隐私模式 / 策略禁用：静默降级成纯内存（等价于「刷新后回到第 1 题」的旧行为）。
  }
}

/** 首次使用时从 sessionStorage 读回（幂等，读失败当没有）。 */
export function hydrateAskCursors(now = Date.now()): AskCursors {
  if (hydrated) return useAskCursorStore.getState().cursors;
  hydrated = true;
  let restored: AskCursors = EMPTY_ASK_CURSORS;
  try {
    const storage = browserSessionStorage();
    const parsed =
      storage === null ? undefined : parseAskCursors(storage.getItem(STORAGE_KEY), now);
    if (parsed !== undefined) restored = parsed;
  } catch {
    restored = EMPTY_ASK_CURSORS;
  }
  useAskCursorStore.setState({ cursors: restored });
  return restored;
}

/** 记一次浏览位并落盘（只记题号，不记任何答案文本）。 */
export function rememberAskCursorFor(
  requestId: string,
  questionId: string,
  now = Date.now(),
): void {
  const { cursors } = useAskCursorStore.getState();
  const next = rememberAskCursor(cursors, requestId, questionId, now);
  if (next === cursors) return;
  useAskCursorStore.setState({ cursors: next });
  persist(next);
}

/** 丢弃指定请求的浏览位（提交成功 / 请求消失）。 */
export function dropAskCursorsFor(requestIds: Iterable<string>): void {
  const { cursors } = useAskCursorStore.getState();
  const next = dropAskCursors(cursors, requestIds);
  if (next === cursors) return;
  useAskCursorStore.setState({ cursors: next });
  persist(next);
}

/** 清空（测试 / 调试用）。 */
export function clearAskCursors(): void {
  useAskCursorStore.setState({ cursors: EMPTY_ASK_CURSORS });
  hydrated = false;
  try {
    browserSessionStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // 同上：静默。
  }
}

/**
 * 请求从 pending 集合消失时按差集删（与 `useAskDraftPrune` 同一形状、同一调用点）。
 *
 * 不 prune 的后果不是「数据变脏」这么轻：sessionStorage 有配额，长期挂着几十条过期浏览位
 * 会把草稿的配额挤掉 —— 那才是用户真会丢东西的地方。
 */
export function useAskCursorPrune(liveRequestIds: readonly string[], active = true): void {
  useEffect(() => {
    if (!active) return;
    hydrateAskCursors();
    const { cursors } = useAskCursorStore.getState();
    const next = pruneAskCursors(cursors, liveRequestIds, Date.now());
    if (next === cursors) return;
    useAskCursorStore.setState({ cursors: next });
    persist(next);
  }, [liveRequestIds, active]);
}

/**
 * Composer 逐题卡的浏览位来源：读回存储 + 每次翻页写回。
 *
 * 三件事捆在一个 hook 里，是因为它们必须一致：`index` 是**这一屏**的下标、`questionIds`
 * 是这一屏的题号序列、存储里放的是题号。任何一处单独用都会错位（比如只存下标：
 * 服务端换了题序就把人钉在别的题上）。
 */
export function useAskCursorIndex(
  requestId: string,
  questionIds: readonly string[],
): readonly [number, (next: number) => void] {
  const idsRef = useRef<readonly string[]>(questionIds);
  idsRef.current = questionIds;
  const [index, setIndex] = useState(() => {
    hydrateAskCursors();
    return resolveAskCursorIndex(
      questionIds,
      askCursorOf(useAskCursorStore.getState().cursors, requestId),
    );
  });
  // 换一条请求（或同一条请求重启）时按存储重算 —— 这就是「刷新后停在上次那一题」。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在 requestId 变化时重算
  useEffect(() => {
    hydrateAskCursors();
    setIndex(
      resolveAskCursorIndex(
        idsRef.current,
        askCursorOf(useAskCursorStore.getState().cursors, requestId),
      ),
    );
  }, [requestId]);
  const move = useCallback(
    (next: number) => {
      const ids = idsRef.current;
      const clamped = ids.length === 0 ? 0 : Math.min(Math.max(next, 0), ids.length - 1);
      setIndex(clamped);
      const questionId = ids[clamped];
      if (questionId !== undefined) rememberAskCursorFor(requestId, questionId);
    },
    [requestId],
  );
  return [index, move] as const;
}
