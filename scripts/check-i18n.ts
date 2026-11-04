#!/usr/bin/env bun

/**
 * Web i18n 契约检查（0.33）。
 *
 * 事实源：`apps/web/src/i18n/messages/{zh-CN,en}.ts`。
 *
 * 规则：
 *   I1 两份 catalog 的 key 集合必须完全相等（双向报缺失）。
 *   I2 代码中 `t('literal')` 的 key 必须存在于 zh-CN catalog。
 *   I3 代码中模板字面量调用的静态前缀必须能命中至少一个 key。
 *   I4 同一 key 在两份 catalog 的 `{placeholder}` 集合必须一致。
 *   I5 孤儿 key 报告：catalog 有、`apps/web/src/**` 零引用的 key。**只报告，
 *      不删除、不阻断**（默认 warn，1 已裁决；删 key 改界面文案同样需 1 裁决）。
 *      转 error 的门槛：孤儿清零、或剩余项全部白名单化到本文件的显式清单之后
 *      才翻 error；在此之前翻只会长期假红。
 *
 * 为什么需要：缺 key 时 `t()` 静默回退成 key 本身，界面直接出现
 * `agents.close.title` 这种裸键；typecheck 与 biome 都抓不到。
 *
 * 不做的事：不校验文案内容与措辞（与 `check-docs.ts` 同口径），也不解析
 * `t(variable)` 这种完全动态的 key——这类调用点单列进 I5 的待人工确认。
 *
 * **I5 的结构性盲区（每条孤儿都必须人工复核这一条）**：helper 里拼出来的 key 不算引用。
 * 案例：`apps/web/src/domains/team/role.ts` 的 `roleLabelKey()` 只 `return \`team.role.${role}\``，
 * 模板不在 `t()` 实参位置，所以 `team.role.member` / `team.role.temporary` 会被静默判成孤儿；
 * 但 `roleOf()` 会返回 `'member'` 或 `'temporary'`，删任何一个都会让侧栏显示裸键。
 * 1 已裁决：不加白名单、接受这点误差（常驻 warn），所以改 I5 规则前先重新裁决。
 *
 * 用法：`bun run scripts/check-i18n.ts [--orphans] [repoRoot]`
 *   `--orphans` 额外打印 I5 完整报告（分组 + 待人工确认）；它自身永不改变退出码。
 * 退出码：0 = 通过；1 = 有 issue（仅 I1–I4）。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const I18N_DIR = 'apps/web/src/i18n';
const SOURCE_DIR = 'apps/web/src';
const BASE_LOCALE = 'zh-CN';
const OTHER_LOCALE = 'en';

interface Issue {
  file: string;
  line: number;
  message: string;
}

type Catalog = Record<string, string>;

const SOURCE_FILE = /\.tsx?$/;
/** `t('key')` —— 引号字面量。 */
const T_LITERAL = /\bt\(\s*(['"])([^'"\n]+)\1/g;
/** 模板字面量调用：只取 `${` 之前的静态前缀。 */
const T_TEMPLATE = /\bt\(\s*`([^`$\n]*)\$\{/g;
/** `{placeholder}` 插值。 */
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
/** 形如 `a.b.c` 的 key；`t('—')` 这类直传文案不算 key。 */
const KEY_SHAPE = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/;
/** 形如 `a.b.` 的前缀片段：拼接出来的 key（`'x.y.' + kind`）算引用。 */
const KEY_PREFIX_SHAPE = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)*\.$/;
/** 任意引号字符串（含非 `t()` 位置：key 映射表、`labelKey()` 返回值等）。 */
const QUOTED_LITERAL = /(['"])([^'"\n]*)\1/g;
/** `t(` 调用点，参数形态由 readArgument 判定。 */
const T_CALL = /\bt\(/g;
/** 参数里出现字面量就交给 QUOTED_LITERAL / TEMPLATE_LITERAL，不当动态调用。 */
const ARGUMENT_LITERAL = /['"`]/;

async function loadCatalog(root: string, locale: string): Promise<Catalog> {
  const file = join(root, I18N_DIR, 'messages', `${locale}.ts`);
  const mod = (await import(file)) as { messages?: Catalog };
  const messages = mod.messages;
  if (messages === undefined || typeof messages !== 'object') {
    throw new Error(`${locale} catalog 缺少 messages 导出：${file}`);
  }
  return messages;
}

async function collect(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return files;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(path)));
      continue;
    }
    if (SOURCE_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function placeholdersOf(value: string): string {
  const found = [...value.matchAll(PLACEHOLDER)].map((match) => match[1]);
  return [...new Set(found)].sort().join(',');
}

/** I1 + I4：两份 catalog 对齐。 */
export function checkCatalogs(base: Catalog, other: Catalog): Issue[] {
  const issues: Issue[] = [];
  const baseKeys = new Set(Object.keys(base));
  const otherKeys = new Set(Object.keys(other));
  const dir = `${I18N_DIR}/messages`;

  for (const key of baseKeys) {
    if (otherKeys.has(key)) continue;
    issues.push({
      file: `${dir}/${OTHER_LOCALE}.ts`,
      line: 1,
      message: `缺少 key（${BASE_LOCALE} 有）：${key}`,
    });
  }
  for (const key of otherKeys) {
    if (baseKeys.has(key)) continue;
    issues.push({
      file: `${dir}/${BASE_LOCALE}.ts`,
      line: 1,
      message: `缺少 key（${OTHER_LOCALE} 有）：${key}`,
    });
  }
  for (const key of baseKeys) {
    if (!otherKeys.has(key)) continue;
    const expected = placeholdersOf(base[key] ?? '');
    const actual = placeholdersOf(other[key] ?? '');
    if (expected === actual) continue;
    issues.push({
      file: `${dir}/${OTHER_LOCALE}.ts`,
      line: 1,
      message: `占位符不一致（${BASE_LOCALE}=${expected || '无'}，${OTHER_LOCALE}=${actual || '无'}）：${key}`,
    });
  }
  return issues;
}

/** I2 + I3：代码引用必须能在 catalog 中落地。 */
export function checkUsages(file: string, source: string, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const keys = new Set(Object.keys(catalog));

  for (const match of source.matchAll(T_LITERAL)) {
    const key = match[2];
    if (key === undefined || !KEY_SHAPE.test(key)) continue;
    if (keys.has(key)) continue;
    issues.push({
      file,
      line: lineAt(source, match.index ?? 0),
      message: `引用未定义的 key：${key}`,
    });
  }

  for (const match of source.matchAll(T_TEMPLATE)) {
    const prefix = match[1] ?? '';
    if (prefix === '') continue;
    let matched = false;
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      matched = true;
      break;
    }
    if (matched) continue;
    issues.push({
      file,
      line: lineAt(source, match.index ?? 0),
      message: `模板 key 前缀匹配不到任何 key：${prefix}`,
    });
  }

  return issues;
}

export async function checkI18n(root: string): Promise<Issue[]> {
  const base = await loadCatalog(root, BASE_LOCALE);
  const other = await loadCatalog(root, OTHER_LOCALE);
  const issues = checkCatalogs(base, other);

  const messagesDir = join('i18n', 'messages');
  for (const file of await collect(join(root, SOURCE_DIR))) {
    // catalog 自身不参与引用检查。
    if (file.includes(messagesDir)) continue;
    const source = await readFile(file, 'utf8');
    const name = relative(root, file).replaceAll('\\', '/');
    issues.push(...checkUsages(name, source, base));
  }

  return issues;
}

/** 模板字面量的静态引用形态：`t(\`agents.${kind}.title\`)` → prefix `agents.` + suffix `.title`。 */
interface TemplateRef {
  prefix: string;
  suffix: string;
}

/** 完全动态的 `t(...)` 调用点：静态分析无法解析出 key，进待人工确认。 */
export interface DynamicCallSite {
  file: string;
  line: number;
  argument: string;
}

/**
 * 静态引用索引：I5 用它判断 catalog 里的 key 是否可能在代码中被引用。
 *
 * - `exact`：任意位置出现过的 key 字面量。`t('a.b')`、`{ labelKey: 'a.b' }`、
 *   `labelKey()` 返回值等都落在这里——这张表宁宽勿窄，宽了只会漏报孤儿，
 *   窄了会把活 key 报成孤儿。
 * - `templates`：模板字面量的前缀 / 后缀约束（沿用 I3 的前缀口径）。
 * - `dynamicCalls`：`t(variable)` 这类完全动态调用点，单列给人看。
 */
export interface ReferenceIndex {
  exact: Set<string>;
  templates: TemplateRef[];
  dynamicCalls: DynamicCallSite[];
}

export function emptyReferenceIndex(): ReferenceIndex {
  return { exact: new Set(), templates: [], dynamicCalls: [] };
}

/** 把模板字面量拆成静态段：`a${x}b${y}c` → `['a', 'b', 'c']`。 */
function splitTemplate(body: string): string[] {
  const parts: string[] = [];
  let buffer = '';
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;
    if (depth === 0 && char === '$' && body[i + 1] === '{') {
      parts.push(buffer);
      buffer = '';
      depth = 1;
      i += 1;
      continue;
    }
    if (depth > 0) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      continue;
    }
    buffer += char;
  }
  parts.push(buffer);
  return parts;
}

/** 取 `t(` 之后的调用参数文本；遇同级 `,` / 换行 / 收尾 `)` 截止。 */
function readArgument(source: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i] as string;
    if (quote !== null) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return source.slice(start, i);
      depth -= 1;
      continue;
    }
    if (depth === 0 && (char === ',' || char === '\n')) return source.slice(start, i);
  }
  return null;
}

