#!/usr/bin/env bun

/**
 * 按目标检索静态文档。
 *
 * 扫描范围（两级）：
 * - 共享侧：`docs/architecture`、`docs/agents`（相对 root，始终参与）。
 * - 个人侧：`docs/constitution`、`docs/lessons`、`docs/roles`；从 root 起向上查找
 *   （含 root 自身，最多 3 层祖先），取第一个其 `docs/` 下含上述任一目录的祖先作为
 *   personal base，只扫该 base 下实际存在的目录。CI 只 clone 共享仓库，找不到时静默跳过。
 *
 * 发现：排除 INDEX.md（INDEX 只做导航，不参与检索）。
 * 打分：paths glob 命中 +5（每模块一次）、trigger 每命中 +1、title 命中 +2（每模块一次）。
 * 退出码：0 有命中；1 无命中（调用方必须回落 AGENTS.md 硬规则）；2 参数 / 目录错误。
 *
 * 输出 `path` 可直接从 cwd 打开：个人侧文档按 personal base 距 root 的层数加 `../` 前缀。
 *
 * 用法：bun run scripts/docs-find.ts --goal "add RPC method" [--paths <p>] [--trigger <t>] [--json] [--limit 5]
 * `--root` 仅用于测试（默认 process.cwd()）。
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseFrontmatter, parseStringArray } from './check-docs';

/** 共享侧：相对 root，始终参与扫描。 */
const SHARED_DOC_DIRS = ['docs/architecture', 'docs/agents'] as const;
/** 个人侧：只在找到 personal base 时扫描。 */
const PERSONAL_DOC_DIRS = ['docs/constitution', 'docs/lessons', 'docs/roles'] as const;
const MAX_PERSONAL_DEPTH = 3;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_TOKENS = 256;
const ANCHOR_LIMIT = 20;

export interface DocsFindOptions {
  goals: string[];
  paths: string[];
  triggers: string[];
  limit: number;
  root: string;
  json: boolean;
}

export interface DocsFindAnchor {
  id?: string;
  text?: string;
  line: number;
}

export interface DocsFindResult {
  title: string;
  path: string;
  kind: string;
  score: number;
  why: string[];
  estTokens: number;
  anchors: DocsFindAnchor[];
}

interface ModuleDoc {
  path: string;
  title: string;
  kind: string;
  triggers: string[];
  paths: string[];
  text: string;
}

interface LoadResult {
  modules: ModuleDoc[];
  warnings: string[];
}

/**
 * 一个扫描 base：base 是磁盘绝对路径，displayBase 是输出用的可直接打开的前缀
 * （共享侧为空，个人侧为若干 `../`），dirs 是要扫的 root 相对目录。
 */
interface DocDir {
  base: string;
  displayBase: string;
  dirs: readonly string[];
}

interface RunResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

const USAGE = `用法: bun run scripts/docs-find.ts --goal "<目标>" [--paths <路径>] [--trigger <词>] [--json] [--limit 5]

  --goal <text>     目标文本；可重复；与 --paths / --trigger 至少给一个
  --paths <p>       仓库相对路径；可重复或逗号分隔
  --trigger <t>     精确 trigger；可重复
  --json            只输出 JSON
  --limit <n>       返回条数，默认 5，上限 20
  --root <dir>      仅用于测试（默认 process.cwd()）
  --help            显示本说明

扫描范围：root 的 docs/architecture、docs/agents；若 root 或其 3 层内祖先存在
docs/constitution、docs/lessons、docs/roles，则同时扫描最近的那个 base（个人侧，
输出路径带 ../ 前缀，可直接从 cwd 打开；找不到时静默跳过）。
`;

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z0-9][a-z0-9_./-]*/g) ?? [];
  const han = text.match(/\p{Script=Han}+/gu) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (token: string): void => {
    if (!token || seen.has(token) || out.length >= MAX_TOKENS) return;
    seen.add(token);
    out.push(token);
  };
  for (const token of ascii) add(token);
  for (const run of han) {
    if (run.length >= 2) {
      add(run);
      for (let index = 0; index < run.length - 1; index += 1) add(run.slice(index, index + 2));
    } else {
      add(run);
    }
  }
  return out;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function matchTrigger(trigger: string, goalLower: string, tokens: Set<string>): boolean {
  const value = trigger.toLowerCase();
  if (!value) return false;
  if (value.includes(' ')) return goalLower.includes(value);
  if (/[_./-]/.test(value)) return goalLower.includes(value) || tokens.has(value);
  return tokens.has(value);
}

function titleMatches(title: string, tokens: Set<string>): boolean {
  const lower = title.toLowerCase();
  for (const token of tokens) {
    if (token.length >= 2 && lower.includes(token)) return true;
  }
  return false;
}

function estimateTokens(text: string): number {
  const cjk = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const other = [...text].length - cjk;
  return Math.ceil(cjk + other / 4);
}

