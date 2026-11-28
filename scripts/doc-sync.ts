#!/usr/bin/env bun

/**
 * doc-sync —— 按需信息工具：读 frontmatter + git 历史，浮现 sync 候选
 * （滞后 / 漏覆盖 / 树缺口 / 孤儿候选）。零存储零状态零依赖（Bun 内置 + git）。
 *
 * 契约：DOC-MANAGEMENT §3.5（kind: current/advisory + paths = 需同步叶子；kind: guide
 * 只有 children，免代码同步；树约定见个人侧 docs/dev/plans/doc-tree-impl.md §2）；
 * 机制与边界见个人侧 docs/dev/plans/doc-sync-impl.md §9。每次运行全派生：基线 = 末次触碰
 * 该文档的 commit，按基线 sha 分组派生 churn/滞后，Bun.Glob 过滤（不用 git pathspec）。
 * 信息性非 gate：churn 只是上界，语义确认与更新判断归人；不写 synced/正确，永不 exit 1，
 * 不接 CI / hook。
 *
 * 用法：bun run scripts/doc-sync.ts [--threshold N] [--json] [--doc <path>] [--all] [--quiet]
 * 退出码：0 成功（无论有无候选）；2 参数 / 目录 / git 错误；永不 1（无 pass/fail 语义）。
 *
 * --quiet（订阅脚本契约，q-subscription-script）：仅输出滞后文档（churnFiles>0 且
 * lagCommits>=threshold），每行 `滞后N次 <doc> (churn M)`（lag 降序 / path 字典序，
 * 稳定排序是订阅 diff 模式的前提）；无滞后 ⇒ stdout 全空。不含 coverage / tree gaps /
 * orphan（quiet = 主信号滞后）。与 --json 组合 ⇒ `{"docs":[…仅滞后…]}`；--doc 优先于 quiet。
 *
 * 「确认无需改」标记（q-subscription-script-p1，doc-refresh 终报建议⑤）：中央标记文件
 * `docs/doc-lag-marks.json`（SCAN_DIRS 之外，commit 标记不触叶子基线），形如
 * `{ "<leaf相对路径>": { "sha": "<确认时 HEAD>", "reason": "必填", "at": "…" } }`。
 * 语义确认者（main/forge 评审时）写入：截至 sha 的代码变更经语义确认无需改本文。
 * 校验（任一失败回落原基线，标记静默忽略）：sha 须同时是 doc.baseline 的后代
 * （git merge-base --is-ancestor baseline sha）且是 HEAD 的祖先（is-ancestor sha HEAD）
 * ——双向防 reset / 超前 sha；reason 必填非空。生效时 lag 只数 mark.sha 之后的 churn
 * （精确抑制虚高段，非清零）；叶子日后真同步（基线越过 sha）标记自然失效。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { parseFrontmatter, parseStringArray } from './docs-find';

const ROOT = join(import.meta.dir, '..');
const SCAN_DIRS = ['docs/architecture', 'docs/agents', 'docs/operations'] as const;
const SYNC_KINDS = new Set(['current', 'advisory']);
const DEFAULT_THRESHOLD = 10;
const USAGE =
  '用法: bun run scripts/doc-sync.ts [--threshold N] [--json] [--doc <path>] [--all] [--quiet]\n';

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** path 相对 repo root；display 去掉 docs/ 前缀（§9.4 示例口径）。 */
interface SyncDoc {
  path: string;
  display: string;
  kind: string;
  globs: string[];
  matchers: Bun.Glob[];
  baseline: string | null;
  /** 生效的「确认无需改」标记（双向 ancestor 校验通过才有；lag 从 mark.sha 起算） */
  confirmed?: LagMark;
  churnFiles: number;
  lagCommits: number;
  status: string;
}

/** 一个基线 sha 到 HEAD 的变更集：churn 文件 + 各 commit 触碰的文件。 */
interface RangeData {
  changed: string[];
  commits: { sha: string; files: string[] }[];
}

/**
 * 「确认无需改」标记（q-subscription-script-p1）：截至 sha 的 churn 经语义确认无需改本文。
 * reason 必填（语义判定理由，确认者署名口径见 doc-refresh 终报建议⑤）。
 */
