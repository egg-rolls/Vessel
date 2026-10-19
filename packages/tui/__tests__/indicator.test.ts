import { describe, expect, it } from 'bun:test';
import {
  indicatorFrame,
  indicatorFrames,
  indicatorInterval,
  resolveIndicatorStyle,
  THINKING_VERB_INTERVAL_MS,
  THINKING_VERBS,
  thinkingVerb,
} from '../src/components/indicator.js';

describe('indicator', () => {
  it('无效 VESSEL_INDICATOR 回退 unicode 而不是空帧', () => {
    const style = resolveIndicatorStyle('nope');

    expect(style).toBe('unicode');
    expect(indicatorFrame(style, 0)).toBe('⠋');
    expect(indicatorFrame(style, 0)).not.toBe('');
  });

  it('所有风格的帧永不为空，tick 循环', () => {
    for (const style of ['unicode', 'ascii', 'emoji', 'kaomoji'] as const) {
      const frames = indicatorFrames(style);
      expect(frames.length).toBeGreaterThan(0);
      expect(indicatorInterval(style)).toBeGreaterThan(0);
      for (const tick of [0, 1, frames.length, frames.length + 1, -1, Number.NaN]) {
        expect(indicatorFrame(style, tick)).not.toBe('');
      }
    }
  });

  it('思考动词按 2500ms 轮换且永不为空', () => {
    expect(thinkingVerb(0)).toBe(THINKING_VERBS[0]);
    expect(thinkingVerb(THINKING_VERB_INTERVAL_MS)).toBe(THINKING_VERBS[1]);
    expect(thinkingVerb(THINKING_VERB_INTERVAL_MS * THINKING_VERBS.length)).toBe(THINKING_VERBS[0]);
    expect(thinkingVerb(Number.NaN)).toBe(THINKING_VERBS[0]);
  });
});
