#!/usr/bin/env bun

/**
 * 安装解析 smoke（0.10 R2B）。
 *
 * 验证「发布后的 tarball 能被 npm 真正装上并运行」，而不是只看包内文件：
 *   0. 根包打包前必须已有 `apps/web/dist/index.html`（dist 被 .gitignore 忽略，
 *      由 CI / 发布前置构建）；根 tarball 的文件清单也必须包含它；
 *   1. 对全部可发布包（18 个）与根 CLI 包执行 `npm pack` 到 OS 临时目录；
 *   2. 在临时工程里用 `overrides` 把每个 `@vessel-agent/*` 指向本地 tarball，
 *      再 `npm install` 根 CLI tarball（不访问尚未发布的 @vessel-agent/* 版本）；
 *   3. 运行 `vessel --version` 与 `vessel --tools`（`VESSEL_MOCK=1`，不需要 Key）
 *      并断言输出。
 *
 * **不 tag、不 publish、不 push、不上传 artifact。**
 *
 * 平台：只在 POSIX（ubuntu / CI）运行。Windows 的 npm `.cmd` bin shim 与
 * `file:` override 路径语义未验证，默认跳过并返回 0；`--force` 可强制尝试。
 *
 * 用法：
 *   bun run scripts/smoke-install.ts [--keep] [--force] [--json] [--help]
 *
 * 退出码：0 = 通过（或平台跳过）；1 = 检查失败；2 = 用法 / 配置错误。
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPublicPackages } from './release-dry-run';

/** 根包发布名（bin 仍是 `vessel`）。 */
export const ROOT_PACKAGE_NAME = 'vessel-agent';

/**
 * 发布顺序：core → permission → config → serve → tui → plugins。
 * 打包本身与顺序无关，这里只用于稳定输出与覆盖检查；新增可发布包时必须同步。
 */
export const PUBLISH_ORDER = [
  'packages/core',
  'packages/permission',
  'packages/config',
  'packages/agent',
  'packages/serve',
  'packages/tui',
  'plugins/tools/basic-tools',
  'plugins/context/doc-subscription',
  'plugins/mcp/client',
  'plugins/evals/harness',
  'plugins/im/feishu',
  'plugins/provider/openai',
  'plugins/provider/anthropic',
  'plugins/security/guardrail-pii',
  'plugins/security/redact-secrets',
  'plugins/security/tool-policy',
  'plugins/observability/hook-logging',
] as const;

const REQUIRED_TOOLS = ['bash', 'read', 'edit'] as const;

/** 根 tarball 必须包含的 Web 控制台入口（`files` 里的 `apps/web/dist`）。 */
export const WEB_DIST_ENTRY = 'apps/web/dist/index.html';

export class SmokeConfigError extends Error {}

export interface SmokePackage {
  /** workspace 相对路径（POSIX），如 packages/core */
  path: string;
  /** 包目录绝对路径 */
  dir: string;
  name: string;
  version: string;
}

export interface TarballInfo {
  name: string;
  version: string;
  filename: string;
  /** tarball 绝对路径 */
  tarball: string;
  /** `npm pack --json` 报告的文件路径；根包用于断言 Web dist 存在 */
  files?: string[];
}

export interface SmokeReport {
  ok: boolean;
  version: string;
  rootPackage: string;
  packageCount: number;
  steps: string[];
  warnings: string[];
  error?: string;
  tmpDir?: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
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

// ── 纯函数（可单测）───────────────────────────────────────────

export function orderPackages(packages: SmokePackage[]): SmokePackage[] {
  const byPath = new Map(packages.map((pkg) => [pkg.path, pkg]));
  const ordered: SmokePackage[] = [];
  for (const path of PUBLISH_ORDER) {
    const pkg = byPath.get(path);
    if (pkg) {
      ordered.push(pkg);
      byPath.delete(path);
    }
  }
  // 新增包尚未加入 PUBLISH_ORDER 时仍然打包，避免 smoke 静默漏包。
  ordered.push(...[...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)));
  return ordered;
}

export function buildOverrides(tarballs: TarballInfo[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const tarball of tarballs) {
    overrides[tarball.name] = `file:${tarball.tarball}`;
  }
  return overrides;
}

export interface PackOutputEntry {
  filename: string;
  name: string;
  version: string;
  /** `npm pack --json` 的 `files[].path`；旧版 npm 没有该字段时为 undefined */
  files?: string[];
}

