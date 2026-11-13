#!/usr/bin/env bun

/**
 * ask 卡片「浏览位」（上次停在第几题）门禁（0.52）。
 *
 * 用户报的 UX 缺口：ask 卡片刷新后**草稿值还在，但停在哪一题丢了**。草稿层（`ask-drafts.ts`）
 * 早就解决「你打的字」，「你站在第几题」却一直是组件里的 `useState(0)`。
 *
 * 这个探针钉四类不变量，每一类都有对应的真实失败方式：
 * A. 形状与解析：记**题号**不记下标（题序属于服务端，下标会错位）；落盘载荷版本不符 /
 *    脏数据 / 全过期都要当「没有浏览位」，不许把整份草稿层带崩。
 * B. 回落：题号没记过 / 题已不在列表里 / 列表为空 ⇒ 一律回第 1 题（宁可少记，不许把人
 *    钉在错的位置）。
 * C. 容量与清理：条数上限于按 savedAt 淘汰最旧；请求消失要连带删（sessionStorage 配额
 *    被过期浏览位占满会把草稿挤掉 —— 那才是用户真会丢东西的地方）。
 * D. 接线反向断言：PromptSlots 必须走 `useAskCursorIndex` 且**不许**再出现
 *    `setQuestionIndex(0)` 那种「一切请求就回第 1 题」的重置；ChatView 必须挂 prune。
 *
 * 用法：bun run scripts/check-ask-cursor.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ASK_CURSOR_MAX_AGE_MS,
  askCursorOf,
  dropAskCursors,
  EMPTY_ASK_CURSORS,
  MAX_ASK_CURSORS,
  parseAskCursors,
  pruneAskCursors,
  rememberAskCursor,
  resolveAskCursorIndex,
  serializeAskCursors,
} from '../apps/web/src/domains/pending/ask-cursor';

const failures: string[] = [];
let checked = 0;

function expect(cond: boolean, message: string): void {
  checked += 1;
  if (!cond) failures.push(message);
}

const NOW = 1_800_000_000_000;
const repoRoot = join(import.meta.dir, '..');

async function source(rel: string): Promise<string> {
  return readFile(join(repoRoot, rel), 'utf8');
}

// A. 形状与解析
const one = rememberAskCursor(EMPTY_ASK_CURSORS, 'req-1', 'q2', NOW);
expect(askCursorOf(one, 'req-1') === 'q2', 'A: 记下的题号读不回来');
expect(askCursorOf(one, 'req-2') === undefined, 'A: 不存在的请求不该有浏览位');
expect(
  rememberAskCursor(one, 'req-1', '', NOW) === one,
  'A: 空题号不该产生记录（会产生无处可去的浏览位）',
);

const roundTrip = parseAskCursors(serializeAskCursors(one), NOW);
expect(
  roundTrip !== undefined && askCursorOf(roundTrip, 'req-1') === 'q2',
  'A: 序列化往返丢了浏览位',
);
expect(parseAskCursors(null, NOW) === undefined, 'A: 空载荷应被视为「没有浏览位」');
expect(parseAskCursors('not json', NOW) === undefined, 'A: 坏 JSON 应被忽略');
expect(
  parseAskCursors(
    JSON.stringify({ version: 999, cursors: { 'req-1': { questionId: 'q2', savedAt: NOW } } }),
    NOW,
  ) === undefined,
  'A: 版本不符应整体忽略（不能按当前版本硬读）',
);
const dirty = parseAskCursors(
  JSON.stringify({
    version: 1,
    cursors: {
      ok: { questionId: 'q1', savedAt: NOW },
      badId: { questionId: 42, savedAt: NOW },
      badAt: { questionId: 'q1', savedAt: 'yesterday' },
      stale: { questionId: 'q1', savedAt: NOW - ASK_CURSOR_MAX_AGE_MS - 1 },
    },
  }),
  NOW,
);
expect(
  dirty !== undefined && Object.keys(dirty).join(',') === 'ok',
  `A: 脏载荷应只留下合法条目，实际留下 ${dirty === undefined ? 'undefined' : Object.keys(dirty).join(',')}`,
);

// B. 回落
expect(resolveAskCursorIndex(['q1', 'q2', 'q3'], 'q3') === 2, 'B: 题号能对上时应落在该题');
expect(resolveAskCursorIndex(['q1', 'q2', 'q3'], undefined) === 0, 'B: 没记过应回第 1 题');
expect(resolveAskCursorIndex(['q1', 'q2', 'q3'], 'q9') === 0, 'B: 题号已不在列表里应回第 1 题');
expect(resolveAskCursorIndex([], 'q1') === 0, 'B: 没有题目时应回 0（不许 NaN）');
expect(
  resolveAskCursorIndex(['q1', 'q2'], 'q9', 5) === 1,
  'B: 回落下标越界时应夹到最后一题（不许给越界下标）',
);

// C. 容量与清理
let many = EMPTY_ASK_CURSORS;
for (let index = 0; index < MAX_ASK_CURSORS + 5; index += 1) {
  many = rememberAskCursor(many, `req-${String(index)}`, 'q1', NOW + index);
}
expect(
  Object.keys(many).length === MAX_ASK_CURSORS,
  `C: 超出上限没有淘汰，实际 ${String(Object.keys(many).length)} 条`,
);
expect(askCursorOf(many, 'req-0') === undefined, 'C: 淘汰应丢最旧的一条（req-0 还在）');

const pruned = pruneAskCursors(
  rememberAskCursor(rememberAskCursor(EMPTY_ASK_CURSORS, 'live', 'q1', NOW), 'gone', 'q1', NOW),
  ['live'],
  NOW,
);
expect(Object.keys(pruned).join(',') === 'live', 'C: 请求消失后浏览位没被清掉');
const prunedStale = pruneAskCursors(
  rememberAskCursor(EMPTY_ASK_CURSORS, 'live', 'q1', NOW - ASK_CURSOR_MAX_AGE_MS - 1),
  ['live'],
  NOW,
);
expect(Object.keys(prunedStale).length === 0, 'C: 过期浏览位没被清掉');
expect(
  dropAskCursors(one, ['req-1']) === EMPTY_ASK_CURSORS ||
    Object.keys(dropAskCursors(one, ['req-1'])).length === 0,
  'C: dropAskCursors 没删掉指定请求',
);
expect(
  dropAskCursors(one, ['other']) === one,
  'C: dropAskCursors 在没有命中时应返回原对象（避免无谓重渲染）',
);

// D. 接线反向断言
const promptSlots = await source('apps/web/src/domains/chat/PromptSlots.tsx');
expect(
  promptSlots.includes('useAskCursorIndex(request.requestId, questionIds)'),
  'D: PromptSlots 没接 useAskCursorIndex（刷新后仍会回第 1 题）',
);
expect(
  /setQuestionIndex\(0\)/u.test(promptSlots) === false,
  'D: PromptSlots 又出现 setQuestionIndex(0) 的请求切换重置（会抹掉读回的浏览位）',
);
expect(
  /useState\(0\)[\s\S]{0,40}questionIndex/u.test(promptSlots) === false,
  'D: questionIndex 又回到组件本地 useState(0)',
);
const chatView = await source('apps/web/src/domains/chat/ChatView.tsx');
expect(
  chatView.includes('useAskCursorPrune(pendingAskIds'),
  'D: ChatView 没挂 useAskCursorPrune（过期浏览位会一直占 sessionStorage）',
);
const store = await source('apps/web/src/domains/pending/ask-cursor-store.ts');
expect(store.includes('vessel.askCursor.v1'), 'D: 落盘键变了（改动要与手记的存储键一致）');
expect(
  /try\s*\{[\s\S]*?setItem/u.test(store),
  'D: 写 sessionStorage 没有 try/catch（隐私模式下会抛进 React 渲染）',
);

if (failures.length > 0) {
  console.error(`check-ask-cursor: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-ask-cursor: OK（${String(checked)} 项：记题号不记下标 / 三种回落 / 上限与清理 / 接线反向断言）`,
);