interface LagMark {
  sha: string;
  reason: string;
  at?: string;
}

/** 中央标记文件（SCAN_DIRS 之外：commit 它不触任何叶子基线）。 */
const MARKS_FILE = 'docs/doc-lag-marks.json';

/** guide 只导航不绑代码：children 已解析为 repo root 相对路径；无 paths/baseline/churn。 */
interface GuideDoc {
  path: string;
  children: string[];
}

interface TreeGaps {
  unregistered: string[];
  dead: string[];
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

/** git 退出码判定（不抛）：merge-base --is-ancestor 校验用（1 = 非祖先，合法结果）。 */
function gitOk(...args: string[]): boolean {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0;
}

/**
 * 读中央标记文件（缺省 / 非法 JSON / 非法条目 ⇒ 无标记，信息性工具不 gate）。
 * 条目校验：sha 非空字符串 + reason 必填非空（main 裁定）；at 可选字符串。
 * ancestor 双向校验在 scanDocs 逐叶做（需要各叶基线）。
 */
function readLagMarks(): Map<string, LagMark> {
  const marks = new Map<string, LagMark>();
  const full = join(ROOT, MARKS_FILE);
  if (!existsSync(full)) return marks;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    return marks; // 非法 JSON ⇒ 全部标记忽略（回落原基线）
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return marks;
  for (const [path, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const sha = typeof record.sha === 'string' ? record.sha.trim() : '';
    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    if (sha === '' || reason === '') continue; // reason 必填（fail-closed 单条）
    const at = typeof record.at === 'string' ? record.at : undefined;
    marks.set(path, { sha, reason, ...(at !== undefined ? { at } : {}) });
  }
  return marks;
}

function lines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** glob 编译一次、按 pattern 去重；非法 glob 视为不命中（docs-find 先例），不抛。 */
const globCache = new Map<string, Bun.Glob | null>();

function compileGlob(pattern: string): Bun.Glob | null {
  const cached = globCache.get(pattern);
  if (cached !== undefined) return cached;
  let matcher: Bun.Glob | null = null;
  try {
    matcher = new Bun.Glob(pattern);
  } catch {
    // 非法 glob = 不命中；frontmatter 结构问题归 reviewer，不在这里断言。
  }
  globCache.set(pattern, matcher);
  return matcher;
}

/** 裸相对名（无 /）按前一绝对条目的 dirname 解析；去重保序。 */
function resolvePaths(entries: string[]): string[] {
  const out: string[] = [];
  let base = '';
  for (const entry of entries) {
    if (entry.includes('/')) {
      out.push(entry);
      base = dirname(entry);
    } else {
      out.push(base === '' ? entry : `${base}/${entry}`);
    }
  }
  return [...new Set(out)];
}

function matchesAny(matchers: Bun.Glob[], file: string): boolean {
  return matchers.some((matcher) => matcher.match(file));
}

function rangeData(sha: string): RangeData {
  const changed = lines(git('diff', '--name-only', `${sha}..HEAD`));
  const commits: { sha: string; files: string[] }[] = [];
  for (const line of lines(git('log', '--format=%H', `${sha}..HEAD`, '--name-only'))) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      commits.push({ sha: line, files: [] });
    } else {
      commits.at(-1)?.files.push(line);
    }
  }
  return { changed, commits };
}

