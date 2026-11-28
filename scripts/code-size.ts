#!/usr/bin/env bun

/**
 * code-size —— 按需信息工具：扫 git 跟踪的源码文件，浮现厚重候选（拆分候选）。
 * 零存储零状态零依赖（Bun 内置 + git），与 doc-sync 同族同口径。
 *
 * 订阅脚本契约（q-subscription-script，设计稿 §3.2）：「没问题就不输出，有问题输出清单」。
 * 行数 > 阈值（默认 1000，用户裁示：千行级明确厚重）⇒ 候选；每行 `<path>: <N> lines`
 * （行数降序 / path 字典序，稳定排序是订阅 diff 模式的前提）；无候选 ⇒ stdout 全空。
 * 排除生成物 / bundle：node_modules / dist / assets 目录段 + *.d.ts / *.gen.ts 后缀
 * （内置常量 + --exclude <glob> 可追加）。
 *
 * 信息性非 gate：厚重只是拆分候选，语义判断归人；永不 exit 1，不接 CI / hook。
 *
 * 用法：bun run scripts/code-size.ts [--threshold N] [--ext ts,tsx] [--exclude <glob>]...
 * 退出码：0 成功（无论有无候选）；2 参数 / git 错误；永不 1（无 pass/fail 语义）。
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DEFAULT_THRESHOLD = 1000;
const DEFAULT_EXTS = ['ts', 'tsx'];
const USAGE =
  '用法: bun run scripts/code-size.ts [--threshold N] [--ext ts,tsx] [--exclude <glob>]...\n';

/** 内置排除：目录段（生成物 / bundle / 资产）+ 后缀（声明 / 生成代码）。 */
const EXCLUDED_DIR_SEGMENTS = new Set(['node_modules', 'dist', 'assets', 'build', 'coverage']);
const EXCLUDED_SUFFIXES = ['.d.ts', '.gen.ts'];

interface HeavyFile {
  path: string;
  lines: number;
}

function git(...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || String(result.error ?? 'unknown error');
    throw new Error(`git ${args.join(' ')} -> exit ${String(result.status)}: ${detail}`);
  }
  return result.stdout ?? '';
}

/** 行数（与 doc-sync / diff 同口径：末尾换行不产生额外空行；空文件 0 行）。 */
function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** 内置排除判定（目录段 + 后缀）；--exclude 追加 glob 另行判定。 */
function isExcluded(file: string): boolean {
  const segments = file.split('/');
  if (segments.some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment))) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

/** glob 编译一次；非法 glob 视为不命中（doc-sync 先例），不抛。 */
function compileGlob(pattern: string): Bun.Glob | null {
  try {
    return new Bun.Glob(pattern);
  } catch {
    return null;
  }
}

async function runCodeSize(
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let threshold = DEFAULT_THRESHOLD;
  let exts = DEFAULT_EXTS;
  const excludeGlobs: Bun.Glob[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const next = (): string | null => {
      const value = argv[index + 1];
      if (value === undefined) return null;
      index += 1;
      return value;
    };
    if (arg === '--threshold') {
      const value = next();
      const parsed = Number(value);
      if (value === null || !Number.isInteger(parsed) || parsed < 1) {
        return { exitCode: 2, stdout: '', stderr: `--threshold 需要正整数\n\n${USAGE}` };
      }
      threshold = parsed;
      continue;
    }
    if (arg === '--ext') {
      const value = next();
      const parsed = (value ?? '')
        .split(',')
        .map((ext) => ext.trim().replace(/^\./, ''))
        .filter((ext) => /^[A-Za-z0-9]+$/.test(ext));
      if (parsed.length === 0) {
        return { exitCode: 2, stdout: '', stderr: `--ext 需要逗号分隔的扩展名\n\n${USAGE}` };
      }
      exts = parsed;
      continue;
    }
    if (arg === '--exclude') {
      const value = next();
      if (value === null || value.trim() === '') {
        return { exitCode: 2, stdout: '', stderr: `--exclude 需要一个 glob\n\n${USAGE}` };
      }
      const matcher = compileGlob(value.trim());
      if (matcher !== null) excludeGlobs.push(matcher);
      continue;
    }
    return { exitCode: 2, stdout: '', stderr: `未知参数: ${arg}\n\n${USAGE}` };
  }

  const tracked = git('ls-files')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidates = tracked.filter(
    (file) =>
      exts.some((ext) => file.endsWith(`.${ext}`)) &&
      !isExcluded(file) &&
      !excludeGlobs.some((matcher) => matcher.match(file)),
  );

  const heavy: HeavyFile[] = [];
  for (const file of candidates) {
    let text: string;
    try {
      text = await readFile(join(ROOT, file), 'utf8');
    } catch {
      continue; // 读失败（已删 / 权限）跳过，信息性工具不 gate
    }
    if (text.includes('\0')) continue; // 二进制不计行数
    const lines = countLines(text);
    if (lines > threshold) heavy.push({ path: file, lines });
  }

  heavy.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  const rows = heavy.map((file) => `${file.path}: ${file.lines} lines`);
  return { exitCode: 0, stdout: rows.length > 0 ? `${rows.join('\n')}\n` : '', stderr: '' };
}

if (import.meta.main) {
  try {
    const result = await runCodeSize(process.argv.slice(2));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
