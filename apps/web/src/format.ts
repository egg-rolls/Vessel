/** Zero-pad a non-negative integer to the given width. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Format an epoch-millisecond timestamp for display in the web console.
 *
 * Uses local time. A timestamp on the same local calendar day as `now`
 * renders as `HH:MM:SS` (or `HH:MM:SS.mmm` with `withMs`); any other day
 * renders as `YYYY-MM-DD HH:MM:SS` (or `YYYY-MM-DD HH:MM:SS.mmm`).
 *
 * `undefined` timestamps render as an empty string.
 */
export function formatTimestamp(
  ts: number | undefined,
  opts?: { now?: number; withMs?: boolean },
): string {
  if (ts === undefined) return '';

  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date(opts?.now ?? Date.now());
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const time = `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`;
  const millis = opts?.withMs === true ? `.${pad(date.getMilliseconds(), 3)}` : '';

  if (sameDay) return `${time}${millis}`;

  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
  return `${day} ${time}${millis}`;
}