function extractAnchors(text: string): DocsFindAnchor[] {
  const lines = text.split('\n');
  const anchors: DocsFindAnchor[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const idMatch = /id="([^"]+)"/.exec(line);
    if (idMatch?.[1]) {
      const key = `id:${idMatch[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        anchors.push({ id: idMatch[1], line: index + 1 });
      }
    }
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) {
      const key = `text:${heading[1]}:${index + 1}`;
      if (!seen.has(key)) {
        seen.add(key);
        anchors.push({ text: heading[1], line: index + 1 });
      }
    }
    if (anchors.length >= ANCHOR_LIMIT) break;
  }
  return anchors;
}

/**
 * 解析参与扫描的文档目录。
 *
 * 共享侧两个目录相对 root，displayBase 为空（输出仍是 `docs/architecture/x.md`）。
 * 个人侧从 root 向上最多 3 层祖先里找第一个 `docs/{constitution,lessons,roles}` 存在的
 * 祖先作为 personal base；只加入该 base 下实际存在的目录，找不到时静默跳过。
 */
function resolveDocDirs(root: string): DocDir[] {
  const dirs: DocDir[] = SHARED_DOC_DIRS.map((dir) => ({
    base: root,
    displayBase: '',
    dirs: [dir],
  }));
  let personalBase: string | null = null;
  let depth = 0;
  let candidate = root;
  for (let step = 0; step <= MAX_PERSONAL_DEPTH; step += 1) {
    if (PERSONAL_DOC_DIRS.some((dir) => existsSync(join(candidate, dir)))) {
      personalBase = candidate;
      depth = step;
      break;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  if (personalBase === null) return dirs;
  const present = PERSONAL_DOC_DIRS.filter((dir) => existsSync(join(personalBase, dir)));
  if (present.length === 0) return dirs;
  dirs.push({ base: personalBase, displayBase: '../'.repeat(depth), dirs: present });
  return dirs;
}

async function loadModules(dirs: DocDir[]): Promise<LoadResult> {
  const modules: ModuleDoc[] = [];
  const warnings: string[] = [];
  for (const dir of dirs) {
    for (const relativeDir of dir.dirs) {
      const full = join(dir.base, relativeDir);
      if (!existsSync(full)) continue;
      const files = await readdir(full);
      const markdown = files.filter((file) => file.endsWith('.md') && file !== 'INDEX.md').sort();
      for (const file of markdown) {
        const relative = `${dir.displayBase}${relativeDir}/${file}`;
        const text = await readFile(join(full, file), 'utf8');
        const frontmatter = parseFrontmatter(text);
        if (!frontmatter) {
          warnings.push(`${relative}: 缺少合法 frontmatter，跳过`);
          continue;
        }
        const triggers = parseStringArray(frontmatter.triggers ?? '');
        const paths = parseStringArray(frontmatter.paths ?? '');
        if (!frontmatter.title || !frontmatter.kind || !triggers || !paths) {
          warnings.push(`${relative}: frontmatter 字段不完整，跳过`);
          continue;
        }
        modules.push({
          path: relative,
          title: frontmatter.title,
          kind: frontmatter.kind,
          triggers,
          paths,
          text,
        });
      }
    }
  }
  return { modules, warnings };
}

function scoreModule(
  module: ModuleDoc,
  options: DocsFindOptions,
  tokens: Set<string>,
  goalLower: string,
): DocsFindResult {
  const why: string[] = [];
  const triggerHits = new Set<string>();
  for (const trigger of module.triggers) {
    if (matchTrigger(trigger, goalLower, tokens)) triggerHits.add(trigger.toLowerCase());
  }
  for (const trigger of options.triggers) {
    const value = trigger.toLowerCase();
    if (module.triggers.some((item) => item.toLowerCase() === value)) triggerHits.add(value);
  }

  const matchedGlobs = new Set<string>();
  for (const queryPath of options.paths) {
    for (const glob of module.paths) {
      try {
        const matcher = new Bun.Glob(glob);
        if (matcher.match(queryPath) || matcher.match(`${queryPath}/__probe__`)) {
          matchedGlobs.add(glob);
          break;
        }
      } catch {
        // 非法 glob 视为不命中；结构门禁会单独报 frontmatter 问题。
      }
    }
  }
  if (matchedGlobs.size > 0) why.push(...[...matchedGlobs].map((glob) => `path:${glob}`));
  for (const trigger of triggerHits) why.push(`trigger:${trigger}`);
  const titleHit = titleMatches(module.title, tokens);
  if (titleHit) why.push('title');

  const score = (matchedGlobs.size > 0 ? 5 : 0) + triggerHits.size + (titleHit ? 2 : 0);
  return {
    title: module.title,
    path: module.path,
    kind: module.kind,
    score,
    why,
    estTokens: estimateTokens(module.text),
    anchors: extractAnchors(module.text),
  };
}

function compareResults(left: DocsFindResult, right: DocsFindResult): number {
  if (right.score !== left.score) return right.score - left.score;
  const leftPath = left.why.some((item) => item.startsWith('path:')) ? 1 : 0;
  const rightPath = right.why.some((item) => item.startsWith('path:')) ? 1 : 0;
  if (rightPath !== leftPath) return rightPath - leftPath;
  const leftTriggers = left.why.filter((item) => item.startsWith('trigger:')).length;
  const rightTriggers = right.why.filter((item) => item.startsWith('trigger:')).length;
  if (rightTriggers !== leftTriggers) return rightTriggers - leftTriggers;
  const leftTitle = left.why.includes('title') ? 1 : 0;
  const rightTitle = right.why.includes('title') ? 1 : 0;
  if (rightTitle !== leftTitle) return rightTitle - leftTitle;
  // 更具体的 glob 优先（长度作为代理），避免 packages/** 压过精确模块。
  const pathLength = (result: DocsFindResult): number =>
    result.why
      .filter((item) => item.startsWith('path:'))
      .reduce((max, item) => Math.max(max, item.length), 0);
  const leftPathLength = pathLength(left);
  const rightPathLength = pathLength(right);
  if (rightPathLength !== leftPathLength) return rightPathLength - leftPathLength;
  if (left.estTokens !== right.estTokens) return left.estTokens - right.estTokens;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function formatHuman(results: DocsFindResult[], fallback: boolean): string {
  if (results.length === 0) {
    return '无命中，回落 AGENTS.md 硬规则\n';
  }
  const lines: string[] = [];
  for (const result of results) {
    lines.push(
      `${result.score}  ${result.kind}  ${result.path}  ${result.title}  ~${result.estTokens} tok`,
    );
    if (result.why.length > 0) lines.push(`  why: ${result.why.join(', ')}`);
    if (result.anchors.length > 0) {
      const anchors = result.anchors
        .slice(0, 5)
        .map((anchor) => anchor.id ?? `${anchor.text}@${anchor.line}`)
        .join(', ');
      lines.push(`  anchors: ${anchors}`);
    }
  }
  if (fallback) lines.push('（fallback: 无命中，回落 AGENTS.md 硬规则）');
  return `${lines.join('\n')}\n`;
}

export async function runDocsFind(argv: string[], defaultRoot = process.cwd()): Promise<RunResult> {
  const goals: string[] = [];
  const paths: string[] = [];
  const triggers: string[] = [];
  let limit = DEFAULT_LIMIT;
  let root = defaultRoot;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const next = (): string | null => {
      const value = argv[index + 1];
      if (value === undefined) return null;
      index += 1;
      return value;
    };
    if (arg === '--help') {
      return { exitCode: 0, stdout: USAGE, stderr: '' };
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--goal' || arg === '--trigger') {
      const value = next();
      if (value === null || value.trim() === '') {
        return { exitCode: 2, stdout: '', stderr: `${arg} 需要一个非空值\n` };
      }
      (arg === '--goal' ? goals : triggers).push(value.trim());
      continue;
    }
    if (arg === '--paths') {
      const value = next();
      if (value === null) return { exitCode: 2, stdout: '', stderr: '--paths 需要一个值\n' };
      for (const part of value.split(',')) {
        const normalized = normalizePath(part.trim());
        if (normalized) paths.push(normalized);
      }
      continue;
    }
    if (arg === '--limit') {
      const value = next();
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return { exitCode: 2, stdout: '', stderr: `--limit 必须是 1..${MAX_LIMIT} 的整数\n` };
      }
      limit = parsed;
      continue;
    }
    if (arg === '--root') {
      const value = next();
      if (value === null) return { exitCode: 2, stdout: '', stderr: '--root 需要一个值\n' };
      root = resolve(value);
      continue;
    }
    return { exitCode: 2, stdout: '', stderr: `未知参数：${arg}\n\n${USAGE}` };
  }

  if (goals.length === 0 && paths.length === 0 && triggers.length === 0) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `至少给 --goal / --paths / --trigger 之一\n\n${USAGE}`,
    };
  }

  const docDirs = resolveDocDirs(root);
  const { modules, warnings } = await loadModules(docDirs);
  const stderr = warnings.length > 0 ? `${warnings.join('\n')}\n` : '';
  if (modules.length === 0) {
    const scanned = [...SHARED_DOC_DIRS, ...PERSONAL_DOC_DIRS].join(' / ');
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${stderr}没有可解析的模块（检查 ${scanned}）\n`,
    };
  }

  const goalLower = goals.join(' ').toLowerCase();
  const tokens = new Set(tokenize(goals.join(' ')));
  const options: DocsFindOptions = { goals, paths, triggers, limit, root, json };
  const results = modules
    .map((module) => scoreModule(module, options, tokens, goalLower))
    .filter((result) => result.score > 0)
    .sort(compareResults)
    .slice(0, limit);

  const fallback = results.length === 0;
  if (json) {
    const payload = {
      query: { goal: goals.join(' '), paths, triggers },
      results,
      count: results.length,
      fallback,
    };
    return { exitCode: fallback ? 1 : 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr };
  }
  return { exitCode: fallback ? 1 : 0, stdout: formatHuman(results, fallback), stderr };
}

if (import.meta.main) {
  const result = await runDocsFind(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
