#!/usr/bin/env bun

/**
 * 发布收口编排（q-release-script，用户裁定：晋升时 main 必跑，自动而非靠记得）。
 *
 * 用法：
 *   bun run scripts/release.ts --bump patch              # 增量·轻收口（修复批）
 *   bun run scripts/release.ts --bump minor [--auto-tag] # 全量·重收口（功能批）
 *   bun run scripts/release.ts --bump major [--auto-tag] # 全量·重收口（破坏批）
 *   bun run scripts/release.ts <version> [--auto-tag]    # 显式版本（重跑/修复漂移，幂等）
 *   bun run scripts/release.ts --suggest-bump            # 只推导 bump 建议（conventional commits），不收口
 *   任一组合 + --dry-run                                  # 只预演计划，不落盘不 git
 *
 * bump 推导（q-semver-auto-bump）：上个 v* tag 以来的 commit history →
 * breaking→major / feat→minor / fix-only→patch；只作建议（advisory），不强制、不改变收口行为。
 *
 * 双模式（bump 类型准则：feat→minor / fix-only→patch / breaking→major）：
 * - **增量（patch）轻收口**：manifest 统一 + CHANGELOG 条目 append（缺节时只立骨架，
 *   不造变更内容）+ CURRENT.md 同步 + auto-commit；`--auto-tag` 打 annotated tag。
 * - **全量（minor/major）重收口**：轻收口全部 + 版本文档 docs/versions/<v>.md
 *   （CHANGELOG 节逐字迁入，缺节报错候人补，不自动造内容）+ INDEX.md 登记。
 *
 * 收口末尾必过 `version.ts --check` 门禁；commit 用 `-c gc.auto=0`；tag 只在
 * `--auto-tag` 时打，**不 push**（push main + tag 由 main 执行，tag push 触发 release.yml）。
 *
 * git 可用性：本脚本 spawn 宿主 `git`。WSL 建的 worktree（.git 指针 /mnt/d，L-057）
 * Windows git 读不了——收口请在主 checkout 跑；--dry-run 对 git 不可用降级为告警。
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyVersion,
  BUMP_KINDS,
  type BumpKind,
  changelogHasVersion,
  checkVersions,
  nextVersion,
  previewVersion,
  readRootVersion,
  validateVersion,
} from './version';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().slice(0, 10);

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: string[]): GitResult {
  const result = Bun.spawnSync(['git', '-c', 'gc.auto=0', ...args], { cwd: ROOT });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function gitAvailable(): boolean {
  return git(['rev-parse', '--show-toplevel']).ok;
}

function die(message: string): never {
  console.error(`release 收口失败：${message}`);
  process.exit(1);
}

/** 从 CHANGELOG 提取 `## [version]` 整节（到下一个 `## [` 或文末）。 */
function extractChangelogSection(text: string, version: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('## [')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/\s+$/, '');
}

/** CHANGELOG 日期（`## [v] - YYYY-MM-DD`）；无日期回落今天。 */
function changelogDate(text: string, version: string): string {
  const heading = text.split('\n').find((line) => line.startsWith(`## [${version}]`));
  return /(\d{4}-\d{2}-\d{2})/.exec(heading ?? '')?.[1] ?? TODAY;
}

