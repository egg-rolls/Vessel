/**
 * 状态规则（R0 §3）
 * @module @vessel-agent/tui
 *
 * 单行、顶部固定。按宽度分级丢弃低优先级段；颜色不是唯一语义，
 * 进度条与百分比、字形与文本同时表达状态。
 * 0.13：删除 session 计数；路径按预算中间省略 / 空闲溢出时 marquee。
 */

import { Text, useStdout } from 'ink';
import { useEffect, useState } from 'react';
import { t } from '../i18n/index.js';
import {
  fitSegments,
  formatPathLabel,
  MARQUEE_TICK_MS,
  marqueeOffset,
  planStatusPath,
  type StatusPathPlan,
  type StatusSegment,
  type StatusTone,
  toneColor,
} from '../repl/status-format.js';
import { glyph } from '../theme.js';
import { formatDuration, formatModelLabel, formatTokenCount } from '../utils/display-labels.js';
import { displayWidth } from '../utils/text-layout.js';
import { viewWidth } from '../views/layout.js';
import { PanelFrame } from './PanelFrame.js';

export type { StatusSegment, StatusTone } from '../repl/status-format.js';

export type StatusKind = 'idle' | 'thinking' | 'tool' | 'cancelling';

export interface StatusRuleProps {
  status: StatusKind;
  model: string;
  context?: { used: number; max?: number };
  durationMs?: number;
  compactions?: number;
  cwd?: string;
  /** home 目录（将 cwd 前缀折叠为 `~`）；不传则原样展示 */
  home?: string;
  branch?: string;
  /** 由 StatusBar 每帧注入的 marquee 偏移（列）；纯函数测试可省略 */
  marqueeOffset?: number;
}

function statusText(kind: StatusKind): string {
  switch (kind) {
    case 'idle':
      return t('status.idle', { glyph: glyph.idle });
    case 'thinking':
      return t('status.thinking', { glyph: glyph.statusRunning });
    case 'tool':
      return t('status.tool', { glyph: glyph.statusRunning });
    case 'cancelling':
      return t('status.cancelling', { glyph: glyph.running });
  }
}

const STATUS_TONE: Record<StatusKind, StatusTone> = {
  idle: 'faint',
  thinking: 'brand',
  tool: 'brand',
  cancelling: 'warn',
};

/** 纯函数：10 格进度条 */
export function contextBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return glyph.barFilled.repeat(filled) + glyph.barEmpty.repeat(width - filled);
}

/** 纯函数：context 阈值色 */
export function contextTone(percent: number): StatusTone {
  if (percent >= 95) return 'statusCritical';
  if (percent > 80) return 'statusBad';
  if (percent >= 50) return 'statusWarn';
  return 'statusGood';
}

function joinSegments(parts: StatusSegment[]): StatusSegment[] {
  const out: StatusSegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ text: ' │ ', tone: 'faint' });
    const part = parts[i];
    if (part) out.push(part);
  }
  return out;
}

type PartKind = 'model' | 'ctx' | 'bar' | 'pct' | 'duration' | 'cmp' | 'path';

interface Part {
  kind: PartKind;
  segment: StatusSegment;
}

/**
 * 溢出时给路径保留的最小预算（够放 `根…\末两级 · branch` 的常用形态）；
 * 不足则先丢其它低优先级段。
 */
const MIN_PATH_BUDGET = 24;

/** 纯函数：分组（不含分隔符）的显示宽度 */
function partsWidth(parts: Part[]): number {
  return parts.reduce((sum, part) => sum + displayWidth(part.segment.text), 0);
}

/** 纯函数：含 ` │ ` 分隔符的总宽度 */
function joinedWidth(parts: Part[]): number {
  return partsWidth(parts) + Math.max(0, parts.length - 1) * 3;
}

/** 纯函数：把 path 之外的分段建好；path 的预算由调用方按需再算 */
function buildBaseParts(props: StatusRuleProps, width: number): Part[] {
  const parts: Part[] = [];
  const model = formatModelLabel(props.model);
  if (model) parts.push({ kind: 'model', segment: { text: model, tone: 'muted' } });

  if (width >= 60) {
    const used = props.context?.used ?? 0;
    const maxTokens = props.context?.max;
    const percent = maxTokens && maxTokens > 0 ? Math.round((used / maxTokens) * 100) : undefined;
    parts.push({
      kind: 'ctx',
      segment: {
        text:
          maxTokens !== undefined
            ? t('status.ctxWithMax', {
                used: formatTokenCount(used),
                max: formatTokenCount(maxTokens),
              })
            : t('status.ctxTokens', { used: formatTokenCount(used) }),
        tone: 'muted',
      },
    });
    if (percent !== undefined) {
      if (width >= 80) {
        parts.push({
          kind: 'bar',
          segment: { text: `[${contextBar(percent)}]`, tone: contextTone(percent) },
        });
      }
      parts.push({ kind: 'pct', segment: { text: `${percent}%`, tone: contextTone(percent) } });
    }

    if (props.durationMs !== undefined && props.durationMs >= 0) {
      parts.push({
        kind: 'duration',
        segment: { text: formatDuration(props.durationMs), tone: 'muted' },
      });
    }

    if (props.compactions !== undefined && props.compactions > 0) {
      parts.push({
        kind: 'cmp',
        segment: {
          text: t('status.compactions', { count: props.compactions }),
          tone: props.compactions >= 10 ? 'danger' : props.compactions >= 5 ? 'warn' : 'muted',
        },
      });
    }
  }

  return parts;
}

/**
 * 纯函数：路径可用整行预算。
 * 组装行 = `─ ` + 状态 + ` │ ` + parts（path 在末尾，含前置分隔符）。
 */
