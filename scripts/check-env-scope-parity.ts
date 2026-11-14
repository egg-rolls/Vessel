#!/usr/bin/env bun

/**
 * 环境信息 scope 对账门禁：**agent 看到的 scope，用户必须看得到标签**（可见性对等）。
 *
 * 为什么 `check-append-only-context.ts` 的 C3 不够：C3 比的是「`ENV_INFO_SCOPES` ⊂
 * `ENV_NOTICE_SCOPES`」，前提是被比的两边都**登记过**。生产者可以在 `scope: '<字面量>'` 里发一个
 * 从来没进过 `ENV_INFO_SCOPES` 的词（`inbox` 就是这样），C3 看不见它，Web 卡头静默退化成兜底
 * 「上下文」——正文照样显示，但用户扫一眼不知道那是什么，等于「agent 看到、用户没看到」。
 *
 * 本门禁不抄任何词表：它**扫生产端真实源码**找出 scope 字面量（A），再拿真实的 Web 词表（B）、
 * 真实的 locale 标签（B）、真实的解析器行为（C）去对。每一条都能被真实改动弄红：
 *
 *   A 生产端出现的 scope 字面量必须都在 `ENV_NOTICE_SCOPES` 里；
 *   B 每个 scope 在**每个** locale 都必须有非空 `chat.env.scope.<scope>` 标签（`EnvCard` 直接
 *     `t()` 这个词，缺了用户看到的就是裸 i18n key）；
 *   C Web 解析器必须真的把这个 scope 认出来——裸词 `<scope>: …` 和生产者实际用到的方括号线格式
 *     `[<scope>] …` 两种都要。登记了词表、加了标签、但解析器认不出 = 标签是死代码，这条专门防它；
 *   D 词表只有一个真相：`SCOPE_TOKEN` 由 `ENV_NOTICE_SCOPES` 拼出，不存在第二份手写列表。
 *
 * 不在范围内：只把 scope 拼在**正文前缀**里、不带 `scope:` 键的生产者（`pii` / `context` 等直接写
 * `'pii: …'` 文案），它们经 `ENV_INFO_SCOPES` 由 C3 覆盖。
 *
 * 为什么可以 import `apps/web/src/domains/chat/env-notice.ts`：那个模块零 import（纯 TS，不碰
 * React / 任何包），bun 直接解析；`scripts/check-env-card-layout.ts` 与 C3 早就在 import 同一个
 * 模块。生产端那一侧**一律读文本**、不 import（`packages/agent` 会拉包，worktree 里没有
 * node_modules）。
 *
 * 用法：`bun scripts/check-env-scope-parity.ts`
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ENV_NOTICE_SCOPES, parseEnvNoticeLine } from '../apps/web/src/domains/chat/env-notice';

const repoRoot = join(import.meta.dir, '..');
const WEB_MODULE = 'apps/web/src/domains/chat/env-notice.ts';
const LOCALE_DIR = 'apps/web/src/i18n/messages';

const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) failures.push(message);
}

async function readSource(relPath: string): Promise<string> {
  return readFile(join(repoRoot, relPath), 'utf8');
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

// ── 生产端扫描：不依赖任何词表 ────────────────────────────────────────────────

const SOURCE_ROOTS = ['src', 'packages', 'plugins'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '__tests__',
  'test',
  'tests',
]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** 一个 `scope: '<字面量>'`；同对象里带 `summary` 才算环境信息通知的载荷。 */
const INLINE_SCOPE = /\bscope\s*:\s*'([a-z][a-z0-9_-]*)'/g;
/** 导出常量形式的 scope（`TRIM_ENV_SCOPE = 'trim'`、`SUBSCRIPTION_NOTICE_SCOPE = 'files'`）。 */
const SCOPE_CONSTANT = /const\s+[A-Za-z0-9_]*(?:ENV|NOTICE)_SCOPE\s*=\s*'([a-z][a-z0-9_-]*)'/g;
/** 正文线格式 `[inbox] 3 unread`：生产端把 scope 写在方括号里。 */
const BRACKETED_LINE = /['"`]\[([a-z][a-z0-9_-]*)\]\s/g;

type Span = { start: number; end: number };

function skipQuoted(text: string, start: number): number {
  const quote = text[start] ?? '';
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (quote !== '`' && char === '\n') return index;
    index += 1;
  }
  return text.length;
}

