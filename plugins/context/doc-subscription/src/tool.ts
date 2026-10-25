/**
 * @vessel-agent/doc-subscription - `subscribe` 工具
 * @module @vessel-agent/doc-subscription/tool
 *
 * 显式订阅：add / remove / list。只接受具体文件（无 glob、无目录），
 * 权限与路径边界在 handler 内复刻 read 工具的同一条 `evaluatePath` 判定。
 * 工具本身不返回任何文件内容——内容只在下一个 run 由 BeforeLlm hook 注入。
 */

import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalPath, evaluatePath, type PathBoundary } from '@vessel-agent/basic-tools';
import type { ToolContext, ToolDefinition } from '@vessel-agent/core';
import type { DocSubscriptionConfig } from './config.js';
import {
  type SessionSubscriptionState,
  type SubscriptionEntry,
  type SubscriptionStore,
  subscriptionId,
} from './store.js';

/** 与 read 工具同口径 */
export const MAX_SUBSCRIBE_BYTES = 8 * 1024 * 1024;

/** 工具依赖 */
export interface SubscribeToolDeps {
  boundary: PathBoundary;
  store: SubscriptionStore;
  config: DocSubscriptionConfig;
}

/** add 的单个路径结果 */
interface AddOutcome {
  entry?: SubscriptionEntry;
  input: string;
  reason?: string;
}

/** 类型守卫：值是否为对象记录 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 只展开开头的 `~` */
function expandHomePrefix(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

/** 用户输入按配置 cwd 解析为绝对路径 */
function resolveInput(config: DocSubscriptionConfig, input: string): string {
  return path.resolve(config.cwd, expandHomePrefix(input));
}

/** 显式拒绝的敏感文件名 / 后缀（不依赖内容 redactor） */
function isSensitiveBasename(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (lower.endsWith('.pem') || lower.endsWith('.key')) return true;
  if (lower === 'id_rsa' || lower === 'id_ed25519') return true;
  if (lower.startsWith('credentials')) return true;
  if (lower === '.netrc') return true;
  return false;
}

/** 通配符 / 花括号模式：订阅只接受具体文件 */
function hasWildcard(input: string): boolean {
  return /[*?[\]{}]/.test(input);
}

/** 校验并构造条目；失败返回 reason（稳定错误码） */
async function prepareEntry(
  input: string,
  deps: SubscribeToolDeps,
  existing: SubscriptionEntry | undefined,
): Promise<AddOutcome> {
  const trimmed = input.trim();
  if (trimmed === '') return { input, reason: 'empty' };
  if (hasWildcard(trimmed)) return { input, reason: 'wildcard' };

  const absolute = resolveInput(deps.config, trimmed);
  const canonical = canonicalPath(absolute);

  const decision = evaluatePath(canonical, deps.boundary);
  if (decision === 'deny') return { input, reason: 'path_denied' };
  if (decision === 'ask') return { input, reason: 'path_outside_allowed_roots' };

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(canonical);
  } catch {
    return { input, reason: 'not_found' };
  }
  if (info.isDirectory()) return { input, reason: 'not_a_file' };
  if (!info.isFile()) return { input, reason: 'not_a_file' };
  if (info.size > MAX_SUBSCRIBE_BYTES) return { input, reason: 'too_large' };
  if (isSensitiveBasename(path.basename(canonical))) return { input, reason: 'sensitive' };

  return {
    input: trimmed,
    entry: {
      id: subscriptionId(canonical),
      path: canonical,
      input: trimmed,
      // 新订阅从“未投递”开始；重复 add 保留已有游标，避免无谓全量重投
      rev: existing?.rev ?? '',
      size: info.size,
      mtime_ms: info.mtimeMs,
      delivered_at: existing?.delivered_at ?? 0,
      ...(existing?.snapshot !== undefined ? { snapshot: existing.snapshot } : {}),
    },
  };
}

/** 解析 add 的输入路径列表（path + paths，保持顺序） */
function collectAddInputs(args: Record<string, unknown>): string[] {
  const inputs: string[] = [];
  const single = args.path;
  if (typeof single === 'string' && single.trim() !== '') inputs.push(single);
  const multiple = args.paths;
  if (Array.isArray(multiple)) {
    for (const item of multiple) {
      if (typeof item === 'string') inputs.push(item);
    }
  }
  return inputs;
}

