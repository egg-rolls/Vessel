#!/usr/bin/env bun

/**
 * 提示词前缀静态审计（CONTRACT-prefix-invariant §5）。
 *
 * 扫描 `packages/**`、`plugins/**`、`src/**` 的非测试 TypeScript 源码，报告会
 * 破坏 system 前缀稳定性的写法：
 *
 *   P1  HookResult 构造/返回 `additionalContext:`（system 注入）
 *   P2  `ctx.systemPrompt =` / `context.systemPrompt =` 赋值
 *
 * 允许清单只覆盖 P1 的旧字段兼容层（字段仍保留，等待外部插件迁移）：
 *   packages/core/src/types/hook.ts
 *   packages/core/src/runtime/hook-runner.ts
 *   packages/core/src/runtime/agent-runtime.ts
 * P2 不允许任何例外。
 *
 * 启发式：用字符级状态机去掉行注释、块注释与字符串/模板字面量内容后再匹配，
 * 避免注释和字符串里的同名文本造成假阳性。不引入 AST 依赖；正则字面量内的
 * `//` 仍可能被当作注释，这是可接受的边界。
 *
 * 用法：bun run scripts/check-prompt-prefix.ts（或 `bun run check:prompt-prefix`）
 * 退出码：0 = 无违规；1 = 有违规。
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PrefixViolation {
  file: string;
  line: number;
  pattern: string;
}

export interface PrefixCheckResult {
  scannedFiles: number;
  violations: PrefixViolation[];
}

const SCAN_ROOTS = ['packages', 'plugins', 'src'] as const;
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);
const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;

/** P1 兼容层：`additionalContext` 只允许在这里保留。 */
export const ADDITIONAL_CONTEXT_ALLOWLIST: ReadonlySet<string> = new Set([
  'packages/core/src/types/hook.ts',
  'packages/core/src/runtime/hook-runner.ts',
  'packages/core/src/runtime/agent-runtime.ts',
]);

interface Rule {
  pattern: string;
  regex: RegExp;
  /** 命中该规则时允许的文件（精确 POSIX 相对路径）。 */
  allowlist?: ReadonlySet<string>;
}

const RULES: ReadonlyArray<Rule> = [
  {
    pattern: 'additionalContext:',
    // 类型声明里的 `additionalContext?:` 也算构造/声明点，交给允许清单放行。
    regex: /\badditionalContext\s*\??\s*:/g,
    allowlist: ADDITIONAL_CONTEXT_ALLOWLIST,
  },
  {
    pattern: 'ctx.systemPrompt =',
    // 复合赋值（`+=`、`??=` 等）同样算赋值；排除 `==` / `===`。
    regex:
      /\b(?:ctx|context)\s*\.\s*systemPrompt\s*(?:\*\*|>>>|<<|>>|&&|\|\||\?\?|[+\-*/%&|^])?=(?!=)/g,
  },
];

type ScanState =
  | 'code'
  | 'line-comment'
  | 'block-comment'
  | 'single-quote'
  | 'double-quote'
  | 'template';

/**
 * 把注释与字符串/模板字面量的内容替换为空格，保留换行以便行号不变。
 *
 * - 模板字面量整体按字符串处理（`${...}` 里的代码不参与匹配）；
 * - 未闭合的单/双引号在行尾结束，避免一行坏字符串吞掉后续源码。
 */
export function stripCommentsAndStrings(source: string): string {
  const out = source.split('');
  let state: ScanState = 'code';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        state = 'line-comment';
        continue;
      }
      if (ch === '/' && next === '*') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        state = 'block-comment';
        continue;
      }
      if (ch === "'") {
        out[i] = ' ';
        state = 'single-quote';
        continue;
      }
      if (ch === '"') {
        out[i] = ' ';
        state = 'double-quote';
        continue;
      }
      if (ch === '`') {
        out[i] = ' ';
        state = 'template';
        continue;
      }
      continue;
    }

    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      else out[i] = ' ';
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        state = 'code';
      } else if (ch !== '\n') {
        out[i] = ' ';
      }
      continue;
    }

    // 字符串 / 模板字面量内部。
    if (ch === '\\') {
      // 转义序列连同下一个字符一起抹掉；续行符保留换行。
      out[i] = ' ';
      if (i + 1 < source.length) {
        if ((source[i + 1] ?? '') !== '\n') out[i + 1] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '\n') {
      // 单/双引号字符串不能跨行；模板字面量可以。
      if (state !== 'template') state = 'code';
      continue;
    }
    if (
      (state === 'single-quote' && ch === "'") ||
      (state === 'double-quote' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      out[i] = ' ';
      state = 'code';
      continue;
    }
    out[i] = ' ';
  }

  return out.join('');
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/** 对单个文件内容跑全部规则；`file` 必须是 POSIX 相对路径。 */
export function checkSource(file: string, source: string): PrefixViolation[] {
  const scrubbed = stripCommentsAndStrings(source);
  const violations: PrefixViolation[] = [];

  for (const rule of RULES) {
    if (rule.allowlist?.has(file)) continue;
    for (const match of scrubbed.matchAll(rule.regex)) {
      violations.push({
        file,
        line: lineOf(scrubbed, match.index ?? 0),
        pattern: rule.pattern,
      });
    }
  }

  return violations.sort((a, b) => a.line - b.line);
}

async function walk(root: string, relDir: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, relDir), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, rel, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_FILE.test(entry.name) || TEST_FILE.test(entry.name)) continue;
    files.push(rel);
  }
}

/** 收集待审计文件（POSIX 相对路径，已排序）。 */
export async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const relDir of SCAN_ROOTS) await walk(root, relDir, files);
  return files.sort();
}

export async function checkPromptPrefix(root: string): Promise<PrefixCheckResult> {
  const files = await collectSourceFiles(root);
  const violations: PrefixViolation[] = [];

  for (const file of files) {
    const source = await readFile(join(root, file), 'utf8');
    violations.push(...checkSource(file, source));
  }

  return {
    scannedFiles: files.length,
    violations: violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };
}

async function main(): Promise<void> {
  const result = await checkPromptPrefix(process.cwd());

  if (result.violations.length === 0) {
    console.log(
      `prompt prefix check passed (${result.scannedFiles} source file(s), no prefix-breaking patterns)`,
    );
    return;
  }

  console.error(`prompt prefix check failed: ${result.violations.length} violation(s)`);
  for (const violation of result.violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.pattern}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
