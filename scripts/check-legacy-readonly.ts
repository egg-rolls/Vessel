#!/usr/bin/env bun

/**
 * 0.54 C-1 门禁：**旧格式会话只读冻结**（ADR-105 D4 / §7 A8；plan-054 §3.3、§3.4、§C 阶段）。
 *
 * 判的不是「新链路能读」（那是 `check-timeline-equality` 的 A1–A7），而是三件事：
 *
 * | # | 断言 | 为什么必须是结构判定 |
 * | --- | --- | --- |
 * | C-1a | 写 `events.ndjson` 的调用点**只允许**在 `packages/core/src/session/session-event-log.ts` 一处 | 靠 review 记不住「第三个写入口」；scan 源码 + 局部常量解析才能钉住 |
 * | C-1b | 写 timeline 目录（`wal.*` / `timeline.ndjson` / `timeline.manifest` / `timeline/blobs` / `holes.ndjson` / `timeline.idx`）的路径**必须经过** `TimelineWriter.open`（即 `packages/core/src/timeline/**` 之外不得直接拼这些文件名） | 「唯一写者」这句话如果没有机械判据，下一个人加一行 `atomicWrite(join(dir,'timeline.manifest'))` 就破了 |
 * | C-1c | 旧格式会话被**写**的时候抛的是 `session_frozen_readonly`，不是别的错误（且目录一字节不变） | 错误码是上层唯一的可映射信息；抛成 `timeline_write_failed` 或静默成功都算失效 |
 *
 * **0.54 C cutover 之后，读面不再服务旧源**：`sessions.events` / `events.list` 的唯一读源
 * 都是时间线（`timeline.read_from` 开关与事件日志读分支已删除）。所以 C-1c 的读那一半断言的
 * 是"旧目录里的数据**不再**从这两条 RPC 出去"（未注入 timeline 端口 ⇒ `not_supported`，
 * 注入空 timeline ⇒ 空页），写那一半（`session_frozen_readonly` + 目录逐字节不变）不变。
 *
 * ## 「旧格式会话」是怎么识别出来的（唯一口径）
 *
 * `packages/core/src/timeline/freeze.ts#isLegacyFrozenSessionDir`：
 *
 * ```
 * 有 events.ndjson（0.54 之前的唯一真相源）
 *   且 没有任何 timeline 标记：timeline.manifest / wal.manifest / wal.log 三者皆无
 * ```
 *
 * 三个标记的含义（缺一个都会误判）：`timeline.manifest` = 写入侧创建标记（最先出现）；
 * `wal.log` = 第一条非 chunk 事件真落盘；`wal.manifest` = 块级 WAL（只有 chunk 的会话
 * 可能还没有 `wal.log`）。本门禁直接 import 这两个常量（`TIMELINE_MARKERS` /
 * `LEGACY_SESSION_LOG`），所以判据不会在门禁和实现之间漂。
 *
 * ## 静态扫描的口径（说明清楚，免得被当成"看起来绿"）
 *
 * 1. 只扫**产品代码**：`packages/**`、`src/**`、`apps/web/src/**`、`plugins/**`；
 *    跳过 `*.test.ts(x)`、`*.d.ts`、`node_modules`、`dist`、`__tests__`、`test`、`tests`。
 *    `scripts/**` 不进扫描范围——门禁与夹具本来就要造这些文件（它们是「造事实的人」，
 *    不是「写产品路径的人」）。
 * 2. **注释先被剥掉**：JSDoc 里提到的 `wal.log` 不算命中（否则文案越写越红，最后只能靠
 *    allowlist 全部吞掉，判据就死了）。
 * 3. 「写」= 调用这些 API 的实参：`writeFile` / `appendFile` / `atomicWrite` /
 *    `createWriteStream` / `mkdir` / `truncateFile` / `rename` / `copyFile` /
 *    `open(...,'a'|'r+'|'w'|'wx'|...)`。实参里的**局部常量**会在同一文件内向前解析
 *    （最多两层，取最近一次赋值）——`const p = join(dir, X); await atomicWrite(p)` 这种
 *    写法必须能被抓到，否则断言就是真空的。
 * 4. 非写命中的「提及」（读点 / 名称定义）必须逐条登记在 {@link READ_ALLOWLIST}：
 *    每项写清 `reason` 与 `expires_in`（到期的版本一到就红）。登记了却没命中 ⇒ 也红
 *    （防止 allowlist 变成永久豁免）。
 * 5. **写命中永远不可登记**：C-1a / C-1b 的写命中必须为 0，没有"临时豁免"这种东西。
 * 6. 扫描器自带反例自检（`judgeScannerSelfTest`）：一个合成片段必须被抓到、注释与
 *    `startsWith('timeline.')` 这类事件类型前缀必须不被抓到。自检红 ⇒ 后面所有绿都不算。
 *
 * ## 已知的计数盲区（写在这里，不是免责声明）
 *
 * 局部常量解析是**语法级**的：`const p = pick(); // pick() 内部拼路径`、跨文件常量、
 * 数组/对象里的名字都抓不到。要补这些得引 TS 类型检查器；本门禁选择「宁可漏在明处」，
 * 用 C-1b 的 allowlist 与 review 兜住。
 *
 * 用法：`bun run scripts/check-legacy-readonly.ts`
 * 退出码：0 = 全过；1 = 有 FAIL（含 NOT_IMPLEMENTED 项）。
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { SessionEventLog, sessionDirPath } from '../packages/core/src/index';
import {
  isLegacyFrozenSessionDir,
  LEGACY_SESSION_LOG,
  TIMELINE_MARKERS,
} from '../packages/core/src/timeline/freeze';
import { rebuildIndexFiles, TimelineIndexReader } from '../packages/core/src/timeline/index';
import { TIMELINE_LAYOUT } from '../packages/core/src/timeline/types';
import { TimelineWriter } from '../packages/core/src/timeline/writer';
import { createEventsMethods } from '../packages/serve/src/gateway/methods/observability';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';
import {
  decideTimelineSubscribe,
  EMPTY_TIMELINE_HEADS,
  selectTimelinePage,
  timelineHello,
} from '../packages/serve/src/gateway/timeline-protocol';
import { createSessionEventsSource } from '../src/session-events';
import { createTimelineDualWrite } from '../src/timeline-dual-write';

const REPO_ROOT = resolve(import.meta.dir, '..');

// ───────────────────────────────────────────────────────────────── 断言脚手架

let checks = 0;
let failures = 0;

function pass(name: string, detail = ''): void {
  checks += 1;
  console.log(`[PASS] ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  checks += 1;
  failures += 1;
  console.log(`[FAIL] ${name} — ${detail}`);
}

function assertTrue(name: string, condition: boolean, detail = ''): void {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function assertEqual(name: string, actual: unknown, want: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(want);
  if (same) pass(name, `${JSON.stringify(actual)}`);
  else fail(name, `actual=${JSON.stringify(actual)} want=${JSON.stringify(want)}`);
}

function assertBytes(name: string, actual: string, want: string): void {
  if (actual === want) pass(name, `bytes=${Buffer.byteLength(actual)} 逐字节相同`);
  else fail(name, `bytes=${Buffer.byteLength(actual)} vs ${Buffer.byteLength(want)}（不相等）`);
}

function section(title: string): void {
  console.log('');
  console.log(`── ${title} ${'-'.repeat(Math.max(0, 66 - title.length))}`);
}

function info(text: string): void {
  console.log(`[INFO] ${text}`);
}

/** 一句可粘贴进报告的「证据」：文件 + 行号 + 片段。 */
function evidence(label: string, detail: string): void {
  console.log(`[EVIDENCE] ${label} — ${detail}`);
}

// ───────────────────────────────────────────────────────── 静态扫描：文件列表

/** 产品代码根（相对仓库根）。 */
const SCAN_ROOTS = ['packages', 'src', 'apps/web/src', 'plugins'] as const;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__tests__',
  'test',
  'tests',
  'fixtures',
]);
const SKIP_SUFFIXES = ['.test.ts', '.test.tsx', '.d.ts'] as const;

async function listSourceFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      out.push(relative(REPO_ROOT, path).split('\\').join('/'));
    }
  }
  for (const root of SCAN_ROOTS) await walk(join(REPO_ROOT, root));
  return out.sort();
}

// ───────────────────────────────────────────────────── 静态扫描：剥注释 + 字面量

/**
 * 这些字符之后出现的 `/` 是**正则字面量**开始，不是除号。
 *
 * 少了这一条，源码里任何 `/...['"`].../` 形状的正则都会把后面的解析带偏 —— 不是理论问题：
 * `src/tenant-runtime-factory.ts:253` 的 `/^["'`“”‘’]+/` 曾让扫描器把 350 行当成一个字符串。
 */
