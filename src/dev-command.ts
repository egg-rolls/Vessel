/**
 * `vessel dev reset [--yes] [--dry-run] [--json]`（0.49 开发期清库）。
 *
 * - 只清空 resolved dataDir 的内容，保留目录本身；
 * - 不提供 RPC（gateway 起不来时仍可用），不改 config / 数据布局；
 * - `--yes` 必须显式给出；`--dry-run` 只列顶层条目与大小。
 *
 * 安全护栏：危险根（home / 文件系统根 / 仓库根 / 深度 < 2）拒绝；
 * 配置端口上的 gateway/node `/health` 返回 200 时拒绝；只删 dataDir 内的条目，
 * 顶层符号链接只删链接本身。
 *
 * @module vessel/dev-command
 */

import { type Dirent, existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadConfig,
  resolveGatewayNodePorts,
  type VesselConfig,
} from '../packages/config/src/index';
import { formatConfigErrors } from './config-error-format';
import { expandHome, resolveDataDir } from './data-paths';
import { t } from './i18n';

type EnvMap = Record<string, string | undefined>;

export interface DevResetArgs {
  yes: boolean;
  dryRun: boolean;
  json: boolean;
}

export type DevCommandArgs = ({ kind: 'reset' } & DevResetArgs) | { kind: 'help' };