/** 轻收口：缺节时立骨架（标题 + 日期 + 候补标记），不造变更内容。返回是否新立。 */
async function ensureChangelogEntry(version: string, dryRun: boolean): Promise<boolean> {
  if (await changelogHasVersion(ROOT, version)) return false;
  const path = join(ROOT, 'CHANGELOG.md');
  const text = await readFile(path, 'utf8');
  const skeleton = `## [${version}] - ${TODAY}\n\n> 修复批（轻收口自动立节；变更明细候补，见 git log 与 docs/versions/CURRENT.md）。\n\n`;
  const firstEntry = text.search(/^## \[/m);
  const next =
    firstEntry >= 0
      ? text.slice(0, firstEntry) + skeleton + text.slice(firstEntry)
      : `${text.trimEnd()}\n\n${skeleton}`;
  if (!dryRun) await writeFile(path, next);
  return true;
}

/** 重收口：版本文档 = 头部 + CHANGELOG 节逐字迁入（2.1.0.md 既有模式）。返回是否新建。 */
async function ensureVersionDoc(
  version: string,
  section: string,
  dryRun: boolean,
): Promise<boolean> {
  const relative = `docs/versions/${version}.md`;
  if (existsSync(join(ROOT, relative))) return false;
  const body = `# ${version}\n\n> ${TODAY} 发布收口（release.ts 自动建档）。变更明细自 CHANGELOG.md [${version}] 节逐字迁入。\n\n## 变更明细（自 CHANGELOG 迁入）\n\n${section}\n`;
  if (!dryRun) await writeFile(join(ROOT, relative), body);
  return true;
}

/** INDEX.md 表头后插入新行（新的在前）；已有该版本行则不动。返回是否新增。 */
async function ensureIndexRow(
  version: string,
  date: string,
  section: string,
  baseline: string,
  dryRun: boolean,
): Promise<boolean> {
  const path = join(ROOT, 'docs/versions/INDEX.md');
  const text = await readFile(path, 'utf8');
  if (new RegExp(`^\\| ${version.replace(/\./g, '\\.')} \\|`, 'm').test(text)) return false;
  const subject =
    section
      .split('\n')
      .find((line) => line.startsWith('> '))
      ?.slice(2)
      .trim() ?? '主题候补';
  const row = `| ${version} | ${date} | ${subject} | merged（基线 \`main @ ${baseline}\`） | [${version}](${version}.md) |`;
  const lines = text.split('\n');
  const separator = lines.findIndex((line) => /^\|[-\s|]+\|$/.test(line));
  if (separator < 0) die('docs/versions/INDEX.md: 找不到表头分隔行（结构漂移，请人工修复）');
  lines.splice(separator + 1, 0, row);
  if (!dryRun) await writeFile(path, lines.join('\n'));
  return true;
}

/** CURRENT.md 同步：只重写「## 版本」节 + 「## 入口」版本记录行；其余人工现态节不动。 */
async function syncCurrent(
  version: string,
  date: string,
  tagLine: string,
  dryRun: boolean,
): Promise<boolean> {
  const path = join(ROOT, 'docs/versions/CURRENT.md');
  const text = await readFile(path, 'utf8');
  const sectionStart = text.indexOf('## 版本');
  if (sectionStart < 0) die('docs/versions/CURRENT.md: 缺「## 版本」节（结构漂移，请人工修复）');
  const sectionEnd = text.indexOf('\n## ', sectionStart + 1);
  const end = sectionEnd < 0 ? text.length : sectionEnd;
  const sdkRaw = await readFile(join(ROOT, 'packages/plugin-sdk/package.json'), 'utf8');
  const sdkVersion = (JSON.parse(sdkRaw) as { version?: string }).version ?? '未知';
  const body = `\n\n**${version}**（${date} 收口）— manifest 根 \`package.json\` = \`${version}\`（workspace manifests 同线；\n\`packages/plugin-sdk\` 独立版本线 \`${sdkVersion}\`，仅 SDK 契约变更时 bump）。\n版本号以根 \`package.json\` 为唯一来源。${tagLine}\n当前变更摘要见 [CHANGELOG](../../CHANGELOG.md)；版本记录见 [INDEX.md](INDEX.md)。\n`;
  let next = `${text.slice(0, sectionStart)}## 版本${body}${text.slice(end)}`;
  const link = `[${version}](${version}.md)`;
  next = next.replace(/^- 版本记录：.*$/m, (line) => {
    const existing = line.match(/\[[^\]]+\]\([^)]+\)/g) ?? [];
    const links = [link, ...existing.filter((item) => item !== link)].slice(0, 4);
    return `- 版本记录：${links.join('、')}`;
  });
  if (next === text) return false;
  if (!dryRun) await writeFile(path, next);
  return true;
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/release.ts --bump patch|minor|major [--dry-run] [--auto-tag]
  bun run scripts/release.ts <version> [--dry-run] [--auto-tag]
  bun run scripts/release.ts --suggest-bump

