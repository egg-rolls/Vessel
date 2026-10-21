import { describe, expect, test } from 'bun:test';
import type { AgentCard, TaskEntry } from '../src/gateway/types';
import { flattenAgentCards, sortTasks } from '../src/state/tasks';

function card(id: string, parentId?: string): AgentCard {
  return {
    id,
    depth: 0,
    state: 'running',
    children_count: 0,
    children_ids: [],
    ...(parentId !== undefined ? { parent_id: parentId } : {}),
  };
}

function task(id: string, since: number): TaskEntry {
  return {
    id,
    title: id,
    assignee: id,
    status: 'running',
    artifact_refs: [],
    since,
  };
}

describe('flattenAgentCards', () => {
  test('orders parents before children and keeps orphans/cycles visible', () => {
    const rows = flattenAgentCards([card('child', 'root'), card('root'), card('orphan', 'gone')]);
    expect(rows.map((row) => row.card.id)).toEqual(['root', 'child', 'orphan']);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);

    const cycle = flattenAgentCards([card('a', 'b'), card('b', 'a')]);
    expect(cycle.map((row) => row.card.id).sort()).toEqual(['a', 'b']);
  });
});

describe('sortTasks', () => {
  test('newest first with id tie-breaker', () => {
    expect(sortTasks([task('older', 1), task('newer', 2)]).map((entry) => entry.id)).toEqual([
      'newer',
      'older',
    ]);
  });
});
