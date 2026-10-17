/**
 * 时间格式化纯函数（SessionTable / /runs 共用）
 * @module @vessel/tui
 */

/** 相对时间格式化（如 "2h ago", "3d ago"）；`now` 可注入以便测试 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const date = new Date(ts);
  return date.toLocaleDateString();
}
