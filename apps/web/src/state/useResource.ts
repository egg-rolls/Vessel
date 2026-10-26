import { useCallback, useEffect, useRef, useState } from 'react';

/** 共享异步状态契约（主计划 §2.2）。 */
export type ResourceState<T> =
  | { status: 'idle' }
  | { status: 'loading'; data?: T }
  | { status: 'success'; data: T; updatedAt: number }
  /**
   * `code` 保留 gateway 的稳定错误码（forbidden / not_found / …）；
   * 只保留 message 会让 403 分支永远匹配不到。
   */
  | { status: 'error'; data?: T; error: string; code?: string; updatedAt?: number };

/** 从任意异常中取出 gateway code（WS 错误是字符串，RPC 错误带 code 属性）。 */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  const message = error instanceof Error ? error.message : String(error);
  const prefix = /^([a-z_]+):/.exec(message);
  return prefix?.[1];
}

export const initialResourceState: ResourceState<never> = { status: 'idle' };

/** 取出当前数据（success 或保留的旧数据）；store 中尚未出现的 key 为 undefined。 */
export function resourceData<T>(state: ResourceState<T> | undefined): T | undefined {
  if (!state) return undefined;
  if (state.status === 'success') return state.data;
  if (state.status === 'loading' || state.status === 'error') return state.data;
  return undefined;
}

/** 开始加载：保留旧数据，避免刷新时闪烁/丢内容。 */
export function beginLoad<T>(prev: ResourceState<T>): ResourceState<T> {
  if (prev.status === 'success') return { status: 'loading', data: prev.data };
  if (prev.status === 'error' && prev.data !== undefined) {
    return { status: 'loading', data: prev.data };
  }
  return { status: 'loading' };
}

export function succeed<T>(data: T, now = Date.now()): ResourceState<T> {
  return { status: 'success', data, updatedAt: now };
}

export interface ResourceError {
  message: string;
  code?: string;
}

/** 失败时保留旧数据与时间戳，供「更新失败，显示 <time> 的数据」使用。 */
export function fail<T>(prev: ResourceState<T>, error: string | ResourceError): ResourceState<T> {
  const data =
    prev.status === 'success' || prev.status === 'loading' || prev.status === 'error'
      ? prev.data
      : undefined;
  const updatedAt =
    prev.status === 'success' || prev.status === 'error' ? prev.updatedAt : undefined;
  const message = typeof error === 'string' ? error : error.message;
  const code = typeof error === 'string' ? undefined : error.code;
  return {
    status: 'error',
    error: message,
    ...(code !== undefined ? { code } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/** generation guard：只有最新代次的响应可以落地。 */
export function isCurrentGeneration(generation: number, current: number): boolean {
  return generation === current;
}

/** 轮询是否应当启动（页面隐藏时可暂停）。 */
export function shouldPoll(
  pollMs: number | undefined,
  pauseWhenHidden: boolean,
  visibility: 'visible' | 'hidden' = 'visible',
): boolean {
  if (!pollMs || pollMs <= 0) return false;
  if (pauseWhenHidden && visibility === 'hidden') return false;
  return true;
}

export interface UseResourceOptions<T> {
  /** 请求函数；通过 ref 调用，可随渲染更新。 */
  load: () => Promise<T>;
  /** false 时不发请求并回到 idle。 */
  enabled?: boolean;
  /** 轮询间隔；<=0/未设置则不轮询。 */
  pollMs?: number;
  /** 页面隐藏时暂停轮询（默认 true）。 */
  pauseWhenHidden?: boolean;
  /** 依赖变化触发重新加载；必须是可 JSON 序列化的原始值。 */
  deps?: readonly (string | number | boolean | null | undefined)[];
  /** 首帧即视为已加载的数据（例如从列表带过来的摘要）。 */
  initialData?: T;
}

export interface UseResourceResult<T> {
  state: ResourceState<T>;
  reload: () => void;
  refreshing: boolean;
}

/**
 * 单个请求的异步状态：首次 loading、刷新保留旧数据、错误保留旧数据、
 * generation guard 保证旧请求不覆盖新结果；可选轮询并在页面隐藏时暂停。
 */
export function useResource<T>({
  load,
  enabled = true,
  pollMs,
  pauseWhenHidden = true,
  deps = [],
  initialData,
}: UseResourceOptions<T>): UseResourceResult<T> {
  const [state, setState] = useState<ResourceState<T>>(() =>
    initialData !== undefined ? succeed(initialData) : initialResourceState,
  );
  const generation = useRef(0);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadRef = useRef(load);
  loadRef.current = load;
  const timerRef = useRef<number | undefined>(undefined);
  const depKey = JSON.stringify(deps);

  const run = useCallback(() => {
    const generationAtStart = ++generation.current;
    setState((prev) => beginLoad(prev));
    void loadRef
      .current()
      .then((data) => {
        if (!mounted.current || !isCurrentGeneration(generationAtStart, generation.current)) return;
        setState(succeed(data));
      })
      .catch((error: unknown) => {
        if (!mounted.current || !isCurrentGeneration(generationAtStart, generation.current)) return;
        const message = error instanceof Error ? error.message : String(error);
        const code = errorCodeOf(error);
        setState((prev) => fail(prev, code ? { message, code } : message));
      });
  }, []);

  const reload = useCallback(() => {
    if (!enabled) return;
    run();
  }, [enabled, run]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: depKey 是调用方 deps 的序列化，load 通过 ref 读取
  useEffect(() => {
    window.clearInterval(timerRef.current);
    timerRef.current = undefined;
    if (!enabled) {
      // 作废旧的在途请求，避免它在新状态下落地。
      generation.current += 1;
      setState(initialResourceState);
      return;
    }
    run();
    const visibility = document.visibilityState === 'hidden' ? 'hidden' : 'visible';
    if (shouldPoll(pollMs, pauseWhenHidden, visibility)) {
      timerRef.current = window.setInterval(run, pollMs);
    }
    if (!pauseWhenHidden || !pollMs) return;
    const onVisibility = () => {
      window.clearInterval(timerRef.current);
      timerRef.current = undefined;
      if (document.visibilityState === 'hidden') return;
      run();
      if (shouldPoll(pollMs, pauseWhenHidden, 'visible')) {
        timerRef.current = window.setInterval(run, pollMs);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timerRef.current);
      timerRef.current = undefined;
    };
  }, [enabled, pollMs, pauseWhenHidden, depKey, run]);

  return {
    state,
    reload,
    refreshing: state.status === 'loading' && state.data !== undefined,
  };
}
