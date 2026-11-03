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
 *
 * 为什么需要：缺 key 时 `t()` 静默回退成 key 本身，界面直接出现
 * `agents.close.title` 这种裸键；typecheck 与 biome 都抓不到。当前 1374 键
 * 全对齐，靠的是纪律而不是守卫——本脚本把纪律变成门禁。
 *
 * 不做的事：不校验文案内容与措辞（与 `check-docs.ts` 同口径），也不解析
 * `t(variable)` 这种完全动态的 key。
 *
 * 用法：`bun run scripts/check-i18n.ts [repoRoot]`
 * 退出码：0 = 通过；1 = 有 issue。
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

async function main(): Promise<void> {
  const root = process.argv[2] ?? process.cwd();
  const issues = await checkI18n(root);

  if (issues.length === 0) {
    console.log('i18n contract passed');
    return;
  }

  console.error(`i18n contract failed: ${issues.length} issue(s)`);
  for (const issue of issues) {
    console.error(`  ${issue.file}:${issue.line}: ${issue.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
