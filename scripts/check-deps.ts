#!/usr/bin/env bun

/**
 * 依赖方向检查（ADR-037 / 0.2）。
 *
 * 规则（D1-D6，见 PLAN-0.2.0-gov.md §5.1）：
 *   D1  packages/core/src/types/** 只能 import types/ 内部（禁止实现目录）
 *   D2  core 模块之间只经 port：相对 import 只能指向同模块、types/ 或另一模块的 index.ts
 *   D3  core 不得依赖 src/、packages/serve、plugins、apps；不得 import 外部 @vessel/*
 *   D4  kernel 只依赖 types/ 与 kernel/ 内部；具体实现仅允许显式白名单（DECISION-007 F5）
 *   D5  非 core 的 workspace 包不得相对 import core 内部；core 不得反向依赖它们
 *   D6  packages/core 的 subpath exports 只能指向 index.ts（不暴露内部实现文件）
 *
 * 用法：bun run scripts/check-deps.ts
 * 退出码：0 = 无违规；1 = 有违规。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

export type RuleId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';

export interface Violation {
  rule: RuleId;
  file: string;
  line: number;
  specifier: string;
  resolved?: string;
  message: string;
}

interface ImportRef {
  specifier: string;
  line: number;
  clause: string;
  kind: 'static' | 'dynamic' | 'require' | 'side-effect';
}

const CORE_SRC = 'packages/core/src';
const CORE_MODULES = [
  'context',
  'events',
  'kernel',
  'limits',
  'provider',
  'runtime',
  'session',
  'types',
] as const;
const CORE_MODULE_SET = new Set<string>(CORE_MODULES);

/**
 * D4 受控白名单（DECISION-007 F5）：kernel 可为默认值 import 这些具体实现，
 * 前提是全部能经 options 覆盖（覆盖能力由 R1 类型/单测保证，静态检查只守边界）。
 */
export const KERNEL_ALLOWED_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  [`${CORE_SRC}/context/context-manager.ts`]: new Set(['MemoryContextManager']),
  [`${CORE_SRC}/events/event-stream.ts`]: new Set(['MemoryEventStream']),
  [`${CORE_SRC}/runtime/agent-runtime.ts`]: new Set(['AgentRuntime']),
  [`${CORE_SRC}/runtime/plugin-host.ts`]: new Set(['MemoryPluginHost']),
};

/**
 * 已知例外：基线里尚未到 R6 模块边界的前置实现依赖。
 * 这些不是白名单（不能扩散）；只允许精确匹配，并在 R6 时移除。
 */
export interface KnownException {
  rule: RuleId;
  file: string;
  specifier: string;
  reason: string;
}

export const KNOWN_EXCEPTIONS: ReadonlyArray<KnownException> = [
  // R6b 后基线无已知例外。新增例外必须是精确匹配，且附带移除条件。
];

const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function parseImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];

  for (const match of source.matchAll(STATIC_IMPORT)) {
    const clause = (match[1] ?? '').trim();
    const specifier = match[2] ?? '';
    refs.push({
      specifier,
      line: lineOf(source, match.index ?? 0),
      clause,
      kind: 'static',
    });
  }

  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    refs.push({
      specifier: match[1] ?? '',
      line: lineOf(source, match.index ?? 0),
      clause: '',
      kind: 'side-effect',
    });
  }

  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    refs.push({
      specifier: match[1] ?? '',
      line: lineOf(source, match.index ?? 0),
      clause: '',
      kind: 'dynamic',
    });
  }

  for (const match of source.matchAll(REQUIRE_CALL)) {
    refs.push({
      specifier: match[1] ?? '',
      line: lineOf(source, match.index ?? 0),
      clause: '',
      kind: 'require',
    });
  }

  return refs.sort((a, b) => a.line - b.line);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/** 取 import clause 中的具名符号；default / namespace / 无法解析时返回 null。 */
