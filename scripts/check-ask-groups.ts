#!/usr/bin/env bun

/**
 * 「已答」分组探针（0.52）。
 *
 * 用户报的是：会话页早就把已答的题标出来了（`pending.item.answered` + `settled`），
 * 待批页和团队页却把已答的题继续混在未答里 —— 一屏十几行，看不出还剩几题没答。
 *
 * 这一层的口径：**分组不另造判据**。分组函数 `askRowGroups` 内部就是
 * `askOpenRows` / `askSettledRows`，而那两个和载荷剔除用的是同一个 `settled`
 * （服务端 answered_question_ids + 本端刚提交的标记）。本探针钉住的就是这件事：
 *
 * A. 行为：settled 的行落进「已答」摞，未答在前，和载荷剔除同口径；
 * B. 幂等：拍平后再分组同形（这样「一列渲染」和「两摞分组」不会越分越歪）；
 * C. 本地答了但没落定的行**留在未答摞**（收走它等于把还没提交的答案藏起来）；
 * D. 接线：两个页面共用同一个分组函数与同一个折叠壳，已答的行照旧锁输入；
 * E. 文案：展开/收起走 i18n，en / zh 都有。
 *
 * 用法：bun run scripts/check-ask-groups.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type AskDrafts,
  askDraftKey,
  EMPTY_ASK_DRAFTS,
} from '../apps/web/src/domains/pending/ask-drafts';
import {
  type AskPlanRow,
  askIncludedAnswers,
  askOpenRows,
  askPendingAnswers,
  askPlanRows,
  askRowGroups,
  askRowsOfGroups,
  askSettledRows,
} from '../apps/web/src/domains/pending/ask-submit-plan';
import type { AskUserQuestion } from '../apps/web/src/gateway/types';

const failures: string[] = [];
let checked = 0;

function expect(cond: boolean, message: string): void {
  checked += 1;
  if (!cond) failures.push(message);
}

const repoRoot = join(import.meta.dir, '..');

async function source(rel: string): Promise<string> {
  return readFile(join(repoRoot, rel), 'utf8');
}

const ids = (rows: readonly AskPlanRow[]): string => rows.map((row) => row.questionId).join(',');

// ── A. 行为：settled 的行落进「已答」摞，未答在前 ─────────────────────────
// 一屏三题：q1 服务端已答（answered_question_ids），q2 / q3 还没答。
const questions: AskUserQuestion[] = [
  { header: '范围', question: '这次改动覆盖到哪一层？', options: ['web', 'serve'] },
  { header: '提交', question: '拆成几个提交？' },
  { header: '探针', question: '要不要补探针？' },
];
const request = { requestId: 'req-1', questions, answeredQuestionIds: ['q1'] };
const rows = askPlanRows([request], EMPTY_ASK_DRAFTS);

expect(rows.length === 3, 'A: 三题展开成三行');
expect(ids(rows.filter((row) => row.settled)) === 'q1', 'A: 服务端已答的 q1 落定');

const groups = askRowGroups(rows);
expect(ids(groups.answered) === 'q1', 'A: settled 的行归入「已答」摞');
expect(ids(groups.open) === 'q2,q3', 'A: 未答摞只剩 q2 / q3');
expect(
  groups.open.length + groups.answered.length === rows.length,
  'A: 两摞不重不漏（每行恰好落一摞）',
);
expect(
  groups.answered.every((row) => row.settled),
  'A: 「已答」摞里没有未落定的行',
);
expect(
  groups.open.every((row) => !row.settled),
  'A: 未答摞里没有已落定的行',
);

// 分组与既有判定同一把尺子（不另造一套）。
expect(
  groups.open.length === askOpenRows(rows).length &&
    groups.answered.length === askSettledRows(rows).length,
  'A: 与 askOpenRows / askSettledRows 同口径',
);

// 未答置顶：拍平后所有未答都在已答之前。
const flattened = askRowsOfGroups(groups);
expect(ids(flattened) === 'q2,q3,q1', 'A: 拍平=未答在前、已答在后');
const firstAnsweredAt = flattened.findIndex((row) => row.settled);
const lastOpenAt = flattened.reduce((last, row, index) => (row.settled ? last : index), -1);
expect(firstAnsweredAt > lastOpenAt, 'A: 未答整体排在已答之前（置顶）');

// ── B. 幂等：拍平后再分组同形 ─────────────────────────────────────────────
const regrouped = askRowGroups(flattened);
expect(ids(regrouped.open) === ids(groups.open), 'B: 幂等 —— 未答摞同序');
expect(ids(regrouped.answered) === ids(groups.answered), 'B: 幂等 —— 已答摞同序');
expect(ids(askRowsOfGroups(regrouped)) === ids(flattened), 'B: 幂等 —— 再拍平与原拍平一致');
expect(
  ids(askRowGroups(rows).open) === ids(groups.open) &&
    ids(askRowGroups(rows).answered) === ids(groups.answered),
  'B: 同一输入反复分组结果一致（纯函数）',
);

// 空输入 / 全未答 / 全已答的边界。
const empty = askRowGroups([]);
expect(empty.open.length === 0 && empty.answered.length === 0, 'B: 空输入分出两摞空');
const allAnswered = askRowGroups(
  askPlanRows([{ ...request, answeredQuestionIds: ['q1', 'q2', 'q3'] }], EMPTY_ASK_DRAFTS),
);
expect(allAnswered.open.length === 0 && allAnswered.answered.length === 3, 'B: 全已答时未答摞为空');
const noneAnswered = askRowGroups(
  askPlanRows([{ ...request, answeredQuestionIds: [] }], EMPTY_ASK_DRAFTS),
);
expect(
  noneAnswered.answered.length === 0 && noneAnswered.open.length === 3,
  'B: 全未答时已答摞为空',
);

// ── C. 与载荷剔除同口径 + 本地答了没落定的行留在未答摞 ─────────────────────
// q1 已落定（草稿里还留着旧答案并勾了「带上这题」），q2 本地答了但没落定，q3 空。
const drafts: AskDrafts = {
  [askDraftKey('req-1', 0)]: { selected: ['web'], custom: '旧答案', include: true },
  [askDraftKey('req-1', 1)]: { selected: [], custom: '拆两个', include: true },
};
const draftedRows = askPlanRows([request], drafts);
const drafted = askRowGroups(draftedRows);

expect(ids(drafted.answered) === 'q1', 'C: 有草稿也不改变已答归属');
expect(ids(drafted.open) === 'q2,q3', 'C: 本地答了但没落定的 q2 仍留在未答摞');
expect(!ids(drafted.answered).split(',').includes('q2'), 'C: 未落定的行不会被收进「已答」摞');
const payloadIds = askPendingAnswers(draftedRows).map((answer) => answer.question_id ?? '');
expect(!payloadIds.includes('q1'), 'C: 已答的题不进载荷（分组与剔除同一判据）');
const includedIds = askIncludedAnswers(draftedRows).map((answer) => answer.question_id ?? '');
expect(!includedIds.includes('q1'), 'C: 勾了「带上这题」也不会把已答的题塞回去');

// ── D. 接线：待批页 / 团队页共用同一个分组函数与同一个折叠壳 ────────────────
const pendingCard = await source('apps/web/src/domains/pending/PendingClusterCard.tsx');
const teamCard = await source('apps/web/src/domains/chat/AskCard.tsx');
const groupShell = await source('apps/web/src/domains/pending/AnsweredGroup.tsx');
const teamBar = await source('apps/web/src/domains/team/TeamPendingBar.tsx');

expect(pendingCard.includes('askRowGroups'), 'D: 待批页用共享分组函数 askRowGroups');
expect(teamCard.includes('askRowGroups'), 'D: 团队页的卡用共享分组函数 askRowGroups');
expect(teamBar.includes('AskCard'), 'D: 团队页确实渲染这张 ask 卡');
expect(
  !/function\s+ask\w*[Gg]roup/u.test(pendingCard + teamCard),
  'D: 两页都没有自己的分组实现（只有壳在共用）',
);
expect(pendingCard.includes('<AnsweredGroup'), 'D: 待批页渲染「已答」分组');
expect(teamCard.includes('<AnsweredGroup'), 'D: 团队页渲染「已答」分组');
expect(groupShell.includes('useState(false)'), 'D: 分组默认折叠（useState(false)）');
expect(groupShell.includes('askRowGroups'), 'D: 分组壳自己不判定，判据来自 askRowGroups');

// 已答的行保持禁用输入（与现有行为一致）。
expect(pendingCard.includes('const locked = disabled || settled'), 'D: 待批页已答的行仍锁输入');
expect(teamCard.includes('disabled={busy || row.settled}'), 'D: 团队页已答的行仍锁输入');

// ── E. 文案：分组标题走 i18n，en / zh 都有 ────────────────────────────────
const en = await source('apps/web/src/i18n/messages/en.ts');
const zh = await source('apps/web/src/i18n/messages/zh-CN.ts');
expect(groupShell.includes("t('pending.answeredGroup.expand'"), 'E: 展开文案走 i18n');
expect(groupShell.includes("t('pending.answeredGroup.collapse'"), 'E: 收起文案走 i18n');
for (const key of ['pending.answeredGroup.expand', 'pending.answeredGroup.collapse']) {
  expect(en.includes(`'${key}'`), `E: en 有 ${key}`);
  expect(zh.includes(`'${key}'`), `E: zh 有 ${key}`);
}

if (failures.length > 0) {
  console.error(`check-ask-groups: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-ask-groups: OK（${String(checked)} 项：已答归组 / 未答置顶 / 幂等 / 与载荷同口径 / 两页接线 / en+zh 文案）`,
);
