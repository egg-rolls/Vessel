/**
 * 状态行 / 启动头共用的显示标签——纯函数
 * @module @vessel/tui
 */

import { displayWidth } from './text-layout.js';

/** 去掉 provider 前缀与 claude/anthropic 前缀；`_` 转空格；`3 5` -> `3.5` */
export function formatModelLabel(model: string): string {
  if (!model) return '';
  let label = model;
  const slash = label.lastIndexOf('/');
  if (slash >= 0) label = label.slice(slash + 1);
  label = label.replace(/^(?:claude|anthropic)[-_ ]+/i, '');
  label = label.replace(/_/g, ' ');
  label = label.replace(/\b(\d+)\s+(\d+)\b/g, '$1.$2');
  return label.trim();
}

/** 会话 ID 只保留前 `head` 位；短 ID 原样返回 */
export function shortSessionId(id: string, head = 4): string {
  if (!id) return '';
  return id.length <= head + 4 ? id : `${id.slice(0, head)}…`;
}

/** token 数：12.4K / 64K；<1000 原样 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  const k = value / 1000;
  if (k >= 100) return `${Math.round(k)}K`;
  return `${Number(k.toFixed(1))}K`;
}

/** 时长：42s / 1m42s / 1h 04m */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m${String(totalSeconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** cwd 摘要：home 替换为 `~`；超宽时保留末两级 */
export function formatCwd(cwd: string, home?: string, maxWidth = 40): string {
  if (!cwd) return '';
  let label = cwd;
  if (home && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
    label = `~${cwd.slice(home.length)}`;
  }
  if (displayWidth(label) <= maxWidth) return label;
  const parts = label.split(/[\\/]+/).filter(Boolean);
  const tail = parts.slice(-2).join('/');
  return tail ? `…/${tail}` : label;
}
