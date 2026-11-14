#!/usr/bin/env bun

/**
 * 门禁：压缩 = 开新段，run 内绝不改中段（0.52 V2）。
 *
 * 旧实现有两条就地改写历史的路：
 *
 * 1. `MemoryWorkingContext.add()` 在未配 summarizer 时同步 `compact()`（删中段 + 插摘要）；
 * 2. tool loop 每轮请求前 `autoCompact()`，加上 provider 400 时 `forceCompact(…, 'overflow')`
 *    删除中段后重试。
 *
 * 两者都会让**同一个 run 内**出现两份不同的历史视图。0.52 起压缩只发生在段边界：
 * run 起点（seed 之后、第一条请求之前）压一次，压缩后的 seed 视图就是新段的基准
 * （段因 `compaction` ⇒ `new(compaction)`），段内不再改写；run 内撑爆上下文则追加一张
 * 「超限」卡并以原始错误收尾，下一次 run 在段起点压缩后开新段。
 *
 * 断言：
 *
 * - T1 追加永不压缩：`add()` 超条数上限 / 超 token 阈值都不丢消息、不改正文。
 * - T2 段起点压缩是 pop 中段：旧前缀逐字未变（同一对象）、只插一条摘要、尾部保留。
 * - T3 新段可见：`compaction` 是已登记的 `new` 段因且有可见记录事件；超限卡文案可见、
 *   不带 provider 原文。
 * - T4 run 内不改写历史（源码）：tool loop 不再每轮压缩，overflow 分支不再 forceCompact。
 *
 * 用法：bun run scripts/check-compaction-segment.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MemoryWorkingContext,
  type Message,
  renderContextOverflowNotice,
  SEGMENT_CAUSE_RECORD_EVENTS,
  SEGMENT_NEW_CAUSES,
} from '../packages/core/src/index';

const REPO_ROOT = join(import.meta.dir, '..');
const BODY_SENTINEL = 'PROVIDER-BODY-SENTINEL';

const failures: string[] = [];
let passed = 0;

function ok(label: string): void {
  passed += 1;
  console.log('  ok  ' + label);
}

function fail(label: string, detail: string): void {
  failures.push(label + '：' + detail);
  console.log('  FAIL ' + label + '：' + detail);
}

function expect(label: string, actual: unknown, want: unknown): void {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a === w) ok(label);
  else fail(label, 'want ' + w + ' got ' + a);
}

function section(title: string): void {
  console.log('\n' + title);
}

/** 读源码做静态断言（门禁的常规手法：判定点少一处就等于放宽）。 */
function source(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

function msg(role: Message['role'], content: string): Message {
  return { role, content, timestamp: 1, run_id: 'run-1', run_segment: 0 } as Message;
}

/** 一段够长的历史：会超 token 阈值，也会超条数上限。 */
function seedHistory(): Message[] {
  const messages: Message[] = [msg('system', '你是 Vessel 的具身成员。')];
  for (let index = 0; index < 12; index += 1) {
    messages.push(
      msg('user', 'm' + String(index) + ' ' + 'y'.repeat(200)),
      msg('assistant', 'a' + String(index) + ' ' + 'z'.repeat(200)),
    );
  }
  return messages;
}

// ── T1：add() 永不压缩 ─────────────────────────────────────────────────────

section('T1 add() 只追加：超条数 / 超 token 阈值都不丢消息');

{
  const context = new MemoryWorkingContext({ maxTokens: 400, maxMessages: 6, autoCompact: true });
  context.setSessionId('s-v2-t1');
  const history = seedHistory();
  for (const message of history) context.add(message);

  expect('T1.1 条数一个不少（不截断、不压缩）', context.messages.length, history.length);
  expect(
    'T1.2 每条正文与写入时逐字一致',
    context.messages.every((message, index) => message.content === history[index]?.content),
    true,
  );
  expect(
    'T1.3 同一个对象（没有克隆改写）',
    context.messages.every((message, index) => message === history[index]),
    true,
  );
  expect('T1.4 lastCompaction 仍是 undefined（add 里没压过）', context.lastCompaction, undefined);
}

// ── T2：段起点压缩 = pop 中段 + 一条摘要 ──────────────────────────────────

section('T2 段起点压缩：旧前缀逐字未变，只插一条摘要');

{
  const context = new MemoryWorkingContext({ maxTokens: 400, maxMessages: 6, autoCompact: true });
  context.setSessionId('s-v2-t2');
  const history = seedHistory();
  for (const message of history) context.add(message);
  const before = [...context.messages];
  const beforeJson = JSON.stringify(before);

  const removed = await context.autoCompactAsync();

  if (removed > 0) ok('T2.1 段起点压缩真的移除了 ' + String(removed) + ' 条中段消息');
  else fail('T2.1', 'autoCompactAsync 没有压缩（阈值/条数用例失效）');

  // 旧字节未变：压缩前就存在的消息，压缩后仍是同一个对象、同样正文。
  const survivors = context.messages.filter((message) => before.includes(message));
  expect(
    'T2.2 幸存消息一个字节都没变',
    survivors.every((message) => {
      const index = before.indexOf(message);
      return JSON.stringify(message) === JSON.stringify(before[index]);
    }),
    true,
  );
  expect(
    'T2.3 头部 system 仍在第 0 位且正文未变',
    context.messages[0]?.content,
    before[0]?.content,
  );
  expect('T2.4 压缩前的数组没被就地改（长度仍是原值）', before.length, history.length);
  expect('T2.5 压缩前的快照仍与当初逐字一致', JSON.stringify(before), beforeJson);
  expect(
    'T2.6 只插了一条摘要（不是多条）',
    context.messages.filter((message) => String(message.content).startsWith('[Auto Compact:'))
      .length,
    1,
  );
  expect('T2.7 尾部最新一条保留原文', context.messages.at(-1)?.content, before.at(-1)?.content);
  expect('T2.8 压缩后总条数必须变少', context.messages.length < before.length, true);
  if ((context.lastCompaction?.removed ?? 0) > 0) ok('T2.9 压缩记录可审计（removed > 0）');
  else fail('T2.9', 'lastCompaction 没记 removed');
}

// ── T3：新段可见 ───────────────────────────────────────────────────────────

section('T3 新段可见：compaction 是登记过的 new 段因 + 可见记录事件');

{
  expect('T3.1 段因词表里 compaction 是 new', SEGMENT_NEW_CAUSES.includes('compaction'), true);
  const record = SEGMENT_CAUSE_RECORD_EVENTS.compaction ?? [];
  if (record.length > 0) ok('T3.2 compaction 有可见记录事件：' + record.join(', '));
  else fail('T3.2', 'compaction 没有登记可见记录事件');

  const tierTable = source('apps/web/src/state/event-visibility.ts');
  for (const event of record) {
    const line = tierTable.split('\n').find((row) => row.includes("'" + event + "'"));
    if (line === undefined) {
      fail('T3.3 ' + event, 'web 可见性表里没有这一行');
    } else if (line.includes("承接: 'notice'") || line.includes("承接: 'card'")) {
      ok('T3.3 ' + event + ' 的承接是 notice/card（新段有可见卡）');
    } else {
      fail('T3.3 ' + event, '承接不是 notice/card：' + line.trim());
    }
  }

  const notice = renderContextOverflowNotice();
  const zh = renderContextOverflowNotice('zh-CN');
  if (notice.startsWith('context: ')) ok('T3.4 超限卡首行是 context: 摘要');
  else fail('T3.4', '超限卡首行不是 context: …… ' + notice.split('\n')[0]);
  if (zh.startsWith('context：')) ok('T3.5 超限卡 zh-CN 首行是 context：摘要');
  else fail('T3.5', 'zh-CN 首行不对：' + zh.split('\n')[0]);
  if (!notice.includes(BODY_SENTINEL) && !notice.includes('messages":'))
    ok('T3.6 超限卡不带 provider 原文（正文里可能含片段）');
  else fail('T3.6', '超限卡里出现了请求/错误正文字样');
  if (notice.includes('new segment')) ok('T3.7 超限卡说清下一步在哪发生（下一次 run 开新段）');
  else fail('T3.7', '超限卡没说下一步：' + notice);
}

// ── T4：run 内不改写历史（源码断言） ──────────────────────────────────────

section('T4 源码：run 内没有压缩路径');

{
  const loop = source('packages/core/src/runtime/tool-calling-loop.ts');
  const loopBody = loop.slice(loop.indexOf('for (let turn'), loop.indexOf('for (let turn') + 4000);
  if (!loopBody.includes('autoCompact(')) ok('T4.1 tool loop 每轮不再压缩');
  else fail('T4.1', 'tool loop 循环体里还有 autoCompact() 调用');

  const unit = source('packages/core/src/runtime/execution-unit.ts');
  if (!unit.includes("await this.forceCompact(execution, '")) ok('T4.2 overflow 不再就地压缩重试');
  else fail('T4.2', 'execution-unit 还在 overflow 时 forceCompact');
  if (unit.includes('appendContextOverflowNotice()')) ok('T4.3 overflow 走「超限」卡 + 收尾失败');
  else fail('T4.3', 'execution-unit 没有 appendContextOverflowNotice 调用点');
  if (unit.includes('compactAtSegmentStart(execution)'))
    ok('T4.4 压缩只在段起点（run 起点 / resume 起点）');
  else fail('T4.4', 'execution-unit 没有段起点压缩调用点');

  const manager = source('packages/core/src/context/context-manager.ts');
  const addBody = manager.slice(
    manager.indexOf('  add(message: Message)'),
    manager.indexOf('  add(message: Message)') + 1600,
  );
  if (!addBody.includes('this.compact(')) ok('T4.5 add() 里不再同步压缩');
  else fail('T4.5', 'context-manager.add() 里还有 this.compact(');
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

console.log('');
if (failures.length === 0) {
  console.log('压缩分段判据：通过 ' + String(passed) + ' 项，0 项红。');
} else {
  console.log(
    '压缩分段判据：通过 ' + String(passed) + ' 项，红 ' + String(failures.length) + ' 项：',
  );
  for (const failure of failures) console.log('  - ' + failure);
}
process.exit(failures.length === 0 ? 0 : 1);
