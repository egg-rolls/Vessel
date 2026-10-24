/** 统一状态展示：字形 + 文本 + 颜色（颜色只是增强）。 */
import { cva } from 'class-variance-authority';
import type { StatusKind } from '../gateway/types';
import { t } from '../i18n';
import { Tooltip } from './Tooltip';
import { cn } from './ui';

export interface StatusMeta {
  glyph: string;
  label: string;
  tone: 'muted' | 'info' | 'warn' | 'ok' | 'danger';
}

const STATUS_LABEL_KEYS: Record<StatusKind, string> = {
  queued: 'status.queued',
  running: 'status.running',
  waiting: 'status.waiting',
  cancelling: 'status.cancelling',
  interrupted: 'status.interrupted',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
  skipped: 'status.skipped',
  pending: 'status.pending',
  connected: 'status.connected',
  disconnected: 'status.disconnected',
  unreachable: 'status.unreachable',
  disabled: 'status.disabled',
  unavailable: 'status.unavailable',
};

/** 字形与语义色不随语言变化；文案由 statusLabel() 从 catalog 读取。 */
export const STATUS_META: Record<StatusKind, Omit<StatusMeta, 'label'>> = {
  queued: { glyph: '○', tone: 'muted' },
  running: { glyph: '◐', tone: 'info' },
  waiting: { glyph: '!', tone: 'warn' },
  cancelling: { glyph: '◑', tone: 'warn' },
  interrupted: { glyph: '‖', tone: 'warn' },
  completed: { glyph: '✓', tone: 'ok' },
  failed: { glyph: '✗', tone: 'danger' },
  cancelled: { glyph: '–', tone: 'muted' },
  skipped: { glyph: '·', tone: 'muted' },
  pending: { glyph: '·', tone: 'muted' },
  connected: { glyph: '✓', tone: 'ok' },
  disconnected: { glyph: '✗', tone: 'danger' },
  unreachable: { glyph: '!', tone: 'danger' },
  disabled: { glyph: '–', tone: 'muted' },
  unavailable: { glyph: '?', tone: 'muted' },
};

const ALIASES: Record<string, StatusKind> = {
  error: 'failed',
  passed: 'completed',
  pass: 'completed',
  ok: 'completed',
  active: 'running',
  waiting_permission: 'waiting',
  idle: 'pending',
  on: 'connected',
  off: 'disabled',
  open: 'connected',
  closed: 'disabled',
};

const KNOWN = new Set<string>(Object.keys(STATUS_META));

const chip = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-xs tracking-wide',
  {
    variants: {
      tone: {
        muted: 'bg-sunken text-faint',
        info: 'bg-info-soft text-info',
        warn: 'bg-warn-soft text-warn',
        ok: 'bg-success-soft text-success',
        danger: 'bg-danger-soft text-danger',
      },
    },
    defaultVariants: { tone: 'muted' },
  },
);

const glyphOnly = cva(
  'inline-flex size-4 flex-none items-center justify-center rounded-full font-mono text-2xs leading-none',
  {
    variants: {
      tone: {
        muted: 'bg-sunken text-faint',
        info: 'bg-info-soft text-info',
        warn: 'bg-warn-soft text-warn',
        ok: 'bg-success-soft text-success',
        danger: 'bg-danger-soft text-danger',
      },
    },
    defaultVariants: { tone: 'muted' },
  },
);

/** 原始状态字符串 → 统一语义；未知值保持原文展示。 */
export function normalizeStatus(raw: string | undefined): StatusKind {
  if (!raw) return 'pending';
  if (KNOWN.has(raw)) return raw as StatusKind;
  return ALIASES[raw] ?? 'pending';
}

export function statusMeta(raw: string | undefined): StatusMeta {
  return { ...STATUS_META[normalizeStatus(raw)], label: statusLabel(raw) };
}

export function statusLabel(raw: string | undefined): string {
  if (!raw) return t(STATUS_LABEL_KEYS.pending);
  if (KNOWN.has(raw)) return t(STATUS_LABEL_KEYS[raw as StatusKind]);
  return ALIASES[raw] ? t(STATUS_LABEL_KEYS[ALIASES[raw]]) : raw;
}

/**
 * Icon-only 状态胶囊：只保留字形与语义色。
 * `completed` 默认不渲染（列表里大量已完成会话会把噪音放大）。
 */
export function StatusGlyph({
  status,
  showCompleted = false,
  label,
}: {
  status: string | undefined;
  /** 为 true 时也渲染 completed。 */
  showCompleted?: boolean;
  /** 覆盖 aria-label / title；默认用状态文案。 */
  label?: string;
}) {
  const kind = normalizeStatus(status);
  if (kind === 'completed' && !showCompleted) return null;
  const meta = STATUS_META[kind];
  const text = label ?? statusLabel(status);
  return (
    <Tooltip label={text}>
      <span
        className={cn(glyphOnly({ tone: meta.tone }), kind === 'running' && 'pulse-soft')}
        data-status={kind}
        role="img"
        aria-label={text}
      >
        {meta.glyph}
      </span>
    </Tooltip>
  );
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
  const text = label ?? statusLabel(status);
  return (
    <Tooltip label={title ?? statusLabel(status)}>
      <span className={chip({ tone: meta.tone })} data-status={kind}>
        <span className={cn('text-2xs', kind === 'running' && 'pulse-soft')} aria-hidden="true">
          {meta.glyph}
        </span>
        <span>{text}</span>
      </span>
    </Tooltip>
  );
}
