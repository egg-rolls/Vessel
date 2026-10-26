/**
 * Store-backed resource helpers.
 *
 * The Zustand stores below keep the same `ResourceState` contract as
 * `state/useResource.ts` (idle / loading / success / error, stale data on
 * refresh, stable error codes). These helpers add request-generation guards so
 * an older poll response can never overwrite a newer one.
 */
import { beginLoad, errorCodeOf, type ResourceState, succeed } from '../state/useResource';

const generations = new Map<string, number>();

/** Reserve the next generation for a resource key; older requests lose. */
export function nextGeneration(key: string): number {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

export function isCurrentGeneration(key: string, generation: number): boolean {
  return generations.get(key) === generation;
}

/** Invalidate in-flight requests for a key (e.g. tenant reset). */
export function invalidateGeneration(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

export function beginStoreLoad<T>(prev: ResourceState<T> | undefined): ResourceState<T> {
  return prev === undefined ? { status: 'loading' } : beginLoad(prev);
}

export function storeFailure<T>(
  prev: ResourceState<T> | undefined,
  error: unknown,
): ResourceState<T> {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCodeOf(error);
  const data =
    prev?.status === 'success' || prev?.status === 'loading' || prev?.status === 'error'
      ? prev.data
      : undefined;
  const updatedAt =
    prev?.status === 'success' || prev?.status === 'error' ? prev.updatedAt : undefined;
  return {
    status: 'error',
    error: message,
    ...(code !== undefined ? { code } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export function storeSuccess<T>(data: T): ResourceState<T> {
  return succeed(data);
}

/** True when the resource has produced data at least once. */
export function hasResourceData<T>(state: ResourceState<T> | undefined): boolean {
  return state?.status === 'success' || (state?.status === 'loading' && state.data !== undefined)
    ? true
    : state?.status === 'error' && state.data !== undefined;
}
