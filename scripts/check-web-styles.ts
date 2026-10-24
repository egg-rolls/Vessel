#!/usr/bin/env bun

/**
 * Web 样式契约检查（0.27 L1/L2/L3）。
 *
 * 扫描 `apps/web/src` 下全部 `.tsx`，拒绝：
 *   - 字面量 arbitrary value（`p-[13px]`、`text-[12.5px]`、`bg-[#111]`）；
 *     引用 `var(--...)` 的动态值允许（例如 `max-h-[min(86dvh,var(--modal-max-h))]`）。
 *   - className 里的裸 `#hex`。
 *   - 内联 style 里的颜色字面量（`color` / `background` / `borderColor` ...）。
 *
 * 用法：`bun run scripts/check-web-styles.ts [repoRoot]`
 * 退出码：0 = 通过；1 = 有违规。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Issue {
  file: string;
  line: number;
  message: string;
}

const TSX = /\.tsx$/;

/** 这些 utility 前缀的 arbitrary value 必须改用 L1 token / L2 variant。 */
const BANNED_ARBITRARY = [
  /^(?:bg|text|border|ring|fill|stroke|outline|from|to|via|divide|placeholder|caret|decoration|accent|shadow)-\[/,
  /^(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me)-\[/,
  /^(?:gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|right|bottom|left)-\[/,
  /^(?:w|h|size|min-w|max-w|min-h|max-h|basis)-\[/,
  /^(?:leading|tracking|z)-\[/,
  /^rounded(?:-[trblse]{1,2})?-\[/,
];

const COLOR_STYLE_PROPERTY =
  /(?:^|[,{])\s*(color|background|backgroundColor|borderColor|outlineColor|fill|stroke|boxShadow|textDecorationColor)\s*:\s*(['"`])([^'"`]*)\2/g;

const ALLOWED_STYLE_VALUE = /var\(--/;

/** 判断一个字符串是否像 class 列表，避免把普通文案里的 `#` 误判成颜色。 */
const CLASS_TOKEN =
  /^(?:[a-z0-9:_-]+:)*(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|bg-|text-|border|rounded|shadow|p[xytblre]?-|m[xytblre]?-|gap-|items-|justify-|font-|w-|h-|size-|min-|max-|leading-|tracking-|overflow-|whitespace-|break-|truncate|sr-only|hover:|focus:|disabled:|active:|aria-|data-|pointer-coarse:|z-|opacity-|cursor-|transition|duration-|underline|uppercase|flex-|basis-|grow|shrink|self-|content-|place-|shadow-)/;

const STRING_LITERAL = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*?)\1/g;
const CLASS_NAME_ATTRIBUTE = /className\s*=\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*?)\1/g;
const INLINE_STYLE = /style\s*=\s*\{\{([\s\S]*?)\}\}/g;
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const ARBITRARY_TOKEN = /(?<![\w-])([a-z][a-z0-9-]*(?:-[a-z0-9]+)*)\[([^\]\n]*)\]/g;

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('*/')
  );
}

function tokenBase(token: string): string {
  // 去掉变体前缀（hover:、sm:、aria-pressed: ...）。
  const parts = token.split(':');
  return parts[parts.length - 1] ?? token;
}

function classListLike(value: string): boolean {
  return value.split(/\s+/).some((token) => CLASS_TOKEN.test(tokenBase(token)));
}

function scanStrings(file: string, source: string): Issue[] {
  const issues: Issue[] = [];
  const lines = source.split('\n');

  for (const match of source.matchAll(STRING_LITERAL)) {
    const value = match[2] ?? '';
    const index = match.index ?? 0;
    if (isCommentLine(lines[lineAt(source, index) - 1] ?? '')) continue;

    let hexArbitrary = false;
    for (const tokenMatch of value.matchAll(ARBITRARY_TOKEN)) {
      const token = tokenMatch[0] ?? '';
      const base = tokenBase(token);
      const content = tokenMatch[2] ?? '';
      if (ALLOWED_STYLE_VALUE.test(content)) continue;
      if (!BANNED_ARBITRARY.some((pattern) => pattern.test(base))) continue;
      if (content.includes('#')) hexArbitrary = true;
      issues.push({
        file,
        line: lineAt(source, index),
        message: `arbitrary value "${token}" — use an L1 token or L2 variant`,
      });
    }

    if (!hexArbitrary && HEX_COLOR.test(value) && classListLike(value)) {
      issues.push({
        file,
        line: lineAt(source, index),
        message: 'raw hex color in a class string — use an L1 color token (e.g. text-ink)',
      });
    }
  }

  for (const match of source.matchAll(CLASS_NAME_ATTRIBUTE)) {
    const value = match[2] ?? '';
    // `bg-[#111]` 已经按 arbitrary value 报过，避免重复。
    if (!HEX_COLOR.test(value) || value.includes('[#')) continue;
    issues.push({
      file,
      line: lineAt(source, match.index ?? 0),
      message: 'raw hex color in className — use an L1 color token',
    });
  }

  for (const match of source.matchAll(INLINE_STYLE)) {
    const body = match[1] ?? '';
    for (const color of body.matchAll(COLOR_STYLE_PROPERTY)) {
      const value = color[3] ?? '';
      if (ALLOWED_STYLE_VALUE.test(value)) continue;
      const ignore = ['transparent', 'none', 'inherit', 'currentColor'];
      if (ignore.includes(value.trim())) continue;
      issues.push({
        file,
        line: lineAt(source, (match.index ?? 0) + (color.index ?? 0)),
        message: `inline style color (${color[1]}) — use an L1 color token / utility`,
      });
    }
  }

  return issues;
}

async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full)));
    else if (TSX.test(entry.name)) files.push(full);
  }
  return files;
}

export async function checkWebStyles(root: string): Promise<Issue[]> {
  const sourceDir = join(root, 'apps/web/src');
  const files = await collect(sourceDir);
  const issues: Issue[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    issues.push(...scanStrings(relative(root, file).replaceAll('\\', '/'), source));
  }
  return issues;
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? process.cwd();
  const issues = await checkWebStyles(root);

  if (issues.length === 0) {
    console.log('web style contract passed');
    return;
  }

  console.error(`web style contract failed: ${issues.length} issue(s)`);
  for (const issue of issues) {
    console.error(`  ${issue.file}:${issue.line}: ${issue.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
