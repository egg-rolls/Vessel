/**
 * TUI 视觉主题（0.5.2）
 * @module @vessel/tui
 *
 * 暖中性 + 黄铜强调，与 Web 的 Linen 设计语言一致：
 * 少用高饱和色和大色块，靠层级、留白和细线表达结构。
 *
 * Ink 7 的 `color` prop 接受 hex；chalk 会在不支持 truecolor 的终端上
 * 自动降级到 256/16 色，因此 PowerShell / Windows Terminal 均可安全使用。
 */

export const theme = {
  /** 品牌与主强调（黄铜） */
  brand: '#c2a273',
  /** 输入提示符 */
  prompt: '#c2a273',
  /** 次级文字 */
  muted: '#8a857b',
  /** 三级文字 / 说明 */
  faint: '#6f6a61',
  /** 成功 */
  ok: '#8fa886',
  /** 进行中 / 警告 */
  warn: '#c9a25e',
  /** 失败 / 拒绝 */
  danger: '#d08a7e',
  /** 信息 / 链接 */
  info: '#93a5b3',
  /** 细分隔线 */
  line: '#4a453d',
  /** 选中背景 */
  selectedBg: '#3a352d',
} as const;

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
