/**
 * 状态栏纯函数层（0.13）：上栏路径 / 下栏分段 / 显隐与热键。
 * @module @vessel-agent/tui
 *
 * 所有宽度一律按终端显示列（`displayWidth`）计算；CJK / emoji 不得用 `.slice`。
 * 本模块不依赖 Ink，便于单测。
 */

import { t } from '../i18n/index.js';
import { theme } from '../theme.js';
import { shortSessionId } from '../utils/display-labels.js';
import { displayWidth, truncateToWidth } from '../utils/text-layout.js';

export type StatusTone =
  | 'rule'
  | 'brand'
  | 'muted'
  | 'faint'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'info'
  | 'statusGood'
  | 'statusWarn'
  | 'statusBad'
  | 'statusCritical'
  | 'plain';

export interface StatusSegment {
  text: string;
  tone: StatusTone;
}

/** 片段色调 → 终端颜色；`plain` 不指定颜色 */
export function toneColor(tone: StatusTone): string | undefined {
  switch (tone) {
    case 'rule':
      return theme.rule;
    case 'brand':
      return theme.brand;
    case 'muted':
      return theme.muted;
    case 'faint':
      return theme.faint;
    case 'ok':
      return theme.ok;
    case 'warn':
      return theme.warn;
    case 'danger':
      return theme.danger;
    case 'info':
      return theme.info;
    case 'statusGood':
      return theme.statusGood;
    case 'statusWarn':
      return theme.statusWarn;
    case 'statusBad':
      return theme.statusBad;
    case 'statusCritical':
      return theme.statusCritical;
    case 'plain':
      return undefined;
  }
}

/** 按显示宽度截断片段数组；保证总宽 <= max */
export function fitSegments(segments: StatusSegment[], max: number): StatusSegment[] {
  const out: StatusSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    const width = displayWidth(segment.text);
    if (used + width <= max) {
      out.push(segment);
      used += width;
      continue;
    }
    const budget = max - used;
    if (budget > 0) out.push({ text: truncateToWidth(segment.text, budget), tone: segment.tone });
    break;
  }
  return out;
}

// ── 上下栏显隐：配置 / 环境 / 热键 ─────────────────────

export type StatusBarsValue = 'top' | 'bottom' | 'both' | 'none';

export interface StatusBarsVisibility {
  top: boolean;
  bottom: boolean;
}

/** 纯函数：显隐 → YAML 值 */
export function statusBarsValue(top: boolean, bottom: boolean): StatusBarsValue {
  if (top && bottom) return 'both';
  if (top) return 'top';
  if (bottom) return 'bottom';
  return 'none';
}

/** 纯函数：YAML 值 → 显隐 */
export function statusBarsVisibility(value: StatusBarsValue): StatusBarsVisibility {
  return {
    top: value === 'top' || value === 'both',
    bottom: value === 'bottom' || value === 'both',
  };
}

/**
 * 纯函数：解析 `ui.statusBars` / `VESSEL_STATUS_BARS`。
 * 接受 `top,bottom`（兼容写法）与 `top|bottom|both|none`；非法值返回 undefined。
 */
export function parseStatusBars(value: unknown): StatusBarsValue | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'top,bottom' || normalized === 'bottom,top') return 'both';
  if (
    normalized === 'top' ||
    normalized === 'bottom' ||
    normalized === 'both' ||
    normalized === 'none'
  ) {
    return normalized;
  }
  return undefined;
}

export interface InitialStatusBars {
  value: StatusBarsValue | undefined;
  source: 'env' | 'config' | 'none';
}

/** 纯函数：初始显隐来源 env > config > 默认（调用方决定自动规则） */
export function resolveInitialStatusBars(options: {
  env?: unknown;
  config?: unknown;
}): InitialStatusBars {
  const fromEnv = parseStatusBars(options.env);
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' };
  const fromConfig = parseStatusBars(options.config);
  if (fromConfig !== undefined) return { value: fromConfig, source: 'config' };
  return { value: undefined, source: 'none' };
}

export type StatusBarHotkey = 'toggleTop' | 'toggleBottom' | 'openSessions';

