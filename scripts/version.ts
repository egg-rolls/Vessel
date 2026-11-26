#!/usr/bin/env bun

/**
 * 统一版本号：根、workspace 包、web 控制台。
 *
 * 用法：
 *   bun run scripts/version.ts 0.1.0            # 写入所有 manifest
 *   bun run scripts/version.ts 0.1.0 --dry-run  # 只显示将要改的文件
 *   bun run scripts/version.ts --bump patch     # 从根版本算下一 SemVer 并写入
 *   bun run scripts/version.ts --bump minor --dry-run  # 只算 + 显示，不落盘
 *   bun run scripts/version.ts --check 0.1.0    # 校验一致性 + CHANGELOG 有该版本
 *   bun run scripts/version.ts --check          # 只校验仓库内一致性
 *
 * `--bump patch|minor|major`：以根 `package.json` 当前版本为基线算下一版本
 * （patch=Z+1 / minor=Y+1,Z=0 / major=X+1,Y=0,Z=0；预发布后缀丢弃后按稳定版 bump），
 * 与写模式 / `--dry-run` 组合；不与显式版本或 `--check` 组合。
 * 发布收口编排（CHANGELOG / CURRENT.md / 版本文档 / commit / tag）见 scripts/release.ts。
 *
 * manifest 里的 `@vessel-agent/*` 依赖**恒为 `workspace:*`**：本地解析由 workspace 负责，
 * 发布 tarball 里的精确版本由 `bun pm pack` 打包时自己改写（实测 bun 1.3.9 对
 * `dependencies` / `devDependencies` / `peerDependencies` 三个字段都会改写）。
 * 写模式因此只把内部依赖**归一化回 `workspace:*`**（无论原值是 `0.50.0`、`^0.53.0`
 * 还是已经是 `workspace:*`），不再钉精确版本；`--check` 反向锁住这一点——任何内部
 * 依赖不是 `workspace:*` 即报错，防止发版把 workspace 协议悄悄钉回固定版本
 * （那样每次发版都要手工对齐，漏一个就发布 404）。
 *
 * 发布收口时由 1 执行写模式；日常开发只跑 `--check`。
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { satisfiesVersionRange } from '../src/plugin/plugin-manifest';

const ROOT = process.cwd();

const MANIFEST_PATTERNS = [
  'package.json',
  'packages/*/package.json',
  'plugins/*/*/package.json',
  'apps/web/package.json',
];

/**
 * 版本线独立于仓库 release 版本的 manifest：写模式不改、--check 不查。
 * plugin-sdk 是对外 SDK 契约包（plugin-embed 契约 §7 / ADR-102）：只在 SDK
 * 契约变更时 bump，宿主 React 主版本升级才升 major；仓库 0.x minor 发版
 * 不得打破插件声明的 runtime.sdk range（^1 跨仓库 minor 恒成立）。
 */
const INDEPENDENT_VERSION_MANIFESTS: ReadonlySet<string> = new Set([
  'packages/plugin-sdk/package.json',
]);

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface Manifest {
  path: string;
  version: string;
}

export function validateVersion(version: string): boolean {
  return SEMVER.test(version);
}

export type BumpKind = 'patch' | 'minor' | 'major';

export const BUMP_KINDS: readonly BumpKind[] = ['patch', 'minor', 'major'];

/**
 * 从当前版本算下一 SemVer（标准 SemVer，RELEASE §1：fix→patch / feat→minor / breaking→major）。
 * 预发布后缀（`-beta.1` 等）丢弃后按稳定版核心 bump；结果再过 validateVersion。
 * 当前版本非法时抛错（不猜基线）。
 */
export function nextVersion(current: string, kind: BumpKind): string {
  if (!validateVersion(current)) {
    throw new Error(`invalid current semver: ${current}`);
  }
  const core = current.split('-')[0] as string;
  const [major, minor, patch] = core.split('.').map(Number) as [number, number, number];
  let next: string;
  switch (kind) {
    case 'major':
      next = `${major + 1}.0.0`;
      break;
    case 'minor':
      next = `${major}.${minor + 1}.0`;
      break;
    case 'patch':
      next = `${major}.${minor}.${patch + 1}`;
      break;
  }
  if (!validateVersion(next)) {
    throw new Error(`bump produced invalid semver: ${next}`);
  }
  return next;
}