export function parsePackOutput(stdout: string): PackOutputEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new SmokeConfigError(`npm pack --json: invalid JSON output: ${stdout.trim()}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new SmokeConfigError('npm pack --json: expected a non-empty array');
  }

  const entries: PackOutputEntry[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      throw new SmokeConfigError('npm pack --json: unexpected entry');
    }
    const filename = (entry as { filename?: unknown }).filename;
    const name = (entry as { name?: unknown }).name;
    const version = (entry as { version?: unknown }).version;
    if (typeof filename !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
      throw new SmokeConfigError('npm pack --json: entry missing filename/name/version');
    }

    const filesRaw = (entry as { files?: unknown }).files;
    let files: string[] | undefined;
    if (filesRaw !== undefined) {
      if (!Array.isArray(filesRaw)) {
        throw new SmokeConfigError('npm pack --json: entry "files" must be an array');
      }
      files = filesRaw.map((file) => {
        const path = (file as { path?: unknown } | null)?.path;
        if (typeof path !== 'string') {
          throw new SmokeConfigError('npm pack --json: entry "files[].path" must be a string');
        }
        return path;
      });
    }

    entries.push({ filename, name, version, ...(files === undefined ? {} : { files }) });
  }
  return entries;
}

/** 根 tarball 必须包含 `apps/web/dist/index.html`；没有文件清单也视为失败。 */
export function checkRootIncludesWeb(files: readonly string[] | undefined): string | null {
  if (files === undefined) {
    return 'root tarball: npm pack --json did not report a file list; cannot verify apps/web/dist';
  }
  if (!files.includes(WEB_DIST_ENTRY)) {
    return `root tarball: missing ${WEB_DIST_ENTRY}; build apps/web before packing (cd apps/web && npm ci && npm run build)`;
  }
  return null;
}

export function checkVersionOutput(output: string, version: string): string | null {
  const trimmed = output.trim();
  if (trimmed === version) return null;
  return `vessel --version: expected "${version}", got "${trimmed}"`;
}

export function checkToolsOutput(output: string): string | null {
  const header = output.match(/Tools \((\d+)\):/);
  if (!header) return 'vessel --tools: missing "Tools (N):" header';
  const count = Number.parseInt(header[1] ?? '0', 10);
  if (count < REQUIRED_TOOLS.length) {
    return `vessel --tools: expected at least ${REQUIRED_TOOLS.length} tools, got ${count}`;
  }
  const absent = REQUIRED_TOOLS.filter(
    (tool) => !new RegExp(`^\\s*-\\s+${tool}:`, 'm').test(output),
  );
  if (absent.length > 0) return `vessel --tools: missing tool(s): ${absent.join(', ')}`;
  return null;
}

// ── 打包与安装 ────────────────────────────────────────────────

async function readManifest(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
}

async function collectPackages(root: string): Promise<SmokePackage[]> {
  const publicPackages = await collectPublicPackages(root);
  const packages: SmokePackage[] = publicPackages.map((pkg) => ({
    path: pkg.path.replace(/\/package\.json$/, ''),
    dir: pkg.dir,
    name: typeof pkg.manifest.name === 'string' ? pkg.manifest.name : '',
    version: typeof pkg.manifest.version === 'string' ? pkg.manifest.version : '',
  }));

  for (const pkg of packages) {
    if (pkg.name === '') throw new SmokeConfigError(`${pkg.path}: missing "name"`);
    if (pkg.version === '') throw new SmokeConfigError(`${pkg.path}: missing "version"`);
  }
  return orderPackages(packages);
}

function packPackage(pkgDir: string, destination: string): TarballInfo[] {
  const result = runCommand(
    npmCommand(),
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    pkgDir,
  );
  if (result.exitCode !== 0) {
    throw new SmokeConfigError(
      `npm pack failed in ${pkgDir} (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }

  return parsePackOutput(result.stdout).map((entry) => ({
    name: entry.name,
    version: entry.version,
    filename: entry.filename,
    tarball: join(destination, entry.filename),
    ...(entry.files === undefined ? {} : { files: entry.files }),
  }));
}