/** 纯函数：Ctrl+T/G/R（输入字符为控制码） */
export function matchStatusBarHotkey(
  inputChar: string,
  key: { ctrl?: boolean },
): StatusBarHotkey | null {
  if (!key.ctrl) return null;
  if (inputChar === 't') return 'toggleTop';
  if (inputChar === 'g') return 'toggleBottom';
  if (inputChar === 'r') return 'openSessions';
  return null;
}

export interface StatusBarToggleResult {
  visibility: StatusBarsVisibility;
  value: StatusBarsValue;
  /** ink-text-input 会把 Ctrl 字符插入输入框：调用方必须 setInput(ui.input)+bumpCaret */
  resetInput: true;
}

/** 纯函数：切换上/下栏；返回新显隐与应写回的 YAML 值 */
export function applyStatusBarToggle(
  current: StatusBarsVisibility,
  which: 'top' | 'bottom',
): StatusBarToggleResult {
  const visibility: StatusBarsVisibility =
    which === 'top' ? { ...current, top: !current.top } : { ...current, bottom: !current.bottom };
  return {
    visibility,
    value: statusBarsValue(visibility.top, visibility.bottom),
    resetInput: true,
  };
}

// ── 路径：完整 / 中间省略 / marquee ────────────────────

/** marquee 每格步进 */
export const MARQUEE_TICK_MS = 140;
/** marquee 首尾停留 */
export const MARQUEE_PAUSE_MS = 1200;
/** branch 自身超过 24 格才尾部截断 */
const BRANCH_MAX_WIDTH = 24;

/** 纯函数：home 前缀折叠为 `~`（不截断） */
export function expandHomePath(cwd: string, home?: string): string {
  if (!cwd) return '';
  if (home && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/**
 * 纯函数：中间省略，保留根（`D:\` / `/` / `~/`）+ 末两级目录，中间单格 `…`。
 * 结果宽度恒 <= maxWidth；放不下末两级时退到末一级，再不行按尾部截断。
 */
export function middleEllipsisPath(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (!path) return '';
  if (displayWidth(path) <= maxWidth) return path;

  const sep = path.includes('\\') ? '\\' : '/';
  let root = '';
  let rest = path;
  const drive = /^[A-Za-z]:[\\/]/.exec(path);
  if (drive) {
    root = drive[0];
    rest = path.slice(root.length);
  } else if (path.startsWith('~/')) {
    root = `~${sep}`;
    rest = path.slice(2);
  } else if (path.startsWith('/')) {
    root = '/';
    rest = path.slice(1);
  } else if (path.startsWith('~')) {
    root = '~';
    rest = path.slice(1).replace(/^[\\/]/, '');
  }

  const parts = rest.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return truncateToWidth(path, maxWidth);

  // 根与省略号之间补分隔符：`D:\…\`、`/…/`、`~/…/`、`…/`。
  const prefix = `${root}${root && !root.endsWith(sep) ? sep : ''}…${sep}`;
  const candidates: string[] = [];
  if (parts.length >= 2) candidates.push(`${prefix}${parts.slice(-2).join(sep)}`);
  candidates.push(`${prefix}${parts.at(-1) ?? ''}`);

  for (const candidate of candidates) {
    if (displayWidth(candidate) <= maxWidth) return candidate;
  }
  return truncateToWidth(candidates[0] ?? path, maxWidth);
}

/**
 * 纯函数：在按显示列切出的窗口里展示文本；被裁掉的一侧补 `…`。
 * 宽字符跨窗口边界时整字跳过（宁可少一格，不打印半个字）。
 */
export function marqueeWindow(text: string, budget: number, offset: number): string {
  if (budget <= 0) return '';
  const total = displayWidth(text);
  if (total <= budget) return text;

  const maxOffset = total - budget;
  const skip = Math.max(0, Math.min(maxOffset, Math.floor(offset)));
  const left = skip > 0;
  const right = skip < maxOffset;
  const innerBudget = Math.max(0, budget - (left ? 1 : 0) - (right ? 1 : 0));
  if (innerBudget === 0) return `${left ? '…' : ''}${right ? '…' : ''}`.slice(0, budget);

  let position = 0;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const width = displayWidth(ch);
    const start = position;
    const end = position + width;
    position = end;
    if (end <= skip) continue;
    if (start < skip) continue; // 跨左边界：跳过整个宽字符
    if (used + width > innerBudget) break;
    out += ch;
    used += width;
  }
  return `${left ? '…' : ''}${out}${right ? '…' : ''}`;
}

export interface MarqueeTiming {
  tickMs?: number;
  pauseMs?: number;
}

/**
 * 纯函数：marquee 偏移（列）。1 格 / tickMs，首尾各停 pauseMs，往返循环。
 * overflow <= 0 恒为 0。
 */
export function marqueeOffset(
  elapsedMs: number,
  overflow: number,
  timing: MarqueeTiming = {},
): number {
  const tick = Math.max(1, timing.tickMs ?? MARQUEE_TICK_MS);
  const pause = Math.max(0, timing.pauseMs ?? MARQUEE_PAUSE_MS);
  const max = Math.max(0, Math.floor(Number.isFinite(overflow) ? overflow : 0));
  if (max === 0) return 0;

  const travel = max * tick;
  const cycle = 2 * (pause + travel);
  let elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) % cycle;

  if (elapsed < pause) return 0;
  elapsed -= pause;
  if (elapsed < travel) return Math.min(max, Math.floor(elapsed / tick));
  elapsed -= travel;
  if (elapsed < pause) return max;
  elapsed -= pause;
  return Math.max(0, max - Math.floor(elapsed / tick));
}