/** 注释抹成空格（等长，行号 / 索引不变）：文档示例里的 `t('a.b')` 不算引用。 */
function maskComments(source: string): string {
  const masked = source.split('');
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (quote !== null) {
      if (char === '\\') i += 2;
      else {
        if (char === quote) quote = null;
        i += 1;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      i += 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        masked[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      masked[i] = ' ';
      masked[i + 1] = ' ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') masked[i] = ' ';
        i += 1;
      }
      if (i < source.length) {
        masked[i] = ' ';
        masked[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    i += 1;
  }
  return masked.join('');
}

/** `function t(` / `const t =`：定义点不是调用点，别算成动态 key。 */
function isDefinitionSite(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const head = source.slice(lineStart, index);
  return (
    /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+$/.test(head) ||
    /(?:const|let|var)\s+$/.test(head)
  );
}

/** 累计单个源文件的静态引用（exact / 模板前缀 / 动态调用点）。 */
export function collectReferences(
  file: string,
  source: string,
  index: ReferenceIndex,
): ReferenceIndex {
  const masked = maskComments(source);

  // 1) 任意位置的 key 字面量：`t('a.b')`、`{ labelKey: 'a.b' }`、`labelKey()` 返回值。
  for (const match of masked.matchAll(QUOTED_LITERAL)) {
    const value = match[2] ?? '';
    if (KEY_SHAPE.test(value)) index.exact.add(value);
    else if (KEY_PREFIX_SHAPE.test(value)) index.templates.push({ prefix: value, suffix: '' });
  }

  // 2) `t()` 调用点：模板字面量取静态前缀 / 后缀，其余按动态调用上报。
  for (const match of masked.matchAll(T_CALL)) {
    const at = match.index ?? 0;
    if (isDefinitionSite(masked, at)) continue;
    const text = readArgument(masked, at + match[0].length)?.trim() ?? '';
    if (text === '') continue;
    if (text.startsWith('`') && text.endsWith('`') && text.length > 1) {
      const body = text.slice(1, -1);
      const segments = splitTemplate(body);
      const prefix = segments[0] ?? '';
      const suffix = segments.length > 1 ? (segments[segments.length - 1] ?? '') : '';
      if (prefix === '' && !suffix.startsWith('.')) {
        // 静态信息为零（`t(\`${x}\`)` 或 `t(\`${x}Title\`)`）：单列等人工确认。
        index.dynamicCalls.push({ file, line: lineAt(masked, at), argument: text });
        continue;
      }
      index.templates.push({ prefix, suffix });
      continue;
    }
    // 参数里有字面量（三元 / 拼接）→ 已在第 1 步收录；剩下的才是真·动态。
    if (ARGUMENT_LITERAL.test(text)) continue;
    index.dynamicCalls.push({ file, line: lineAt(masked, at), argument: text });
  }

  return index;
}

/** 孤儿 key 报告。 */
export interface OrphanReport {
  /** catalog 键总数。 */
  keyCount: number;
  /** 被精确字面量命中的 key 数。 */
  exactCovered: number;
  /** 被模板前缀 / 后缀命中的 key 数（不含 exact）。 */
  templateCovered: number;
  /** 零静态引用的 key（候选孤儿），已排序。 */
  orphans: string[];
  /** 按首段前缀分组的孤儿。 */
  groups: { prefix: string; keys: string[] }[];
  /** 完全动态的 `t(...)` 调用点（白名单外的静态不可解析集）。 */
  dynamicCalls: DynamicCallSite[];
  /** 孤儿中与某动态调用点共享词元的子集：待人工确认，不算定论。 */
  suspects: string[];
}

/** 一个 key 是否能在静态引用索引里落地。 */
function coverageOf(key: string, index: ReferenceIndex): 'exact' | 'template' | 'none' {
  if (index.exact.has(key)) return 'exact';
  for (const ref of index.templates) {
    if (key.length <= ref.prefix.length + ref.suffix.length) continue;
    if (!key.startsWith(ref.prefix)) continue;
    if (!key.endsWith(ref.suffix)) continue;
    return 'template';
  }
  return 'none';
}

/** 词元集：`agents.groupCount` / `groupCount` → {agents, group, count}。 */
function tokensOf(raw: string): Set<string> {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  return new Set(words);
}

/** I5：catalog 有、源码零引用的 key。只报告，不删除。 */
export function findOrphans(catalog: Catalog, index: ReferenceIndex): OrphanReport {
  const keys = Object.keys(catalog).sort();
  let exactCovered = 0;
  let templateCovered = 0;
  const orphans: string[] = [];

  for (const key of keys) {
    const coverage = coverageOf(key, index);
    if (coverage === 'exact') exactCovered += 1;
    else if (coverage === 'template') templateCovered += 1;
    else orphans.push(key);
  }

  const grouped = new Map<string, string[]>();
  for (const key of orphans) {
    const prefix = key.split('.')[0] ?? key;
    const bucket = grouped.get(prefix);
    if (bucket === undefined) grouped.set(prefix, [key]);
    else bucket.push(key);
  }
  const groups = [...grouped.entries()]
    .map(([prefix, groupKeys]) => ({ prefix, keys: groupKeys }))
    .sort((a, b) => b.keys.length - a.keys.length || a.prefix.localeCompare(b.prefix));

  // 动态调用点的词元：孤儿若与**同一处**调用点共享两个以上词元，静态分析无法证伪 →
  // 待人工确认。单字重合太松（`title` / `key` 这类词到处都是），这里按调用点配对。
  const dynamicTokenSets = index.dynamicCalls.map((call) => tokensOf(call.argument));
  const suspects = orphans.filter((key) => {
    const keyTokens = tokensOf(key);
    return dynamicTokenSets.some((callTokens) => {
      let shared = 0;
      for (const token of keyTokens) {
        if (callTokens.has(token)) shared += 1;
        if (shared >= 2) return true;
      }
      return false;
    });
  });

  return {
    keyCount: keys.length,
    exactCovered,
    templateCovered,
    orphans,
    groups,
    dynamicCalls: index.dynamicCalls,
    suspects,
  };
}

/** I5 数据采集：扫源码建静态引用索引。 */
export async function analyzeOrphans(root: string): Promise<OrphanReport> {
  const base = await loadCatalog(root, BASE_LOCALE);
  const index = emptyReferenceIndex();
  const messagesDir = join('i18n', 'messages');

  for (const file of await collect(join(root, SOURCE_DIR))) {
    // catalog 自身不参与引用检查。
    if (file.includes(messagesDir)) continue;
    const source = await readFile(file, 'utf8');
    const name = relative(root, file).replaceAll('\\', '/');
    collectReferences(name, source, index);
  }

  return findOrphans(base, index);
}

function formatOrphanReport(report: OrphanReport): string {
  const suspects = new Set(report.suspects);
  const lines: string[] = [];
  lines.push('i18n 孤儿 key 报告（I5，只报告不改动）');
  lines.push(`  catalog 键：${report.keyCount}`);
  lines.push(`  有引用：${report.exactCovered} 字面量 / ${report.templateCovered} 模板前缀`);
  lines.push(`  孤儿：${report.orphans.length}（其中待人工确认 ${report.suspects.length}）`);
  for (const group of report.groups) {
    lines.push(`    ${group.prefix}.*  ${group.keys.length}`);
  }
  if (report.dynamicCalls.length > 0) {
    lines.push(`  动态调用点 ${report.dynamicCalls.length} 处（候选 key 需人工确认）`);
    for (const call of report.dynamicCalls) {
      lines.push(`    ${call.file}:${call.line}  t(${call.argument})`);
    }
  }
  if (report.orphans.length > 0) {
    lines.push('  孤儿明细（[?] = 待人工确认）');
    for (const group of report.groups) {
      for (const key of group.keys) lines.push(`    ${suspects.has(key) ? '[?]' : '   '} ${key}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantOrphans = args.includes('--orphans');
  const root = args.find((arg) => !arg.startsWith('--')) ?? process.cwd();
  const issues = await checkI18n(root);

  if (wantOrphans) {
    // 报告模式：始终 exit 0，不阻断任何门禁。
    console.log(formatOrphanReport(await analyzeOrphans(root)));
  }

  if (issues.length === 0) {
    console.log('i18n contract passed');
  } else {
    console.error(`i18n contract failed: ${issues.length} issue(s)`);
    for (const issue of issues) {
      console.error(`  ${issue.file}:${issue.line}: ${issue.message}`);
    }
    process.exit(1);
  }

  if (!wantOrphans) {
    // I5 常驻 warn（1 已裁决）：只提醒数量，不改变退出码；转 error 需孤儿清零或
    // 剩余项全部白名单化，之后重新裁决。
    const report = await analyzeOrphans(root);
    if (report.orphans.length > 0) {
      console.error(
        `i18n orphans: ${report.orphans.length} (warn，未阻断；明细 ` +
          '`bun run scripts/check-i18n.ts --orphans`)',
      );
    }
  }
}

if (import.meta.main) {
  await main();
}
