/**
 * stale-while-revalidate（SWR）数据刷新 hook —— 数据刷新规范的共享实现
 * （docs/architecture/data-refresh-swr.md）。
 *
 * 语义条款：
 * 1. 首次加载（无 data）：`isLoading`，视图显示 loading 态；失败 → error（无 data）。
 * 2. revalidate（interval tick / refreshKey 变化 / reload() / 回可见）：data 保持旧值，
 *    `isRefreshing`；成功 → 原子 swap + updatedAt；失败 → 保留旧数据 + error（视图给
 *    细微 stale 提示）。**任何 revalidate 都不整页 loading。**
 * 3. queryKey 变化 = 新查询（range / 过滤切换）：旧查询数据对新查询无意义 → 清 data
 *    回首次加载语义。与 revalidate 严格区分。
 * 4. generation guard：只有最新代次响应可落地；queryKey 变化作废旧在途请求。
 * 5. 在途去重：请求在途时跳过新的 revalidate 触发（事件 burst 不会造成 RPC 风暴），
 *    下一个 tick 自然重试。queryKey 变化不受此限。
 * 6. pauseWhenHidden（默认 true）：页面隐藏暂停轮询，回可见立即 revalidate 一次。
 *
 * 宿主侧同契约实现：apps/web/src/state/useResource.ts（kanban 为范例）；本 hook 是
 * 插件侧 / 共享实现，两者遵循同一份规范。
 *
 * DOM-lib-light（同 host.ts）：根 tsconfig 只有 ES2022 lib，全局对象经结构化子集
 * 访问，消费方（浏览器 / 插件应用）带真实 DOM lib。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** 查询身份：必须是可 JSON 序列化的原始值数组（range / 过滤等）。 */
export type SwrQueryKey = readonly (string | number | boolean | null | undefined)[];

export interface SwrOptions<T> {
  /** 请求函数；经 ref 调用，闭包随渲染更新。 */
  load: () => Promise<T>;
  /** 查询身份；变化 = 新查询 → 清旧数据回首次 loading（条款 3）。 */
  queryKey?: SwrQueryKey;
  /** 后台轮询间隔 ms；<=0 / 缺省不轮询。 */
  intervalMs?: number;
  /** 外部刷新信号（宿主事件去抖后的 refreshKey）：变化 → 后台 revalidate（条款 2）。 */
  refreshKey?: number;
  /** 页面隐藏时暂停轮询（默认 true）；回可见立即 revalidate 一次（条款 6）。 */
  pauseWhenHidden?: boolean;
  /** false 时不发请求并清空数据（默认 true）。 */
  enabled?: boolean;
}

export interface SwrResult<T> {
  /** 旧值保持；就绪原子 swap。无数据时 undefined。 */
  data: T | undefined;
  /** 最近错误；有 data 时供 stale 提示，不撤数据。 */
  error: Error | undefined;
  /** 仅首次（无 data）loading。 */
  isLoading: boolean;
  /** 有 data 的后台刷新中（细微指示用，绝不整页 loading）。 */
  isRefreshing: boolean;
  /** 最近成功时间（ms epoch；stale 提示用）。 */
  updatedAt: number | undefined;
  /** 手动刷新 = revalidate（有旧数据则保留）。 */
  reload: () => void;
}

/** 内部状态机：loading/error 无 data；ready/revalidating/stale 恒有 data。 */
type SwrState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: T; updatedAt: number }
  | { status: 'revalidating'; data: T; updatedAt: number }
  | { status: 'stale'; data: T; updatedAt: number; error: Error };

type SwrWithData<T> = Extract<SwrState<T>, { data: T }>;

function hasData<T>(state: SwrState<T>): state is SwrWithData<T> {
  return state.status === 'ready' || state.status === 'revalidating' || state.status === 'stale';
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** 结构化全局子集：轮询 / 可见性所需的最小面（根程序无 lib.dom）。 */
interface SwrWindow {
  setInterval?: (handler: () => void, timeout: number) => number;
  clearInterval?: (id: number | undefined) => void;
}

interface SwrDocument {
  visibilityState?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

function swrWindow(): SwrWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as SwrWindow);
}

function swrDocument(): SwrDocument | undefined {
  return typeof document === 'undefined' ? undefined : (document as unknown as SwrDocument);
}

export function useStaleWhileRevalidate<T>({
  load,
  queryKey,
  intervalMs,
  refreshKey = 0,
  pauseWhenHidden = true,
  enabled = true,
}: SwrOptions<T>): SwrResult<T> {
  const [state, setState] = useState<SwrState<T>>({ status: 'loading' });
  const generation = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const timerRef = useRef<number | undefined>(undefined);
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const queryKeyJson = JSON.stringify(queryKey ?? []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** 一次 revalidate：有旧数据 → revalidating（保留）；无 → loading（首次）。 */
  const run = useCallback(() => {
    if (!enabledRef.current || inFlight.current) return;
    const generationAtStart = ++generation.current;
    inFlight.current = true;
    setState((prev) =>
      hasData(prev)
        ? { status: 'revalidating', data: prev.data, updatedAt: prev.updatedAt }
        : { status: 'loading' },
    );
    void loadRef.current().then(
      (data) => {
        if (!mounted.current || generationAtStart !== generation.current) return;
        inFlight.current = false;
        setState({ status: 'ready', data, updatedAt: Date.now() });
      },
      (reason: unknown) => {
        if (!mounted.current || generationAtStart !== generation.current) return;
        inFlight.current = false;
        const error = toError(reason);
        setState((prev) =>
          hasData(prev)
            ? { status: 'stale', data: prev.data, updatedAt: prev.updatedAt, error }
            : { status: 'error', error },
        );
      },
    );
  }, []);

  const reload = useCallback(() => {
    run();
  }, [run]);

  // 查询身份 / enabled 变化：作废旧在途请求，新查询从首次加载语义开始（条款 3/4）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKeyJson 是 queryKey 的序列化；load 经 ref 读取。
  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setState({ status: 'loading' });
    if (enabled) run();
  }, [enabled, queryKeyJson, run]);

  // 外部刷新信号：变化 → 后台 revalidate（在途去重由 run 保证，条款 2/5）。
  const seenRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (seenRefreshKey.current === refreshKey) return;
    seenRefreshKey.current = refreshKey;
    run();
  }, [refreshKey, run]);

  // 轮询调度：只动 timer，不碰数据状态（intervalMs 变化不得清空旧数据）。
  useEffect(() => {
    const scope = swrWindow();
    const doc = swrDocument();
    if (!enabled || intervalMs === undefined || intervalMs <= 0 || !scope?.setInterval) return;
    const start = (): void => {
      scope.clearInterval?.(timerRef.current);
      timerRef.current = scope.setInterval?.(run, intervalMs);
    };
    const stop = (): void => {
      scope.clearInterval?.(timerRef.current);
      timerRef.current = undefined;
    };
    if (!pauseWhenHidden || !doc?.addEventListener) {
      start();
      return stop;
    }
    if (doc.visibilityState !== 'hidden') start();
    const onVisibility = (): void => {
      stop();
      if (doc.visibilityState === 'hidden') return;
      run();
      start();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    return () => {
      doc.removeEventListener?.('visibilitychange', onVisibility);
      stop();
    };
  }, [enabled, intervalMs, pauseWhenHidden, run]);

  return {
    data: hasData(state) ? state.data : undefined,
    error: state.status === 'error' || state.status === 'stale' ? state.error : undefined,
    isLoading: state.status === 'loading',
    isRefreshing: state.status === 'revalidating',
    updatedAt: hasData(state) ? state.updatedAt : undefined,
    reload,
  };
}
