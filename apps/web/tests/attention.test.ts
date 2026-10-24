import { describe, expect, test } from 'bun:test';
import { appendInteractions } from '../src/domains/observe/attention';
import type { ListedInteraction } from '../src/gateway/interaction-hydration';

function item(requestId: string, createdAt: number): ListedInteraction {
  return {
    kind: 'permission',
    request_id: requestId,
    run_id: `run-${requestId}`,
    created_at: createdAt,
    status: 'pending',
  };
}

describe('appendInteractions', () => {
  test('appends a cursor page in server order without duplicating overlapping ids', () => {
    const first = [item('r3', 300), item('r2', 200)];
    // 下一页与上一页在边界上重叠（同 created_at 时按 request_id 续页）。
    const page = [item('r2', 200), item('r1', 100)];

    expect(appendInteractions(first, page).map((entry) => entry.request_id)).toEqual([
      'r3',
      'r2',
      'r1',
    ]);
  });

  test('re-loading the same cursor page changes nothing', () => {
    const first = [item('r3', 300), item('r2', 200)];
    const page = [item('r1', 100)];

    const once = appendInteractions(first, page);
    const twice = appendInteractions(once, page);

    expect(twice.map((entry) => entry.request_id)).toEqual(['r3', 'r2', 'r1']);
    expect(twice).toHaveLength(3);
  });
});