export interface DevCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DevCommandContext {
  config?: VesselConfig;
  env?: EnvMap;
  cwd?: string;
  homeDir?: string;
  configPath?: string;
  userConfigPath?: string;
  /** 健康探测超时（ms）；测试可调小。 */
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 健康探测默认超时：本地回环，足够快。 */
const HEALTH_TIMEOUT_MS = 1000;

function formatHelp(): string {
  return [
    t('dev.reset.usage'),
    '',
    `  ${t('dev.reset.helpYes')}`,
    `  ${t('dev.reset.helpDryRun')}`,
    `  ${t('dev.reset.helpJson')}`,
    '',
    t('dev.reset.helpSafety'),
  ].join('\n');
}

/** realpath（命令层一次性路径判定；不存在时退回 resolve）。 */
function canonicalPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function normalizeForCompare(target: string): string {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let out = path.normalize(resolved);
  if (out.length > root.length && out.endsWith(path.sep)) out = out.slice(0, -1);
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/** 路径深度（相对文件系统根的片段数）；`C:\` / `/` = 0。 */
function pathDepth(target: string): number {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const rel = path.relative(root, resolved);
  if (rel === '' || rel === '.') return 0;
  return rel.split(/[\\/]+/).filter(Boolean).length;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 从 cwd 向上找仓库根（含 `.git` 的最近目录）；找不到返回 undefined。 */
function findRepoRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < 32; depth++) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** 危险根判定；返回拒绝原因（i18n key 的参数值），安全时返回 undefined。 */
function dangerousRoot(
  dataDir: string,
  options: { cwd: string; homeDir: string },
): string | undefined {
  const target = canonicalPath(dataDir);
  const home = canonicalPath(options.homeDir);
  const root = path.parse(target).root;
  const repoRoot = findRepoRoot(options.cwd);

  if (samePath(target, home)) return 'home';
  if (samePath(target, root)) return 'filesystem root';
  // cwd 可能不在这个仓库里（脚本从别处调用）；数据目录自身是工作树根同样危险。
  if (existsSync(path.join(target, '.git'))) return 'repository root';
  if (repoRoot !== undefined && samePath(target, repoRoot)) return 'repository root';
  if (pathDepth(target) < 2) return 'too shallow';
  return undefined;
}

async function probeHealth(port: number | undefined, ctx: DevCommandContext): Promise<boolean> {
  if (port === undefined || !Number.isInteger(port) || port <= 0 || port > 65535) return false;
  const impl = ctx.fetchImpl ?? fetch;
  try {
    const response = await impl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(ctx.healthTimeoutMs ?? HEALTH_TIMEOUT_MS),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** 配置声明的平台 / node 端口；任一 `/health` 200 即视为仍在运行。 */
async function runningListenerPort(
  config: VesselConfig,
  ctx: DevCommandContext,
): Promise<number | undefined> {
  const gatewayMode = resolveGatewayNodePorts(config, 'gateway');
  const legacyMode = resolveGatewayNodePorts(config, 'legacy');
  const ports = new Set<number>();
  for (const port of [gatewayMode.platformPort, gatewayMode.nodePort, legacyMode.nodePort]) {
    if (port !== undefined) ports.add(port);
  }
  for (const port of ports) {
    if (await probeHealth(port, ctx)) return port;
  }
  return undefined;
}

interface TopLevelScan {
  entries: Array<{ name: string; isDirectory: boolean }>;
  bytes: number;
}

async function sizeOf(absPath: string): Promise<number> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(absPath);
  } catch {
    return 0;
  }
  if (stats.isSymbolicLink()) return stats.size;
  if (stats.isDirectory()) {
    let total = 0;
    let children: Dirent[];
    try {
      children = await readdir(absPath, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const child of children) total += await sizeOf(path.join(absPath, child.name));
    return total;
  }
  return stats.size;
}

async function scanTopLevel(dataDir: string): Promise<TopLevelScan> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], bytes: 0 };
    throw error;
  }
  const entries = dirents
    .map((dirent) => ({
      name: dirent.name,
      isDirectory: dirent.isDirectory() && !dirent.isSymbolicLink(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  let bytes = 0;
  for (const entry of entries) bytes += await sizeOf(path.join(dataDir, entry.name));
  return { entries, bytes };
}

/** 删除顶层条目：符号链接只删链接本身，目录递归删除（不跟随链接）。 */
async function removeTopLevel(
  dataDir: string,
  entries: TopLevelScan['entries'],
): Promise<string[]> {
  const failures: string[] = [];
  for (const entry of entries) {
    const absPath = path.join(dataDir, entry.name);
    try {
      const stats = await lstat(absPath);
      if (stats.isSymbolicLink()) {
        await unlink(absPath);
      } else {
        await rm(absPath, { recursive: true });
      }
    } catch (error) {
      failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

function formatEntryList(scan: TopLevelScan): string {
  if (scan.entries.length === 0) return `  ${t('dev.reset.empty')}`;
  return scan.entries
    .map((entry) => `  - ${entry.name}${entry.isDirectory ? path.sep : ''}`)
    .join('\n');
}

function formatBytes(bytes: number): string {
  return `${bytes} B`;
}

function formatHubNote(config: VesselConfig, dataDir: string): string | undefined {
  const configured = config.hub?.dataDir;
  if (typeof configured !== 'string' || configured.trim() === '') return undefined;
  const hubDataDir = path.resolve(expandHome(configured.trim()));
  if (isInside(dataDir, hubDataDir)) return undefined;
  if (samePath(hubDataDir, dataDir)) return undefined;
  return t('dev.reset.hubOutside', { path: hubDataDir });
}

/** `vessel dev reset` */
export async function runDevCommand(
  command: DevCommandArgs,
  ctx: DevCommandContext = {},
): Promise<DevCommandResult> {
  if (command.kind === 'help') return { exitCode: 0, stdout: formatHelp(), stderr: '' };

  const env = ctx.env ?? process.env;
  let config = ctx.config;
  if (config === undefined) {
    const loaded = await loadConfig({
      env,
      configPath: ctx.configPath,
      userConfigPath: ctx.userConfigPath,
    });
    if (loaded.validation.errors.length > 0) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: formatConfigErrors(loaded.validation.errors, { paths: loaded.paths }),
      };
    }
    config = loaded.config;
  }

  const dataDir = resolveDataDir(config, env);
  const warnings: string[] = [];
  const hubNote = formatHubNote(config, dataDir);
  if (hubNote !== undefined) warnings.push(hubNote);

  const danger = dangerousRoot(dataDir, {
    cwd: ctx.cwd ?? process.cwd(),
    homeDir: ctx.homeDir ?? os.homedir(),
  });
  if (danger !== undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: t('dev.reset.dangerous', { path: dataDir, reason: danger }),
    };
  }

  const running = await runningListenerPort(config, ctx);
  if (running !== undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: t('dev.reset.gatewayRunning', { port: running }),
    };
  }

  let stats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    stats = await lstat(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (stats !== undefined && !stats.isDirectory()) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: t('dev.reset.notDirectory', { path: dataDir }),
    };
  }

  const scan = await scanTopLevel(dataDir);

  if (!command.yes && !command.dryRun) {
    return {
      exitCode: 2,
      stdout: [t('dev.reset.target', { path: dataDir }), t('dev.reset.confirmHint')].join('\n'),
      stderr: '',
    };
  }

  if (command.dryRun) {
    if (command.json) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          { dataDir, removed: scan.entries.length, dryRun: true, bytes: scan.bytes },
          null,
          2,
        ),
        stderr: warnings.join('\n'),
      };
    }
    const lines = [
      t('dev.reset.dryRunTitle', { path: dataDir }),
      formatEntryList(scan),
      t('dev.reset.total', { count: scan.entries.length, bytes: formatBytes(scan.bytes) }),
    ];
    return { exitCode: 0, stdout: lines.join('\n'), stderr: warnings.join('\n') };
  }

  if (stats === undefined) {
    // 目标本来不存在：按“重建为空目录”的后置条件创建。
    await mkdir(dataDir, { recursive: true });
  }

  const failures = await removeTopLevel(dataDir, scan.entries);
  if (failures.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: [
        t('dev.reset.partialFailure', { path: dataDir }),
        ...failures.map((failure) => `  - ${failure}`),
        ...warnings,
      ].join('\n'),
    };
  }

  let remaining: string[] = [];
  try {
    remaining = await readdir(dataDir);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  if (remaining.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: t('dev.reset.notEmpty', { path: dataDir, count: remaining.length }),
    };
  }

  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        { dataDir, removed: scan.entries.length, dryRun: false, bytes: scan.bytes },
        null,
        2,
      ),
      stderr: warnings.join('\n'),
    };
  }

  return {
    exitCode: 0,
    stdout: [
      t('dev.reset.removed', {
        path: dataDir,
        count: scan.entries.length,
        bytes: formatBytes(scan.bytes),
      }),
      ...warnings,
    ].join('\n'),
    stderr: '',
  };
}