async function packAll(
  root: string,
  packages: SmokePackage[],
  destination: string,
): Promise<{ packages: TarballInfo[]; rootTarball: TarballInfo; rootName: string }> {
  await mkdir(destination, { recursive: true });

  const packed: TarballInfo[] = [];
  for (const pkg of packages) {
    const [entry] = packPackage(pkg.dir, destination);
    if (!entry) throw new SmokeConfigError(`${pkg.path}: npm pack produced no tarball`);
    if (entry.name !== pkg.name || entry.version !== pkg.version) {
      throw new SmokeConfigError(
        `${pkg.path}: packed ${entry.name}@${entry.version} != ${pkg.name}@${pkg.version}`,
      );
    }
    if (!existsSync(entry.tarball)) {
      throw new SmokeConfigError(`${pkg.path}: tarball not found: ${entry.tarball}`);
    }
    packed.push(entry);
  }

  const rootManifest = await readManifest(root);
  const rootVersion = typeof rootManifest.version === 'string' ? rootManifest.version : '';
  const rootName = typeof rootManifest.name === 'string' ? rootManifest.name : '';
  if (rootName === '') throw new SmokeConfigError('root package.json: missing "name"');
  if (rootVersion === '') throw new SmokeConfigError('root package.json: missing "version"');

  // dist 被 .gitignore 忽略；未构建时根 tarball 会静默缺少 Web 控制台。
  if (!existsSync(join(root, WEB_DIST_ENTRY))) {
    throw new SmokeConfigError(
      `root package requires a built web console: missing ${WEB_DIST_ENTRY}; ` +
        'run "cd apps/web && npm ci && npm run build" before smoke-install',
    );
  }

  const [rootEntry] = packPackage(root, destination);
  if (!rootEntry) throw new SmokeConfigError('root package: npm pack produced no tarball');
  if (rootEntry.name !== rootName || rootEntry.version !== rootVersion) {
    throw new SmokeConfigError(
      `root tarball: packed ${rootEntry.name}@${rootEntry.version} != ${rootName}@${rootVersion}`,
    );
  }
  if (!existsSync(rootEntry.tarball)) {
    throw new SmokeConfigError(`root tarball not found: ${rootEntry.tarball}`);
  }

  const webIssue = checkRootIncludesWeb(rootEntry.files);
  if (webIssue) throw new SmokeConfigError(webIssue);

  return { packages: packed, rootTarball: rootEntry, rootName };
}