export function namedSymbols(clause: string): Set<string> | null {
  const brace = /\{([\s\S]*)\}/.exec(clause);
  if (!brace) return null;
  if (/\*\s+as\s+/.test(clause) && !brace[1]?.trim().startsWith('*')) {
    // 仍可能同时有具名导入；继续解析具名部分。
  }

  const symbols = new Set<string>();
  for (const raw of (brace[1] ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const withoutType = entry.replace(/^type\s+/, '');
    const name = withoutType.split(/\s+as\s+/)[0]?.trim();
    if (name) symbols.add(name);
  }
  return symbols;
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function moduleOf(relPath: string): string | null {
  const match = new RegExp(`^${CORE_SRC}/([^/]+)/`).exec(relPath);
  const name = match?.[1];
  return name !== undefined && CORE_MODULE_SET.has(name) ? name : null;
}

function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

/** 把相对 specifier 解析成 repo 相对路径；.js 映射回 .ts。 */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = posix.dirname(fromFile);
  // 仓库内路径按 POSIX 解析，避免 node:path.resolve 把它锚到进程 cwd。
  const resolved = posix.resolve('/', base, specifier).replace(/^\/+/, '');
  if (resolved.endsWith('.js')) return `${resolved.slice(0, -3)}.ts`;
  return resolved;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || specifier === 'bun' || specifier.startsWith('bun:');
}

function collectFiles(root: string, glob: string): Promise<string[]> {
  const files: string[] = [];
  const scan = new Bun.Glob(glob);
  return (async () => {
    for await (const match of scan.scan({ cwd: root, onlyFiles: true })) {
      if (match.endsWith('.ts') || match.endsWith('.tsx')) files.push(toPosix(match));
    }
    return files.sort();
  })();
}

function addIf(
  violations: Violation[],
  condition: boolean,
  violation: Omit<Violation, 'rule'> & { rule: RuleId },
): void {
  if (condition) violations.push(violation);
}

export async function checkDependencies(root: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const coreFiles = await collectFiles(root, `${CORE_SRC}/**/*.ts`);
  const packageFiles = [
    ...(await collectFiles(root, 'packages/*/src/**/*.ts')),
    ...(await collectFiles(root, 'plugins/*/*/src/**/*.ts')),
  ];

  for (const file of coreFiles) {
    const source = await readFile(join(root, file), 'utf8');
    const fileModule = moduleOf(file);
    const inKernel = fileModule === 'kernel';
    const inTypes = fileModule === 'types';

    for (const ref of parseImports(source)) {
      const { specifier, line } = ref;

      if (!isRelative(specifier)) {
        // D3 / D5：core 不得 import 外部 workspace 包（node/bun 内置除外）。
        addIf(violations, !isBuiltin(specifier), {
          rule: 'D3',
          file,
          line,
          specifier,
          message: 'core 不得 import 外部包（只允许 node:/bun 内置与相对导入）',
        });
        continue;
      }

      const resolved = resolveRelative(file, specifier);
      const targetModule = moduleOf(resolved);

      // D3：相对导入不得逃出 packages/core。
      addIf(violations, !isWithin(resolved, 'packages/core'), {
        rule: 'D3',
        file,
        line,
        specifier,
        resolved,
        message: 'core 相对导入不得逃出 packages/core',
      });

      if (!isWithin(resolved, 'packages/core')) continue;

      // D1：types 只能依赖 types 自身。
      addIf(violations, inTypes && !isWithin(resolved, `${CORE_SRC}/types`), {
        rule: 'D1',
        file,
        line,
        specifier,
        resolved,
        message: 'types/** 只能 import types/ 内部，禁止依赖实现',
      });

      // D4：kernel 只允许 kernel/、types/ 与显式白名单。
      if (inKernel) {
        const insideKernel = isWithin(resolved, `${CORE_SRC}/kernel`);
        const insideTypes = isWithin(resolved, `${CORE_SRC}/types`);
        if (insideKernel || insideTypes) continue;

        const allowed = KERNEL_ALLOWED_IMPORTS[resolved];
        const symbols = namedSymbols(ref.clause);
        const symbolsAllowed =
          allowed !== undefined &&
          symbols !== null &&
          symbols.size > 0 &&
          [...symbols].every((symbol) => allowed.has(symbol));

        addIf(violations, !symbolsAllowed, {
          rule: 'D4',
          file,
          line,
          specifier,
          resolved,
          message:
            allowed === undefined
              ? 'kernel 只能依赖 types/ 或显式白名单中的实现'
              : `kernel 从白名单文件只允许具名导入 ${[...allowed].join(', ')}`,
        });
        continue;
      }

      // D2：模块之间只经 port（同模块、types/、另一模块的 index.ts）。
      if (fileModule && targetModule && fileModule !== targetModule) {
        const isBarrel = resolved.endsWith('/index.ts');
        const isTypes = targetModule === 'types';
        addIf(violations, !isBarrel && !isTypes, {
          rule: 'D2',
          file,
          line,
          specifier,
          resolved,
          message: `core 模块 ${fileModule} 不得直接 import ${targetModule} 的内部文件（只允许 index.ts / types）`,
        });
      }
    }
  }

  // D5：非 core 的 workspace 包不得相对 import core 内部。
  for (const file of packageFiles) {
    if (isWithin(file, 'packages/core')) continue;
    const source = await readFile(join(root, file), 'utf8');

    for (const ref of parseImports(source)) {
      const { specifier, line } = ref;

      if (isRelative(specifier)) {
        const resolved = resolveRelative(file, specifier);
        addIf(violations, isWithin(resolved, 'packages/core'), {
          rule: 'D5',
          file,
          line,
          specifier,
          resolved,
          message: 'workspace 包必须通过 @vessel/core 导入，不得相对 import core 内部',
        });
      } else {
        addIf(violations, /^@vessel\/core\//.test(specifier), {
          rule: 'D5',
          file,
          line,
          specifier,
          message: 'workspace 包不得 import @vessel/core/ 内部路径（只允许公开 subpath）',
        });
      }
    }
  }

  // D6：packages/core 的 subpath exports 只能指向 index.ts。
  const corePkgPath = join(root, 'packages/core/package.json');
  if (existsSync(corePkgPath)) {
    const pkg = JSON.parse(await readFile(corePkgPath, 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
      for (const file of exportTargets(target)) {
        addIf(violations, !file.endsWith('/index.ts') && file !== './src/index.ts', {
          rule: 'D6',
          file: 'packages/core/package.json',
          line: 0,
          specifier: subpath,
          resolved: file,
          message: 'subpath exports 只能指向 index.ts，不得暴露内部实现文件',
        });
      }
    }
  }

  return violations;
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>).flatMap(exportTargets);
  }
  return [];
}

