#!/usr/bin/env bun

/**
 * 发布干跑（0.4，G2）。
 *
 * 枚举根 workspaces 中所有非 private 包，校验：
 *   1. 包版本与根版本一致；
 *   2. tarball 内 package.json 不含 workspace:* / file: 依赖；
 *   2b. @vessel/* 内部依赖（精确版本）等于根版本；
 *   3. 必填字段存在（name / version / main 或 exports / types）；
 *   4. tarball 不含 .env、密钥、数据库、日志、覆盖率等禁止文件；
 *   5. CHANGELOG.md 含 `## [<root version>]`。
 *
 * 文件清单用 `npm pack --dry-run --json`；tarball manifest 用实际 `bun pm pack`
 * 到 OS 临时目录后解析（Q1 / Addendum C §12.2.1 已批准）。**不发布、不上传、不 tag。**
 *
 * 用法：
 *   bun run scripts/release-dry-run.ts [--json] [--keep] [--pack-tool bun|npm] [--help]
 *
 * 退出码：0 = 全部通过；1 = 有检查失败；2 = 用法 / 根配置错误。
 */

import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { changelogHasVersion } from './version';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type PackTool = 'bun' | 'npm';
export type Severity = 'error' | 'warning';

export interface PackageIssue {
  code: string;
  message: string;
  severity: Severity;
}

export interface PublicPackage {
  /** workspace 相对路径（POSIX），如 packages/core/package.json */
  path: string;
  /** 包目录的绝对路径 */
  dir: string;
  manifest: Record<string, unknown>;
}

export interface PackageResult {
  path: string;
  name: string;
  version: string;
  ok: boolean;
  fileCount: number;
  issues: PackageIssue[];
}

export interface DryRunReport {
  targetVersion: string;
  packTool: PackTool;
  packageCount: number;
  ok: boolean;
  globalIssues: PackageIssue[];
  packages: PackageResult[];
  tmpDir?: string;
}

export interface PackedPackage {
  manifest: Record<string, unknown>;
  files: string[];
}

/** 可注入的打包函数，便于单测不真正 spawn。 */
export type PackFn = (pkgDir: string, tool: PackTool, workDir: string) => Promise<PackedPackage>;

export class DryRunConfigError extends Error {}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

// ── 枚举与静态检查 ────────────────────────────────────────────

function workspacePatterns(rootManifest: Record<string, unknown>): string[] {
  const value = rootManifest.workspaces;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (value && typeof value === 'object') {
    const packages = (value as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((item): item is string => typeof item === 'string');
    }
  }
  return [];
}

export async function readRootVersion(root: string): Promise<string> {
  const path = join(root, 'package.json');
  if (!existsSync(path)) throw new DryRunConfigError(`root package.json not found: ${path}`);

  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const version = manifest.version;
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new DryRunConfigError('root package.json: missing or invalid "version"');
  }
  return version;
}

export async function collectPublicPackages(root: string): Promise<PublicPackage[]> {
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const patterns = workspacePatterns(rootManifest);
  if (patterns.length === 0) {
    throw new DryRunConfigError('root package.json: no workspaces patterns');
  }

  const paths = new Set<string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(`${pattern.replaceAll('\\', '/')}/package.json`);
    for await (const match of glob.scan({ cwd: root })) {
      paths.add(match.replaceAll('\\', '/'));
    }
  }

  const packages: PublicPackage[] = [];
  for (const path of [...paths].sort()) {
    const manifest = JSON.parse(await readFile(join(root, path), 'utf8')) as Record<
      string,
      unknown
    >;
    if (manifest.private === true) continue;
    packages.push({ path, dir: join(root, dirname(path)), manifest });
  }

  return packages;
}

function requiredFieldIssues(manifest: Record<string, unknown>, label: string): PackageIssue[] {
  const issues: PackageIssue[] = [];
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    issues.push({ code: 'missing_field', severity: 'error', message: `${label}: missing "name"` });
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    issues.push({
      code: 'missing_field',
      severity: 'error',
      message: `${label}: missing "version"`,
    });
  }
  const hasMain = typeof manifest.main === 'string' && manifest.main.length > 0;
  const hasExports = manifest.exports !== undefined && manifest.exports !== null;
  if (!hasMain && !hasExports) {
    issues.push({
      code: 'missing_field',
      severity: 'error',
      message: `${label}: missing "main" or "exports"`,
    });
  }
  if (typeof manifest.types !== 'string' || manifest.types.length === 0) {
    issues.push({ code: 'missing_field', severity: 'error', message: `${label}: missing "types"` });
  }
  return issues;
}