function skipRegex(text: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '\n') return start + 1;
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return index + 1;
    index += 1;
  }
  return start + 1;
}

/**
 * 极简词法：跳过注释 / 字符串 / 模板串 / 正则，收集所有 `{...}` 配对区间。
 * 目的只有一个——判断某个 `scope:` 落在哪个对象字面量里，好去那个对象里找 `summary`。
 */
function objectSpans(text: string): Span[] {
  const spans: Span[] = [];
  const stack: number[] = [];
  let index = 0;
  let previous = '';
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      index = skipQuoted(text, index);
      continue;
    }
    if (char === '/' && (previous === '' || '=(,:!&|?{};[+-*%~^<>'.includes(previous))) {
      index = skipRegex(text, index);
      continue;
    }
    if (char === '{') stack.push(index);
    if (char === '}') {
      const start = stack.pop();
      if (start !== undefined) spans.push({ start, end: index });
    }
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return spans;
}

function enclosingSpan(spans: readonly Span[], index: number): Span | undefined {
  let best: Span | undefined;
  for (const span of spans) {
    if (span.start < index && index < span.end && (best === undefined || span.start > best.start)) {
      best = span;
    }
  }
  return best;
}

async function collectSources(dir: string, acc: string[]): Promise<string[]> {
  const entries = await readdir(join(repoRoot, dir), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectSources(relPath, acc);
      continue;
    }
    if (/\.(?:ts|tsx)$/.test(entry.name) && !TEST_FILE.test(entry.name)) acc.push(relPath);
  }
  return acc;
}

type Producer = { scope: string; where: string };

async function discoverProducers(): Promise<Producer[]> {
  const producers: Producer[] = [];
  for (const root of SOURCE_ROOTS) {
    const files = await collectSources(root, []);
    for (const relPath of files) {
      const text = await readSource(relPath);
      const spans = objectSpans(text);
      for (const match of text.matchAll(INLINE_SCOPE)) {
        const index = match.index ?? 0;
        const span = enclosingSpan(spans, index);
        const body = span === undefined ? '' : text.slice(span.start, span.end);
        // 只认环境信息通知的载荷形状（同对象带 `summary`，可能是 `summary:` 也可能是简写
        // `summary,`）。这一步排除同名但无关的字面量：`scope: 'once'`（权限决策）与
        // `scope: 'run'`（限额检查）都不带 summary，不会被误会。
        if (!/\bsummary\b/.test(body)) continue;
        producers.push({
          scope: match[1] ?? '',
          where: `${relPath}:${String(lineOf(text, index))}`,
        });
      }
      for (const match of text.matchAll(SCOPE_CONSTANT)) {
        producers.push({
          scope: match[1] ?? '',
          where: `${relPath}:${String(lineOf(text, match.index ?? 0))}`,
        });
      }
    }
  }
  return producers;
}

async function discoverBracketedPrefixes(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const root of SOURCE_ROOTS) {
    const files = await collectSources(root, []);
    for (const relPath of files) {
      const text = await readSource(relPath);
      for (const match of text.matchAll(BRACKETED_LINE)) {
        const scope = match[1] ?? '';
        // 只看登记进 Web 词表的词：`[runtime]` / `[assistant]` 这些是别的通道的方括号前缀，
        // 与卡头 scope 无关（它们是正文的一部分，本模块一个字都不剥）。
        if (!ENV_NOTICE_SCOPES.some((known) => known === scope)) continue;
        if (!found.has(scope)) {
          found.set(scope, `${relPath}:${String(lineOf(text, match.index ?? 0))}`);
        }
      }
    }
  }
  return found;
}

// ── 断言 ─────────────────────────────────────────────────────────────────────

