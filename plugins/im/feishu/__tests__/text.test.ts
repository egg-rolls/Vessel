import { describe, expect, it } from 'bun:test';
import { extractText, TRUNCATED_SUFFIX, truncateReply } from '../src/text.js';

describe('extractText', () => {
  it('extracts text from text messages', () => {
    expect(extractText('text', JSON.stringify({ text: 'hello' }))).toBe('hello');
  });

  it('ignores non-text messages', () => {
    expect(extractText('image', JSON.stringify({ image_key: 'x' }))).toBeNull();
  });

  it('ignores malformed content', () => {
    expect(extractText('text', '{oops')).toBeNull();
    expect(extractText('text', JSON.stringify({ image_key: 'x' }))).toBeNull();
  });
});

describe('truncateReply', () => {
  it('leaves short replies unchanged', () => {
    expect(truncateReply('hello', 10)).toBe('hello');
  });

  it('keeps the final length within the limit including the suffix', () => {
    const result = truncateReply('x'.repeat(100), 50);
    expect(result.length).toBe(50);
    expect(result.endsWith(TRUNCATED_SUFFIX)).toBe(true);
  });

  it('returns only the suffix prefix when the limit is tiny', () => {
    const result = truncateReply('x'.repeat(100), 5);
    expect(result).toBe(TRUNCATED_SUFFIX.slice(0, 5));
    expect(result.length).toBe(5);
  });
});
