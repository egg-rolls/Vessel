import { describe, expect, test } from 'bun:test';
import {
  baseNodeDisplayName,
  dedupeDisplayNames,
  matchesNodeQuery,
  nodeDisplayNames,
} from '../src/domains/nodes/display-names';

describe('dedupeDisplayNames', () => {
  test('suffixes later duplicates by list order', () => {
    expect(dedupeDisplayNames(['SoulKiller', 'SoulKiller', 'SoulKiller'])).toEqual([
      'SoulKiller',
      'SoulKiller-1',
      'SoulKiller-2',
    ]);
  });

  test('skips suffixes that are already taken', () => {
    expect(dedupeDisplayNames(['SoulKiller', 'SoulKiller-1', 'SoulKiller'])).toEqual([
      'SoulKiller',
      'SoulKiller-1',
      'SoulKiller-2',
    ]);
  });

  test('leaves unique names untouched and trims whitespace', () => {
    expect(dedupeDisplayNames(['office', ' home ', 'lab'])).toEqual(['office', 'home', 'lab']);
    expect(dedupeDisplayNames(['a', ' a '])).toEqual(['a', 'a-1']);
  });
});

describe('nodeDisplayNames', () => {
  test('health name wins over the provider name and duplicates are deduped', () => {
    const names = nodeDisplayNames([
      { key: 'current', name: 'gateway', url: '', healthName: 'SoulKiller' },
      { key: 'extra', name: 'SoulKiller', url: 'https://extra.example' },
      { key: 'third', name: 'third', url: 'https://third.example', healthName: 'SoulKiller' },
    ]);
    expect([...names.values()]).toEqual(['SoulKiller', 'SoulKiller-1', 'SoulKiller-2']);
  });

  test('falls back to the gateway URL instead of exposing a raw node_id', () => {
    expect(
      baseNodeDisplayName({
        name: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        nodeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        url: 'https://gw.example.com:8642',
      }),
    ).toBe('https://gw.example.com:8642');

    // 没有 URL 的当前节点（同源）使用页面 origin。
    expect(
      baseNodeDisplayName({ name: 'node-1', nodeId: 'node-1', url: '' }, 'http://127.0.0.1:8642'),
    ).toBe('http://127.0.0.1:8642');
  });
});

describe('matchesNodeQuery', () => {
  test('matches display name and node id', () => {
    expect(matchesNodeQuery('SoulKiller', 'node-1', 'SoulKiller', 'soul')).toBe(true);
    expect(matchesNodeQuery('SoulKiller', 'node-1', 'SoulKiller', 'NODE-1')).toBe(true);
    expect(matchesNodeQuery('SoulKiller', 'node-1', 'SoulKiller', '')).toBe(true);
  });

  test('does not match unrelated text', () => {
    expect(matchesNodeQuery('SoulKiller', 'node-1', 'SoulKiller', 'office')).toBe(false);
  });
});
