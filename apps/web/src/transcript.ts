/**
 * Take the last `limit` items of a transcript while reporting how many were
 * hidden from the front.
 *
 * - `limit <= 0` returns an empty window and hides everything.
 * - `limit >= items.length` returns a copy of the whole list.
 * - The input array is never mutated.
 */
export function windowTail<T>(
  items: readonly T[],
  limit: number,
): { shown: T[]; hiddenCount: number } {
  if (limit <= 0) {
    return { shown: [], hiddenCount: items.length };
  }

  if (limit >= items.length) {
    return { shown: items.slice(), hiddenCount: 0 };
  }

  const start = items.length - limit;
  return { shown: items.slice(start), hiddenCount: start };
}
