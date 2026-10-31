/**
 * RunDetail / RunTimeline 共用的展示格式化与导出 helper。
 */

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 耗时文案；同 `RunsView`：已结束的 run 没有 `completed_at` 时显示 `—`，不按「现在」算。 */
export function durationLabel(start?: number, end?: number, running = false): string {
  if (start === undefined) return '—';
  const stop = end ?? (running ? Date.now() : undefined);
  if (stop === undefined) return '—';
  const value = Math.max(0, stop - start);
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function exportJson(data: unknown, runId: string): void {
  const blob = new Blob([pretty(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `run-${runId.replace(/[^A-Za-z0-9_.-]+/g, '_')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