async function installRoot(
  appDir: string,
  rootTarball: TarballInfo,
  tarballs: TarballInfo[],
  overrides: Record<string, string>,
): Promise<void> {
  await mkdir(appDir, { recursive: true });

  // 18 个包作为直接依赖安装，确保每个 tarball 自身可解析；overrides 使用
  // 完全相同的 `file:` spec，保证根 tarball 对 @vessel-agent/* 的精确版本依赖
  // 全部指向本地文件（npm 要求直接依赖与 override 的 spec 完全一致）。
  const dependencies: Record<string, string> = {
    [rootTarball.name]: overrides[rootTarball.name] ?? `file:${rootTarball.tarball}`,
  };
  for (const tarball of tarballs) {
    dependencies[tarball.name] = overrides[tarball.name] ?? `file:${tarball.tarball}`;
  }

  const manifest = {
    name: 'vessel-install-smoke',
    private: true,
    version: '0.0.0',
    dependencies,
    overrides,
  };
  await writeFile(join(appDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const result = runCommand(
    npmCommand(),
    ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
    appDir,
  );
  if (result.exitCode !== 0) {
    throw new SmokeConfigError(
      `npm install failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

async function verifyInstalledTree(
  appDir: string,
  packages: SmokePackage[],
  version: string,
): Promise<void> {
  for (const pkg of packages) {
    const dir = join(appDir, 'node_modules', ...pkg.name.split('/'));
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) {
      throw new SmokeConfigError(`installed tree: missing ${pkg.name} (${manifestPath})`);
    }
    const installed = await readManifest(dir);
    if (installed.version !== version) {
      throw new SmokeConfigError(
        `installed tree: ${pkg.name}@${String(installed.version)} != ${version}`,
      );
    }
  }
}

function runBin(appDir: string, rootName: string, args: string[], dataDir: string): CommandResult {
  const env = {
    ...process.env,
    VESSEL_MOCK: '1',
    VESSEL_NO_UPDATE_CHECK: '1',
    VESSEL_DATA_DIR: dataDir,
  };
  const installedDir = join(appDir, 'node_modules', ...rootName.split('/'));
  const binLink = join(appDir, 'node_modules', '.bin', 'vessel');

  // POSIX 上运行真实 bin shim（验证 bin 字段与 shebang）；Windows 用 bun 直接跑入口。
  const cmd =
    process.platform === 'win32'
      ? [process.execPath, join(installedDir, 'src', 'cli.ts')]
      : [binLink];

  const result = Bun.spawnSync({
    cmd: [...cmd, ...args],
    cwd: appDir,
    env,
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

// ── 主流程 ────────────────────────────────────────────────────

export interface SmokeOptions {
  root?: string;
  keep?: boolean;
}

export async function runInstallSmoke(options: SmokeOptions = {}): Promise<SmokeReport> {
  const root = options.root ?? process.cwd();
  const steps: string[] = [];
  const warnings: string[] = [];
  const tmpRoot = await mkdtemp(join(tmpdir(), 'vessel-install-smoke-'));

  const report: SmokeReport = {
    ok: false,
    version: '',
    rootPackage: ROOT_PACKAGE_NAME,
    packageCount: 0,
    steps,
    warnings,
  };
  if (options.keep) report.tmpDir = tmpRoot;

  try {
    const packages = await collectPackages(root);
    const versions = new Set(packages.map((pkg) => pkg.version));
    if (versions.size !== 1) {
      throw new SmokeConfigError(
        `workspace packages have mixed versions: ${[...versions].sort().join(', ')}`,
      );
    }
    const version = [...versions][0] ?? '';
    report.version = version;
    report.packageCount = packages.length;
    steps.push(`collected ${packages.length} publishable package(s) at ${version}`);

    const tarballDir = join(tmpRoot, 'tarballs');
    const appDir = join(tmpRoot, 'app');
    const dataDir = join(tmpRoot, 'data');

    const packed = await packAll(root, packages, tarballDir);
    report.rootPackage = packed.rootName;
    steps.push(`packed ${packed.packages.length} package(s) + root ${packed.rootTarball.name}`);
    if (packed.rootName !== ROOT_PACKAGE_NAME) {
      warnings.push(
        `root package name is "${packed.rootName}", expected publish name "${ROOT_PACKAGE_NAME}" (bin stays "vessel")`,
      );
    }
    if (packed.packages.length !== PUBLISH_ORDER.length) {
      warnings.push(
        `packed ${packed.packages.length} package(s), expected ${PUBLISH_ORDER.length}; update PUBLISH_ORDER`,
      );
    }

    await installRoot(appDir, packed.rootTarball, packed.packages, buildOverrides(packed.packages));
    steps.push('installed root tarball with local @vessel-agent/* overrides');

    await verifyInstalledTree(appDir, packages, version);
    steps.push(`verified ${packages.length} installed @vessel-agent/* package version(s)`);

    const versionResult = runBin(appDir, packed.rootName, ['--version'], dataDir);
    if (versionResult.exitCode !== 0) {
      throw new SmokeConfigError(
        `vessel --version failed (${versionResult.exitCode}): ${
          versionResult.stderr.trim() || versionResult.stdout.trim()
        }`,
      );
    }
    const versionIssue = checkVersionOutput(versionResult.stdout, version);
    if (versionIssue) throw new SmokeConfigError(versionIssue);
    steps.push(`vessel --version => ${versionResult.stdout.trim()}`);

    const toolsResult = runBin(appDir, packed.rootName, ['--tools'], dataDir);
    if (toolsResult.exitCode !== 0) {
      throw new SmokeConfigError(
        `vessel --tools failed (${toolsResult.exitCode}): ${
          toolsResult.stderr.trim() || toolsResult.stdout.trim()
        }`,
      );
    }
    const toolsIssue = checkToolsOutput(toolsResult.stdout);
    if (toolsIssue) throw new SmokeConfigError(toolsIssue);
    steps.push('vessel --tools => bash/read/edit present');

    report.ok = true;
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    return report;
  } finally {
    if (!options.keep) await rm(tmpRoot, { recursive: true, force: true });
  }
}

function printHuman(report: SmokeReport): void {
  console.log(
    `install smoke: ${report.rootPackage}@${report.version}, ${report.packageCount} package(s)`,
  );
  for (const step of report.steps) console.log(`  ok ${step}`);
  for (const warning of report.warnings) console.warn(`  warning ${warning}`);
  if (report.tmpDir) console.log(`  temp dir kept: ${report.tmpDir}`);
  if (report.ok) {
    console.log('install smoke passed');
    return;
  }
  console.error(`install smoke failed: ${report.error ?? 'unknown error'}`);
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/smoke-install.ts [--keep] [--force] [--json] [--help]

Packs every publishable package plus the root CLI, installs the root tarball
with local @vessel-agent/* overrides, then runs \`vessel --version\` and
\`vessel --tools\` (VESSEL_MOCK=1, no API key). The root tarball must contain
apps/web/dist/index.html; build apps/web before running this script.

Windows is skipped by default (npm .cmd bin shims are not validated); use
--force to attempt it anyway.

Exit codes: 0 = passed/skipped, 1 = check failed, 2 = usage/config error.`);
}

function parseArgs(args: string[]): {
  keep: boolean;
  force: boolean;
  json: boolean;
  help: boolean;
} {
  let keep = false;
  let force = false;
  let json = false;
  let help = false;

  for (const arg of args) {
    if (arg === '--keep') {
      keep = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new SmokeConfigError(`unknown argument: ${arg}`);
    }
  }
  return { keep, force, json, help };
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

  if (process.platform === 'win32' && !options.force) {
    console.log(
      'install smoke skipped on Windows: npm .cmd bin shims and file: overrides are only validated on POSIX/CI (use --force to attempt).',
    );
    return;
  }

  try {
    const report = await runInstallSmoke({ keep: options.keep });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exit(1);
      return;
    }
    printHuman(report);
    if (!report.ok) process.exit(1);
  } catch (error) {
    if (error instanceof SmokeConfigError) {
      console.error(`install smoke config error: ${error.message}`);
      process.exit(2);
    }
    console.error(`install smoke error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