模式：patch=增量轻收口（manifest+CHANGELOG append+CURRENT.md+commit）；
minor/major=全量重收口（+版本文档+INDEX 登记；CHANGELOG 完整节缺则报错候补）。
--auto-tag：打 annotated tag vX.Y.Z（不 push；push 触发 release.yml）。
显式版本：重跑/修复漂移（与根版本相同=只同步不 bump）。
--suggest-bump：从上个 v* tag 以来的 conventional commits 推导 bump 类型
（breaking→major / feat→minor / fix→patch），只打印建议+证据，不收口。
正常收口也会打印同一推导作 advisory（与 --bump 不一致时告警，不强制）。`);
}

/** 显式版本 → bump 类型（与根版本相同 = 漂移修复，按轻收口只同步不 bump）。 */
function deriveKind(current: string, target: string): BumpKind {
  const parts = (version: string): [number, number, number] => {
    const [major = 0, minor = 0, patch = 0] = (version.split('-')[0] ?? '').split('.').map(Number);
    return [major, minor, patch];
  };
  const [cM, cm, cp] = parts(current);
  const [tM, tm, tp] = parts(target);
  if (cM === tM && cm === tm && cp === tp) return 'patch';
  if (tM === cM + 1 && tm === 0 && tp === 0) return 'major';
  if (tM === cM && tm === cm + 1 && tp === 0) return 'minor';
  if (tM === cM && tm === cm && tp === cp + 1) return 'patch';
  die(
    `显式版本 ${target} 不是根版本 ${current} 的 patch/minor/major 增量（或等于根版本做漂移修复）`,
  );
}

// ── bump 类型推导（q-semver-auto-bump：conventional commits → 建议，只建议不强制）──

/** 一条 commit 的 conventional 解析结果（非 conventional → other）。 */
type CommitSignal = 'major' | 'minor' | 'patch' | 'other';

const CONVENTIONAL_HEADER = /^(\w+)(\([^)]*\))?(!)?:\s*.+$/;

/** 单条 commit message（含 body）→ 信号：breaking→major / feat→minor / fix→patch。 */
export function commitSignal(message: string): CommitSignal {
  const [header = '', ...bodyLines] = message.split('\n');
  const match = CONVENTIONAL_HEADER.exec(header.trim());
  const body = bodyLines.join('\n');
  if (/^BREAKING[ -]CHANGE:/m.test(body) || match?.[3] === '!') return 'major';
  if (match === null) return 'other';
  const type = (match[1] ?? '').toLowerCase();
  if (type === 'feat') return 'minor';
  if (type === 'fix') return 'patch';
  return 'other';
}

export interface BumpSuggestion {
  /** null = 无 conventional 信号（不臆造建议） */
  kind: BumpKind | null;
  counts: Record<CommitSignal, number>;
  /** 证据：breaking / feat 的 subject（各截前 3 条） */
  breaking: string[];
  feats: string[];
  total: number;
}

/** commit history → bump 建议：任一 breaking→major，否则任一 feat→minor，否则任一 fix→patch。 */
export function suggestBumpFromCommits(messages: readonly string[]): BumpSuggestion {
  const counts: Record<CommitSignal, number> = { major: 0, minor: 0, patch: 0, other: 0 };
  const breaking: string[] = [];
  const feats: string[] = [];
  for (const message of messages) {
    if (message.trim() === '') continue;
    const signal = commitSignal(message);
    counts[signal] += 1;
    const subject = (message.split('\n')[0] ?? '').trim();
    if (signal === 'major' && breaking.length < 3) breaking.push(subject);
    if (signal === 'minor' && feats.length < 3) feats.push(subject);
  }
  const kind: BumpKind | null =
    counts.major > 0 ? 'major' : counts.minor > 0 ? 'minor' : counts.patch > 0 ? 'patch' : null;
  return { kind, counts, breaking, feats, total: messages.filter((m) => m.trim() !== '').length };
}

/** 上一个 v* tag 以来的 commit messages（无 tag → 最近 300 条）；git 不可用 → null。 */
function collectCommitMessages(): string[] | null {
  if (!gitAvailable()) return null;
  const describe = git(['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const range = describe.ok && describe.stdout !== '' ? [`${describe.stdout}..HEAD`] : [];
  const limit = range.length === 0 ? ['-n', '300'] : [];
  const log = git(['log', '-z', '--format=%B', ...limit, ...range]);
  if (!log.ok) return null;
  return log.stdout.split('\0').filter((message) => message.trim() !== '');
}

/** 建议行（advisory）：推导 + 证据；与本次 kind 不一致时只告警不拦截。 */
function printSuggestion(suggestion: BumpSuggestion, chosen?: BumpKind): void {
  const { kind, counts, breaking, feats, total } = suggestion;
  if (kind === null) {
    console.log(
      `[suggest] ${total} 条 commit 无 conventional 信号（feat/fix/breaking），不臆造建议`,
    );
    return;
  }
  console.log(
    `[suggest] commit history 推导 bump=${kind}（breaking ${counts.major} / feat ${counts.minor} / fix ${counts.patch} / other ${counts.other}，共 ${total} 条）`,
  );
  for (const subject of breaking) console.log(`  breaking: ${subject}`);
  for (const subject of feats) console.log(`  feat: ${subject}`);
  if (chosen !== undefined && chosen !== kind) {
    console.warn(
      `[suggest] warning: 推导 ${kind} 与本次 ${chosen} 不一致（只建议不强制；准则 feat→minor / fix-only→patch / breaking→major）`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  // 独立推导面：只打印建议 + 证据，不收口（候设计 → 先给 main 一个可跑的决策输入）。
  if (args.includes('--suggest-bump')) {
    if (args.length > 1) die('--suggest-bump 单独使用（不与 --bump / 显式版本 / 其他 flag 组合）');
    const messages = collectCommitMessages();
    if (messages === null)
      die('git 不可用，无法读 commit history（L-057：收口/推导请在主 checkout 跑）');
    printSuggestion(suggestBumpFromCommits(messages));
    return;
  }

  const dryRun = args.includes('--dry-run');
  const autoTag = args.includes('--auto-tag');
  const bumpIndex = args.indexOf('--bump');
  let bump: BumpKind | undefined;
  if (bumpIndex >= 0) {
    const value = args[bumpIndex + 1];
    if (!value || !BUMP_KINDS.includes(value as BumpKind)) {
      die(`--bump 需要 patch|minor|major（得到 ${value ?? '空'}）`);
    }
    bump = value as BumpKind;
  }
  const bumpValueIndex = bumpIndex >= 0 ? bumpIndex + 1 : -1;
  const positional = args.filter((arg, index) => !arg.startsWith('-') && index !== bumpValueIndex);

  const current = await readRootVersion(ROOT);
  let version: string;
  let kind: BumpKind;
  if (bump) {
    if (positional[0]) die('--bump 不与显式版本组合（二选一）');
    version = nextVersion(current, bump);
    kind = bump;
  } else {
    version = positional[0] ?? '';
    if (!version) {
      printUsage();
      process.exit(1);
    }
    if (!validateVersion(version)) die(`invalid semver: ${version}`);
    kind = deriveKind(current, version);
  }
  const heavy = kind !== 'patch';
  console.log(
    `release ${heavy ? '全量·重收口' : '增量·轻收口'}: ${current} -> ${version}${dryRun ? '（dry-run 预演）' : ''}`,
  );

  // ── 前置：git 可用性 + 工作区干净 + 基线 ─────────────────────
  const hasGit = gitAvailable();
  let baseline = 'unknown';
  let dirty: string[] = [];
  if (hasGit) {
    baseline = git(['rev-parse', '--short', 'HEAD']).stdout || 'unknown';
    dirty = git(['status', '--porcelain']).stdout.split('\n').filter(Boolean);
    console.log(
      `[前置] 基线 main @ ${baseline}；工作区${dirty.length === 0 ? '干净' : `不干净（${dirty.length} 项）`}`,
    );
    // q-semver-auto-bump：推导只作建议（与本次 kind 不一致时告警），不改变收口行为。
    const messages = collectCommitMessages();
    if (messages !== null) printSuggestion(suggestBumpFromCommits(messages), kind);
  }
  if (!hasGit) {
    if (!dryRun) {
      die(
        'git 不可用（L-057：WSL worktree 的 .git 指针是 /mnt/d，Windows git 读不了）——收口请在主 checkout 跑',
      );
    }
    console.warn('[前置] warning: git 不可用，跳过干净度/tag 状态检查（dry-run 降级）');
  } else if (dirty.length > 0 && !dryRun) {
    die(
      `工作区不干净（${dirty.length} 项），收口要求干净起点：\n  ${dirty.slice(0, 10).join('\n  ')}`,
    );
  } // ── CHANGELOG 门禁 ──────────────────────────────────────────
  const changelogText = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const section = extractChangelogSection(changelogText, version);
  const date = section ? changelogDate(changelogText, version) : TODAY;
  let changelogAppended = false;
  if (heavy) {
    if (!section) {
      die(
        `CHANGELOG.md 缺 "## [${version}]" 完整节——全量收口不自动造内容，请先补节再重跑（显式版本 ${version} 幂等重跑）`,
      );
    }
    console.log(`[CHANGELOG] 完整节已在（${date}）`);
  } else {
    changelogAppended = await ensureChangelogEntry(version, dryRun);
    console.log(
      changelogAppended
        ? `[CHANGELOG] ${dryRun ? 'would append' : 'appended'} 骨架节 ## [${version}]（明细候补，不造内容）`
        : `[CHANGELOG] 节已在（${date}）`,
    );
  }

  // ── manifest 统一 ───────────────────────────────────────────
  const changed = dryRun ? await previewVersion(ROOT, version) : await applyVersion(ROOT, version);
  console.log(
    changed.length === 0
      ? `[manifest] 全部已在 ${version}`
      : `[manifest] ${dryRun ? 'would update' : 'updated'} ${changed.length} 个：\n  ${changed.join('\n  ')}`,
  );

  // ── 重收口：版本文档 + INDEX 登记 ─────────────────────────────
  let docCreated = false;
  let indexAdded = false;
  if (heavy && section) {
    docCreated = await ensureVersionDoc(version, section, dryRun);
    indexAdded = await ensureIndexRow(version, date, section, baseline, dryRun);
    console.log(
      `[版本文档] ${docCreated ? `${dryRun ? 'would create' : 'created'} docs/versions/${version}.md（CHANGELOG 节逐字迁入）` : '已在，不动'}` +
        `；[INDEX] ${indexAdded ? `${dryRun ? 'would add' : 'added'} 行` : '行已在，不动'}`,
    );
  } else {
    console.log('[版本文档] 轻收口不建档（增量批明细在 CHANGELOG）');
  }

  // ── CURRENT.md 同步 ─────────────────────────────────────────
  // tag 状态写命令不写死读数（gov.md）：保证收口幂等重跑零噪声 commit。
  const tagExists = hasGit && git(['rev-parse', '-q', '--verify', `refs/tags/v${version}`]).ok;
  const tagLine = "tag 状态见 `git tag -l 'v*'`（tag push 触发 release.yml）。";
  const currentChanged = await syncCurrent(version, date, tagLine, dryRun);
  console.log(
    `[CURRENT.md] ${currentChanged ? `${dryRun ? 'would sync' : 'synced'} 版本节 + 入口链接` : '已是目标态'}`,
  );

  // ── --check 门禁（写模式：落盘后、commit 前）──────────────────
  if (dryRun) {
    console.log(`[门禁] version --check ${version} 将于落盘后执行（dry-run 不评磁盘态）`);
  } else {
    const errors = await checkVersions(ROOT, version);
    if (errors.length > 0) {
      console.error('version check failed（改动已落盘、未 commit；修复后用显式版本幂等重跑）:');
      for (const error of errors) console.error(`  ${error}`);
      process.exit(1);
    }
    console.log(`[门禁] version --check ${version} 通过`);
  }

  // ── auto-commit + 可选 auto-tag（不 push）─────────────────────
  // previewVersion 行带 reasons 装饰，commit 清单只要路径。
  const changedPaths = dryRun ? changed.map((line) => line.split(' (')[0] as string) : changed;
  const touched = [
    ...changedPaths,
    ...(changelogAppended ? ['CHANGELOG.md'] : []),
    ...(docCreated ? [`docs/versions/${version}.md`] : []),
    ...(indexAdded ? ['docs/versions/INDEX.md'] : []),
    ...(currentChanged ? ['docs/versions/CURRENT.md'] : []),
  ];
  if (dryRun) {
    console.log(
      touched.length === 0
        ? '[commit] 无改动，无需 commit'
        : `[commit] would commit ${touched.length} 个文件：\n  ${touched.join('\n  ')}`,
    );
    if (autoTag) console.log(`[tag] would tag v${version}（annotated，不 push）`);
    return;
  }
  if (touched.length === 0) {
    console.log('[commit] 无改动，无需 commit');
  } else {
    const add = git(['add', ...touched]);
    if (!add.ok) die(`git add 失败：${add.stderr}`);
    const commit = git([
      'commit',
      '-m',
      `chore(release): v${version} ${heavy ? '全量' : '增量'}收口（manifest+CHANGELOG+CURRENT.md${heavy ? '+版本文档+INDEX' : ''}）`,
    ]);
    if (!commit.ok) die(`git commit 失败：${commit.stderr}`);
    console.log(`[commit] ${commit.stdout.split('\n')[0]}`);
  }
  if (autoTag) {
    if (tagExists) die(`tag v${version} 已存在（不删除/移动已发布 tag，RELEASE §7）`);
    const tag = git(['tag', '-a', `v${version}`, '-m', `v${version}`]);
    if (!tag.ok) die(`git tag 失败：${tag.stderr}`);
    console.log(
      `[tag] v${version} 已打（未 push；push main + tag 由 main 执行，tag push 触发 release.yml）`,
    );
  }
}

if (import.meta.main) {
  await main();
}
