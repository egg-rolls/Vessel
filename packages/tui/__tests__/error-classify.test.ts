import { describe, expect, it } from 'bun:test';
import { classifyError } from '../src/error-classifier.js';

describe('classifyError', () => {
  it('分类网络错误', () => {
    const c = classifyError(new Error('fetch failed: ENOTFOUND api.openai.com'));
    expect(c.category).toBe('network');
    expect(c.hint).toBeTruthy();
  });

  it('分类鉴权错误（401）', () => {
    const c = classifyError(new Error('OpenAI API error: 401 - Unauthorized'));
    expect(c.category).toBe('auth');
  });

  it('分类限流（429）', () => {
    const c = classifyError(new Error('OpenAI API error: 429 - Rate limit exceeded'));
    expect(c.category).toBe('quota');
  });

  it('分类用量限额（Usage limits exceeded）', () => {
    const c = classifyError(new Error('Usage limits exceeded'));
    expect(c.category).toBe('quota');
  });

  it('分类终止策略', () => {
    const c = classifyError(new Error('Termination policy triggered: max iterations'));
    expect(c.category).toBe('quota');
  });

  it('分类 API 错误（500）', () => {
    const c = classifyError(new Error('OpenAI API error: 500 - Internal Server Error'));
    expect(c.category).toBe('api');
  });

  it('分类未知错误', () => {
    const c = classifyError(new Error('something weird'));
    expect(c.category).toBe('unknown');
    expect(c.hint).toBeUndefined();
  });

  it('非 Error 对象也能处理', () => {
    const c = classifyError('plain string error');
    expect(c.category).toBe('unknown');
    expect(c.message).toBe('plain string error');
  });
});