const REGEX_ALLOWED_AFTER = new Set([
  '\n',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
  '/',
]);

interface StringLiteral {
  /** 在 `code` 里的起始偏移。 */
  index: number;
  /** 字面量的内容（模板串保留 `${...}` 原文）。 */
  value: string;
}

interface Scanned {
  /** 注释被替换成空格的源码（偏移 / 行号与原文一致）。 */
  code: string;
  /**
   * 结构骨架：注释**与字符串内容**都被替换成空格，只留括号 / 引号本身。
   *
   * 用途只有一个 —— 数括号（块作用域、调用实参）。在 `code` 上数括号会被 `'{'` 这种
   * 字符串内容骗到，那正是「块作用域解析」最怕的事。
   */
  masked: string;
  literals: StringLiteral[];
}

/**
 * 把注释替换成空格（保留换行，偏移不变），同时收集字符串字面量。
 *
 * 为什么不用正则：`//` 在字符串里、`'` 在注释里、模板串里的 `${...}` 都会让正则算错行号，
 * 而行号是本门禁唯一的"证据"形态。
 */
function scanSource(text: string): Scanned {
  const out: string[] = [];
  const masked: string[] = [];
  const literals: StringLiteral[] = [];
  let index = 0;
  const push = (chunk: string): void => {
    out.push(chunk);
    // 默认骨架 = 原样（代码字符本来就要参与括号计数）
    masked.push(chunk);
  };
  /** 代码里最近一个非空白字符（判断 `/` 是除号还是正则字面量）。 */
  const previousSignificant = (): string | undefined => {
    for (let cursor = out.length - 1; cursor >= 0; cursor -= 1) {
      const chunk = out[cursor] ?? '';
      for (let inner = chunk.length - 1; inner >= 0; inner -= 1) {
        const candidate = chunk[inner];
        if (candidate !== undefined && !/\s/.test(candidate)) return candidate;
        if (candidate === '\n') return '\n';
      }
    }
    return undefined;
  };
  const blank = (count: number): string => ' '.repeat(count);
  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') {
        push(' ');
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      push('  ');
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        push(text[index] === '\n' ? '\n' : ' ');
        index += 1;
      }
      if (index < text.length) {
        push('  ');
        index += 2;
      }
      continue;
    }
    if (char === '/' && REGEX_ALLOWED_AFTER.has(previousSignificant() ?? '\n')) {
      // 正则字面量：**必须**先认出来，否则 `/^["'`]+/` 里的引号会把整个文件的解析带偏
      // （真实事故：`src/tenant-runtime-factory.ts:253` 的 `.replace(/^["'`“”‘’]+/, '')`
      // 让扫描器把第 253 行之后全部当成一个字符串，报出了一个 90 行之外的假写点）。
      const start = index;
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < text.length) {
        const inner = text[cursor];
        if (inner === '\n') break;
        if (inner === '\\') {
          cursor += 2;
          continue;
        }
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) {
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (closed) {
        const literalText = text.slice(start, cursor + 1);
        out.push(literalText);
        masked.push(literalText.replace(/[^\n]/g, ' '));
        index = cursor + 1;
        continue;
      }
    }
    if (char === "'" || char === '"' || char === '`') {
      const start = index;
      const quote = char;
      push(char);
      index += 1;
      let value = '';
      while (index < text.length) {
        const current = text[index];
        if (current === undefined) break;
        if (current === '\\') {
          value += text.slice(index, index + 2);
          push(text.slice(index, index + 2));
          index += 2;
          continue;
        }
        if (quote === '`' && current === '$' && text[index + 1] === '{') {
          // 模板串里的插值：原样穿过（不递归收集内部字面量，够了：路径名不会藏在 `${}` 里）
          let depth = 0;
          const from = index;
          while (index < text.length) {
            if (text[index] === '{') depth += 1;
            if (text[index] === '}') {
              depth -= 1;
              if (depth === 0) {
                index += 1;
                break;
              }
            }
            index += 1;
          }
          value += text.slice(from, index);
          push(text.slice(from, index));
          // 骨架里插值也是字符串内容：抹成空格（否则 `${` 的 `{` 会把括号栈带歪）
          masked.pop();
          masked.push(blank(text.slice(from, index).length));
          continue;
        }
        if (current === quote) {
          push(quote);
          index += 1;
          break;
        }
        value += current;
        push(current);
        // 字符串内容在骨架里抹掉（引号本身保留）
        masked.pop();
        masked.push(current === '\n' ? '\n' : ' ');
        index += 1;
      }
      literals.push({ index: start, value });
      continue;
    }
    push(char);
    index += 1;
  }
  return { code: out.join(''), masked: masked.join(''), literals };
}

// ───────────────────────────────────────────────────── 静态扫描：命中与分类

/** timeline 目录里的文件名（`TIMELINE_LAYOUT` 的取值，门禁逐项登记，见 {@link judgeLayoutCoverage}）。 */
const TIMELINE_FILE_KEYS = [
  'walLog',
  'walBlocks',
  'walManifest',
  'timeline',
  'blobsDir',
  'timelineManifest',
  'holes',
  'indexDir',
] as const;

/** `TIMELINE_LAYOUT` 里**故意不扫**的名字：太通用了（`session.idx` / `run.idx` / `type.idx`）。 */
const GENERIC_LAYOUT_KEYS = ['indexSession', 'indexRun', 'indexType'] as const;

const TIMELINE_FILE_NAMES: string[] = TIMELINE_FILE_KEYS.map(
  (key) => TIMELINE_LAYOUT[key] as string,
);

/** 写 API：命中后解析实参里的局部常量，再看名字。 */
const WRITE_APIS = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'atomicWrite',
  'createWriteStream',
  'mkdir',
  'truncateFile',
  'rename',
  'copyFile',
] as const;

/** `open(...)` 只有写标志才算写。 */
const OPEN_WRITE_FLAG = /["'](?:a|a\+|as|as\+|ax|ax\+|w|w\+|wx|wx\+|w\+x|r\+|r\+s)["']/;

type Family = 'timeline' | 'events';

interface Hit {
  file: string;
  line: number;
  family: Family;
  /** 命中的名字（`wal.log` / `events.ndjson` / `TIMELINE_LAYOUT` / `sessionEventsFilePath`）。 */
  token: string;
  /** `write` = 写 API 的实参解析出这个名字；`mention` = 只在代码里出现。 */
  kind: 'write' | 'mention';
  /** 写命中时的 API 名（mention 为 `''`）。 */
  api: string;
  snippet: string;
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) {
    if (code[i] === '\n') line += 1;
  }
  return line;
}

function snippetAt(code: string, index: number): string {
  const from = code.lastIndexOf('\n', index) + 1;
  const to = code.indexOf('\n', index);
  return code
    .slice(from, to < 0 ? code.length : to)
    .trim()
    .slice(0, 160);
}

/** 从 `(` 开始取平衡括号内的文本（字符串内的括号不参与计数）。 */
function balancedCall(masked: string, code: string, openIndex: number): string {
  if (masked[openIndex] !== '(') return '';
  let depth = 0;
  let index = openIndex;
  while (index < masked.length) {
    const char = masked[index];
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex, index + 1);
    }
    index += 1;
  }
  return code.slice(openIndex);
}

/** 一对 `{}` 的偏移区间（骨架坐标系）。 */
interface BlockSpan {
  start: number;
  end: number;
}

/** 骨架里所有 `{}` 区间（注释 / 字符串内容已被抹掉，所以括号计数可信）。 */
function blockSpans(masked: string): BlockSpan[] {
  const spans: BlockSpan[] = [];
  const stack: number[] = [];
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === '{') stack.push(index);
    else if (masked[index] === '}') {
      const start = stack.pop();
      if (start !== undefined) spans.push({ start, end: index });
    }
  }
  return spans;
}

/** 包住该偏移的块，由内向外（块作用域解析的搜索顺序）。 */
function enclosingBlocks(spans: readonly BlockSpan[], index: number): BlockSpan[] {
  return spans
    .filter((span) => span.start < index && index < span.end)
    .sort((a, b) => b.start - a.start);
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** 从一条语句开头往后找 `;`（括号计数用骨架），返回**绝对**结束偏移。 */
function findStatementEnd(masked: string, from: number): number {
  let depth = 0;
  let index = from;
  while (index < masked.length) {
    const char = masked[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth < 0) return index;
    }
    if (char === ';' && depth === 0) return index;
    if (char === '\n' && depth === 0) {
      // 无分号写法（ASI）：换行即语句结束，够用了
      return index;
    }
    index += 1;
  }
  return masked.length;
}

