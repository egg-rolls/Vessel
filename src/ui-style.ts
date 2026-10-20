/**
 * CLI 暗金样式（0.12 DECISION-023 §2.5）。
 *
 * 只用于一次性命令的**人类可读**输出：标题、分隔线、状态前缀、成功/失败行。
 * `--json`、路径、表格数据行保持纯文本；调用方自己决定哪些片段上色。
 *
 * ANSI 只在同时满足以下条件时输出：
 * - stdout 是 TTY（或调用方显式 `isTTY: true`）；
 * - `NO_COLOR` 未设置（按 no-color.org，任意值含空串都算设置）；
 * - `TERM !== 'dumb'`。
 *
 * @module vessel/ui-style
 */

/** 暗金主色（与 TUI theme 的 brand 一致） */
export const DARK_GOLD = '#c2a273';
/** 暗金强调色：与主色同值，强调靠 `BOLD`（与 TUI 用 `bold + theme.brand` 的做法一致） */
export const DARK_GOLD_BRIGHT = '#c2a273';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

/** 状态前缀类型 */
export type StatusKind = 'ok' | 'warn' | 'err' | 'info';

/** 创建选项（测试注入；正常路径只需默认值） */
export interface UiStyleOptions {
  /** 覆盖 TTY 检测；缺省 `process.stdout.isTTY === true` */
  isTTY?: boolean;
  /** true 强制去色；缺省读 `NO_COLOR` */
  noColor?: boolean;
  env?: Record<string, string | undefined>;
}

export interface UiStyle {
  /** 是否输出 ANSI */
  readonly color: boolean;
  /** 暗金主色 */
  brand(text: string): string;
  /** 暗金亮色 + 粗体（标题） */
  title(text: string): string;
  /** 暗金亮色（分组标题） */
  section(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
  err(text: string): string;
  info(text: string): string;
  dim(text: string): string;
  /** 状态符号 + 颜色：`✓` / `!` / `✗` / `·` */
  symbol(kind: StatusKind): string;
  /** 分隔线（缺省 48 列，暗金色） */
  rule(width?: number): string;
  /** 对齐的 `label  value` 行（label 暗金，value 原样） */
  kv(label: string, value: string, width?: number): string;
}

/** 十六进制色 → ANSI 24-bit 前景色 */
export function truecolor(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return '';
  const value = Number.parseInt(match[1] ?? '', 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** 是否允许 ANSI */
export function shouldUseColor(options: UiStyleOptions = {}): boolean {
  if (options.noColor === true) return false;
  const env = options.env ?? process.env;
  if (Object.hasOwn(env, 'NO_COLOR')) return false;
  if (env.TERM === 'dumb') return false;
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  return isTTY;
}

const SYMBOLS: Record<StatusKind, string> = {
  ok: '✓',
  warn: '!',
  err: '✗',
  info: '·',
};

/** 终端显示宽度（CJK / 全角按 2 列） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 构造样式器；无色时所有方法返回原文（symbol 仍返回符号）。 */
export function createUiStyle(options: UiStyleOptions = {}): UiStyle {
  const color = shouldUseColor(options);
  const gold = truecolor(DARK_GOLD);
  const goldBright = truecolor(DARK_GOLD_BRIGHT);

  const wrap = (prefix: string, text: string): string =>
    color ? `${prefix}${text}${RESET}` : text;

  return {
    color,
    brand: (text) => wrap(gold, text),
    title: (text) => wrap(`${goldBright}${BOLD}`, text),
    section: (text) => wrap(goldBright, text),
    ok: (text) => wrap(GREEN, text),
    warn: (text) => wrap(YELLOW, text),
    err: (text) => wrap(RED, text),
    info: (text) => wrap(CYAN, text),
    dim: (text) => wrap(DIM, text),
    symbol: (kind) =>
      color
        ? `${kind === 'err' ? RED : kind === 'warn' ? YELLOW : kind === 'ok' ? GREEN : CYAN}${SYMBOLS[kind]}${RESET}`
        : SYMBOLS[kind],
    rule: (width = 48) => wrap(gold, '─'.repeat(Math.max(1, width))),
    kv: (label, value, width) => {
      const padded =
        width === undefined ? label : label + ' '.repeat(Math.max(0, width - displayWidth(label)));
      return `${wrap(gold, padded)}  ${value}`;
    },
  };
}

/** 进程级样式器（TUI/REPL 之外的一次性命令共用） */
export const ui: UiStyle = createUiStyle();
