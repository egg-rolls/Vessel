#!/usr/bin/env bun

/**
 * RPC 方法表 v1.1 一致性检查（0.5）。
 *
 * 事实源：`@vessel-agent/serve` 的 local dispatcher manifest（与 gateway 同一方法表）。
 * 对照：`docs/architecture/gateway-rpc.md` 的 `rpc-methods` 标记表格 + DECISION-010 A-3/A-4
 * 冻结的 canonical 集合。
 *
 * 同时断言 legacy-only 方法不进入 manifest：team.* / durable.* /
 * run.submit|get|cancel / metrics.rebuild。
 *
 * 第二段校验插件清单（`plugins` 下各 package.json 的 `vessel` 块），复用 loader 的
 * `validatePluginManifest`：`contributes.rpc[].name` 必须是 `PLUGIN_RPC_NAME_RE`
 * 允许的裸名；engines / entry / contributes / permissions 的错误同样失败。
 * 0.48 起同一个校验器也覆盖 `contributes.http` / `contributes.cli`（路径形状、
 * 路由冲突、CLI handler 指向 rpc、args JSON Schema 子集）；错误消息自带
 * `contributes.<surface>[i].<field>` 定位，这里统一拼上 `文件: ` 前缀。
 * loader 在运行时 fail-closed，这一步把它提前到提交前。
 *
 * 用法：bun run scripts/check-rpc-methods.ts
 * 退出码：0 = 一致；1 = 有差异。
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createGatewayEventHub, createLocalRpcDispatcher } from '../packages/serve/src/index';
import { PLUGIN_RPC_NAME_RE, validatePluginManifest } from '../src/plugin-manifest';
import { readPackageVersion } from '../src/version';

type Permission = 'read' | 'write' | 'admin';

/** A-3 §10.1 + A-4 冻结的 canonical 方法表。 */
export const EXPECTED_METHODS: Readonly<Record<string, Permission>> = {
  'health.get': 'read',
  'capabilities.list': 'read',
  'config.get': 'read',
  'config.sources': 'read',
  // 0.15（DECISION-030）：Web Settings 白名单写回。
  'config.set': 'write',
  'sessions.list': 'read',
  'sessions.get': 'read',
  'sessions.search': 'read',
  'sessions.delete': 'write',
  'sessions.rename': 'write',
  // 0.34（CONTRACT-0.34-context C7）：手动压缩（connect / 远程）。
  'sessions.compact': 'write',
  // 0.39（CREATE-0.39）：session 主键入口（空 / copy / compact）与 primary 切换。
  'sessions.create': 'write',
  'sessions.restart': 'write',
  'sessions.activate': 'write',
  'runs.list': 'read',
  'runs.get': 'read',
  'runs.start': 'write',
  'runs.cancel': 'write',
  'runs.resume': 'write',
  // 0.14 P0（DECISION-025 §1.4）：agents 注册表。
  'agents.list': 'read',
  'agents.get': 'read',
  // 0.25：canonical agent 生命周期（批量；team-scoped token 不能 create）。
  'agents.create': 'write',
  'agents.update': 'write',
  'agents.close': 'write',
  // 0.26：批量投递；team-scoped token 只能操作同 team 成员。
  'agents.send': 'write',
  'agents.dispatch': 'write',
  // 0.15（DECISION-030 E5）：canonical agent 树。
  'agents.tree': 'read',
  'events.list': 'read',
  'events.subscribe': 'read',
  'tools.list': 'read',
  'plugins.list': 'read',
  // CONTRACT-0.43 Errata E3：热重载体验型 plugin（write；plugin 子进程无宿主 RPC 通道）。
  'plugins.reload': 'write',
  // CONTRACT-0.47：插件目录只读快照（Web / 宿主消费；不触发 reload、不查 registry）。
  'plugins.catalog': 'read',
  'metrics.get': 'read',
  'metrics.reset': 'write',
  'mcp.list': 'read',
  'mcp.reconnect': 'write',
  'trace.prune': 'admin',
  'tenants.list': 'admin',
  'tenants.get': 'read',
  'tenants.create': 'admin',
  'tenants.update': 'admin',
  'permission.respond': 'write',
  'ask.respond': 'write',
  // CONTRACT-hot-apply §7：工具确认策略三档写回（用户 YAML 的两个数组）。
  'permissions.setToolPolicy': 'write',
  // 0.18：刷新后读取 pending / answered / orphaned 交互（只读）。
  'interactions.list': 'read',
  'evals.latest': 'read',
  'evals.run': 'write',
  'feishu.status': 'read',
  // 0.12（DECISION-023 §2.3）：热重载，admin-only。
  'gateway.reload': 'admin',
  // 0.19 S3：本地 Team 控制面。canonical 是复数 `teams.*`；
  // legacy `team.*`（单数）前缀仍视为 legacy-only，两者无关。
  'teams.list': 'read',
  'teams.get': 'read',
  'teams.post': 'write',
  // 0.38（CONTRACT-0.38-team-retract）：消息撤回 = 追加 tombstone。
  'teams.retract': 'write',
  'teams.members': 'write',
  // 0.24 S10.3：Team CRUD（create 仅 human / admin；update / archive 可在
  // team-scoped control 白名单内，但只能操作自己的 team）。
  'teams.create': 'write',
  'teams.update': 'write',
  'teams.archive': 'write',
  // 0.19 S4：人工预算 status / override（不进 control scope 白名单）。
  'teams.budget': 'write',
  // 0.27：冻结 / 解冻 spawn（team-scoped token 只能操作自己的 team）。
  'teams.spawnFrozen': 'write',
  // 0.19 S5：hub 控制面。exchange 换短期 control token；revoke / list 只允许 admin。
  'auth.exchange': 'write',
  'auth.revoke': 'admin',
  'auth.tokens': 'admin',
};