interface Assignment {
  /** 整条赋值语句的偏移区间（用于把「这个 token 属于写点」标出来）。 */
  start: number;
  end: number;
  /** `=` 右边到语句结束的文本（在 `code` 坐标系里取，字符串内容完整）。 */
  text: string;
}

/**
 * 在调用点之前找**最近一次** `const|let|var NAME = <初始化文本>`。
 *
 * 只在该调用点**所在块及其外层块**里找（由内向外），找不到就放弃：
 * - 往函数外找会把「别的函数里同名的 `path`」算进来 —— 那是假红（`plugins/observability/
 *   usage/src/store.ts` 的 `writeFileAtomic(path)` 就被上过这个当）；
 * - 函数参数（`function f(path)`）不是 `const`，因此不会被解析 —— 也正是我们要的。
 */
function resolveLastAssignment(
  code: string,
  masked: string,
  name: string,
  before: number,
  blocks: readonly BlockSpan[],
): Assignment | undefined {
  const pattern = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;]*)?=`, 'g');
  const scopes = enclosingBlocks(blocks, before);
  // 模块顶层 / 门禁自检的片段可能不在任何块里：此时文件整体就是最外层作用域。
  // **只**在没有更内层块时才加它 —— 否则会把「别的函数里同名变量」算进来（那是假红）。
  if (scopes.length === 0) scopes.push({ start: 0, end: masked.length });
  for (const block of scopes) {
    let found: Assignment | undefined;
    for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
      if (match.index >= before) break;
      if (match.index < block.start) continue;
      const from = match.index + match[0].length;
      const end = findStatementEnd(masked, from);
      found = { start: match.index, end, text: code.slice(from, end) };
    }
    pattern.lastIndex = 0;
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 把实参里的局部常量展开（最多两层），得到「这段文本到底在说什么名字」。
 *
 * 同时收集被展开的赋值语句区间：那些语句里的名字 token **属于这次写**，不该再被当成
 * 「待登记的只读提及」——否则同一处会同时要求「登记」和「写命中必须为 0」两条相反的结论。
 */
function expandLocals(
  code: string,
  masked: string,
  blocks: readonly BlockSpan[],
  argumentText: string,
  callIndex: number,
): { text: string; tainted: Assignment[] } {
  let expanded = argumentText;
  const tainted: Assignment[] = [];
  for (let round = 0; round < 2; round += 1) {
    let changed = false;
    const names = new Set<string>();
    for (let match = IDENTIFIER.exec(expanded); match !== null; match = IDENTIFIER.exec(expanded)) {
      names.add(match[0]);
    }
    for (const name of names) {
      const resolved = resolveLastAssignment(code, masked, name, callIndex, blocks);
      if (resolved === undefined) continue;
      if (expanded.includes(resolved.text)) continue;
      tainted.push(resolved);
      expanded = `${expanded} ${resolved.text}`;
      changed = true;
    }
    if (!changed) break;
  }
  return { text: expanded, tainted };
}

function tokensOf(text: string): Array<{ family: Family; token: string }> {
  const found: Array<{ family: Family; token: string }> = [];
  for (const name of TIMELINE_FILE_NAMES) {
    if (text.includes(name)) found.push({ family: 'timeline', token: name });
  }
  if (text.includes(LEGACY_SESSION_LOG))
    found.push({ family: 'events', token: LEGACY_SESSION_LOG });
  if (/\bTIMELINE_LAYOUT\s*\.\s*[A-Za-z_$]/.test(text)) {
    found.push({ family: 'timeline', token: 'TIMELINE_LAYOUT' });
  }
  if (/\bsessionEventsFilePath\s*\(/.test(text)) {
    found.push({ family: 'events', token: 'sessionEventsFilePath' });
  }
  if (/\bsessionEventsFilePath\b/.test(text)) {
    // 作为函数值传递（`eventsFile: sessionEventsFilePath`）也算引用
    if (!found.some((item) => item.token === 'sessionEventsFilePath')) {
      found.push({ family: 'events', token: 'sessionEventsFilePath' });
    }
  }
  return found;
}

interface ScanResult {
  hits: Hit[];
  /**
   * 被写点「吃掉」的行号：这些行里的名字 token 属于某次写调用（`const p = join(dir, X)`
   * 之后 `atomicWrite(p, ...)` 的 `const` 那一行）。它们**不需要**再登记进 allowlist ——
   * 它们已经被「写命中必须为 0」这条更严的断言覆盖了。
   */
  writeTaintedLines: number[];
}

function scanFile(file: string, text: string): ScanResult {
  const { code, masked, literals } = scanSource(text);
  const blocks = blockSpans(masked);
  const hits: Hit[] = [];
  const writeTaintedLines: number[] = [];

  // ① 字面量命中（`'wal.log'`、`` `${dir}/events.ndjson` ``）
  for (const literal of literals) {
    for (const token of tokensOf(literal.value)) {
      hits.push({
        file,
        line: lineOf(code, literal.index),
        family: token.family,
        token: token.token,
        kind: 'mention',
        api: '',
        snippet: snippetAt(code, literal.index),
      });
    }
  }

  // ② 标识符命中（`TIMELINE_LAYOUT.x` / `sessionEventsFilePath(...)`）
  const identifierPattern = /\b(TIMELINE_LAYOUT|sessionEventsFilePath)\b/g;
  for (
    let match = identifierPattern.exec(code);
    match !== null;
    match = identifierPattern.exec(code)
  ) {
    const name = match[1] ?? '';
    if (
      name === 'TIMELINE_LAYOUT' &&
      !/\bTIMELINE_LAYOUT\s*\./.test(code.slice(match.index, match.index + 40))
    )
      continue;
    hits.push({
      file,
      line: lineOf(code, match.index),
      family: name === 'TIMELINE_LAYOUT' ? 'timeline' : 'events',
      token: name,
      kind: 'mention',
      api: '',
      snippet: snippetAt(code, match.index),
    });
  }

  /**
   * ③ / ④ 写命中：写 API 的实参（展开局部常量后）解析出名字。
   *
   * 两个入口（WWITE_APIS 与写标志的 `open`）共用这一段，保证「哪些 API 算写」只有一处定义。
   */
  function collectWrite(match: RegExpExecArray, api: string): void {
    const before = code.slice(Math.max(0, match.index - 20), match.index);
    if (/function\s+$/.test(before)) return; // 定义，不是调用
    const openIndex = match.index + match[0].length - 1;
    const call = balancedCall(masked, code, openIndex);
    if (api === 'open' && !OPEN_WRITE_FLAG.test(call)) return;
    const expanded = expandLocals(code, masked, blocks, call, match.index);
    for (const assignment of expanded.tainted) {
      for (
        let line = lineOf(code, assignment.start);
        line <= lineOf(code, assignment.end);
        line += 1
      ) {
        writeTaintedLines.push(line);
      }
    }
    for (const token of tokensOf(expanded.text)) {
      hits.push({
        file,
        line: lineOf(code, match.index),
        family: token.family,
        token: token.token,
        kind: 'write',
        api,
        snippet: snippetAt(code, match.index),
      });
      if (token.family === 'timeline' || token.family === 'events') {
        writeTaintedLines.push(lineOf(code, match.index));
      }
    }
  }

  for (const api of WRITE_APIS) {
    const pattern = new RegExp(`\\b${api}\\s*\\(`, 'g');
    for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
      collectWrite(match, api);
    }
  }
  const openPattern = /\bopen\s*\(/g;
  for (let match = openPattern.exec(masked); match !== null; match = openPattern.exec(masked)) {
    collectWrite(match, 'open');
  }

  return { hits, writeTaintedLines: [...new Set(writeTaintedLines)] };
}

// ───────────────────────────────────────────────────── 静态扫描：allowlist

interface AllowEntry {
  file: string;
  family: Family;
  token: string;
  /** 为什么这个提及不是写（必须是"读点 / 名称定义 / 用户可见文案"这一类的具体理由）。 */
  reason: string;
  /** 到这个版本必须消失（与 `package.json` 的 `version` 比较；到期即红）。 */
  expires_in: string;
}

/**
 * 只读提及的登记表（plan-054 §3.3 / §C-1 b：每条都要"原因 + 计划删除的 minor"）。
 *
 * 规矩：
 * - 这里**只登记提及**（读点 / 名称定义 / 文案）。写命中永远不可登记；
 * - 登记了却没命中 ⇒ 红（过期条目必须删掉，别留成永久豁免）；
 * - `expires_in` 到期（`version >= expires_in`）⇒ 红。
 */
const READ_ALLOWLIST: readonly AllowEntry[] = [
  // ── `events.ndjson` 的**名称定义**（旧链路唯一真相源的名字本身）──
  {
    file: 'packages/core/src/tenant/tenant-paths.ts',
    family: 'events',
    token: LEGACY_SESSION_LOG,
    reason: '唯一的 `events.ndjson` 路径构造点（`sessionEventsFilePath` 的实现体），不打开、不写',
    expires_in: '0.56.0',
  },
  {
    file: 'packages/core/src/tenant/tenant-paths.ts',
    family: 'events',
    token: 'sessionEventsFilePath',
    reason: '同上：路径构造函数的定义（`SessionEventLog` 与读点共用）',
    expires_in: '0.56.0',
  },
  {
    file: 'packages/core/src/tenant/index.ts',
    family: 'events',
    token: 'sessionEventsFilePath',
    reason: 'barrel 再导出（名字出口），无 IO',
    expires_in: '0.56.0',
  },
  {
    file: 'packages/core/src/index.ts',
    family: 'events',
    token: 'sessionEventsFilePath',
    reason: 'barrel 再导出（D2 要求跨模块只从 barrel 导入），无 IO',
    expires_in: '0.56.0',
  },
  {
    file: 'packages/core/src/timeline/freeze.ts',
    family: 'events',
    token: LEGACY_SESSION_LOG,
    reason: '冻结判据自己的常量（`LEGACY_SESSION_LOG` = 判定的一半），无 IO',
    expires_in: '0.56.0',
  },
  {
    file: 'packages/core/src/timeline/freeze.ts',
    family: 'events',
    token: LEGACY_SESSION_LOG,
    reason:
      '`session_frozen_readonly` 的错误文案（排障要能一眼看出「有旧日志、没有 timeline 标记」）',
    expires_in: '0.56.0',
  },
  // ── `events.ndjson` 的**只读使用方**（读点 / 文案 / 探针）──
  {
    file: 'packages/core/src/context/archive-notice.ts',
    family: 'events',
    token: LEGACY_SESSION_LOG,
    reason: '归档卡上的用户可见文案（告诉人去哪儿找原文），只拼显示字符串，不打开文件',
    expires_in: '0.55.0',
  },
  {
    file: 'plugins/observability/usage/src/store.ts',
    family: 'events',
    token: LEGACY_SESSION_LOG,
    reason:
      'usage 插件只读会话日志（`SESSION_LOG` 常量仅用于 readdir/stat/读），插件不能 import core 内部常量',
    expires_in: '0.55.0',
  },
  {
    file: 'src/bootstrap.ts',
    family: 'events',
    token: 'sessionEventsFilePath',
    reason:
      '装配层把只读尾窗探针的路径交给 `contextUsage` / `systemContext` / `sessionEvents`（`eventsFile` 回调，只读）',
    expires_in: '0.55.0',
  },
  {
    file: 'src/bootstrap.ts',
    family: 'events',
    token: 'sessionEventsFilePath',
    reason: '同上（import 语句也算引用，避免名字被搬走后门禁失明）',
    expires_in: '0.55.0',
  },
  {
    file: 'src/cli.ts',
    family: 'events',
    token: 'sessionEventsFilePath',
    reason: '装配层第二条入口（daemon / cli）：同一批只读探针的 `eventsFile` 回调',
    expires_in: '0.55.0',
  },
  {
    file: 'src/cli.ts',
    family: 'events',
    token: 'sessionEventsFilePath',
    reason: '同上（import 语句）',
    expires_in: '0.55.0',
  },
  // ── 迁移工具（`vessel session migrate`）：**离线读**旧日志、**只写**时间线 ──
  //
  // 为什么这些提及不该被当成「旧链路还活着」：迁移器是**唯一**被允许读 `events.ndjson`
  // 的写侧工具，它的读是**离线扫描**（一次性、无写回，源 sha256 前后自证相等）；它对
  // 时间线的写发生在会话目录里的**暂存区**（`MIGRATE_STAGING_DIR`），promote 之后才进
  // 会话目录 —— 所以它不经过 `TimelineWriter` 的冻结闸门也不破坏「唯一写者」纪律。
  {
    file: 'src/session-migrate.ts',
    family: 'events',
    token: LEGACY_SESSION_LOG,
    reason:
      '迁移器的**离线读 + 源完整性自证**（sha256 前后比对、seq 升序/缺口校验）；无写回，0.54 已全库迁移完毕，工具保留供恢复旧备份',
    expires_in: '0.56.0',
  },
  {
    file: 'src/session-migrate-command.ts',
    family: 'events',
    token: LEGACY_SESSION_LOG,
    reason:
      '迁移命令的用户可见文案（「旧格式会话只有 events.ndjson」/ 源字节数与 sha256 输出）；无 IO',
    expires_in: '0.56.0',
  },
  {
    file: 'src/i18n/messages/en.ts',
    family: 'events',
    token: LEGACY_SESSION_LOG,
    reason: '迁移命令的英文帮助文案（同一条），纯字符串，无 IO',
    expires_in: '0.56.0',
  },
  {
    file: 'src/i18n/messages/zh-CN.ts',
    family: 'events',
    token: LEGACY_SESSION_LOG,
    reason: '迁移命令的中文帮助文案（同一条），纯字符串，无 IO',
    expires_in: '0.56.0',
  },
  {
    file: 'src/session-migrate.ts',
    family: 'timeline',
    token: 'timeline.manifest',
    reason:
      '迁移器检查「这个会话是不是已经迁过」（存在 ⇔ 已迁）+ 自证时逐名读回暂存区里刚落的时间线文件；写归 core（`TimelineWriter` 写在暂存区）',
    expires_in: '0.56.0',
  },
  {
    file: 'src/session-migrate.ts',
    family: 'timeline',
    token: 'timeline.ndjson',
    reason: '同上：迁移自证逐名比对暂存区文件（只读）',
    expires_in: '0.56.0',
  },
  {
    file: 'src/session-migrate.ts',
    family: 'timeline',
    token: 'timeline.idx',
    reason: '同上：迁移自证逐名比对暂存区文件（只读）',
    expires_in: '0.56.0',
  },
  {
    file: 'src/session-migrate.ts',
    family: 'timeline',
    token: 'wal.log',
    reason: '同上：迁移自证逐名比对暂存区文件（只读）',
    expires_in: '0.56.0',
  },
  {
    file: 'src/session-migrate.ts',
    family: 'timeline',
    token: 'wal.manifest',
    reason: '同上：迁移自证逐名比对暂存区文件（只读）',
    expires_in: '0.56.0',
  },
  {
    file: 'src/session-migrate.ts',
    family: 'timeline',
    token: 'wal.blocks',
    reason: '同上：迁移自证逐名比对暂存区文件（只读）',
    expires_in: '0.56.0',
  },
  {
    file: 'src/session-migrate.ts',
    family: 'timeline',
    token: 'holes.ndjson',
    reason: '同上：迁移自证逐名比对暂存区文件（只读）',
    expires_in: '0.56.0',
  },
  // ── timeline 目录名的**只读使用方**（装配层读两指针，ADR-105 §11.1）──
  {
    file: 'src/timeline-dual-write.ts',
    family: 'timeline',
    token: 'TIMELINE_LAYOUT',
    reason:
      '`readHeadsOnDisk` 读 `timeline.manifest` 算两指针（没有内存 writer 时的只读面）；写入归 core',
    expires_in: '0.55.0',
  },
];

// ───────────────────────────────────────────────────── 静态扫描：断言

function compareVersion(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** 「只有一个写者」的两条豁免目录（与断言一一对应，不是 allowlist）。 */
const EVENTS_WRITER_FILE = 'packages/core/src/session/session-event-log.ts';
const TIMELINE_WRITER_DIR = 'packages/core/src/timeline/';

function describeWriteHit(hit: Hit): string {
  return `${hit.file}:${hit.line} ${hit.api}(...) 命中 ${hit.token} ｜ ${hit.snippet}`;
}

function judgeLayoutCoverage(): void {
  const unregistered = Object.keys(TIMELINE_LAYOUT).filter((key) => {
    if ((TIMELINE_FILE_KEYS as readonly string[]).includes(key)) return false;
    if ((GENERIC_LAYOUT_KEYS as readonly string[]).includes(key)) return false;
    return true;
  });
  assertTrue(
    '扫描器覆盖 `TIMELINE_LAYOUT` 的全部文件名（新增布局名必须登记，否则断言会悄悄漏）',
    unregistered.length === 0,
    unregistered.length === 0
      ? `已登记 ${TIMELINE_FILE_NAMES.length} 个；通用名不扫：${GENERIC_LAYOUT_KEYS.join(', ')}`
      : `未登记：${unregistered.join(', ')}`,
  );
}

function judgeScannerSelfTest(): void {
  const positive = [
    'const p = join(dir, TIMELINE_LAYOUT.walLog);',
    "await atomicWrite(p, 'x');",
  ].join('\n');
  const hitsPositive = scanFile('selftest/positive.ts', positive).hits;
  assertTrue(
    '自检①：`const p = join(dir, TIMELINE_LAYOUT.walLog); atomicWrite(p, ...)` 必须抓到写命中',
    hitsPositive.some((hit) => hit.kind === 'write' && hit.token === 'TIMELINE_LAYOUT'),
    JSON.stringify(hitsPositive.map((hit) => `${hit.kind}:${hit.token}`)),
  );

  const commentOnly = [
    '/** 这里只有注释提到 wal.log / timeline.manifest / events.ndjson */',
    '// 还有一行注释提到 TIMELINE_LAYOUT.walManifest',
    'await mkdir(sessionDir, { recursive: true });',
  ].join('\n');
  const hitsComment = scanFile('selftest/comment.ts', commentOnly).hits;
  assertTrue(
    '自检②：注释里的文件名不算命中（否则文案越写越红）',
    hitsComment.length === 0,
    JSON.stringify(hitsComment.map((hit) => `${hit.kind}:${hit.token}`)),
  );

  const eventType = [
    "if (event.type.startsWith('timeline.')) return false;",
    "publishDiagnostic('timeline.gap_reported', 'timeline', report);",
  ].join('\n');
  const hitsEventType = scanFile('selftest/event-type.ts', eventType).hits;
  assertTrue(
    "自检③：事件类型名（`timeline.gap_reported` / `startsWith('timeline.')`）不是文件名，不算命中",
    hitsEventType.length === 0,
    JSON.stringify(hitsEventType.map((hit) => `${hit.kind}:${hit.token}`)),
  );

  const eventsWrite = [
    'const log = sessionEventsFilePath(dir, id);',
    "await appendFile(log, line, 'utf8');",
  ].join('\n');
  const hitsEventsWrite = scanFile('selftest/events-write.ts', eventsWrite).hits;
  assertTrue(
    '自检④：`const log = sessionEventsFilePath(...); appendFile(log, ...)` 必须抓到 events 写命中',
    hitsEventsWrite.some((hit) => hit.kind === 'write' && hit.family === 'events'),
    JSON.stringify(hitsEventsWrite.map((hit) => `${hit.kind}:${hit.token}`)),
  );

  const readOnly = [
    'const records = await readTimelineEvents(sessionDir);',
    'const manifest = await readCrcNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.timelineManifest));',
  ].join('\n');
  const hitsReadOnly = scanFile('selftest/read-only.ts', readOnly).hits;
  assertTrue(
    '自检⑤：读点的 `join(dir, TIMELINE_LAYOUT.x)` 只算提及，不算写',
    hitsReadOnly.length > 0 && hitsReadOnly.every((hit) => hit.kind === 'mention'),
    JSON.stringify(hitsReadOnly.map((hit) => `${hit.kind}:${hit.token}`)),
  );
}

async function judgeStaticScan(): Promise<void> {
  const files = await listSourceFiles();
  info(`扫描 ${files.length} 个产品源文件（roots: ${SCAN_ROOTS.join(', ')}）`);

  const hits: Hit[] = [];
  const taintedByFile = new Map<string, Set<number>>();
  for (const file of files) {
    const text = await readFile(join(REPO_ROOT, file), 'utf8');
    const scanned = scanFile(file, text);
    hits.push(...scanned.hits);
    taintedByFile.set(file, new Set(scanned.writeTaintedLines));
  }
  const writeHits = hits.filter((hit) => hit.kind === 'write');
  const mentionHits = hits.filter((hit) => hit.kind === 'mention');
  info(`命中：写 ${writeHits.length} 条 / 提及 ${mentionHits.length} 条`);
  info(
    '写命中清单（证据；C-1a/C-1b 的判据就是「清单里不许出现 core/timeline 与 session-event-log.ts 之外的行」）：',
  );
  for (const hit of writeHits.sort((a, b) => (a.file < b.file ? -1 : 1))) {
    info(`  · ${describeWriteHit(hit)}`);
  }
  // 范围的边界写清楚：本门禁判「唯一写者」，不判「旧链路停止写」。后者是停写单
  // （plan-054 §C 阶段 ②）的判据 —— 今天这些写点**仍然存在且必须存在**，
  // 把它们算成红只会让门禁被绕过。
  info(
    '范围外（本门禁不判，归停写单）：旧链路仍在写 —— `SessionEventLog`（`events.ndjson`）、' +
      '`FileTraceRecorder`（`data/events/<run_id>.jsonl`，packages/core/src/observability/trace-recorder.ts）；' +
      '`deleteSessionData` / `SessionEventLog.deleteSession` 的 `rm -r` 是用户显式删除，不在「写」集合里。',
  );

  // C-1a：写 events.ndjson 只允许 session-event-log.ts
  const eventsWrites = writeHits.filter(
    (hit) => hit.family === 'events' && hit.file !== EVENTS_WRITER_FILE,
  );
  assertTrue(
    'C-1a 写 events.ndjson 的调用点只有 packages/core/src/session/session-event-log.ts 一处',
    eventsWrites.length === 0,
    eventsWrites.length === 0
      ? `session-event-log.ts 内 ${writeHits.filter((hit) => hit.family === 'events').length} 处（唯一写者）`
      : eventsWrites.map(describeWriteHit).join(' ｜ '),
  );

  // C-1b：写 timeline 目录只允许 packages/core/src/timeline/**
  const timelineWrites = writeHits.filter(
    (hit) => hit.family === 'timeline' && !hit.file.startsWith(TIMELINE_WRITER_DIR),
  );
  assertTrue(
    'C-1b 写 timeline 目录的路径必须经过 TimelineWriter.open（core/timeline 之外 0 处）',
    timelineWrites.length === 0,
    timelineWrites.length === 0
      ? `core/timeline 内 ${writeHits.filter((hit) => hit.family === 'timeline').length} 处`
      : timelineWrites.map(describeWriteHit).join(' ｜ '),
  );
  for (const hit of timelineWrites) {
    evidence('C-1b 违规写点', describeWriteHit(hit));
  }

  // 提及（读点 / 名称定义）必须逐条登记；属于写点内部的 token 不登记（已被更严的断言覆盖）
  const needsRegistry = mentionHits.filter((hit) => {
    if (hit.family === 'events' && hit.file === EVENTS_WRITER_FILE) return false;
    if (hit.family === 'timeline' && hit.file.startsWith(TIMELINE_WRITER_DIR)) return false;
    if (taintedByFile.get(hit.file)?.has(hit.line) === true) return false;
    return true;
  });
  const unregistered = needsRegistry.filter(
    (hit) =>
      !READ_ALLOWLIST.some(
        (entry) =>
          entry.file === hit.file && entry.family === hit.family && entry.token === hit.token,
      ),
  );
  assertTrue(
    'C-1a/C-1b 侧：core/timeline 与 session-event-log.ts 之外的每一处提及都登记了（原因 + 到期版本）',
    unregistered.length === 0,
    unregistered.length === 0
      ? `已登记 ${needsRegistry.length} 条（allowlist ${READ_ALLOWLIST.length} 项）`
      : unregistered
          .map((hit) => `${hit.file}:${hit.line} ${hit.family}:${hit.token} ｜ ${hit.snippet}`)
          .join(' ｜ '),
  );
  for (const hit of unregistered) {
    evidence('未登记的提及', `${hit.file}:${hit.line} ${hit.family}:${hit.token}`);
  }

  const staleEntries = READ_ALLOWLIST.filter(
    (entry) =>
      !needsRegistry.some(
        (hit) =>
          hit.file === entry.file && hit.family === entry.family && hit.token === entry.token,
      ),
  );
  assertTrue(
    'allowlist 没有僵尸条目（登记了却不再命中 ⇒ 必须删掉，不许当永久豁免）',
    staleEntries.length === 0,
    staleEntries.length === 0
      ? `${READ_ALLOWLIST.length} 项全部命中`
      : staleEntries.map((entry) => `${entry.file} ${entry.token}`).join(' ｜ '),
  );

  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const version = packageJson.version ?? '0.0.0';
  const expired = READ_ALLOWLIST.filter((entry) => compareVersion(version, entry.expires_in) >= 0);
  assertTrue(
    `allowlist 没有到期条目（当前 ${version}）`,
    expired.length === 0,
    expired.length === 0
      ? `最晚到期：${
          READ_ALLOWLIST.map((entry) => entry.expires_in)
            .sort()
            .at(-1) ?? '-'
        }`
      : expired
          .map((entry) => `${entry.file} ${entry.token} expires_in=${entry.expires_in}`)
          .join(' ｜ '),
  );
}

// ───────────────────────────────────────────── 行为：旧格式会话判定（标记文件）

interface DirSnapshot {
  names: string[];
  digests: Record<string, string>;
}

async function snapshotDir(root: string, prefix = ''): Promise<DirSnapshot> {
  const names: string[] = [];
  const digests: Record<string, string> = {};
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { names, digests };
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    names.push(rel);
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await snapshotDir(path, rel);
      names.push(...nested.names);
      Object.assign(digests, nested.digests);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(path);
    digests[rel] = createHash('sha256').update(bytes).digest('hex');
  }
  return { names: names.sort(), digests };
}

const NOW = 1_760_000_000_000;
const LEGACY_SESSION_ID = 'legacy-c1';
const LEGACY_RUN_ID = 'run-legacy-c1';

const LEGACY_RECORDS = [
  {
    v: 1,
    seq: 1,
    session_id: LEGACY_SESSION_ID,
    run_id: LEGACY_RUN_ID,
    ts: NOW,
    type: 'run.started',
    data: { run_id: LEGACY_RUN_ID },
  },
  {
    v: 1,
    seq: 2,
    session_id: LEGACY_SESSION_ID,
    run_id: LEGACY_RUN_ID,
    ts: NOW + 1,
    type: 'user.message',
    data: { text: 'legacy hello' },
  },
  {
    v: 1,
    seq: 3,
    session_id: LEGACY_SESSION_ID,
    run_id: LEGACY_RUN_ID,
    ts: NOW + 2,
    type: 'assistant.message',
    data: { text: 'legacy answer' },
  },
] as const;

const LEGACY_TRACE_EVENTS: Array<Record<string, unknown>> = [
  { type: 'run.started', run_id: LEGACY_RUN_ID, ts: NOW, seq: 1, data: { run_id: LEGACY_RUN_ID } },
  { type: 'user.message', run_id: LEGACY_RUN_ID, ts: NOW + 1, seq: 2, data: { text: 'hello' } },
  { type: 'context.changed', run_id: LEGACY_RUN_ID, ts: NOW + 2, seq: 3, data: { reason: 'x' } },
];

interface Fixture {
  root: string;
  sessionsDir: string;
  traceDir: string;
  sessionDir: string;
  legacyBytes: string;
}

/** 造一个**真正的旧格式会话**：`events.ndjson` + `index.json` + 旧 trace，没有任何 timeline 文件。 */
async function createLegacyFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-legacy-readonly-'));
  const sessionsDir = join(root, 'sessions');
  const sessionDir = sessionDirPath(sessionsDir, LEGACY_SESSION_ID);
  const traceDir = join(root, 'events');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(traceDir, { recursive: true });
  const legacyBytes = `${LEGACY_RECORDS.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await writeFile(join(sessionDir, LEGACY_SESSION_LOG), legacyBytes, 'utf8');
  await writeFile(
    join(sessionDir, 'index.json'),
    `${JSON.stringify(
      {
        v: 1,
        session_id: LEGACY_SESSION_ID,
        status: 'completed',
        started_at: NOW,
        updated_at: NOW + 2,
        event_count: LEGACY_RECORDS.length,
        derived_upto_seq: LEGACY_RECORDS.length,
        messages_cached: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(traceDir, `${encodeURIComponent(LEGACY_RUN_ID)}.jsonl`),
    `${LEGACY_TRACE_EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  return { root, sessionsDir, traceDir, sessionDir, legacyBytes };
}

/**
 * 旧格式判定矩阵：标记文件是判定的一半，必须逐条钉住。
 *
 * 五个夹具 = 「只有旧日志」+ 三个标记各一次 + 「旧日志都没有」。最后一个反向夹具保证
 * 断言不是「凡是目录都判旧格式」。
 */
async function judgeFreezePredicate(): Promise<void> {
  info(
    `旧格式判定：有 ${LEGACY_SESSION_LOG} 且无 ${TIMELINE_MARKERS.join(' / ')}（packages/core/src/timeline/freeze.ts）`,
  );
  const root = await mkdtemp(join(tmpdir(), 'vessel-legacy-predicate-'));
  const cases: Array<{ label: string; files: string[]; want: boolean }> = [
    { label: `只有 ${LEGACY_SESSION_LOG}`, files: [LEGACY_SESSION_LOG], want: true },
    {
      label: `${LEGACY_SESSION_LOG} + ${TIMELINE_LAYOUT.timelineManifest}`,
      files: [LEGACY_SESSION_LOG, TIMELINE_LAYOUT.timelineManifest],
      want: false,
    },
    {
      label: `${LEGACY_SESSION_LOG} + ${TIMELINE_LAYOUT.walManifest}`,
      files: [LEGACY_SESSION_LOG, TIMELINE_LAYOUT.walManifest],
      want: false,
    },
    {
      label: `${LEGACY_SESSION_LOG} + ${TIMELINE_LAYOUT.walLog}`,
      files: [LEGACY_SESSION_LOG, TIMELINE_LAYOUT.walLog],
      want: false,
    },
    { label: `空目录（连旧日志都没有）`, files: [], want: false },
  ];
  for (const item of cases) {
    const dir = join(root, item.label.replace(/[^\w]+/g, '_'));
    await mkdir(dir, { recursive: true });
    for (const file of item.files) {
      await writeFile(join(dir, file), '', 'utf8');
    }
    assertEqual(
      `旧格式判定：${item.label} ⇒ ${item.want}`,
      await isLegacyFrozenSessionDir(dir),
      item.want,
    );
  }
  await rm(root, { recursive: true, force: true });
}

// ───────────────────────────────────────────── 行为：读路径逐字节不变 + 写被拒

interface SessionsEventsResult {
  events: Array<{ seq: number; type: string; ts: number; run_id?: string; data?: unknown }>;
  next_seq: number;
  latest_seq: number;
  has_more: boolean;
}

interface EventsListResult {
  events: Array<Record<string, unknown>>;
}

const QUIET_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 写入口的期望结果：抛 `session_frozen_readonly`，或者至少**一个字节都不写**。 */
type WriteEntryOutcome =
  | { kind: 'reject'; code: string }
  | { kind: 'no-throw' }
  | { kind: 'other-error'; code: string; message: string };

async function runWriteEntry(fn: () => Promise<unknown>): Promise<WriteEntryOutcome> {
  try {
    await fn();
    return { kind: 'no-throw' };
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'session_frozen_readonly') return { kind: 'reject', code };
    return { kind: 'other-error', code, message };
  }
}

async function judgeBehaviour(): Promise<void> {
  const fixture = await createLegacyFixture();
  const quiet = QUIET_LOGGER;
  try {
    const log = new SessionEventLog({
      dir: fixture.sessionsDir,
      durable: false,
      logger: quiet,
    });
    const sessionMethods = createSessionMethods({
      sessionFor: () =>
        ({
          load: async (id: string) => ({ session_id: id, messages: [], status: 'completed' }),
        }) as never,
      sessionEvents: createSessionEventsSource({
        log,
        eventsFile: (id) => join(sessionDirPath(fixture.sessionsDir, id), LEGACY_SESSION_LOG),
      }),
    });
    // 0.54 C：`sessions.events` 的**唯一**读源是时间线，所以这里要两种装配：
    // - 没有 timeline 端口 ⇒ 能力没注入 ⇒ `not_supported`（不悄悄退回旧日志）；
    // - 注入「该会话还没有时间线标记」的空端口 ⇒ 空页（`EMPTY_TIMELINE_HEADS`）。
    const sessionMethodsEmptyTimeline = createSessionMethods({
      sessionFor: () =>
        ({
          load: async (id: string) => ({ session_id: id, messages: [], status: 'completed' }),
        }) as never,
      timelineHeads: { lookup: async () => undefined },
      timelineRead: { readPage: async () => [] },
    });
    // `events.list` 同理：没有 timeline 端口 ⇒ `not_supported`；端口在但时间线上没有这个
    // run ⇒ 空列表。**两条都不读 `data/events/<run>.jsonl`**（那张表已不在读路径上）。
    const eventsMethods = createEventsMethods({});
    const eventsMethodsEmptyTimeline = createEventsMethods({
      timelineRunEvents: { read: async () => [] },
    });

    const sessionsEventsMethod = sessionMethods.find((item) => item.name === 'sessions.events');
    if (sessionsEventsMethod === undefined) throw new Error('sessions.events missing');
    const sessionsEventsEmptyMethod = sessionMethodsEmptyTimeline.find(
      (item) => item.name === 'sessions.events',
    );
    if (sessionsEventsEmptyMethod === undefined) throw new Error('sessions.events missing (empty)');
    const eventsListMethod = eventsMethods.find((item) => item.name === 'events.list');
    if (eventsListMethod === undefined) throw new Error('events.list missing');
    const eventsListEmptyMethod = eventsMethodsEmptyTimeline.find(
      (item) => item.name === 'events.list',
    );
    if (eventsListEmptyMethod === undefined) throw new Error('events.list missing (empty)');

    /** 读一次 `sessions.events`：区分「抛错」与「返回一页」（两者都是被断言的行为）。 */
    async function sessionsEventsOutcome(
      method: typeof sessionsEventsMethod | undefined,
    ): Promise<{ kind: 'error'; code: string } | { kind: 'page'; page: SessionsEventsResult }> {
      if (method === undefined) throw new Error('sessions.events missing');
      try {
        const page = (await method.handler(
          { session_id: LEGACY_SESSION_ID },
          {} as never,
        )) as SessionsEventsResult;
        return { kind: 'page', page };
      } catch (error) {
        return { kind: 'error', code: (error as { code?: string }).code ?? '' };
      }
    }

    async function eventsListOutcome(
      method: typeof eventsListMethod | undefined,
    ): Promise<{ kind: 'error'; code: string } | { kind: 'page'; page: EventsListResult }> {
      if (method === undefined) throw new Error('events.list missing');
      try {
        const page = (await method.handler(
          { run_id: LEGACY_RUN_ID },
          {} as never,
        )) as EventsListResult;
        return { kind: 'page', page };
      } catch (error) {
        return { kind: 'error', code: (error as { code?: string }).code ?? '' };
      }
    }
    const EMPTY_SESSIONS_EVENTS_PAGE: SessionsEventsResult = {
      events: [],
      next_seq: 0,
      latest_seq: 0,
      has_more: false,
    };

    // ① 基线（0.54 C 起）：**读面不再服务旧源**。
    //
    // 旧断言是"读结果与 events.ndjson / trace 逐字节相同"——那两条读路径正是本单删掉的
    // （`sessions.events` / `events.list` 的唯一读源已是时间线）。所以这里断言的**对象**
    // 换成"现在真实发生的事"，而不是把断言删掉：
    // 旧目录里的数据**不再**从这两条 RPC 出去，且旧文件本体一字节没动。
    assertTrue(
      'C-1c① 夹具确实写着旧日志与旧 trace（否则下面"读不到"是空断言）',
      LEGACY_RECORDS.length > 0 && LEGACY_TRACE_EVENTS.length > 0,
      `session-log=${LEGACY_RECORDS.length} trace=${LEGACY_TRACE_EVENTS.length}`,
    );
    const sessionsEventsBefore = await sessionsEventsOutcome(sessionsEventsMethod);
    assertEqual(
      'C-1c① sessions.events（未注入 timeline 端口）⇒ not_supported（不退回旧日志）',
      sessionsEventsBefore,
      { kind: 'error', code: 'not_supported' },
    );
    const sessionsEventsEmptyBefore = await sessionsEventsOutcome(sessionsEventsEmptyMethod);
    assertEqual(
      'C-1c① sessions.events（注入空 timeline）⇒ 空页，旧日志一条都不出',
      sessionsEventsEmptyBefore,
      { kind: 'page', page: EMPTY_SESSIONS_EVENTS_PAGE },
    );
    const eventsListBefore = await eventsListOutcome(eventsListMethod);
    assertEqual(
      'C-1c① events.list（未注入 timeline 端口）⇒ not_supported（不退回旧 trace）',
      eventsListBefore,
      { kind: 'error', code: 'not_supported' },
    );
    const eventsListEmptyBefore = await eventsListOutcome(eventsListEmptyMethod);
    assertEqual(
      'C-1c① events.list（注入空 timeline）⇒ 空列表，旧 trace 一条都不出',
      eventsListEmptyBefore,
      { kind: 'page', page: { events: [] } },
    );
    const snapshotBefore = await snapshotDir(fixture.sessionDir);

    // ② 写入口逐个尝试：抛 session_frozen_readonly 或 0 字节
    const entries: Array<{ label: string; run: () => Promise<unknown> }> = [
      {
        label: 'TimelineWriter.open（唯一写者）',
        run: () =>
          TimelineWriter.open({ sessionId: LEGACY_SESSION_ID, sessionDir: fixture.sessionDir }),
      },
      {
        label: 'rebuildIndexFiles（索引重建）',
        run: () => rebuildIndexFiles(fixture.sessionDir),
      },
      {
        label: 'TimelineIndexReader.open（建索引的"读"入口）',
        run: () => TimelineIndexReader.open(fixture.sessionDir),
      },
      {
        label: '装配层双写 createTimelineDualWrite().record（src/timeline-dual-write）',
        run: async () => {
          const dual = createTimelineDualWrite({
            dataDir: fixture.root,
            sessionsDir: fixture.sessionsDir,
            dualWrite: true,
            archiveIntervalMs: 0,
            verifySampleRate: 0,
            logger: quiet,
          });
          try {
            dual.record(LEGACY_SESSION_ID, {
              run_id: LEGACY_RUN_ID,
              type: 'user.message',
              ts: NOW + 3,
              data: { text: 'must not be written' },
              persisted: true,
            });
            await dual.finishRun(LEGACY_SESSION_ID, LEGACY_RUN_ID);
            await dual.flushSession(LEGACY_SESSION_ID);
          } finally {
            await dual.closeAll();
          }
        },
      },
    ];

    const outcomes: Array<{ label: string; outcome: WriteEntryOutcome }> = [];
    for (const entry of entries) {
      const outcome = await runWriteEntry(entry.run);
      outcomes.push({ label: entry.label, outcome });
    }
    for (const item of outcomes) {
      if (item.outcome.kind === 'reject') {
        pass(`C-1c② ${item.label} ⇒ 拒绝，码 = ${item.outcome.code}`);
      } else if (item.outcome.kind === 'no-throw') {
        fail(
          `C-1c② ${item.label} ⇒ 没抛错（必须抛 session_frozen_readonly，或至少一个字节都不写；见下一条目录断言）`,
          'no-throw',
        );
      } else {
        fail(
          `C-1c② ${item.label} ⇒ 抛的是「别的错误」`,
          `code=${item.outcome.code} message=${item.outcome.message}`,
        );
      }
    }
    assertTrue(
      'C-1c② 所有写入口的错误码要么是 session_frozen_readonly、要么根本没抛（没有第三个码）',
      outcomes.every((item) => item.outcome.kind !== 'other-error'),
      outcomes
        .map((item) =>
          item.outcome.kind === 'reject'
            ? `${item.label}=session_frozen_readonly`
            : item.outcome.kind === 'no-throw'
              ? `${item.label}=no-throw`
              : `${item.label}=${item.outcome.code}`,
        )
        .join(' ｜ '),
    );

    // ③ 冻结面：目录里一个 timeline 文件都不许出现，现有文件一个字节都不许变
    const snapshotAfterWrites = await snapshotDir(fixture.sessionDir);
    const timelineArtifacts = snapshotAfterWrites.names.filter((name) =>
      [
        ...TIMELINE_MARKERS,
        TIMELINE_LAYOUT.timeline,
        TIMELINE_LAYOUT.holes,
        TIMELINE_LAYOUT.indexDir,
      ].some((marker) => name === marker || name.startsWith(`${marker}/`)),
    );
    assertEqual('C-1c③ 冻结层碰过之后会话目录里没有任何 timeline 文件', timelineArtifacts, []);
    assertEqual(
      'C-1c③ 目录条目集合一字节不变（不新增、不删除）',
      snapshotAfterWrites.names,
      snapshotBefore.names,
    );
    assertEqual(
      'C-1c③ 目录内所有文件的内容摘要不变',
      snapshotAfterWrites.digests,
      snapshotBefore.digests,
    );
    assertBytes(
      'C-1c③ events.ndjson 本体逐字节不变',
      await readFile(join(fixture.sessionDir, LEGACY_SESSION_LOG), 'utf8'),
      fixture.legacyBytes,
    );

    // ④ 写入口碰过之后，读面的行为**没变**（同一批断言重跑一遍）。
    //
    // 这一条不是"复读"：旧实现在冻结层的写尝试之后可能把 `index.json` / 写句柄状态改掉，
    // 从而改变读结果；现在读面根本不看旧目录，所以要证明的是「碰过之后还是同样的两条
    // 结论」——未注入端口仍 `not_supported`、注入空 timeline 仍空页（旧日志一条都不出）。
    const sessionsEventsAfter = await sessionsEventsOutcome(sessionsEventsMethod);
    assertEqual(
      'C-1c④ 冻结层碰过之后 sessions.events 仍然 not_supported',
      sessionsEventsAfter,
      sessionsEventsBefore,
    );
    const sessionsEventsEmptyAfter = await sessionsEventsOutcome(sessionsEventsEmptyMethod);
    assertEqual(
      'C-1c④ 冻结层碰过之后 sessions.events 仍是空页（旧日志一条都不出）',
      sessionsEventsEmptyAfter,
      { kind: 'page', page: EMPTY_SESSIONS_EVENTS_PAGE },
    );
    const eventsListAfter = await eventsListOutcome(eventsListMethod);
    assertEqual(
      'C-1c④ 冻结层碰过之后 events.list 仍然 not_supported',
      eventsListAfter,
      eventsListBefore,
    );
    const eventsListEmptyAfter = await eventsListOutcome(eventsListEmptyMethod);
    assertEqual(
      'C-1c④ 冻结层碰过之后 events.list 仍是空列表（旧 trace 一条都不出）',
      eventsListEmptyAfter,
      { kind: 'page', page: { events: [] } },
    );

    // ⑤ 订阅侧（0.54 C 后）：没有时间线标记的会话**不再**被拒成 `session_frozen_readonly`。
    //
    // 旧格式只读冻结在 0.54 cutover 之后**只剩写保护**（`freeze.ts#assertTimelineWritable`，
    // 由本脚本的 ② / C-1c② 断言覆盖）；读面上「没有标记」与「刚建好的新会话」形状相同，
    // 把它报成"旧格式只读冻结"是假事实。所以这里断言**现在的真实行为**：
    // 裁决给出空段，且 `end_seq = start_seq - 1` / `count = 0`（没有任何可发的帧）。
    const decision = decideTimelineSubscribe({
      afterTimelineSeq: LEGACY_RECORDS.length,
      sinceGiven: false,
      sessionId: LEGACY_SESSION_ID,
      headsInjected: true,
      heads: undefined,
      readPortInjected: true,
    });
    assertEqual(
      'C-1c⑤ decideTimelineSubscribe(无时间线标记, after_timeline_seq) ⇒ 空段',
      decision,
      {
        kind: 'timeline',
        heads: EMPTY_TIMELINE_HEADS,
      },
    );
    if (decision.kind !== 'timeline') {
      throw new Error(`C-1c⑤ 期望 kind=timeline（空段），收到 ${decision.kind}`);
    }
    const segment = timelineHello({
      afterTimelineSeq: LEGACY_RECORDS.length,
      heads: decision.heads,
    });
    assertEqual(
      'C-1c⑤ 空段的形状：end_seq = start_seq - 1 且 count = 0（不发帧、不抛错）',
      [segment.end_seq, segment.start_seq - 1, segment.count, segment.wal_head],
      [segment.start_seq - 1, segment.end_seq, 0, 0],
    );
    assertEqual(
      'C-1c⑤ 空段没有任何可读 seq（页读为空） ⇒ 客户端不会去重试一个不存在的区间',
      selectTimelinePage([], segment.start_seq, segment.end_seq),
      [],
    );
    const gatewayText = await readFile(join(REPO_ROOT, 'packages/serve/src/gateway.ts'), 'utf8');
    assertTrue(
      'C-1c⑤ gateway 把 decision.code 原样交给客户端（不换成别的码、不静默）',
      // 0.54 B1 过渡期把「subscribed:false + reject 对象」改成了**真 throw**
      // `throw new RpcError(decision.code, decision.message)` —— 码照样逐字透传，而且更严格
      // （拒绝路径不再需要调用方自己把它翻译成错误帧）。
      // 断言意图不变：**错误码必须原样来自 decision**。真 throw 形状里 `RpcError(decision.code, …)`
      // 本身就证明了这一点，所以**不再**要求旧的 `code: decision.code` 对象字面量同时存在
      // （那个形状已不存在，继续要求它等于把断言钉死在旧实现上）。
      /throw new RpcError\(\s*decision\.code\s*,\s*decision\.message\s*\)/.test(gatewayText),
      'packages/serve/src/gateway.ts 里 `throw new RpcError(decision.code, decision.message)`',
    );

    // ⑥ 反向（保证断言不真空）：新格式会话的写入口必须**真的能写**
    const freshDir = join(fixture.sessionsDir, 'fresh-c1');
    await mkdir(freshDir, { recursive: true });
    const freshWriter = await TimelineWriter.open({
      sessionId: 'fresh-c1',
      sessionDir: freshDir,
      chunkFlushMs: 20,
    });
    await freshWriter.append({ run_id: 'run-fresh', type: 'run.started', ts: NOW, data: {} });
    await freshWriter.flush();
    await freshWriter.close();
    const freshSnapshot = await snapshotDir(freshDir);
    assertTrue(
      'C-1c⑥ 反向对照：新格式会话（无 events.ndjson）写者能建 timeline（断言不是「一律拒写」）',
      freshSnapshot.names.includes(TIMELINE_LAYOUT.walLog) &&
        freshSnapshot.names.includes(TIMELINE_LAYOUT.timelineManifest),
      freshSnapshot.names.join(', '),
    );

    await log.close();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

// ───────────────────────────────────────────────────────────────── 汇总

/**
 * 已知的区块链（**只用来把话说清楚，不参与判定**）。
 *
 * 这是 C-1 在 `freeze-c1` 这一单里**修不动**的那一处：文件属于 `src/**`（ADR-105 §11.1 里
 * 记的装配层），单子边界内不许改。它在这里的意义是：门禁红的时候，报告里已经写清
 * 「是哪一处、为什么、归谁、怎么修、到期版本」，而不是留一条要看源码才能懂的 FAIL。
 *
 * 红线：这张表**不会**让任何断言变绿。命中它的违规仍然逐条 FAIL；
 * 新出现的违规（哪怕在同一个文件）也不会因为这张表而豁免 —— 匹配粒度是「文件 + 症状」，
 * 只是文案。
 */
const KNOWN_BLOCKERS = [
  {
    title: 'C-1b / C-1c② / C-1c③：装配层在写者之外写 `timeline.manifest`',
    where: 'src/timeline-dual-write.ts:414-425 `ensureTimelineMarker()`，调用点 :869 `writerFor()`',
    why:
      '双写在 `TimelineWriter.open()` 之前先把 `timeline.manifest` 落好，绕过了写者的「旧格式会话 ⇒ session_frozen_readonly」判定；' +
      '旧会话因此被就地解冻：`wal.log` / `wal.blocks` / `holes.ndjson` / `timeline.idx/` 一起被创建（C-1c③ 的实测 diff）。',
    owner: '`src/**` 的当前 owner（pub-i2 正在改这个文件；freeze-c1 单子的边界不含 src/**）',
    fix:
      '两种修法都要动 src：(a) 删掉 `ensureTimelineMarker`，改由装配层显式回答「这个会话是不是本进程刚建的」——旧会话跳过双写' +
      '（旧链路照常写、读路径一字节不变）；(b) 标记创建回到 core 的 `ensureManifest()`，装配层传一个显式的 `adoptExistingSession` 之类的一次性开关。' +
      '共同点：**freeze 判据只能有一份**（现在是 `packages/core/src/timeline/freeze.ts`）。',
    expires_in: '0.55.0',
  },
] as const;

function reportBlockers(): void {
  if (failures === 0) return;
  console.log('');
  console.log('── 已知阻塞项（不参与判定，只为把报告写明白） ---------------------------');
  for (const blocker of KNOWN_BLOCKERS) {
    console.log(`[BLOCKED] ${blocker.title}`);
    console.log(`          where: ${blocker.where}`);
    console.log(`          why:   ${blocker.why}`);
    console.log(`          owner: ${blocker.owner}`);
    console.log(`          fix:   ${blocker.fix}`);
    console.log(
      `          到期:  ${blocker.expires_in}（到期未修 ⇒ 这条豁免话术作废，按 FAIL 处理）`,
    );
  }
}

async function main(): Promise<void> {
  console.log('0.54 C-1 门禁：旧格式会话只读冻结（plan-054 §C-1 / ADR-105 §7 A8）');

  section('0 扫描器自检（自检红 ⇒ 后面所有绿都不算）');
  judgeLayoutCoverage();
  judgeScannerSelfTest();

  section('C-1a / C-1b 静态门（扫产品源码：写点 + 提及登记）');
  await judgeStaticScan();

  section('C-1c 行为（旧格式判定 / 读逐字节不变 / 写被同一个码拒绝）');
  await judgeFreezePredicate();
  await judgeBehaviour();

  reportBlockers();
  console.log('');
  console.log(`检查 ${checks} 条，失败 ${failures} 条`);
  if (failures > 0) {
    console.log('结果：FAIL');
    process.exit(1);
  }
  console.log('结果：PASS');
}

await main();