/** 读根 package.json 的 version（唯一版本源）；缺失 / 非字符串时抛错。 */
export async function readRootVersion(root: string): Promise<string> {
  const raw = await readFile(join(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !validateVersion(pkg.version)) {
    throw new Error('root package.json: missing valid "version"（--bump 需要根版本作基线）');
  }
  return pkg.version;
}

export async function collectManifests(root = ROOT): Promise<Manifest[]> {
  const paths = new Set<string>();

  for (const pattern of MANIFEST_PATTERNS) {
    if (!pattern.includes('*')) {
      paths.add(pattern);
      continue;
    }

    const glob = new Bun.Glob(pattern);
    for await (const match of glob.scan({ cwd: root })) {
      // Glob 在 Windows 上返回反斜杠，统一成 POSIX 形式。
      paths.add(match.replaceAll('\\', '/'));
    }
  }

  const manifests: Manifest[] = [];
  for (const path of [...paths].sort()) {
    if (!existsSync(join(root, path))) continue;
    if (INDEPENDENT_VERSION_MANIFESTS.has(path)) continue;

    const raw = await readFile(join(root, path), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version !== 'string') {
      // 根 package.json 是 private 包，version 归 asm 维护；缺失时跳过并告警。
      if (path === 'package.json') continue;
      throw new Error(`${path}: missing string "version"`);
    }
    manifests.push({ path, version: pkg.version });
  }

  return manifests;
}

export async function rootVersionMissing(root: string): Promise<boolean> {
  const raw = await readFile(join(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { version?: unknown };
  return typeof pkg.version !== 'string';
}

/** 参与内部版本同步的依赖字段；optionalDependencies 不在此列。 */
const INTERNAL_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

/** manifest 里内部依赖的唯一合法写法（精确版本由 bun pack 写进 tarball）。 */
const WORKSPACE_PROTOCOL = 'workspace:*';

/**
 * 把 `@vessel-agent/*` 依赖归一化为 `workspace:*`；外部依赖保持原样。
 * 返回是否有内容被改写。
 *
 * 注意：**不要**改回「写入精确版本」——bun 的 `pm pack` 会在打包时把
 * `workspace:*` 改写为当前版本，`release-dry-run` 的 `workspace_dependency` /
 * `internal_dependency_version` 检查看的是 tarball，不是 manifest。
 */
function syncInternalDependencies(pkg: Record<string, unknown>): boolean {
  let updated = false;

  for (const field of INTERNAL_DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;

    const entries = deps as Record<string, unknown>;
    for (const name of Object.keys(entries)) {
      if (!name.startsWith('@vessel-agent/')) continue;
      if (entries[name] === WORKSPACE_PROTOCOL) continue;
      entries[name] = WORKSPACE_PROTOCOL;
      updated = true;
    }
  }

  return updated;
}

/**
 * 内置插件清单版本（`vessel.version`）同步到引擎版本（q-plugin-lifecycle §6.4）。
 *
 * 内置与引擎同仓同发布，清单版本独立线没有演进事实支撑，只制造面板混排（child 取
 * manifest.version、in-process 取 pkg.version）与 child reload 指纹语义混乱。写模式
 * 因此把已声明的 `vessel.version` 一并 bump 到引擎版本，让两条取值分支自然同源。
 *
 * 只在字段已存在时改写：未声明清单版本的 in-process 包本就用 pkg.version，不新增字段。
 * 第三方插件不在仓库 `plugins/` 发现根（装到 user/project 目录），version.ts 扫不到，
 * 其独立版本 + engines 门禁完整保留。
 */
function syncVesselBlockVersion(pkg: Record<string, unknown>, version: string): boolean {
  const vessel = pkg.vessel;
  if (!vessel || typeof vessel !== 'object' || Array.isArray(vessel)) return false;
  const block = vessel as Record<string, unknown>;
  if (typeof block.version !== 'string') return false;
  if (block.version === version) return false;
  block.version = version;
  return true;
}

/** 内部依赖是否已全部是 `workspace:*`；返回违规描述（空数组 = 合规）。 */
function internalDependencyIssues(pkg: Record<string, unknown>, path: string): string[] {
  const issues: string[] = [];

  for (const field of INTERNAL_DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;

    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      if (!name.startsWith('@vessel-agent/')) continue;
      if (value === WORKSPACE_PROTOCOL) continue;
      issues.push(
        `${path}: ${field}.${name} = ${JSON.stringify(value)}, expected "${WORKSPACE_PROTOCOL}"` +
          '（内部依赖不许钉固定版本；tarball 的精确版本由 bun pm pack 负责）',
      );
    }
  }

  return issues;
}

/** 读取 manifest 的原始 JSON；解析失败时返回 null（由调用方决定是否报错）。 */
async function readPackageJson(
  root: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(root, path), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function applyVersion(root: string, version: string): Promise<string[]> {
  if (!validateVersion(version)) {
    throw new Error(`invalid semver: ${version}`);
  }

  const manifests = await collectManifests(root);
  const changed: string[] = [];

  for (const manifest of manifests) {
    const fullPath = join(root, manifest.path);
    const pkg = JSON.parse(await readFile(fullPath, 'utf8')) as Record<string, unknown>;

    // 版本已经是目标值时也要检查内部依赖：手工改过、或历史遗留的固定版本
    // 都要归一化回 `workspace:*`（tarball 的精确版本由 bun pm pack 负责）。
    let updated = manifest.version !== version;
    if (updated) pkg.version = version;
    if (syncInternalDependencies(pkg)) updated = true;
    // 内置清单版本同 bump（§6.4）：pkg.version 与 vessel.version 一起跟踪引擎版本。
    if (syncVesselBlockVersion(pkg, version)) updated = true;
    if (!updated) continue;

    await writeFile(fullPath, `${JSON.stringify(pkg, null, 2)}\n`);
    changed.push(manifest.path);
  }

  return changed;
}

/**
 * 写模式预演：返回将要改动的 manifest 行（`path (reasons)`），不落盘。
 * 内部依赖归一化与 vessel.version 同 bump 都算进去（否则版本已对齐时谎报无改动）。
 * version.ts --dry-run 与 release.ts --dry-run 共用。
 */
export async function previewVersion(root: string, version: string): Promise<string[]> {
  const manifests = await collectManifests(root);
  const pending: string[] = [];
  for (const manifest of manifests) {
    const pkg = await readPackageJson(root, manifest.path);
    if (!pkg) continue;
    const reasons: string[] = [];
    if (manifest.version !== version) reasons.push(`${manifest.version} -> ${version}`);
    if (internalDependencyIssues(pkg, manifest.path).length > 0) {
      reasons.push(`内部依赖 -> ${WORKSPACE_PROTOCOL}`);
    }
    const vessel = pkg.vessel as Record<string, unknown> | undefined;
    if (typeof vessel?.version === 'string' && vessel.version !== version) {
      reasons.push(`vessel.version ${vessel.version} -> ${version}`);
    }
    if (reasons.length === 0) continue;
    pending.push(`${manifest.path} (${reasons.join('; ')})`);
  }
  return pending;
}

export async function changelogHasVersion(root: string, version: string): Promise<boolean> {
  const text = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  return new RegExp(`^## \\[${escapeRegExp(version)}\\]`, 'm').test(text);
}

export async function checkVersions(root: string, expected?: string): Promise<string[]> {
  const errors: string[] = [];
  const manifests = await collectManifests(root);
  const versions = new Set(manifests.map((manifest) => manifest.version));

  if (versions.size !== 1) {
    errors.push(`version mismatch across manifests: ${[...versions].join(', ')}`);
    for (const manifest of manifests) {
      errors.push(`  ${manifest.path}: ${manifest.version}`);
    }
  }

  const target = expected ?? manifests[0]?.version;
  if (!target) return [...errors, 'no manifests found'];

  if (expected && !validateVersion(expected)) {
    errors.push(`invalid expected semver: ${expected}`);
  }

  for (const manifest of manifests) {
    if (manifest.version !== target) {
      errors.push(`${manifest.path}: ${manifest.version} != ${target}`);
    }
  }

  // 防回退锁：内部依赖恒为 `workspace:*`。发版写模式若把 `@vessel-agent/*` 钉回
  // 固定版本（漏对齐即发布 404），这里必须拦住；tarball 的精确版本由 bun pm pack 负责。
  // 根 manifest 即使因为 private/无 version 被 collectManifests 跳过，也要查依赖。
  const depCheckPaths = new Set([...manifests.map((manifest) => manifest.path), 'package.json']);
  for (const path of depCheckPaths) {
    const pkg = await readPackageJson(root, path);
    if (!pkg) continue;
    errors.push(...internalDependencyIssues(pkg, path));
  }

  if (!(await changelogHasVersion(root, target))) {
    errors.push(`CHANGELOG.md: missing "## [${target}]" heading`);
  }

  // 插件 engines.vessel 必须允许当前版本；否则 loader 会静默跳过内置插件
  // （0.50.0 bump 曾因 `>=0.33.0 <0.45.0` 让 marketplace/usage 消失）。
  // 同时锁内置清单版本同源（§6.4）：仓库 plugins/ 即内置（repo 源），其 vessel.version
  // 必须 = 引擎版本，否则面板 child/in-process 两条取值分支混排、child 指纹语义漂移。
  for (const manifest of manifests) {
    if (!manifest.path.startsWith('plugins/')) continue;
    let pkg: { vessel?: { version?: unknown; engines?: { vessel?: unknown } } };
    try {
      pkg = JSON.parse(await readFile(join(root, manifest.path), 'utf8'));
    } catch {
      continue;
    }
    const manifestVersion = pkg.vessel?.version;
    if (typeof manifestVersion === 'string' && manifestVersion !== target) {
      errors.push(
        `${manifest.path}: vessel.version "${manifestVersion}" != engine ${target} ` +
          '(built-in plugin manifest version must track the engine version)',
      );
    }
    const range = pkg.vessel?.engines?.vessel;
    if (typeof range === 'string' && !satisfiesVersionRange(target, range)) {
      errors.push(
        `${manifest.path}: vessel.engines.vessel "${range}" does not allow ${target} (plugin would be skipped)`,
      );
    }
  }

  return errors;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/version.ts <version> [--dry-run]
  bun run scripts/version.ts --bump patch|minor|major [--dry-run]
  bun run scripts/version.ts --check [version]

Examples:
  bun run scripts/version.ts 0.1.0
  bun run scripts/version.ts --bump patch --dry-run
  bun run scripts/version.ts --check 0.1.0

发布收口编排（manifest + CHANGELOG + CURRENT.md + commit/tag）: scripts/release.ts`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run');

  let bump: BumpKind | undefined;
  const bumpIndex = args.indexOf('--bump');
  if (bumpIndex >= 0) {
    const value = args[bumpIndex + 1];
    if (!value || !BUMP_KINDS.includes(value as BumpKind)) {
      console.error(`--bump 需要 patch|minor|major（得到 ${value ?? '空'}）`);
      process.exit(1);
    }
    bump = value as BumpKind;
  }
  const bumpValueIndex = bumpIndex >= 0 ? bumpIndex + 1 : -1;
  const positional = args.filter((arg, index) => !arg.startsWith('-') && index !== bumpValueIndex);

  if (check) {
    if (bump) {
      console.error('--bump 不与 --check 组合（--check 只校验，不算下一版本）');
      process.exit(1);
    }
    const expected = positional[0];
    const errors = await checkVersions(ROOT, expected);
    if (errors.length > 0) {
      console.error('version check failed:');
      for (const error of errors) console.error(`  ${error}`);
      process.exit(1);
    }
    if (await rootVersionMissing(ROOT)) {
      console.warn('warning: root package.json has no "version" (owned by asm)');
    }
    console.log(`version check passed${expected ? `: ${expected}` : ''}`);
    return;
  }

  let version = positional[0];
  if (bump) {
    if (version) {
      console.error('--bump 不与显式版本组合（二选一）');
      process.exit(1);
    }
    const current = await readRootVersion(ROOT);
    version = nextVersion(current, bump);
    console.log(`bump ${bump}: ${current} -> ${version}`);
  }
  if (!version) {
    printUsage();
    process.exit(1);
  }

  if (!validateVersion(version)) {
    console.error(`invalid semver: ${version}`);
    process.exit(1);
  }

  if (dryRun) {
    const pending = await previewVersion(ROOT, version);
    if (pending.length === 0) {
      console.log(
        `all manifests already at ${version} with internal deps at ${WORKSPACE_PROTOCOL}`,
      );
      return;
    }
    console.log(`would update ${pending.length} manifest(s) to ${version}:`);
    for (const line of pending) console.log(`  ${line}`);
    return;
  }

  const changed = await applyVersion(ROOT, version);
  if (changed.length === 0) {
    console.log(`all manifests already at ${version}`);
  } else {
    console.log(`updated ${changed.length} manifest(s) to ${version}:`);
    for (const path of changed) console.log(`  ${path}`);
  }

  if (!(await changelogHasVersion(ROOT, version))) {
    console.warn(`warning: CHANGELOG.md is missing "## [${version}]"`);
  }
}

if (import.meta.main) {
  await main();
}