function pathBudgetOf(parts: Part[], max: number, statusWidth: number): number {
  const prefix = 2 + statusWidth + 3;
  return max - prefix - joinedWidth(parts) - (parts.length > 0 ? 3 : 0);
}

/** 纯函数：包装成最终行（前缀 `─ ` + 状态 + 分隔 + tail） */
function assemble(status: StatusSegment, parts: Part[]): StatusSegment[] {
  if (parts.length === 0) return [{ text: '─ ', tone: 'rule' }, status];
  return [
    { text: '─ ', tone: 'rule' },
    status,
    { text: ' │ ', tone: 'faint' },
    ...joinSegments(parts.map((part) => part.segment)),
  ];
}

/**
 * 纯函数：按终端列数生成状态规则片段。
 *
 * >=100：状态 │ model │ ctx used/max [bar] pct │ 时长 │ cmp │ 路径 · branch
 * 80–99：去路径；60–79：去进度条；24–59：状态 + model；<24：仅状态。
 * 路径预算不足时按 cmp → 进度条 → 时长 丢弃。
 */
export function formatStatusRule(props: StatusRuleProps, columns: number): StatusSegment[] {
  const width = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
  const max = Math.max(1, width - 6);
  const status: StatusSegment = {
    text: statusText(props.status),
    tone: STATUS_TONE[props.status],
  };

  if (width < 24) return fitSegments([status], max);

  const parts = buildBaseParts(props, width);
  const statusWidth = displayWidth(status.text);

  if (width >= 100 && props.cwd) {
    for (const kind of ['cmp', 'bar', 'duration'] as const) {
      if (pathBudgetOf(parts, max, statusWidth) >= MIN_PATH_BUDGET) break;
      const index = parts.findIndex((part) => part.kind === kind);
      if (index >= 0) parts.splice(index, 1);
    }
    const budget = pathBudgetOf(parts, max, statusWidth);
    if (budget > 0) {
      parts.push({
        kind: 'path',
        segment: {
          text: formatPathLabel({
            cwd: props.cwd,
            ...(props.home !== undefined ? { home: props.home } : {}),
            ...(props.branch ? { branch: props.branch } : {}),
            budget,
            idle: props.status === 'idle',
            ...(props.marqueeOffset !== undefined ? { marqueeOffset: props.marqueeOffset } : {}),
          }),
          tone: 'faint',
        },
      });
    }
  }

  return fitSegments(assemble(status, parts), max);
}

/** 纯函数：路径是否需要 marquee（供组件决定是否建计时器） */
export function statusPathPlan(props: StatusRuleProps, columns: number): StatusPathPlan | null {
  const width = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
  if (width < 100 || !props.cwd) return null;
  const max = Math.max(1, width - 6);
  const parts = buildBaseParts(props, width);
  const statusWidth = displayWidth(statusText(props.status));
  for (const kind of ['cmp', 'bar', 'duration'] as const) {
    if (pathBudgetOf(parts, max, statusWidth) >= MIN_PATH_BUDGET) break;
    const index = parts.findIndex((part) => part.kind === kind);
    if (index >= 0) parts.splice(index, 1);
  }
  const budget = pathBudgetOf(parts, max, statusWidth);
  if (budget <= 0) return null;
  return planStatusPath(
    {
      cwd: props.cwd,
      ...(props.home !== undefined ? { home: props.home } : {}),
      ...(props.branch ? { branch: props.branch } : {}),
    },
    budget,
  );
}

export interface StatusBarProps extends StatusRuleProps {
  /** 终端列数；缺省读 stdout（测试 / 嵌入可显式传入） */
  columns?: number;
  /** 独占 overlay / 栏隐藏 / VESSEL_NO_MARQUEE 时不滚动 */
  marqueeAllowed?: boolean;
}

export function StatusBar(props: StatusBarProps) {
  const { stdout } = useStdout();
  const columns = props.columns ?? stdout.columns ?? 80;
  const plan = statusPathPlan(props, columns);
  const marqueeEnabled =
    props.marqueeAllowed !== false &&
    props.status === 'idle' &&
    (plan?.overflow ?? 0) > 0 &&
    process.env.VESSEL_NO_MARQUEE !== '1';

  const [tick, setTick] = useState(0);
  const planText = plan?.text;
  const planBudget = plan?.budget;
  const planOverflow = plan?.overflow;

  // biome-ignore lint/correctness/useExhaustiveDependencies: path/budget changes must reset the marquee window
  useEffect(() => {
    setTick(0);
    if (!marqueeEnabled) return;
    const timer = setInterval(() => setTick((value) => value + 1), MARQUEE_TICK_MS);
    return () => clearInterval(timer);
  }, [marqueeEnabled, planText, planBudget, planOverflow]);

  const offset = marqueeEnabled ? marqueeOffset(tick * MARQUEE_TICK_MS, planOverflow ?? 0) : 0;
  const segments = formatStatusRule(
    { ...props, ...(marqueeEnabled ? { marqueeOffset: offset } : {}) },
    columns,
  );
  let keyOffset = 0;
  const keyed = segments.map((segment) => {
    const key = `${keyOffset}-${segment.tone}`;
    keyOffset += segment.text.length;
    return { segment, key };
  });

  return (
    <PanelFrame width={viewWidth(columns)}>
      <Text wrap="truncate-end">
        {keyed.map(({ segment, key }) => (
          <Text key={key} color={toneColor(segment.tone)}>
            {segment.text}
          </Text>
        ))}
      </Text>
    </PanelFrame>
  );
}