export function evaluateSourceManifest(
  manifest: Record<string, unknown>,
  targetVersion: string,
): PackageIssue[] {
  const issues = requiredFieldIssues(manifest, 'source');
  if (typeof manifest.version === 'string' && manifest.version !== targetVersion) {
    issues.push({
      code: 'version_mismatch',
      severity: 'error',
      message: `source: version ${manifest.version} != root ${targetVersion}`,
    });
  }
  return issues;
}

export function evaluatePackedManifest(
  manifest: Record<string, unknown>,
  targetVersion: string,
): PackageIssue[] {
  const issues = requiredFieldIssues(manifest, 'tarball');
  if (typeof manifest.version === 'string' && manifest.version !== targetVersion) {
    issues.push({
      code: 'version_mismatch',
      severity: 'error',
      message: `tarball: version ${manifest.version} != root ${targetVersion}`,
    });
  }

  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!deps || typeof deps !== 'object') continue;

    for (const [name, rawValue] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof rawValue !== 'string') continue;
      const value = rawValue.trim();

      if (value.startsWith('workspace:') || value.startsWith('file:')) {
        issues.push({
          code: 'workspace_dependency',
          severity: 'error',
          message: `tarball: ${field}.${name} = ${value}`,
        });
        continue;
      }

      if (!name.startsWith('@vessel/')) continue;
      if (EXACT_SEMVER.test(value)) {
        if (value !== targetVersion) {
          issues.push({
            code: 'internal_dependency_version',
            severity: 'error',
            message: `tarball: ${field}.${name} = ${value}, expected ${targetVersion}`,
          });
        }
      } else {
        issues.push({
          code: 'internal_dependency_range',
          severity: 'warning',
          message: `tarball: ${field}.${name} = ${value} (range; verify manually)`,
        });
      }
    }
  }

  return issues;
}

export function detectForbiddenFile(path: string): string | null {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const base = normalized.split('/').pop() ?? normalized;

  if (normalized === '.env' || normalized.startsWith('.env.')) return '.env';
  if (/\.(?:pem|key|crt|p12|pfx)$/i.test(normalized)) {
    // Committed, non-production TLS fixtures are allowed (Addendum C allows
    // __tests__ source); real key material anywhere else is rejected.
    if (normalized.startsWith('__tests__/fixtures/')) return null;
    return 'key material';
  }
  if (
    base === 'credentials.json' ||
    base === 'service-account.json' ||
    base.endsWith('.credentials.json')
  ) {
    return 'credentials';
  }
  if (normalized.startsWith('.vessel/')) return '.vessel';
  if (/\.(?:db|sqlite|sqlite3)$/i.test(normalized)) return 'database';
  if (
    /\.log$/i.test(normalized) ||
    normalized.startsWith('logs/') ||
    base.startsWith('npm-debug.log')
  )
    return 'log';
  if (
    normalized.startsWith('coverage/') ||
    normalized.startsWith('test-results/') ||
    normalized.startsWith('reports/')
  ) {
    return 'test artifact';
  }
  if (normalized.endsWith('.snap')) return 'snapshot';
  return null;
}

export function evaluatePackedFiles(files: string[]): PackageIssue[] {
  const issues: PackageIssue[] = [];
  for (const file of files) {
    const rule = detectForbiddenFile(file);
    if (rule) {
      issues.push({
        code: 'forbidden_file',
        severity: 'error',
        message: `tarball: forbidden ${rule} file: ${file}`,
      });
    }
  }
  return issues;
}

function entryTargets(manifest: Record<string, unknown>): string[] {
  const targets = new Set<string>();

  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.replace(/^\.\//, '');
      if (trimmed.length > 0) targets.add(trimmed);
      return;
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) add(nested);
    }
  };

  add(manifest.main);
  add(manifest.types);
  add(manifest.exports);
  return [...targets];
}

export function checkEntryFiles(
  manifest: Record<string, unknown>,
  files: string[],
): PackageIssue[] {
  const issues: PackageIssue[] = [];
  const available = new Set(files);
  for (const target of entryTargets(manifest)) {
    if (!available.has(target)) {
      issues.push({
        code: 'entry_file_missing',
        severity: 'warning',
        message: `tarball: entry target not found: ${target}`,
      });
    }
  }
  return issues;
}

// ── tar 解析（无外部依赖）─────────────────────────────────────

export interface TarEntry {
  path: string;
  data: Uint8Array;
}

