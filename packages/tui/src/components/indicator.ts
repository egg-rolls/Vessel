/**
 * 指示器风格与帧——纯函数（R0 §4.1）
 * @module @vessel-agent/tui
 */

export type IndicatorStyle = 'unicode' | 'ascii' | 'emoji' | 'kaomoji';

const FRAMES: Record<IndicatorStyle, readonly string[]> = {
  unicode: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  ascii: ['|', '/', '-', '\\'],
  emoji: ['⚙', '🌀', '🤔', '✨', '🍵', '🔮'],
  kaomoji: ['(・_・)', '(￣▽￣)', '(¬_¬)', '(•‿•)', '(°ロ°)', '(,,>﹏<,,)'],
};

const INTERVALS: Record<IndicatorStyle, number> = {
  unicode: 80,
  ascii: 100,
  emoji: 600,
  kaomoji: 2500,
};

export const THINKING_VERBS = [
  'thinking',
  'reading',
  'editing',
  'running',
  'planning',
  'checking',
] as const;

export const THINKING_VERB_INTERVAL_MS = 2500;

/** 无效值回退 unicode；空值同 */
export function resolveIndicatorStyle(value: string | undefined): IndicatorStyle {
  if (value === 'ascii' || value === 'emoji' || value === 'kaomoji' || value === 'unicode') {
    return value;
  }
  return 'unicode';
}

export function indicatorFrames(style: IndicatorStyle): readonly string[] {
  return FRAMES[style];
}

/** 帧永远非空：tick 异常时回退第一帧 */
export function indicatorFrame(style: IndicatorStyle, tick: number): string {
  const frames = FRAMES[style];
  if (!Number.isFinite(tick) || tick < 0) return frames[0] ?? '';
  return frames[Math.floor(tick) % frames.length] ?? frames[0] ?? '';
}

export function indicatorInterval(style: IndicatorStyle): number {
  return INTERVALS[style];
}

/** 思考动词按 2500ms 轮换 */
export function thinkingVerb(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return THINKING_VERBS[0];
  const index = Math.floor(elapsedMs / THINKING_VERB_INTERVAL_MS) % THINKING_VERBS.length;
  return THINKING_VERBS[index] ?? THINKING_VERBS[0];
}