export interface PathLabelOptions {
  cwd: string;
  home?: string;
  branch?: string;
  /** 整行可用显示宽度（含 branch） */
  budget: number;
  /** idle 才允许滚动 */
  idle?: boolean;
  /** 未提供时用中间省略静态形态 */
  marqueeOffset?: number;
}

/**
 * 纯函数：`路径 · branch` 按预算格式化。
 *
 * 1. 完整放下 → 原样；
 * 2. 放不下 → 路径中间省略，branch 固定最右（自身超 24 格尾部截断）；
 * 3. idle 且路径自身溢出 → marquee 窗口。
 */
export function formatPathLabel(options: PathLabelOptions): string {
  const budget = Math.max(0, Math.floor(options.budget));
  if (budget <= 0) return '';

  const path = expandHomePath(options.cwd, options.home);
  const branch = options.branch?.trim() || undefined;
  const full = branch ? `${path} · ${branch}` : path;
  if (displayWidth(full) <= budget) return full;

  const branchTail =
    branch === undefined
      ? undefined
      : displayWidth(branch) > BRANCH_MAX_WIDTH
        ? truncateToWidth(branch, BRANCH_MAX_WIDTH)
        : branch;
  const reserve = branchTail === undefined ? 0 : displayWidth(' · ') + displayWidth(branchTail);
  const pathBudget = budget - reserve;

  if (pathBudget <= 0) return truncateToWidth(branchTail ?? path, budget);

  const pathLabel =
    options.idle && options.marqueeOffset !== undefined && displayWidth(path) > pathBudget
      ? marqueeWindow(path, pathBudget, options.marqueeOffset)
      : middleEllipsisPath(path, pathBudget);

  const label = branchTail === undefined ? pathLabel : `${pathLabel} · ${branchTail}`;
  return displayWidth(label) <= budget ? label : truncateToWidth(label, budget);
}

export interface StatusPathPlan {
  /** home 折叠后的完整路径 */
  text: string;
  /** 路径可用预算（已扣除 branch） */
  budget: number;
  /** 路径自身超出的列数；0 = 不滚动 */
  overflow: number;
}

/** 纯函数：给 StatusBar 判断是否需要 marquee */
export function planStatusPath(
  options: { cwd?: string; home?: string; branch?: string },
  budget: number,
): StatusPathPlan | null {
  if (!options.cwd) return null;
  const path = expandHomePath(options.cwd, options.home);
  const branch = options.branch?.trim() || undefined;
  const branchTail =
    branch === undefined
      ? undefined
      : displayWidth(branch) > BRANCH_MAX_WIDTH
        ? truncateToWidth(branch, BRANCH_MAX_WIDTH)
        : branch;
  const reserve = branchTail === undefined ? 0 : displayWidth(' · ') + displayWidth(branchTail);
  const pathBudget = Math.max(0, budget - reserve);
  return {
    text: path,
    budget: pathBudget,
    overflow: Math.max(0, displayWidth(path) - pathBudget),
  };
}

// ── 下栏 ────────────────────────────────────────────