export function splitKnownExceptions(
  violations: Violation[],
  exceptions: ReadonlyArray<KnownException> = KNOWN_EXCEPTIONS,
): {
  known: Array<{ violation: Violation; reason: string }>;
  unknown: Violation[];
} {
  const known: Array<{ violation: Violation; reason: string }> = [];
  const unknown: Violation[] = [];

  for (const violation of violations) {
    const match = exceptions.find(
      (exception) =>
        exception.rule === violation.rule &&
        exception.file === violation.file &&
        exception.specifier === violation.specifier,
    );
    if (match) known.push({ violation, reason: match.reason });
    else unknown.push(violation);
  }

  return { known, unknown };
}

async function main(): Promise<void> {
  const root = process.cwd();
  const violations = await checkDependencies(root);
  const { known, unknown } = splitKnownExceptions(violations);

  for (const { violation, reason } of known) {
    const location = violation.line > 0 ? `${violation.file}:${violation.line}` : violation.file;
    console.warn(`  [known ${violation.rule}] ${location} ${violation.specifier}`);
    console.warn(`       ${reason}`);
  }

  if (unknown.length === 0) {
    console.log(
      `dependency check passed (D1-D6)${known.length > 0 ? ` with ${known.length} known exception(s)` : ''}`,
    );
    return;
  }

  console.error(`dependency check failed: ${unknown.length} violation(s)`);
  for (const violation of unknown) {
    const location = violation.line > 0 ? `${violation.file}:${violation.line}` : violation.file;
    const resolved = violation.resolved ? ` -> ${violation.resolved}` : '';
    console.error(`  [${violation.rule}] ${location} ${violation.specifier}${resolved}`);
    console.error(`       ${violation.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