const LEGACY_PREFIXES = ['team.', 'durable.'] as const;
const LEGACY_EXACT = new Set(['run.submit', 'run.get', 'run.cancel', 'metrics.rebuild']);

const PLUGINS_DIR = 'plugins';
/** 构建产物与前端静态目录不参与清单扫描 */
const PLUGIN_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'web']);

const BEGIN_MARKER = '<!-- rpc-methods:begin -->';
const END_MARKER = '<!-- rpc-methods:end -->';
const DOC_PATH = 'docs/architecture/gateway-rpc.md';

export interface MethodTableIssue {
  method?: string;
  message: string;
}

function isLegacy(method: string): boolean {
  return LEGACY_EXACT.has(method) || LEGACY_PREFIXES.some((prefix) => method.startsWith(prefix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 递归收集 `plugins/**` 下的 package.json（跳过 node_modules / dist / web）。 */
export async function findPluginPackageJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (PLUGIN_SCAN_SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'package.json') {
        files.push(join(dir, entry.name));
      }
    }
  }
  await walk(join(root, PLUGINS_DIR));
  return files.sort();
}

/** 解析 gateway-rpc 中标记表格的 `方法 | permission` 行。 */
export function parseDocMethodTable(text: string): Record<string, Permission> | null {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return null;

  const block = text.slice(begin + BEGIN_MARKER.length, end);
  const rows: Record<string, Permission> = {};
  for (const line of block.split('\n')) {
    // 方法名允许 camelCase（如 `teams.spawnFrozen`）。
    const match = /^\|\s*`?([A-Za-z][A-Za-z0-9_.]*)`?\s*\|\s*(read|write|admin)\s*\|/.exec(
      line.trim(),
    );
    if (!match) continue;
    const method = match[1] ?? '';
    const permission = match[2] as Permission;
    rows[method] = permission;
  }
  return rows;
}