const producers = await discoverProducers();
const producerScopes = [...new Set(producers.map((producer) => producer.scope))].sort();
const bracketed = await discoverBracketedPrefixes();
const localeFiles = (await readdir(join(repoRoot, LOCALE_DIR)))
  .filter((name) => name.endsWith('.ts'))
  .sort();
const locales = new Map<string, string>();
for (const name of localeFiles) locales.set(name, await readSource(`${LOCALE_DIR}/${name}`));

const inVocab = (scope: string): boolean => ENV_NOTICE_SCOPES.some((known) => known === scope);

function labelOf(localeText: string, scope: string): string | undefined {
  const pattern = new RegExp(`'chat\\.env\\.scope\\.${scope}'\\s*:\\s*'([^']*)'`);
  return pattern.exec(localeText)?.[1];
}

// A：生产端出现的每个 scope 都必须在 Web 词表里
for (const producer of producers) {
  expect(
    inVocab(producer.scope),
    `A 生产端 scope "${producer.scope}"（${producer.where}）不在 ENV_NOTICE_SCOPES 里：` +
      'Web 卡头会退化成兜底「上下文」，用户看不出这条是哪一类环境信息',
  );
}

// B：词表里每个词在每个 locale 都有非空标签（`EnvCard` 直接 `t('chat.env.scope.<scope>')`）
for (const scope of [...new Set([...ENV_NOTICE_SCOPES, ...producerScopes])].sort()) {
  for (const [name, text] of locales) {
    const label = labelOf(text, scope);
    expect(
      label !== undefined && label.trim() !== '',
      `B scope "${scope}" 在 ${LOCALE_DIR}/${name} 缺少非空标签 'chat.env.scope.${scope}'：` +
        '卡头会直接把 i18n key 显示给用户',
    );
  }
}

// C：解析器真的认得（否则词表与标签都是死代码）
for (const scope of producerScopes) {
  const plain = parseEnvNoticeLine(`${scope}: probe`);
  expect(
    plain?.scope === scope,
    `C Web 解析器认不出裸词线格式 "${scope}: …"（${scope}）：词表登记了但解析不出来，` +
      '卡头仍会退回兜底「上下文」',
  );
}
for (const [scope, where] of bracketed) {
  if (!producerScopes.includes(scope)) continue;
  const parsed = parseEnvNoticeLine(`[${scope}] probe`);
  expect(
    parsed?.scope === scope,
    `C 生产端 ${where} 使用的线格式是 "[${scope}] …"，但 Web 解析器认不出：` +
      '方括号形式必须能取到 scope（正文照旧不剥），否则标签永远不生效',
  );
}

// D：scope 词表只有一个真相，解析用的正则由它拼出
const webSource = await readSource(WEB_MODULE);
expect(
  webSource.includes('ENV_NOTICE_SCOPES.join'),
  `D ${WEB_MODULE} 的 scope 正则不再由 ENV_NOTICE_SCOPES 拼出：词表可能与解析器悄悄分叉`,
);

// ── 报告 ─────────────────────────────────────────────────────────────────────

console.log(`生产端 scope 发点（源码扫描，共 ${String(producers.length)} 处）：`);
for (const producer of [...producers].sort((a, b) => a.scope.localeCompare(b.scope))) {
  const vocabMark = inVocab(producer.scope) ? '词表✓' : '词表✗';
  const labels = [...locales.entries()]
    .map(([name, text]) => {
      const label = labelOf(text, producer.scope);
      return `${name.replace(/\.ts$/, '')}=${label === undefined ? '✗' : `"${label}"`}`;
    })
    .join(' ');
  console.log(`  - ${producer.scope.padEnd(10)} ${vocabMark} ${labels}  ${producer.where}`);
}
console.log(`方括号线格式（去重后）：${[...bracketed.keys()].sort().join(' / ') || '(无)'}`);
console.log(
  `Web 词表 ${String(ENV_NOTICE_SCOPES.length)} 个词 / locale ${String(locales.size)} 份`,
);

if (failures.length > 0) {
  console.error(
    `check-env-scope-parity: ${String(failures.length)} 项 FAIL（共 ${String(checks)} 项）`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`check-env-scope-parity: OK（${String(checks)} 项断言）`);
