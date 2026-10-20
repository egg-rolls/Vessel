/**
 * TUI 视觉主题（0.5.2 / 0.5.3）
 * @module @vessel-agent/tui
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
  /** 选中背景（只作背景，不用于文字） */
  selectedBg: string | undefined;
  /** 彩色选中底上的前景（亮底用深色墨，保证对比度） */
  selectedInk: string | undefined;
  /** 状态规则 / 分节线 */
  rule: string | undefined;
  /** badge、选中强调 */
  badge: string | undefined;
  /** 面板边框 */
  panel: string | undefined;
  /** context 用量阈值色（颜色不是唯一语义） */
  statusGood: string | undefined;
  statusWarn: string | undefined;
  statusBad: string | undefined;
  statusCritical: string | undefined;
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
  selectedInk: '#1c1a17',
  rule: '#4a453d',
  badge: '#c2a273',
  panel: '#4a453d',
  statusGood: '#6fa86f',
  statusWarn: '#d8a23a',
  statusBad: '#d08a3a',
  statusCritical: '#c85a4a',
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
  selectedInk: 'black',
  rule: 'gray',
  badge: 'yellowBright',
  panel: 'gray',
  statusGood: 'green',
  statusWarn: 'yellow',
  statusBad: 'yellowBright',
  statusCritical: 'red',
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
  selectedInk: undefined,
  rule: undefined,
  badge: undefined,
  panel: undefined,
  statusGood: undefined,
  statusWarn: undefined,
  statusBad: undefined,
  statusCritical: undefined,
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
  statusRunning: '●',
  treeMid: '├─',
  treeLast: '└─',
  treePipe: '│',
  expanded: '▾',
  collapsed: '▸',
  barFilled: '█',
  barEmpty: '░',
} as const;
