#!/usr/bin/env bun

/**
 * 统一版本号：根、workspace 包、web 控制台。
 *
 * 用法：
 *   bun run scripts/version.ts 0.1.0            # 写入所有 manifest
 *   bun run scripts/version.ts 0.1.0 --dry-run  # 只显示将要改的文件
 *   bun run scripts/version.ts --check 0.1.0    # 校验一致性 + CHANGELOG 有该版本
 *   bun run scripts/version.ts --check          # 只校验仓库内一致性
 *
 * 写模式同时把各 manifest 的 `@vessel/*` 依赖（dependencies / devDependencies /
 * peerDependencies）改写为精确目标版本，避免 `workspace:*` / `^x.y.z` 进入发布
 * tarball（`release-dry-run` 的 `internal_dependency_version` 检查）。
 *
 * 发布收口时由 1 执行写模式；日常开发只跑 `--check`。
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

const MANIFEST_PATTERNS = [
  'package.json',
  'packages/*/package.json',
  'plugins/*/*/package.json',
  'apps/web/package.json',
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface Manifest {
  path: string;
  version: string;
}

export function validateVersion(version: string): boolean {
  return SEMVER.test(version);
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

/**
 * 把 `@vessel/*` 依赖改写为精确目标版本；外部依赖保持原样。
 * 返回是否有内容被改写。
 */
function syncInternalDependencies(pkg: Record<string, unknown>, version: string): boolean {
  let updated = false;

  for (const field of INTERNAL_DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;

    const entries = deps as Record<string, unknown>;
    for (const name of Object.keys(entries)) {
      if (!name.startsWith('@vessel/')) continue;
      if (entries[name] === version) continue;
      entries[name] = version;
      updated = true;
    }
  }

  return updated;
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

    // 版本已经是目标值时也要检查内部依赖：bump 后 `workspace:*` / `^旧版本`
    // 仍可能残留，release-dry-run 会拒绝这样的 tarball。
    let updated = manifest.version !== version;
    if (updated) pkg.version = version;
    if (syncInternalDependencies(pkg, version)) updated = true;
    if (!updated) continue;

    await writeFile(fullPath, `${JSON.stringify(pkg, null, 2)}\n`);
    changed.push(manifest.path);
  }

  return changed;
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

  if (!(await changelogHasVersion(root, target))) {
    errors.push(`CHANGELOG.md: missing "## [${target}]" heading`);
  }

  return errors;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/version.ts <version> [--dry-run]
  bun run scripts/version.ts --check [version]

Examples:
  bun run scripts/version.ts 0.1.0
  bun run scripts/version.ts --check 0.1.0`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((arg) => !arg.startsWith('-'));

  if (check) {
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

  const version = positional[0];
  if (!version) {
    printUsage();
    process.exit(1);
  }

  if (!validateVersion(version)) {
    console.error(`invalid semver: ${version}`);
    process.exit(1);
  }

  if (dryRun) {
    const manifests = await collectManifests(ROOT);
    const pending = manifests.filter((manifest) => manifest.version !== version);
    if (pending.length === 0) {
      console.log(`all manifests already at ${version}`);
      return;
    }
    console.log(`would update ${pending.length} manifest(s) to ${version}:`);
    for (const manifest of pending)
      console.log(`  ${manifest.path} (${manifest.version} -> ${version})`);
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
