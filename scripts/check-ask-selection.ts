#!/usr/bin/env bun

/**
 * ask 选项「单选可取消」门禁（0.52）。
 *
 * 用户报的是直觉问题：「单选的选项点下去之后没法取消，只能改选另一个」。三个地方
 * （会话的逐题卡、对话/团队里的待批卡、待批页）本来是各抄一份 `<label><input type=radio>`
 * ——所以语义改动要改三遍，而这次的要求正是「复用，只改一次」。于是：
 *
 * - 语义收口成纯函数 `toggleAskOption`（本探针的行为断言对象）；
 * - 渲染收口成 `AskOptionChips`（本探针的接线断言对象）；
 * - 一个容易被下一个人改回去的原生坑：**已选中的 radio 再点一次不会触发 `onChange`**
 *   （值没变），所以取消必须挂在 `onClick` 上 —— 只写 `onChange` 的话「能点但没反应」，
 *   正是用户踩的那个坑。这条用静态断言钉住。
 *
 * 用法：bun run scripts/check-ask-selection.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { toggleAskOption } from '../apps/web/src/domains/pending/ask-selection';

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

// A. 单选：可取消
expect(toggleAskOption([], 'a', false).join(',') === 'a', 'A: 单选空态点一次应选中');
expect(toggleAskOption(['a'], 'a', false).length === 0, 'A: 单选再点同一项必须取消（回到未答）');
expect(toggleAskOption(['a'], 'b', false).join(',') === 'b', 'A: 单选改选另一项应替换');
expect(
  toggleAskOption(['a', 'b'], 'c', false).join(',') === 'c',
  'A: 单选遇到脏数据（多个已选）时应收敛成单个',
);

// B. 多选：叠加 + 可取消，顺序稳定
expect(toggleAskOption([], 'a', true).join(',') === 'a', 'B: 多选点一次应加入');
expect(toggleAskOption(['a'], 'b', true).join(',') === 'a,b', 'B: 多选应保持选择顺序');
expect(toggleAskOption(['a', 'b'], 'a', true).join(',') === 'b', 'B: 多选再点应移除');
expect(toggleAskOption(['a'], 'a', true).length === 0, 'B: 多选取消最后一项应回到空');

// C. 取消 → 未答 ⇒ 不进载荷（ask 允许留空；这条依赖 isAskDraftAnswered 的同一口径）
const drafts = await source('apps/web/src/domains/pending/ask-drafts.ts');
expect(
  /selected\.length > 0/u.test(drafts),
  'C: isAskDraftAnswered 不再要求 selected 非空 —— 取消勾选会被当成「已回答空值」提交',
);

// D. 三个调用点复用一个组件 + 一个判定
const askCard = await source('apps/web/src/domains/chat/AskCard.tsx');
const pendingCard = await source('apps/web/src/domains/pending/PendingClusterCard.tsx');
const chips = await source('apps/web/src/domains/pending/AskOptionChips.tsx');

const askCardChips = askCard.split('<AskOptionChips').length - 1;
const pendingChips = pendingCard.split('<AskOptionChips').length - 1;
expect(
  askCardChips === 2,
  `D: AskCard 应有两处 AskOptionChips（逐题卡 + 待批卡），实际 ${String(askCardChips)}`,
);
expect(
  pendingChips === 1,
  `D: PendingClusterCard 应有一处 AskOptionChips，实际 ${String(pendingChips)}`,
);
expect(
  !askCard.includes("multi_select ? 'checkbox' : 'radio'") &&
    !pendingCard.includes("multi_select ? 'checkbox' : 'radio'"),
  'D: 又有调用点自己手写了 option 的 <label><input>（复用被破坏）',
);
expect(
  askCard.includes("from '../pending/ask-selection'") &&
    pendingCard.includes("from './ask-selection'"),
  'D: 两个调用点都要走同一个 toggleAskOption（不许各自实现）',
);
expect(
  !/function toggleOption/u.test(pendingCard),
  'D: PendingClusterCard 又长出本地 toggleOption（与共享判定分叉）',
);

// E. 单选取消必须挂 onClick（radio 已选不触发 onChange）
expect(
  /onClick=\{\(event\) => \{/u.test(chips) && chips.includes('event.preventDefault()'),
  'E: 单选取消没挂在 onClick 上——已选中的 radio 不会再触发 onChange，点第二次会「没反应」',
);
expect(
  chips.includes("multi ? 'checkbox' : 'radio'"),
  'E: AskOptionChips 丢了 multi 分支（单选/多选仍要区分控件类型）',
);
expect(
  chips.includes('disabled={disabled}'),
  'E: AskOptionChips 丢了 disabled 透传（已答/已提交的题必须锁住）',
);

if (failures.length > 0) {
  console.error(
    `check-ask-selection: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-ask-selection: OK（${String(checked)} 项：单选可取消 / 多选语义 / 未答不进载荷 / 三处复用 / onClick 兜底）`,
);