function readCString(buffer: Uint8Array, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  let end = slice.indexOf(0);
  if (end === -1) end = slice.length;
  return new TextDecoder().decode(slice.subarray(0, end));
}

export function parseTar(data: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;

  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readCString(header, 0, 100);
    const sizeText = readCString(header, 124, 12).trim();
    const size = sizeText.length > 0 ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`invalid tar entry size at offset ${offset}`);
    }

    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = readCString(header, 345, 155);
    const dataStart = offset + 512;
    const content = data.subarray(dataStart, dataStart + size);

    if (type === 'x') {
      const text = new TextDecoder().decode(content);
      const match = text.match(/^\d+ path=(.*)$/m);
      if (match?.[1]) pendingLongName = match[1];
    } else if (type === 'L') {
      pendingLongName = readCString(content, 0, content.length).replace(/\0+$/, '');
    } else if (type === '0' || type === '\0') {
      const resolved = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
      pendingLongName = undefined;
      if (resolved.length > 0) entries.push({ path: resolved, data: content });
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

export function unpackTarball(data: Uint8Array): PackedPackage {
  const entries = parseTar(Bun.gunzipSync(Uint8Array.from(data)));
  const manifestEntry = entries.find(
    (entry) => entry.path === 'package/package.json' || entry.path === './package/package.json',
  );
  if (!manifestEntry) throw new Error('tarball: package/package.json not found');

  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as Record<
    string,
    unknown
  >;
  const files = entries
    .map((entry) => entry.path.replace(/^\.\//, '').replace(/^package\//, ''))
    .filter((path) => path.length > 0 && !path.endsWith('/'));

  return { manifest, files };
}

// ── 进程与打包 ────────────────────────────────────────────────

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCommand(cmd: string, args: string[], cwd: string): CommandResult {
  const result = Bun.spawnSync({
    cmd: [cmd, ...args],
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function findTarball(dir: string): string {
  const tarballs = readdirSync(dir).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length === 0) throw new Error(`no .tgz produced in ${dir}`);
  if (tarballs.length > 1) throw new Error(`multiple .tgz files produced in ${dir}`);
  const name = tarballs[0];
  if (!name) throw new Error(`no .tgz produced in ${dir}`);
  return join(dir, name);
}

export async function listPackedFiles(pkgDir: string): Promise<string[]> {
  const result = runCommand(
    npmCommand(),
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    pkgDir,
  );
  if (result.exitCode !== 0) {
    throw new Error(`npm pack --dry-run failed (${result.exitCode}): ${result.stderr.trim()}`);
  }

  const parsed = JSON.parse(result.stdout) as Array<{ files?: Array<{ path?: unknown }> }>;
  const first = parsed[0];
  if (!first || !Array.isArray(first.files)) {
    throw new Error('npm pack --dry-run: unexpected JSON output');
  }
  return first.files
    .map((file) => file.path)
    .filter((path): path is string => typeof path === 'string');
}

export async function packPackage(
  pkgDir: string,
  tool: PackTool,
  workDir: string,
): Promise<PackedPackage> {
  await mkdir(workDir, { recursive: true });

  const result =
    tool === 'bun'
      ? runCommand(
          process.execPath,
          ['pm', 'pack', '--ignore-scripts', '--destination', workDir],
          pkgDir,
        )
      : runCommand(
          npmCommand(),
          ['pack', '--ignore-scripts', '--pack-destination', workDir],
          pkgDir,
        );

  if (result.exitCode !== 0) {
    throw new Error(`${tool} pack failed (${result.exitCode}): ${result.stderr.trim()}`);
  }

  const tarball = findTarball(workDir);
  const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
  return unpackTarball(bytes);
}

// ── 主流程 ────────────────────────────────────────────────────

export interface DryRunOptions {
  root?: string;
  packTool?: PackTool;
  keep?: boolean;
  /** 注入打包函数（单测用）。 */
  pack?: PackFn;
}

function slugify(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '_');
}

export async function runReleaseDryRun(options: DryRunOptions = {}): Promise<DryRunReport> {
  const root = options.root ?? process.cwd();
  const packTool = options.packTool ?? 'bun';
  const targetVersion = await readRootVersion(root);
  const packages = await collectPublicPackages(root);
  if (packages.length === 0) throw new DryRunConfigError('no public workspace packages found');

  const globalIssues: PackageIssue[] = [];
  if (!(await changelogHasVersion(root, targetVersion))) {
    globalIssues.push({
      code: 'changelog_missing',
      severity: 'error',
      message: `CHANGELOG.md: missing "## [${targetVersion}]"`,
    });
  }

  const pack = options.pack ?? packPackage;
  const tmpRoot = await mkdtemp(join(tmpdir(), 'vessel-release-dry-run-'));
  const results: PackageResult[] = [];

  try {
    for (const pkg of packages) {
      const issues = evaluateSourceManifest(pkg.manifest, targetVersion);
      const workDir = join(tmpRoot, slugify(pkg.path));
      let fileCount = 0;

      try {
        const packed = await pack(pkg.dir, packTool, workDir);
        fileCount = packed.files.length;
        issues.push(...evaluatePackedManifest(packed.manifest, targetVersion));
        issues.push(...evaluatePackedFiles(packed.files));
        issues.push(...checkEntryFiles(packed.manifest, packed.files));

        const dryRunFiles = await listPackedFiles(pkg.dir);
        const dryRunForbidden = evaluatePackedFiles(dryRunFiles);
        for (const issue of dryRunForbidden) {
          if (!issues.some((item) => item.message === issue.message)) issues.push(issue);
        }
      } catch (error) {
        issues.push({
          code: 'pack_failed',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const name = typeof pkg.manifest.name === 'string' ? pkg.manifest.name : pkg.path;
      const version = typeof pkg.manifest.version === 'string' ? pkg.manifest.version : '';
      results.push({
        path: pkg.path,
        name,
        version,
        ok: !issues.some((issue) => issue.severity === 'error'),
        fileCount,
        issues,
      });
    }
  } finally {
    if (!options.keep) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  const ok =
    globalIssues.every((issue) => issue.severity !== 'error') &&
    results.every((result) => result.ok);

  const report: DryRunReport = {
    targetVersion,
    packTool,
    packageCount: results.length,
    ok,
    globalIssues,
    packages: results,
  };
  if (options.keep) report.tmpDir = tmpRoot;
  return report;
}

function printHuman(report: DryRunReport): void {
  console.log(
    `release dry run: target ${report.targetVersion}, ${report.packageCount} public package(s), pack tool ${report.packTool}`,
  );

  for (const issue of report.globalIssues) {
    console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  }

  for (const pkg of report.packages) {
    const status = pkg.ok ? 'ok' : 'FAILED';
    console.log(`  ${status} ${pkg.path} (${pkg.name}@${pkg.version}, ${pkg.fileCount} files)`);
    for (const issue of pkg.issues) {
      console.log(`    [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }

  if (report.tmpDir) console.log(`  temp dir kept: ${report.tmpDir}`);

  if (report.ok) {
    console.log(`release dry run passed: ${report.packageCount} package(s)`);
    return;
  }

  const errors =
    report.globalIssues.filter((issue) => issue.severity === 'error').length +
    report.packages.reduce(
      (sum, pkg) => sum + pkg.issues.filter((issue) => issue.severity === 'error').length,
      0,
    );
  console.error(`release dry run failed: ${errors} error(s)`);
  process.exit(1);
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/release-dry-run.ts [--json] [--keep] [--pack-tool bun|npm] [--help]

Checks every non-private workspace package:
  - version equals the root package version
  - tarball manifest has no workspace:* / file: dependencies
  - internal @vessel/* versions match the root version
  - required fields (name, version, main or exports, types)
  - no secrets, databases, logs or test artifacts
  - CHANGELOG.md contains the root version heading

Exit codes: 0 = passed, 1 = check failed, 2 = usage/config error.`);
}

function parseArgs(args: string[]): {
  json: boolean;
  keep: boolean;
  packTool: PackTool;
  help: boolean;
} {
  let json = false;
  let keep = false;
  let help = false;
  let packTool: PackTool = 'bun';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--keep') {
      keep = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--pack-tool') {
      const value = args[index + 1];
      if (value !== 'bun' && value !== 'npm') {
        throw new DryRunConfigError('--pack-tool expects "bun" or "npm"');
      }
      packTool = value;
      index += 1;
    } else {
      throw new DryRunConfigError(`unknown argument: ${arg}`);
    }
  }

  return { json, keep, packTool, help };
}

async function main(): Promise<void> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exit(2);
  }

  if (options.help) {
    printUsage();
    return;
  }

  try {
    const report = await runReleaseDryRun({ keep: options.keep, packTool: options.packTool });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exit(1);
      return;
    }
    printHuman(report);
  } catch (error) {
    if (error instanceof DryRunConfigError) {
      console.error(`release dry run config error: ${error.message}`);
      process.exit(2);
    }
    console.error(
      `release dry run error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
