#!/usr/bin/env bun

/**
 * 「取消 hold / 留档」按钮探针（0.53）。
 *
 * 用户报的是：`inbox` 有 `held` 语义，agent 源（父 agent 发给本会话）的消息被 hold 住之后，
 * 条带上一个写入口都没有 —— 只能等它自己跑掉。产品裁定要补一颗「取消 hold / 留档」。
 *
 * 这一颗的**难点全在语义**，不在渲染：`agents.recall` 对 human 源是真删（discard），对其它源
 * 是 unhold 留档（退回可读 unread）。所以：
 *
 * A. 给不给：判据是「非 human 源 + 当前 held」，与服务端 recall 的分档同一个（`HUMAN_SOURCE`）；
 * B. 怎么画：按钮在（agent 源的卡上）+ 调的就是那条 RPC（`agents.recall`），没新造 RPC；
 * C. 怎么收场：乐观更新 + **两条失败分支都回滚**到 held + toast，成功那条**不从条带上抹掉**
 *    （抹掉就是伪装成删除：消息其实还在 unread）。
 *
 * 用法：bun run scripts/check-inbox-unhold.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canUnhold, HUMAN_SOURCE, type PendingStripEntry } from '../apps/web/src/domains/chat/pending-strip';

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

// ── A. 给不给：非 human 源 + held ────────────────────────────────────────
const entry = (from: string, status: PendingStripEntry['status']): PendingStripEntry => ({
  message_id: 'm-1',
  from,
  summary: 'hi',
  status,
  ts: 0,
});

expect(canUnhold(entry('agent:main@node', 'held')), 'A: agent 源 + held ⇒ 给「留档」键');
expect(!canUnhold(entry('agent:main@node', 'unread')), 'A: agent 源 + unread ⇒ 不给（本来就是留档态）');
expect(canUnhold(entry('ask', 'held')), 'A: ask 源 + held ⇒ 给（recall 对它也是 unhold）');
expect(!canUnhold(entry(HUMAN_SOURCE, 'held')), 'A: human 源 + held ⇒ 不给（它有三颗写键，且 recall 是真删）');
expect(!canUnhold(entry(HUMAN_SOURCE, 'unread')), 'A: human 源 + unread ⇒ 不给');

// 与服务端分档同一个判据：非 human 源 ⇔ recall 走 unhold。
const sources = [HUMAN_SOURCE, 'agent:main@node', 'ask', 'system'];
for (const from of sources) {
  for (const status of ['held', 'unread'] as const) {
    const expected = from !== HUMAN_SOURCE && status === 'held';
    expect(canUnhold(entry(from, status)) === expected, `A: ${from} / ${status} 与「非 human + held」一致`);
  }
}

// ── B. 按钮在、调的是既有 RPC ────────────────────────────────────────────
const strip = await source('apps/web/src/domains/chat/PendingStrip.tsx');
const streamItems = await source('apps/web/src/domains/chat/StreamItems.tsx');
const icon = await source('apps/web/src/components/ui/Icon.tsx');
const serveRecall = await source('packages/serve/src/gateway/methods/agents.ts');

expect(strip.includes("from './pending-strip'"), 'B: 条带从 pending-strip 取判定');
expect(strip.includes('canUnhold(head.entry)') && strip.includes('canUnhold(row.entry)'), 'B: 组头与组内两条渲染路径都按 canUnhold 给键');

// 抽出手柄体（handleUnhold → handleTakeBack 之间），只在这里断言调用与回滚。
const start = strip.indexOf('const handleUnhold');
const end = strip.indexOf('const handleTakeBack');
expect(start >= 0 && end > start, 'B: 条带里有 handleUnhold 手柄');
const handler = start >= 0 && end > start ? strip.slice(start, end) : '';

expect(handler.includes("client.rpc<AgentRecallResponse>('agents.recall'"), 'B: 调的就是 agents.recall（既有 RPC）');
expect(handler.includes('canUnhold') || strip.includes('canUnhold(row.entry)'), 'B: 手柄由 canUnhold 放行');
expect(serveRecall.includes("'recall'") || serveRecall.includes('recall'), 'B: 服务端确实有 recall 这条 RPC');
expect(!/agents\.(unhold|archive)/u.test(strip + streamItems), 'B: 没有新造 unhold/archive RPC（契约没动）');

// 按钮本身：agent 源的卡上画出来，语义说全（不是「撤掉」）。
expect(streamItems.includes('onUnhold?: (id: string) => void'), 'B: QueuedNotice 暴露 onUnhold');
expect(streamItems.includes('onUnhold !== undefined &&'), 'B: 给了才画那颗键（缺省不画空槽）');
expect(streamItems.includes("t('chat.pending.unhold')"), 'B: 按钮文案走 i18n（title/aria-label）');
expect(streamItems.includes('<Icon name="archive"'), 'B: 图形是「归档」而不是「撤回」');
expect(icon.includes('| \'archive\''), 'B: Icon 里有 archive 这个键');
expect(strip.includes('onUnhold={canUnhold(head.entry) ? unholdRow : undefined}'), 'B: 组头把 unhold 挂到行上');
expect(strip.includes('onUnhold={canUnhold(row.entry) ? unholdRow : undefined}'), 'B: 组内每条也把 unhold 挂上');

// ── C. 收场：乐观更新 + 两条失败分支都回滚 + toast，成功不抹掉条目 ──────────
const flipsToUnread = handler.split("withEntryStatus(prev.entries, messageId, 'unread')").length - 1;
const rollsBack = handler.split("withEntryStatus(prev.entries, messageId, 'held')").length - 1;
expect(flipsToUnread === 1, 'C: 成功前只有一处「翻成 unread」（乐观更新，别重复翻）');
expect(rollsBack === 2, 'C: 回滚有两处（服务端没受理 + 抛错），两条失败路径都归位');
expect(handler.includes("toast.error(t('chat.pending.unholdRejected')"), 'C: 未受理有 toast');
expect(handler.includes("toast.error(t('chat.pending.unholdFailed', { detail: errorMessage(error) })"), 'C: 抛错有 toast（带 detail）');
expect(handler.includes("toast.success(t('chat.pending.unheld')"), 'C: 成功有 toast');
expect(handler.includes('setReloadTick((value) => value + 1)'), 'C: 失败后重读对齐，不本地假装成功');
expect(!handler.includes('entries: prev.entries.filter'), 'C: 成功路径**不**把条目从条带上抹掉（unhold ≠ 删除）');

// 服务端分档要与前端判据同形（同一份「human 才真删」，别一边删一边留档）。
const serveService = await source('packages/agent/src/service.ts');
expect(
  serveRecall.includes("source === 'human'") || serveRecall.includes('`source === human`'),
  'C: gateway 文档写明 recall 按 source 分档',
);
expect(
  serveService.includes('if (source === HUMAN_PRINCIPAL) store.discard') &&
    serveService.includes('else store.unhold'),
  'C: 服务端收口是 discard(human) / unhold(其它) —— 与 canUnhold 同一判据',
);

// ── D. 文案：en / zh 都有 ────────────────────────────────────────────────
const en = await source('apps/web/src/i18n/messages/en.ts');
const zh = await source('apps/web/src/i18n/messages/zh-CN.ts');
for (const key of [
  'chat.pending.unhold',
  'chat.pending.unholding',
  'chat.pending.unheld',
  'chat.pending.unholdRejected',
  'chat.pending.unholdFailed',
]) {
  expect(en.includes(`'${key}'`), `D: en 有 ${key}`);
  expect(zh.includes(`'${key}'`), `D: zh 有 ${key}`);
}

if (failures.length > 0) {
  console.error(
    `check-inbox-unhold: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-inbox-unhold: OK（${String(checked)} 项：给键判据 / 走既有 recall / 乐观更新+双分支回滚 / 不伪装删除 / en+zh 文案）`,
);