export interface BottomBarData {
  /** 启动配置 + 本次会话 "always" 实际生效数（不含 ask_user） */
  autoApproveCount: number;
  /** 权限弹窗等待中的工具名 */
  waitingTool?: string;
  bashCount: number;
  subagentCount: number;
  currentSessionId?: string;
  tenantId?: string;
  queuedCount: number;
  /** 队列预览已展示时下栏不再重复 `queue N` */
  queuePreviewVisible?: boolean;
}

type BottomField = 'perm' | 'bash' | 'sub' | 'session' | 'tenant' | 'queue';

interface BottomPart {
  field: BottomField;
  segment: StatusSegment;
}

function joinBottom(parts: BottomPart[]): StatusSegment[] {
  const out: StatusSegment[] = [];
  for (let index = 0; index < parts.length; index++) {
    if (index > 0) out.push({ text: ' │ ', tone: 'faint' });
    const part = parts[index];
    if (part) out.push(part.segment);
  }
  return out;
}

function bottomWidth(parts: BottomPart[]): number {
  const content = parts.reduce((sum, part) => sum + displayWidth(part.segment.text), 0);
  return content + Math.max(0, parts.length - 1) * displayWidth(' │ ');
}

/**
 * 纯函数：下栏单行分段。
 *
 * 宽度分级：<40 整栏不渲染；40–59 perm+bash+sub；60–79 +session；
 * 80–99 同 60；>=100 +tenant/queue。
 * 空间不足时从右到左丢弃：tenant → queue → session → sub → auto；perm/bash 不丢。
 */
export function formatBottomBar(data: BottomBarData, columns: number): StatusSegment[] {
  const width = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
  if (width < 40) return [];
  // PanelFrame 外宽 = cols - 2，内容宽再减左右边框与 padding 各 1。
  const max = Math.max(1, width - 6);

  const parts: BottomPart[] = [];
  const waiting = data.waitingTool?.trim();
  if (waiting) {
    parts.push({
      field: 'perm',
      segment: { text: t('status.permWaiting', { tool: waiting }), tone: 'statusWarn' },
    });
  } else {
    const auto =
      data.autoApproveCount > 0
        ? ` · ${t('status.permAuto', { count: Math.floor(data.autoApproveCount) })}`
        : '';
    parts.push({
      field: 'perm',
      segment: { text: `${t('status.permAsk')}${auto}`, tone: 'muted' },
    });
  }

  if (data.bashCount > 0) {
    parts.push({
      field: 'bash',
      segment: { text: t('status.bash', { count: Math.floor(data.bashCount) }), tone: 'brand' },
    });
  }

  if (width >= 40 && data.subagentCount > 0) {
    parts.push({
      field: 'sub',
      segment: {
        text: t('status.subagents', { count: Math.floor(data.subagentCount) }),
        tone: 'brand',
      },
    });
  }

  if (width >= 60) {
    const id = data.currentSessionId ? shortSessionId(data.currentSessionId) : '';
    if (id) {
      parts.push({
        field: 'session',
        segment: { text: t('status.sessionEntry', { id }), tone: 'faint' },
      });
    }
  }

  if (width >= 100 && data.tenantId && data.tenantId !== 'default') {
    parts.push({
      field: 'tenant',
      segment: { text: t('status.tenant', { id: data.tenantId }), tone: 'faint' },
    });
  }

  if (width >= 100 && data.queuedCount > 0 && !data.queuePreviewVisible) {
    parts.push({
      field: 'queue',
      segment: {
        text: t('status.queued', { count: Math.floor(data.queuedCount) }),
        tone: 'statusWarn',
      },
    });
  }

  // 固定丢弃顺序（从右到左）。
  for (const field of ['tenant', 'queue', 'session', 'sub'] as const) {
    if (bottomWidth(parts) <= max) break;
    const index = parts.findIndex((part) => part.field === field);
    if (index >= 0) parts.splice(index, 1);
  }

  // 仍超宽：去掉 auto 计数，最后才截断 perm/bash 文本。
  if (bottomWidth(parts) > max && !waiting) {
    const perm = parts.find((part) => part.field === 'perm');
    if (perm) perm.segment = { text: t('status.permAsk'), tone: 'muted' };
  }

  const segments = joinBottom(parts);
  return fitSegments(segments, max);
}
