#!/usr/bin/env bun

/**
 * RPC 方法表 v1.1 一致性检查（0.5）。
 *
 * 事实源：`@vessel-agent/serve` 的 local dispatcher manifest（与 gateway 同一方法表）。
 * 对照：`docs/ARCHITECTURE.md` 的 `rpc-methods` 标记表格 + DECISION-010 A-3/A-4
 * 冻结的 canonical 集合。
 *
 * 同时断言 legacy-only 方法不进入 manifest：team.* / durable.* /
 * run.submit|get|cancel / metrics.rebuild。
 *
 * 用法：bun run scripts/check-rpc-methods.ts
 * 退出码：0 = 一致；1 = 有差异。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryEventStream } from '../packages/core/src/index';
import { createLocalRpcDispatcher } from '../packages/serve/src/index';

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
  'runs.list': 'read',
  'runs.get': 'read',
  'runs.start': 'write',
  'runs.cancel': 'write',
  'runs.resume': 'write',
  // 0.14 P0（DECISION-025 §1.4）：agents 注册表。
  'agents.list': 'read',
  'agents.get': 'read',
  // 0.15（DECISION-030 E5）：canonical agent 树与只读任务板。
  'agents.tree': 'read',
  'tasks.list': 'read',
  'tasks.get': 'read',
  'events.list': 'read',
  'events.subscribe': 'read',
  'tools.list': 'read',
  'plugins.list': 'read',
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
  'workflow.list': 'read',
  'workflow.get': 'read',
  'workflow.start': 'write',
  'workflow.resume': 'write',
  'workflow.cancel': 'write',
  'evals.latest': 'read',
  'evals.run': 'write',
  'feishu.status': 'read',
  // 0.12（DECISION-023 §2.3）：热重载，admin-only。
  'gateway.reload': 'admin',
};

const LEGACY_PREFIXES = ['team.', 'durable.'] as const;
const LEGACY_EXACT = new Set(['run.submit', 'run.get', 'run.cancel', 'metrics.rebuild']);

const BEGIN_MARKER = '<!-- rpc-methods:begin -->';
const END_MARKER = '<!-- rpc-methods:end -->';
const DOC_PATH = 'docs/ARCHITECTURE.md';

export interface MethodTableIssue {
  method?: string;
  message: string;
}

function isLegacy(method: string): boolean {
  return LEGACY_EXACT.has(method) || LEGACY_PREFIXES.some((prefix) => method.startsWith(prefix));
}

/** 解析 ARCHITECTURE 中标记表格的 `方法 | permission` 行。 */
export function parseDocMethodTable(text: string): Record<string, Permission> | null {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return null;

  const block = text.slice(begin + BEGIN_MARKER.length, end);
  const rows: Record<string, Permission> = {};
  for (const line of block.split('\n')) {
    const match = /^\|\s*`?([a-z][a-z0-9_.]*)`?\s*\|\s*(read|write|admin)\s*\|/.exec(line.trim());
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
      issues.push({ method, message: `ARCHITECTURE 方法表缺少 ${method}` });
    } else if (documented[method] !== permission) {
      issues.push({
        method,
        message: `ARCHITECTURE permission 不一致：${method} 期望 ${permission}，实际 ${documented[method]}`,
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
      issues.push({ method, message: `ARCHITECTURE 出现未冻结方法 ${method}` });
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

  const dispatcher = createLocalRpcDispatcher({ events: new MemoryEventStream() });
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

async function main(): Promise<void> {
  const issues = await checkRpcMethods(process.cwd());
  if (issues.length === 0) {
    console.log('rpc method table check passed');
    return;
  }

  console.error(`rpc method table check failed: ${issues.length} issue(s)`);
  for (const issue of issues) {
    console.error(`  ${issue.method ? `${issue.method}: ` : ''}${issue.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
