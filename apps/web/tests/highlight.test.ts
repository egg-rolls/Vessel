import { describe, expect, test } from 'bun:test';
import { highlightSegments } from '../src/domains/chat/highlight';

describe('highlightSegments', () => {
  test('does not treat regex metacharacters in the query as syntax', () => {
    expect(highlightSegments('retry (provider) client', '(')).toEqual([
      { text: 'retry ', match: false, start: 0 },
      { text: '(', match: true, start: 6 },
      { text: 'provider) client', match: false, start: 7 },
    ]);
  });

  test('highlights case-insensitively without changing the original text', () => {
    expect(highlightSegments('Retry the provider', 'retry')).toEqual([
      { text: 'Retry', match: true, start: 0 },
      { text: ' the provider', match: false, start: 5 },
    ]);
    expect(highlightSegments('Retry the provider', 'PROVIDER')).toEqual([
      { text: 'Retry the ', match: false, start: 0 },
      { text: 'provider', match: true, start: 10 },
    ]);
  });

  test('returns the whole string when the query is empty', () => {
    expect(highlightSegments('abc', '  ')).toEqual([{ text: 'abc', match: false, start: 0 }]);
  });
});