/** 格式化为删除结果 */
function formatRemove(
  state: SessionSubscriptionState,
  args: Record<string, unknown>,
  resolveInput: (input: string) => string,
): string {
  const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : undefined;
  const rawPath =
    typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined;

  if (id === undefined && rawPath === undefined) {
    return '错误：remove 需要 path 或 id。';
  }

  let key: string | undefined;
  if (id !== undefined) {
    key = Object.keys(state.subscriptions).find(
      (candidate) => state.subscriptions[candidate]?.id === id,
    );
    if (key === undefined) return `not_found: id=${id}`;
  } else if (rawPath !== undefined) {
    key = canonicalPath(resolveInput(rawPath));
  }

  if (key === undefined || state.subscriptions[key] === undefined) {
    return `not_found: ${rawPath ?? id}`;
  }
  delete state.subscriptions[key];
  return `removed: ${key}`;
}

/** rev 的展示形态 */
function describeRev(entry: SubscriptionEntry): string {
  if (entry.rev === '') return 'never';
  if (entry.rev === 'deleted') return 'deleted';
  if (entry.rev.startsWith('too_large:')) return 'too_large';
  if (entry.rev.startsWith('binary:'))
    return `binary:${entry.rev.slice('binary:'.length, 'binary:'.length + 12)}`;
  return `sha256:${entry.rev.slice(0, 12)}`;
}

/** 格式化 list */
function formatList(state: SessionSubscriptionState): string {
  const entries = Object.values(state.subscriptions).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (entries.length === 0) return 'no subscriptions';
  const lines = [`subscribed ${entries.length}:`];
  for (const entry of entries) {
    lines.push(
      `  ${entry.path} id=${entry.id} rev=${describeRev(entry)} ` +
        `bytes=${entry.size} delivered_at=${entry.delivered_at}`,
    );
  }
  return lines.join('\n');
}

/** 构造 subscribe 工具 */
export function createSubscribeTool(deps: SubscribeToolDeps): ToolDefinition {
  return {
    name: 'subscribe',
    description:
      'Manage explicit per-session file subscriptions. add/remove/list concrete files; ' +
      'changes are injected at the start of the next run (first full, then diffs).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'list'],
          description: 'add | remove | list',
        },
        path: { type: 'string', description: 'Single file path (add / remove)' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple file paths (add only)',
        },
        id: { type: 'string', description: 'Subscription id (remove only)' },
      },
      required: ['action'],
    },
    display: { label: 'Subscribe', kind: 'generic' },
    // 校验全部在 handler；工具不暴露文件内容
    checkPermission: async () => 'allow',
    handler: async (args: unknown, ctx: ToolContext): Promise<string> => {
      if (!isRecord(args)) return '错误：subscribe 需要 { action }';
      const action = args.action;
      if (action !== 'add' && action !== 'remove' && action !== 'list') {
        return '错误：action 必须是 add / remove / list。';
      }

      const sessionId = ctx.session_id ?? 'default';
      let state: SessionSubscriptionState;
      try {
        state = await deps.store.load(sessionId);
      } catch {
        return '错误：读取订阅状态失败。';
      }

      if (action === 'list') return formatList(state);

      if (action === 'remove') {
        if (
          (typeof args.path !== 'string' || args.path.trim() === '') &&
          (typeof args.id !== 'string' || args.id.trim() === '')
        ) {
          return '错误：remove 需要 path 或 id。';
        }
        const result = formatRemove(state, args, (input) => resolveInput(deps.config, input));
        if (result.startsWith('removed:')) {
          try {
            await deps.store.save(state);
          } catch {
            return '错误：保存订阅状态失败。';
          }
        }
        return result;
      }

      // add
      const inputs = collectAddInputs(args);
      if (inputs.length === 0) return '错误：add 需要 path 或 paths。';

      const added: SubscriptionEntry[] = [];
      const rejected: Array<{ input: string; reason: string }> = [];
      const seen = new Set<string>();

      for (const input of inputs) {
        const existingCanonical = canonicalPath(resolveInput(deps.config, input.trim()));
        if (seen.has(existingCanonical)) continue;
        seen.add(existingCanonical);

        const outcome = await prepareEntry(
          input,
          deps,
          state.subscriptions[existingCanonical] ?? undefined,
        );
        if (outcome.entry === undefined) {
          rejected.push({ input: outcome.input, reason: outcome.reason ?? 'invalid' });
          continue;
        }
        state.subscriptions[outcome.entry.path] = outcome.entry;
        added.push(outcome.entry);
      }

      if (added.length > 0) {
        try {
          await deps.store.save(state);
        } catch {
          return '错误：保存订阅状态失败。';
        }
      }

      const lines: string[] = [];
      if (added.length > 0) {
        lines.push(`added ${added.length}:`);
        for (const entry of added) lines.push(`  ${entry.path}`);
      }
      if (rejected.length > 0) {
        lines.push(`rejected ${rejected.length}:`);
        for (const item of rejected) lines.push(`  ${item.reason}: ${item.input}`);
      }
      return lines.join('\n');
    },
  };
}
