/** 统一状态展示：字形 + 文本 + 颜色（颜色只是增强）。 */
import type { StatusKind } from '../gateway/types';

export interface StatusMeta {
  glyph: string;
  label: string;
  tone: 'muted' | 'info' | 'warn' | 'ok' | 'danger';
}

export const STATUS_META: Record<StatusKind, StatusMeta> = {
  queued: { glyph: '○', label: '排队', tone: 'muted' },
  running: { glyph: '◐', label: '运行中', tone: 'info' },
  waiting: { glyph: '!', label: '等待确认', tone: 'warn' },
  cancelling: { glyph: '◑', label: '取消中', tone: 'warn' },
  interrupted: { glyph: '‖', label: '已中断', tone: 'warn' },
  completed: { glyph: '✓', label: '已完成', tone: 'ok' },
  failed: { glyph: '✗', label: '失败', tone: 'danger' },
  cancelled: { glyph: '–', label: '已取消', tone: 'muted' },
  skipped: { glyph: '·', label: '已跳过', tone: 'muted' },
  pending: { glyph: '·', label: '待执行', tone: 'muted' },
  connected: { glyph: '✓', label: '已连接', tone: 'ok' },
  disconnected: { glyph: '✗', label: '未连接', tone: 'danger' },
  unreachable: { glyph: '!', label: '不可达', tone: 'danger' },
  disabled: { glyph: '–', label: '已停用', tone: 'muted' },
  unavailable: { glyph: '?', label: '不可用', tone: 'muted' },
};

const ALIASES: Record<string, StatusKind> = {
  error: 'failed',
  passed: 'completed',
  pass: 'completed',
  ok: 'completed',
  active: 'running',
  idle: 'pending',
  on: 'connected',
  off: 'disabled',
  open: 'connected',
  closed: 'disabled',
};

const KNOWN = new Set<string>(Object.keys(STATUS_META));

/** 原始状态字符串 → 统一语义；未知值保持原文展示。 */
export function normalizeStatus(raw: string | undefined): StatusKind {
  if (!raw) return 'pending';
  if (KNOWN.has(raw)) return raw as StatusKind;
  return ALIASES[raw] ?? 'pending';
}

export function statusMeta(raw: string | undefined): StatusMeta {
  return STATUS_META[normalizeStatus(raw)];
}

export function statusLabel(raw: string | undefined): string {
  if (!raw) return STATUS_META.pending.label;
  if (KNOWN.has(raw)) return STATUS_META[raw as StatusKind].label;
  return ALIASES[raw] ? STATUS_META[ALIASES[raw]].label : raw;
}

export function StatusChip({
  status,
  label,
  title,
}: {
  status: string | undefined;
  /** 覆盖文本（例如 `queued · 第 2 位`）。字形仍由 status 决定。 */
  label?: string;
  title?: string;
}) {
  const kind = normalizeStatus(status);
  const meta = STATUS_META[kind];
  return (
    <span
      className={`status-chip tone-${meta.tone}`}
      data-status={kind}
      title={title ?? statusLabel(status)}
    >
      <span className="status-glyph" aria-hidden="true">
        {meta.glyph}
      </span>
      <span>{label ?? statusLabel(status)}</span>
    </span>
  );
}
