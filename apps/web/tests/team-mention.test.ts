import { describe, expect, test } from 'bun:test';
import {
  detectMention,
  exceedsMessageLimit,
  insertMention,
  mentionCandidates,
  mentionIds,
  utf8ByteLength,
} from '../src/domains/team/mention';
import type { TeamMember } from '../src/gateway/types';

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    agent_id: 'agent-aaaa1111',
    name: 'Alice',
    membership: 'present',
    presence: 'live',
    visibility: 'team',
    state: 'idle',
    ...overrides,
  };
}

const roster: TeamMember[] = [
  member({ agent_id: 'agent-aaaa1111', name: 'Alice' }),
  member({ agent_id: 'agent-bbbb2222', name: 'Alice' }),
  member({ agent_id: 'agent-cccc3333', name: undefined }),
  member({ agent_id: 'agent-dddd4444', name: 'Bob', membership: 'left' }),
  member({ agent_id: 'agent-eeee5555', name: 'Carol', presence: 'gone' }),
];

describe('detectMention', () => {
  test('triggers at line start or after whitespace', () => {
    expect(detectMention('@a', 2)).toEqual({ start: 0, query: 'a' });
    expect(detectMention('hello @al', 9)).toEqual({ start: 6, query: 'al' });
    expect(detectMention('line\n@a', 7)).toEqual({ start: 5, query: 'a' });
    expect(detectMention('hello @', 7)).toEqual({ start: 6, query: '' });
  });

  test('does not trigger in the middle of a word', () => {
    expect(detectMention('hi@bob', 6)).toBeNull();
    expect(detectMention('mail@example.com', 16)).toBeNull();
  });

  test('stops matching once whitespace follows the query', () => {
    expect(detectMention('@al done', 8)).toBeNull();
  });
});

describe('mentionCandidates', () => {
  test('only present members are offered', () => {
    const ids = mentionCandidates(roster, '').map((candidate) => candidate.agentId);
    expect(ids).toContain('agent-aaaa1111');
    expect(ids).toContain('agent-cccc3333');
    expect(ids).not.toContain('agent-dddd4444');
  });

  test('duplicate names disambiguate with an id suffix but submit the full id', () => {
    const candidates = mentionCandidates(roster, 'alice');
    expect(candidates).toHaveLength(2);
    const labels = candidates.map((candidate) => candidate.label).sort();
    expect(labels).toEqual(['Alice (agent-aa)', 'Alice (agent-bb)']);
    expect(candidates.map((candidate) => candidate.agentId).sort()).toEqual([
      'agent-aaaa1111',
      'agent-bbbb2222',
    ]);
  });

  test('members without a name use the agent id', () => {
    const candidates = mentionCandidates(roster, 'cccc');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.label).toBe('agent-cccc3333');
  });

  test('filters by name and id substring', () => {
    expect(mentionCandidates(roster, 'carol')).toHaveLength(1);
    expect(mentionCandidates(roster, 'nomatch')).toHaveLength(0);
  });
});

describe('insertMention', () => {
  test('replaces the trigger fragment and places the caret after the label', () => {
    const trigger = detectMention('hi @al', 6);
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    const result = insertMention('hi @al', trigger, 'Alice');
    expect(result.value).toBe('hi @Alice ');
    expect(result.caret).toBe(10);
  });
});

describe('mentionIds', () => {
  test('uses chips only; body @name text is not parsed', () => {
    expect(mentionIds([])).toEqual([]);
  });

  test('deduplicates while preserving first occurrence order', () => {
    expect(
      mentionIds([
        { agentId: 'b', label: 'B' },
        { agentId: 'a', label: 'A' },
        { agentId: 'b', label: 'B' },
      ]),
    ).toEqual(['b', 'a']);
  });
});

describe('message size', () => {
  test('measures UTF-8 bytes and enforces the 64 KiB limit', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
    expect(exceedsMessageLimit('a'.repeat(64 * 1024))).toBe(false);
    expect(exceedsMessageLimit('a'.repeat(64 * 1024 + 1))).toBe(true);
  });
});
