#!/usr/bin/env bun

/**
 * 「内部错误文本分级」门禁（0.52）。
 *
 * 用户报的：`verbosity: normal`、没开「显示系统信息（内部事件）」，却在报错会话里看到
 * `stale_fence: fencing token is older than the current lease`。
 *
 * 真因不是 tier 白名单塌了，而是**白名单只管事件、不管错误文本**：失败卡是 content 层
 * （永远可见，正确），但它把 `failure.error` 原样塞进 `<pre>`，而 `LeaseExpiredError.message`
 * 本身就是内部不变量字符串。修法：已知 reason 翻成人话，原文只在 debug 口径露出；
 * **未知错误保持原样**（不许为了好看把真错误藏起来）。
 *
 * 用法：bun run scripts/check-error-text.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { humanizeRunError } from '../apps/web/src/domains/chat/error-text';

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

// A. 映射
const lease = humanizeRunError('stale_fence: fencing token is older than the current lease');
expect(lease?.key === 'chat.run.reason.lease', 'A: stale_fence 没被翻成人话');
expect(
  humanizeRunError('Error: lease_expired')?.key === 'chat.run.reason.lease',
  'A: lease_expired 没被翻成人话',
);
expect(humanizeRunError('session_locked')?.key === 'chat.run.reason.locked', 'A: 锁冲突没映射');
expect(
  humanizeRunError('HTTP 429 too many requests')?.key === 'chat.run.reason.rateLimited',
  'A: 限流没映射',
);
expect(
  humanizeRunError('context_overflow: prompt exceeds window')?.key ===
    'chat.run.reason.contextTooLong',
  'A: 上下文超窗没映射',
);

// B. 未知错误必须原样保留（不许静默吞掉）
const unknown = humanizeRunError('TypeError: cannot read properties of undefined');
expect(unknown !== undefined, 'B: 未知错误被整条吞掉');
expect(unknown?.key === undefined, 'B: 未知错误被硬套了一个已知 reason');
expect(unknown?.raw?.startsWith('TypeError') === true, 'B: 未知错误的原文丢了');
expect(humanizeRunError('') === undefined, 'B: 空错误应返回 undefined（交给 i18n 的 noError）');
expect(humanizeRunError(undefined) === undefined, 'B: undefined 应原样返回');

// C. 接线：卡片必须用人话；原文只在 debug 口径
const items = await source('apps/web/src/domains/chat/StreamItems.tsx');
expect(items.includes('humanizeRunError(error)'), 'C: 失败卡没接 humanizeRunError');
expect(items.includes('t(humanized.key)'), 'C: 已知 reason 没走 i18n 文案');
expect(
  items.includes('showRawError'),
  'C: 原文没有受 debug 口径约束 —— 用户仍会看到 stale_fence 这种内部串',
);
expect(
  items.includes('showsInternalEvents('),
  'C: debug 判定必须复用「显示系统信息 / verbosity=debug」这一个开关，别另造',
);

// D. i18n 两侧都要有
const zh = await source('apps/web/src/i18n/messages/zh-CN.ts');
const en = await source('apps/web/src/i18n/messages/en.ts');
for (const key of [
  'chat.run.reason.lease',
  'chat.run.reason.locked',
  'chat.run.reason.rateLimited',
  'chat.run.reason.contextTooLong',
]) {
  expect(zh.includes(`'${key}'`), `D: zh-CN 缺 ${key}`);
  expect(en.includes(`'${key}'`), `D: en 缺 ${key}`);
}

if (failures.length > 0) {
  console.error(`check-error-text: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-error-text: OK（${String(checked)} 项：已知 reason 人话 / 未知原文保留 / debug 口径 / i18n 两侧）`,
);
