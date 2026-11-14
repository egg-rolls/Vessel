#!/usr/bin/env bun

/**
 * 「上下文卡不许每次重启重发」门禁（0.52）。
 *
 * 用户报的现象：重启 gateway 后发一条消息，就会收到一张「上下文」环境卡 —— 哪怕只有
 * 消息数 / tokens 变了。根因不是渲染，是**去重状态放错了层**：
 * `ExecutionUnit.lastSystemContext` 是纯内存，重启 = 新 body = 新 EU ⇒ `last === undefined`
 * ⇒ `publishSystemContext()` 必然走「首次」分支发全量快照。
 *
 * 修法：把指纹（hash / model / tools_count）按 session 落进 `SessionState`（RunJournal 单写口），
 * 重启后 seed 恢复，于是「没有实质变化就不发」。本探针钉两件事：
 *   A 判定函数本身（同进程 / 新会话 / 重启后全同 / 重启后有变）；
 *   B 接线（EU 读它 + 写它、两个 backend 都真的落盘）—— 算对了没落盘等于没做。
 *
 * 用法：bun run scripts/check-prompt-context-dedup.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  normalizePromptContextFingerprint,
  samePromptContext,
  shouldPublishSystemContext,
} from '../packages/core/src/context/prompt-context';

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

const base = { hash: 'h1', model: 'm1', tools_count: 3, at: 1_700_000_000_000 };

// A. 判定
expect(
  shouldPublishSystemContext({ live: true, next: base }) === true,
  'A: 同进程有上一份快照时必须交给既有增量逻辑（不该由这里拦）',
);
expect(
  shouldPublishSystemContext({ live: false, next: base }) === true,
  'A: 新会话（既无内存快照也无持久指纹）必须发全量卡',
);
expect(
  shouldPublishSystemContext({ live: false, restored: base, next: base }) === false,
  'A: 重启后指纹全同却仍要发卡 —— 正是用户报的「每次重启都发一张」',
);
expect(
  shouldPublishSystemContext({
    live: false,
    restored: base,
    next: { ...base, at: base.at + 5000 },
  }) === false,
  'A: `at` 不同不算实质变化（时间戳参与判定会导致永远重发）',
);
expect(
  shouldPublishSystemContext({ live: false, restored: base, next: { ...base, hash: 'h2' } }) ===
    true,
  'A: system prompt 变了必须重发',
);
expect(
  shouldPublishSystemContext({ live: false, restored: base, next: { ...base, model: 'm2' } }) ===
    true,
  'A: 换模型必须重发',
);
expect(
  shouldPublishSystemContext({ live: false, restored: base, next: { ...base, tools_count: 4 } }) ===
    true,
  'A: 装/卸插件（工具数变化）必须重发',
);

// B. 指纹自身的健壮性
expect(samePromptContext(base, { ...base, at: 9 }) === true, 'B: at 不该参与相等判定');
expect(samePromptContext(base, undefined) === false, 'B: 缺一边应判不等');
expect(normalizePromptContextFingerprint(base)?.hash === 'h1', 'B: 合法指纹被丢弃');
expect(
  normalizePromptContextFingerprint({ ...base, hash: '' }) === undefined,
  'B: 空 hash 应丢弃（否则会和任何快照「相等」）',
);
expect(
  normalizePromptContextFingerprint({ ...base, tools_count: Number.NaN }) === undefined,
  'B: NaN 工具数应丢弃',
);
expect(normalizePromptContextFingerprint('nope') === undefined, 'B: 非对象应丢弃');

// C. 接线
const eu = await source('packages/core/src/runtime/execution-unit.ts');
expect(
  eu.includes('shouldPublishSystemContext({'),
  'C: ExecutionUnit 没调用统一判定（重启去重不会生效）',
);
expect(
  eu.includes('this.promptContextFingerprint = stored?.prompt_context'),
  'C: seed 没恢复持久指纹',
);
expect(
  eu.includes('sessionState.prompt_context = this.promptContextFingerprint'),
  'C: 发布后没把指纹写回 session state（等于没落盘）',
);
const fileBackend = await source('packages/core/src/session/file-backend.ts');
expect(
  (fileBackend.match(/prompt_context/gu) ?? []).length >= 2,
  'C: file backend 读/写没有都带上 prompt_context',
);
const sqlite = await source('packages/core/src/session/sqlite-backend.ts');
expect(
  sqlite.includes("ensureColumn('prompt_context'"),
  'C: sqlite 旧库没有补列 —— 老数据会直接报错或丢字段',
);

if (failures.length > 0) {
  console.error(
    `check-prompt-context-dedup: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-prompt-context-dedup: OK（${String(checked)} 项：同进程 / 新会话 / 重启全同不发 / 有变才发 / 落盘接线）`,
);
