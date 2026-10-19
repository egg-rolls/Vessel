/**
 * TUI 视觉主题（0.5.2 / 0.5.3）
 * @module @vessel/tui
 *
 * 暖中性 + 黄铜强调，与 Web 的 Linen 设计语言一致：
 * 少用高饱和色和大色块，靠层级、留白和细线表达结构。
 *
 * Ink 7 的 `color` prop 接受 hex；chalk 会在不支持 truecolor 的终端上
 * 自动降级到 256/16 色。但 hex→16 色的最近色映射不可控，低亮度 token
 * （faint / line）可能被映射到接近黑色。0.5.3 起按颜色等级显式回退：
 * level 0 全部不着色，level 1 用命名 ANSI 色，level 2/3 保留 hex。
 */

export type ColorLevel = 0 | 1 | 2 | 3;

export interface Theme {
  /** 品牌与主强调（黄铜） */
  brand: string | undefined;
  /** 输入提示符 */
  prompt: string | undefined;
  /** 次级文字 */
  muted: string | undefined;
  /** 三级文字 / 说明 */
  faint: string | undefined;
  /** 成功 */
  ok: string | undefined;
  /** 进行中 / 警告 */
  warn: string | undefined;
  /** 失败 / 拒绝 */
  danger: string | undefined;
  /** 信息 / 链接 */
  info: string | undefined;
  /** 细分隔线 */
  line: string | undefined;
  /** 选中背景（也用作彩色背景上的前景，保证对比度） */
  selectedBg: string | undefined;
}

const TRUECOLOR_THEME: Theme = {
  brand: '#c2a273',
  prompt: '#c2a273',
  muted: '#8a857b',
  faint: '#6f6a61',
  ok: '#8fa886',
  warn: '#c9a25e',
  danger: '#d08a7e',
  info: '#93a5b3',
  line: '#4a453d',
  selectedBg: '#3a352d',
};

/** 16 色终端：只用命名 ANSI 色，避免 hex 映射到不可见黑 */
const ANSI16_THEME: Theme = {
  brand: 'yellowBright',
  prompt: 'yellowBright',
  muted: 'white',
  faint: 'gray',
  ok: 'greenBright',
  warn: 'yellowBright',
  danger: 'redBright',
  info: 'cyanBright',
  line: 'gray',
  selectedBg: 'black',
};

/** 无色终端：颜色全部关闭，依靠字形与文本标记区分状态 */
const NO_COLOR_THEME: Theme = {
  brand: undefined,
  prompt: undefined,
  muted: undefined,
  faint: undefined,
  ok: undefined,
  warn: undefined,
  danger: undefined,
  info: undefined,
  line: undefined,
  selectedBg: undefined,
};

/**
 * 检测颜色等级（与 chalk 的主要规则保持一致，但不新增依赖）：
 * - NO_COLOR / FORCE_COLOR=0 / TERM=dumb -> 0
 * - COLORTERM=truecolor|24bit -> 3
 * - TERM=*256color* 或 Windows Terminal（WT_SESSION）-> 2
 * - 其它 -> 1
 */
export function detectColorLevel(env: NodeJS.ProcessEnv = process.env): ColorLevel {
  const force = env.FORCE_COLOR;
  if (force === '0') return 0;
  if (env.NO_COLOR !== undefined && force === undefined) return 0;
  if (env.TERM === 'dumb') return 0;

  const colorTerm = (env.COLORTERM ?? '').toLowerCase();
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) return 3;

  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('truecolor') || term.includes('24bit')) return 3;
  if (force === '3') return 3;
  if (force === '2') return 2;
  if (force === '1') return 1;
  if (term.includes('256color') || env.WT_SESSION !== undefined) return 2;
  return 1;
}

export function createTheme(level: ColorLevel): Theme {
  if (level === 0) return NO_COLOR_THEME;
  if (level === 1) return ANSI16_THEME;
  return TRUECOLOR_THEME;
}

export const theme: Theme = createTheme(detectColorLevel());

/** 提示符号（避免 emoji 在不同终端宽度不一致） */
export const glyph = {
  bullet: '·',
  pointer: '›',
  done: '✓',
  fail: '✗',
  running: '◐',
  idle: '○',
  rule: '─',
} as const;