/** 扫描集：leaf = current/advisory（无 paths = 空 globs，churn 0）；guide 只读 children。 */
async function scanDocs(): Promise<{ docs: SyncDoc[]; guides: GuideDoc[] }> {
  const docs: SyncDoc[] = [];
  const guides: GuideDoc[] = [];
  const marks = readLagMarks();
  for (const dir of SCAN_DIRS) {
    const full = join(ROOT, dir);
    if (!existsSync(full)) throw new Error(`缺少扫描目录: ${dir}`);
    const files = (await readdir(full)).filter((file) => file.endsWith('.md')).sort();
    for (const file of files) {
      const text = await readFile(join(full, file), 'utf8');
      const frontmatter = parseFrontmatter(text);
      const kind = frontmatter.kind ?? '';
      const path = `${dir}/${file}`;
      if (kind === 'guide') {
        const children = parseStringArray(frontmatter.children).map((child) =>
          posix.join(posix.dirname(path), child),
        );
        guides.push({ path, children: [...new Set(children)] });
        continue;
      }
      if (!SYNC_KINDS.has(kind)) continue;
      const globs = resolvePaths(parseStringArray(frontmatter.paths));
      const matchers = globs
        .map((glob) => compileGlob(glob))
        .filter((matcher): matcher is Bun.Glob => matcher !== null);
      const baseline = git('log', '-1', '--format=%h', '--', path).trim() || null;
      // 「确认无需改」标记校验（双向 ancestor，main 裁定）：baseline → mark.sha → HEAD
      // 任一失败 ⇒ 回落原基线（防 reset / 超前 sha / 写错叶）。新文档（无基线）不适用。
      const mark = marks.get(path);
      let confirmed: LagMark | undefined;
      if (mark !== undefined && baseline !== null) {
        if (
          gitOk('merge-base', '--is-ancestor', baseline, mark.sha) &&
          gitOk('merge-base', '--is-ancestor', mark.sha, 'HEAD')
        ) {
          confirmed = mark;
        }
      }
      docs.push({
        path,
        display: path.replace(/^docs\//, ''),
        kind,
        globs,
        matchers,
        baseline,
        ...(confirmed !== undefined ? { confirmed } : {}),
        churnFiles: 0,
        lagCommits: 0,
        status: '新文档',
      });
    }
  }
  return { docs, guides };
}

/** 按基线 sha 分组派生 churn/滞后；git 调用数 = 唯一基线数，非文档数。
 * 生效标记（confirmed）的叶子从 mark.sha 起算（精确抑制虚高段，非清零）。 */
function computeLag(docs: SyncDoc[], threshold: number): Map<string, RangeData> {
  const ranges = new Map<string, RangeData>();
  for (const doc of docs) {
    if (doc.baseline === null) continue; // 新文档：跳过滞后
    const lagBase = doc.confirmed?.sha ?? doc.baseline;
    let range = ranges.get(lagBase);
    if (range === undefined) {
      range = rangeData(lagBase);
      ranges.set(lagBase, range);
    }
    doc.churnFiles = range.changed.filter((file) => matchesAny(doc.matchers, file)).length;
    doc.lagCommits = range.commits.filter((commit) =>
      commit.files.some((file) => matchesAny(doc.matchers, file)),
    ).length;
    if (doc.churnFiles === 0) {
      doc.status = '无churn';
    } else if (doc.lagCommits >= threshold) {
      doc.status = `滞后${doc.lagCommits}次`;
    } else {
      doc.status = '需更新';
    }
  }
  return ranges;
}

/** 树缺口（信息性）：leaf 未登记进任何 guide children / children 指向不存在的文件。 */
function findTreeGaps(docs: SyncDoc[], guides: GuideDoc[]): TreeGaps {
  const registered = new Set(guides.flatMap((guide) => guide.children));
  return {
    unregistered: docs.filter((doc) => !registered.has(doc.path)).map((doc) => doc.path),
    dead: [...registered].filter((child) => !existsSync(join(ROOT, child))),
  };
}

/** CJK 按 2 列宽对齐（状态词汇是中文，padEnd 数码元会歪）。 */
function pad(text: string, width: number): string {
  let current = 0;
  for (const ch of text) current += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return text + ' '.repeat(Math.max(1, width - current));
}

function formatLag(docs: SyncDoc[], all: boolean): string[] {
  const rows = docs
    .filter((doc) => all || doc.churnFiles > 0 || doc.status === '新文档')
    .sort(
      (a, b) =>
        b.lagCommits - a.lagCommits || b.churnFiles - a.churnFiles || a.path.localeCompare(b.path),
    );
  if (rows.length === 0) return ['(none)'];
  const out = [
    `${pad('status', 12)}${pad('doc', 34)}${pad('base', 10)}${pad('commits', 9)}${pad('files', 7)}paths`,
  ];
  for (const doc of rows) {
    const isNew = doc.baseline === null;
    const globs = doc.globs.slice(0, 2).join(' ') + (doc.globs.length > 2 ? ' ...' : '');
    // base 列 = 有效 lag 基线（生效标记时为 mark.sha；原基线见 --doc 详情）。
    const lagBase = doc.confirmed?.sha.slice(0, 10) ?? doc.baseline ?? '-';
    out.push(
      pad(doc.status, 12) +
        pad(doc.display, 34) +
        pad(lagBase, 10) +
        pad(isNew ? '-' : String(doc.lagCommits), 9) +
        pad(isNew ? '-' : String(doc.churnFiles), 7) +
        globs,
    );
  }
  return out;
}

/** quiet 模式（订阅脚本契约）：仅滞后文档，稳定排序（lag 降序 / path 字典序）。 */
function laggingDocs(docs: SyncDoc[]): SyncDoc[] {
  return docs
    .filter((doc) => doc.churnFiles > 0 && doc.status.startsWith('滞后'))
    .sort((a, b) => b.lagCommits - a.lagCommits || a.path.localeCompare(b.path));
}

function formatQuietLag(docs: SyncDoc[]): string[] {
  return laggingDocs(docs).map(
    (doc) => `滞后${doc.lagCommits}次 ${doc.display} (churn ${doc.churnFiles})`,
  );
}

function formatCoverage(uncovered: string[], all: boolean): string[] {
  if (uncovered.length === 0) return ['(none)'];
  if (all) return uncovered;
  const groups = new Map<string, string[]>();
  for (const file of uncovered) {
    const slash = file.indexOf('/');
    const dir = slash < 0 ? '(root)' : file.slice(0, slash);
    const bucket = groups.get(dir);
    if (bucket) bucket.push(file);
    else groups.set(dir, [file]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([dir, files]) => {
      const label = dir === '(root)' ? '(root)' : `${dir}/`;
      return `${pad(label, 24)}${pad(String(files.length), 6)}e.g. ${files[0] ?? ''}`;
    });
}

function formatTreeGaps(gaps: TreeGaps): string[] {
  if (gaps.unregistered.length === 0 && gaps.dead.length === 0) return ['(none)'];
  const display = (path: string): string => path.replace(/^docs\//, '');
  const out: string[] = [];
  if (gaps.unregistered.length > 0) {
    out.push(`unregistered: ${gaps.unregistered.map(display).join(', ')}`);
  }
  if (gaps.dead.length > 0) out.push(`dead children: ${gaps.dead.map(display).join(', ')}`);
  return out;
}

function docFields(doc: SyncDoc) {
  const { path, kind, baseline, globs, churnFiles, lagCommits, status } = doc;
  return {
    path,
    kind,
    baseline,
    ...(doc.confirmed !== undefined ? { confirmed: doc.confirmed } : {}),
    globs,
    churnFiles,
    lagCommits,
    status,
  };
}

function docDetail(doc: SyncDoc, range: RangeData | null): { files: string[]; commits: string[] } {
  if (range === null) return { files: [], commits: [] };
  return {
    files: range.changed.filter((file) => matchesAny(doc.matchers, file)),
    commits: range.commits
      .filter((commit) => commit.files.some((file) => matchesAny(doc.matchers, file)))
      .map((commit) => commit.sha),
  };
}

function formatDocDetail(doc: SyncDoc, detail: { files: string[]; commits: string[] }): string {
  const out = [
    `doc: ${doc.path}  kind: ${doc.kind}  status: ${doc.status}`,
    `baseline: ${doc.baseline ?? '(none)'}`,
  ];
  if (doc.confirmed !== undefined) {
    out.push(
      `confirmed-no-change: ${doc.confirmed.sha} (lag counted from here; reason: ${doc.confirmed.reason})`,
    );
  }
  out.push(`globs (${doc.globs.length}):`, ...doc.globs.map((glob) => `  ${glob}`));
  if (doc.baseline !== null) {
    out.push(`churn files (${detail.files.length}):`, ...detail.files.map((file) => `  ${file}`));
    out.push(`lag commits (${detail.commits.length}):`, ...detail.commits.map((sha) => `  ${sha}`));
  }
  return `${out.join('\n')}\n`;
}

function formatGuideDetail(guide: GuideDoc): string {
  const out = [
    `guide: ${guide.path}  kind: guide`,
    `children (${guide.children.length}):`,
    ...guide.children.map((child) => `  ${child}`),
  ];
  return `${out.join('\n')}\n`;
}

async function runDocSync(argv: string[]): Promise<RunResult> {
  let threshold = DEFAULT_THRESHOLD;
  let json = false;
  let all = false;
  let quiet = false;
  let docPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const next = (): string | null => {
      const value = argv[index + 1];
      if (value === undefined) return null;
      index += 1;
      return value;
    };
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--quiet') {
      quiet = true;
      continue;
    }
    if (arg === '--threshold') {
      const value = next();
      const parsed = Number(value);
      if (value === null || !Number.isInteger(parsed) || parsed < 1) {
        return { exitCode: 2, stdout: '', stderr: `--threshold 需要正整数\n\n${USAGE}` };
      }
      threshold = parsed;
      continue;
    }
    if (arg === '--doc') {
      const value = next();
      if (value === null || value.trim() === '') {
        return { exitCode: 2, stdout: '', stderr: `--doc 需要一个路径\n\n${USAGE}` };
      }
      docPath = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
      continue;
    }
    return { exitCode: 2, stdout: '', stderr: `未知参数: ${arg}\n\n${USAGE}` };
  }

  const head = git('rev-parse', '--short', 'HEAD').trim();
  const { docs, guides } = await scanDocs();
  const ranges = computeLag(docs, threshold);

  if (docPath !== null) {
    const guide = guides.find((item) => item.path === docPath);
    if (guide !== undefined) {
      if (json) {
        const payload = { head, threshold, guide };
        return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
      }
      return { exitCode: 0, stdout: formatGuideDetail(guide), stderr: '' };
    }
    const doc = docs.find((item) => item.path === docPath);
    if (doc === undefined) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: `--doc 不在扫描集（current/advisory/guide）: ${docPath}\n`,
      };
    }
    let range: RangeData | null = null;
    if (doc.baseline !== null) range = ranges.get(doc.confirmed?.sha ?? doc.baseline) ?? null;
    const detail = docDetail(doc, range);
    if (json) {
      const payload = {
        head,
        threshold,
        doc: { ...docFields(doc), files: detail.files, commits: detail.commits },
      };
      return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: formatDocDetail(doc, detail), stderr: '' };
  }

  // quiet（订阅脚本契约）：仅滞后主信号，无滞后 stdout 全空；不算 coverage / tree gaps。
  if (quiet) {
    const lagging = laggingDocs(docs);
    if (json) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ docs: lagging.map(docFields) }, null, 2)}\n`,
        stderr: '',
      };
    }
    const rows = formatQuietLag(docs);
    return { exitCode: 0, stdout: rows.length > 0 ? `${rows.join('\n')}\n` : '', stderr: '' };
  }

  const tracked = lines(git('ls-files'));
  const staged = lines(git('diff', '--cached', '--name-only', '--diff-filter=A'));
  const codeFiles = [...new Set([...tracked, ...staged])].filter(
    (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
  );
  const allMatchers = [...globCache.values()].filter((m): m is Bun.Glob => m !== null);
  const uncovered = codeFiles.filter((file) => !matchesAny(allMatchers, file));
  const orphans = docs.filter((doc) => !tracked.some((file) => matchesAny(doc.matchers, file)));
  const treeGaps = findTreeGaps(docs, guides);

  if (json) {
    const payload = {
      head,
      threshold,
      docs: docs.map(docFields),
      guides,
      coverage: uncovered,
      treeGaps,
      orphans: orphans.map((doc) => doc.path),
    };
    return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
  }

  const out = [
    `doc-sync @ ${head}  threshold=${threshold}  (informational: churn is upper bound, judgment belongs to human)`,
    '',
    '== lag ==',
    ...formatLag(docs, all),
    '',
    all ? '== coverage gaps (all files) ==' : '== coverage gaps (grouped) ==',
    ...formatCoverage(uncovered, all),
    '',
    '== tree gaps ==',
    ...formatTreeGaps(treeGaps),
    '',
    '== orphan candidates ==',
    ...(orphans.length === 0 ? ['(none)'] : orphans.map((doc) => doc.display)),
  ];
  return { exitCode: 0, stdout: `${out.join('\n')}\n`, stderr: '' };
}

if (import.meta.main) {
  try {
    const result = await runDocSync(process.argv.slice(2));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