export function compareMethodTables(
  actual: Record<string, Permission>,
  documented: Record<string, Permission>,
  expected: Readonly<Record<string, Permission>> = EXPECTED_METHODS,
): MethodTableIssue[] {
  const issues: MethodTableIssue[] = [];

  for (const [method, permission] of Object.entries(expected)) {
    if (actual[method] === undefined) {
      issues.push({ method, message: `manifest 缺少 canonical 方法 ${method}` });
    } else if (actual[method] !== permission) {
      issues.push({
        method,
        message: `manifest permission 不一致：${method} 期望 ${permission}，实际 ${actual[method]}`,
      });
    }
    if (documented[method] === undefined) {
      issues.push({ method, message: `gateway-rpc 方法表缺少 ${method}` });
    } else if (documented[method] !== permission) {
      issues.push({
        method,
        message: `gateway-rpc permission 不一致：${method} 期望 ${permission}，实际 ${documented[method]}`,
      });
    }
  }

  for (const method of Object.keys(actual)) {
    if (expected[method] === undefined) {
      issues.push({ method, message: `manifest 出现未冻结方法 ${method}` });
    }
    if (isLegacy(method)) {
      issues.push({ method, message: `legacy-only 方法不得进入 manifest：${method}` });
    }
  }

  for (const method of Object.keys(documented)) {
    if (expected[method] === undefined) {
      issues.push({ method, message: `gateway-rpc 出现未冻结方法 ${method}` });
    }
    if (isLegacy(method)) {
      issues.push({ method, message: `legacy-only 方法不得出现在 canonical 表：${method}` });
    }
  }

  return issues;
}

export async function checkRpcMethods(root: string): Promise<MethodTableIssue[]> {
  const text = await readFile(join(root, DOC_PATH), 'utf8');
  const documented = parseDocMethodTable(text);
  if (documented === null) {
    return [{ message: `${DOC_PATH} 缺少 ${BEGIN_MARKER} / ${END_MARKER} 标记表格` }];
  }

  const dispatcher = createLocalRpcDispatcher({ hub: createGatewayEventHub() });
  try {
    const manifest = dispatcher.manifest();
    const actual: Record<string, Permission> = {};
    for (const method of manifest.methods) {
      actual[method.name] = method.permission;
    }
    return compareMethodTables(actual, documented);
  } finally {
    dispatcher.dispose();
  }
}

/**
 * 静态校验 `plugins` 下各 package.json 的 `vessel` 块：与 loader 同一套 manifest 规则。
 *
 * 扫描范围与 loader 一致：无 `vessel` 块的能力插件跳过；有 `vessel.entry` 且
 * `contributes` 是对象时做完整清单校验。`contributes.rpc[].name` 先单独检查，
 * 以便错误定位到 `文件:contributes.rpc[i].name`，且不与完整校验重复计数。
 */
export async function checkPluginManifests(root: string): Promise<MethodTableIssue[]> {
  const issues: MethodTableIssue[] = [];
  const vesselVersion = readPackageVersion();
  const files = await findPluginPackageJsonFiles(root);

  for (const file of files) {
    const displayPath = relative(root, file).split('\\').join('/');
    let pkg: unknown;
    try {
      pkg = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      issues.push({ message: `${displayPath}: package.json is not valid JSON` });
      continue;
    }
    if (!isRecord(pkg) || !isRecord(pkg.vessel)) continue;

    const vessel = pkg.vessel;
    const contributes = isRecord(vessel.contributes) ? vessel.contributes : undefined;

    const reportedRpcIndexes: number[] = [];
    if (Array.isArray(contributes?.rpc)) {
      contributes.rpc.forEach((entry, index) => {
        if (!isRecord(entry) || typeof entry.name !== 'string') return;
        if (PLUGIN_RPC_NAME_RE.test(entry.name)) return;
        reportedRpcIndexes.push(index);
        issues.push({
          message: `${displayPath}: contributes.rpc[${index}].name "${entry.name}" must match ${PLUGIN_RPC_NAME_RE.source}`,
        });
      });
    }

    const hasEntry = typeof vessel.entry === 'string' && vessel.entry.trim() !== '';
    if (!hasEntry || contributes === undefined) continue;

    const result = validatePluginManifest(vessel, { baseDir: dirname(file), vesselVersion });
    if (result.ok) continue;

    const rpcMatch = /contributes\.rpc\[(\d+)\]\.name/.exec(result.error.message);
    if (rpcMatch && reportedRpcIndexes.includes(Number(rpcMatch[1]))) continue;
    issues.push({ message: `${displayPath}: [${result.error.code}] ${result.error.message}` });
  }

  return issues;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const issues = [...(await checkRpcMethods(root)), ...(await checkPluginManifests(root))];
  if (issues.length === 0) {
    console.log('rpc method table and plugin manifest check passed');
    return;
  }

  console.error(`rpc / plugin manifest check failed: ${issues.length} issue(s)`);
  for (const issue of issues) {
    console.error(`  ${issue.method ? `${issue.method}: ` : ''}${issue.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
