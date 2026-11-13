#!/usr/bin/env bun

/**
 * 环境信息卡（EnvCard）的排版口径门禁（0.52）。
 *
 * 用户 2026-11-13 的两条裁定，都落在「缩略卡 vs 展开看板」的分工上：
 *
 * 1. **一眼要看的事实放缩略卡**：模型 / N 条消息 / N 个工具 / 估算 tokens 原来在展开体里
 *    逐行躺着，用户要它们上缩略卡那一行、并从展开体里移出来。于是 `EnvCard` 多了 `facts`
 *    （由它拼 summary），`envCardOfPromptContext` 允许 `summaryParts` 为空（展开体只留
 *    原文块 / hash / 窗口上限）—— 若哪天有人把事实又塞回 `lines`，这张卡就会重复一遍。
 * 2. **配色分工**：卡头「环境信息」用主题色（`text-accent`），紧跟的「哪一类」（成员 / 上下文 / …）
 *    用正文色（`text-ink`），后面的值保持灰色。标题与类型抢同一抹强调色就看不出主次。
 *
 * 判据都是**源码级 + 纯函数行为**，因为这几个文件是 React、脚本侧点不进去：
 * 但版面回归恰恰是「改一行 class / 少传一个 prop」这类静默退化，机器判得住。
 *
 * 用法：bun run scripts/check-env-card-layout.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { envCardOfPromptContext } from '../apps/web/src/domains/chat/env-notice';

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

const envCard = await source('apps/web/src/domains/chat/EnvCard.tsx');
const streamItems = await source('apps/web/src/domains/chat/StreamItems.tsx');

// A. 折叠态那一行由 facts 拼，缺省才回落到首行原文
expect(
  envCard.includes("facts && facts.length > 0 ? facts.join(' · ') : env.lines[0]?.text"),
  'A: EnvCard 的 summary 不再是「有 facts 用 facts、否则首行原文」',
);
expect(envCard.includes('facts?: readonly string[];'), 'A: EnvCard 没有 facts 这个 props 声明');

// B. 配色分工：标题主题色 / 类型正文色
expect(
  /font-mono text-2xs tracking-wider text-accent[\s\S]{0,160}chat\.env\.title/u.test(envCard),
  'B: 卡头「环境信息」不是 text-accent（用户裁定标题用主题色）',
);
expect(
  /font-mono text-2xs tracking-wider text-ink[\s\S]{0,160}chat\.env\.scope\./u.test(envCard),
  'B: 卡头 scope（成员 / 上下文 / …）不是 text-ink（用户裁定类型用正文色）',
);
expect(
  /text-faint[\s\S]{0,160}chat\.env\.title/u.test(envCard) === false,
  'B: 「环境信息」又回到 text-faint 灰字（应该是主题色）',
);

// C. PromptContextCard：全量摘要进 facts、不进 lines；增量形态维持原样
expect(
  streamItems.includes('envCardOfPromptContext(hasChanges ? summaryParts : [], ['),
  'C: PromptContextCard 仍把全量摘要当 lines 传（会与折叠行的 facts 重复）',
);
expect(
  streamItems.includes('facts={hasChanges ? undefined : summaryParts}'),
  'C: PromptContextCard 没有把全量摘要交给折叠行的 facts',
);

// D. 纯函数行为：空摘要 ⇒ 没有 lines（展开体不该出现空行），但块与 count 照旧
const emptyCard = envCardOfPromptContext(
  [],
  [{ labelKey: 'chat.modelContext.system', text: 'SYS' }],
);
expect(emptyCard.lines.length === 0, 'D: 空摘要仍然产生了 lines（展开体会多出空行）');
expect(emptyCard.blocks?.length === 1, 'D: 空摘要把原文块也弄丢了');
expect(emptyCard.count === 1, 'D: 空摘要的卡头条数变了');
expect(emptyCard.droppedLines === undefined, 'D: 空摘要却报了被丢的行数');

const fullCard = envCardOfPromptContext(['m', 'a', 'b', 'c'], []);
expect(fullCard.lines.length === 4, 'D: 非空摘要的行数不对');
expect(
  fullCard.lines.map((line) => line.text).join('|') === 'm|a|b|c',
  'D: 非空摘要的文本/顺序变了',
);

if (failures.length > 0) {
  console.error(
    `check-env-card-layout: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-env-card-layout: OK（${String(checked)} 项：事实进缩略卡 / 展开体不重复 / 标题主题色 + 类型正文色）`,
);
