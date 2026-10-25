/**
 * @vessel-agent/doc-subscription - `subscribe` 工具
 * @module @vessel-agent/doc-subscription/tool
 *
 * 显式订阅：add / remove / list / inspect。只接受具体文件（无 glob、无目录），
 * 权限与路径边界在 handler 内复用 read 工具的同一条 `evaluatePath` 判定。
 *
 * - BeforeLlm 只发短通知（无正文）；正文只在模型显式 `inspect` 时返回。
 * - `inspect` 成功才推进 `seen_rev`；失败 / 超限不推进。
 * - 工具不写日志，不主动把正文写进 trace；正文随工具结果进入上下文。
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalPath, evaluatePath, type PathBoundary } from '@vessel-agent/basic-tools';
import type { ToolContext, ToolDefinition } from '@vessel-agent/core';
import type { DocSubscriptionConfig } from './config.js';
import { unifiedDiff } from './diff.js';
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

/** inspect 的结果 */
interface InspectOutcome {
  output: string;
  changed: boolean;
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

/** XML 属性值转义（& < > "） */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 内容 hash */
function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
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
      // 重复 add 保留已有游标，避免无谓重通知 / 重新全量。
      rev: existing?.rev ?? '',
      notified_rev: existing?.notified_rev ?? '',
      seen_rev: existing?.seen_rev ?? '',
      size: info.size,
      mtime_ms: info.mtimeMs,
      notified_at: existing?.notified_at ?? 0,
      seen_at: existing?.seen_at ?? 0,
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
  resolve: (input: string) => string,
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
    key = canonicalPath(resolve(rawPath));
  }

  if (key === undefined || state.subscriptions[key] === undefined) {
    return `not_found: ${rawPath ?? id}`;
  }
  delete state.subscriptions[key];
  return `removed: ${key}`;
}

/** rev 的展示形态 */
function describeRev(rev: string): string {
  if (rev === '') return 'never';
  if (rev === 'deleted') return 'deleted';
  if (rev.startsWith('too_large:')) return 'too_large';
  if (rev.startsWith('binary:'))
    return `binary:${rev.slice('binary:'.length, 'binary:'.length + 12)}`;
  return `sha256:${rev.slice(0, 12)}`;
}

/** 格式化 list；显示 changed（未通知）/ unread（未 inspect） */
function formatList(state: SessionSubscriptionState): string {
  const entries = Object.values(state.subscriptions).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (entries.length === 0) return 'no subscriptions';
  const lines = [`subscribed ${entries.length}:`];
  for (const entry of entries) {
    const changeLabel =
      entry.rev === '' ? 'pending' : entry.rev !== entry.notified_rev ? 'changed' : 'notified';
    const unread = entry.seen_rev === '' || entry.seen_rev !== entry.rev;
    lines.push(
      `  ${entry.path} id=${entry.id} rev=${describeRev(entry.rev)} ` +
        `seen=${describeRev(entry.seen_rev)} bytes=${entry.size} ` +
        `${changeLabel} ${unread ? 'unread' : 'read'}`,
    );
  }
  return lines.join('\n');
}

/** 找到 inspect 的条目 key；id 优先于 path */
function resolveKey(
  state: SessionSubscriptionState,
  args: Record<string, unknown>,
  deps: SubscribeToolDeps,
): string | undefined {
  const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : undefined;
  if (id !== undefined) {
    return Object.keys(state.subscriptions).find(
      (candidate) => state.subscriptions[candidate]?.id === id,
    );
  }
  const rawPath =
    typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined;
  if (rawPath === undefined) return undefined;
  return canonicalPath(resolveInput(deps.config, rawPath));
}

/** inspect 的 XML 信封 */
function inspectEnvelope(
  entry: SubscriptionEntry,
  attrs: Record<string, string>,
  body: string,
): string {
  const attrText = [
    `path="${escapeXmlAttr(entry.path)}"`,
    `id="${escapeXmlAttr(entry.id)}"`,
    ...Object.entries(attrs).map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`),
  ].join(' ');
  return `<subscription-inspect ${attrText}>\n${body}\n</subscription-inspect>`;
}

/**
 * 显式读取订阅正文：首次 / 无快照给全文，之后给 diff。
 * 只有成功返回正文才推进 seen_rev；失败 / 超限只更新观察值。
 */
async function inspectSubscription(
  state: SessionSubscriptionState,
  args: Record<string, unknown>,
  deps: SubscribeToolDeps,
  now: number,
): Promise<InspectOutcome> {
  const key = resolveKey(state, args, deps);
  if (key === undefined || state.subscriptions[key] === undefined) {
    return { output: 'not_found: inspect 需要已订阅的 path 或 id。', changed: false };
  }
  const entry = state.subscriptions[key];
  if (entry === undefined) return { output: 'not_found', changed: false };

  if (evaluatePath(entry.path, deps.boundary) !== 'allow') {
    return { output: 'path_denied: 路径已不在允许边界内。', changed: false };
  }

  let info: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    info = await stat(entry.path);
  } catch {
    info = undefined;
  }

  if (info === undefined || info.isDirectory()) {
    if (entry.seen_rev === 'deleted') {
      return {
        output: inspectEnvelope(entry, { status: 'deleted', change: 'none' }, 'File is deleted.'),
        changed: false,
      };
    }
    const next: SubscriptionEntry = {
      ...entry,
      rev: 'deleted',
      notified_rev: 'deleted',
      seen_rev: 'deleted',
      size: 0,
      mtime_ms: 0,
      seen_at: now,
    };
    delete next.snapshot;
    state.subscriptions[key] = next;
    return {
      output: inspectEnvelope(entry, { status: 'deleted', rev: 'deleted' }, 'File was deleted.'),
      changed: true,
    };
  }

  if (!info.isFile()) {
    return { output: 'not_a_file: 订阅路径不是普通文件。', changed: false };
  }
  if (info.size > MAX_SUBSCRIBE_BYTES) {
    return {
      output: inspectEnvelope(
        entry,
        { status: 'too_large', bytes: String(info.size) },
        'File is too large; use bash to inspect it.',
      ),
      changed: false,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(entry.path);
  } catch {
    return { output: 'read_failed: 无法读取文件。', changed: false };
  }

  if (buffer.includes(0)) {
    return {
      output: inspectEnvelope(
        entry,
        { status: 'binary' },
        'File is binary; use bash to inspect it.',
      ),
      changed: false,
    };
  }

  const hash = sha256Hex(buffer);
  const text = buffer.toString('utf-8');

  // 已看过同一版：不重复返回正文。
  if (entry.seen_rev === hash) {
    state.subscriptions[key] = {
      ...entry,
      rev: hash,
      notified_rev: hash,
      size: buffer.byteLength,
      mtime_ms: info.mtimeMs,
    };
    return {
      output: inspectEnvelope(
        entry,
        { rev: `sha256:${hash}`, change: 'none' },
        'No changes since the last inspect.',
      ),
      changed: true,
    };
  }

  const baseAttrs = { rev: `sha256:${hash}` };

  // 第一次（或没有快照）：给全文；超限则降级。
  if (entry.snapshot === undefined) {
    if (buffer.byteLength > deps.config.maxFullBytes) {
      state.subscriptions[key] = {
        ...entry,
        rev: hash,
        size: buffer.byteLength,
        mtime_ms: info.mtimeMs,
      };
      return {
        output: inspectEnvelope(
          entry,
          { ...baseAttrs, status: 'too_large' },
          `File is ${buffer.byteLength} bytes; use read to view it.`,
        ),
        changed: true,
      };
    }
    const next: SubscriptionEntry = {
      ...entry,
      rev: hash,
      notified_rev: hash,
      seen_rev: hash,
      size: buffer.byteLength,
      mtime_ms: info.mtimeMs,
      seen_at: now,
      snapshot: text,
    };
    state.subscriptions[key] = next;
    return {
      output: inspectEnvelope(entry, { ...baseAttrs, change: 'full' }, text),
      changed: true,
    };
  }

  const diff = unifiedDiff(entry.snapshot, text, {
    maxBytes: deps.config.maxDiffBytes,
    maxLines: deps.config.maxDiffLines,
  });
  if (diff.truncated) {
    // 不推进 seen_rev / notified_rev；下一次仍可按需 inspect 或 read。
    state.subscriptions[key] = {
      ...entry,
      rev: hash,
      size: buffer.byteLength,
      mtime_ms: info.mtimeMs,
    };
    return {
      output: inspectEnvelope(
        entry,
        { ...baseAttrs, change: 'diff_omitted' },
        `Diff exceeded limits (${diff.bytes} bytes / ${diff.lines} lines); use read to view it.`,
      ),
      changed: true,
    };
  }

  const next: SubscriptionEntry = {
    ...entry,
    rev: hash,
    notified_rev: hash,
    seen_rev: hash,
    size: buffer.byteLength,
    mtime_ms: info.mtimeMs,
    seen_at: now,
  };
  if (buffer.byteLength <= deps.config.maxFullBytes) {
    next.snapshot = text;
  } else {
    delete next.snapshot;
  }
  state.subscriptions[key] = next;
  return {
    output: inspectEnvelope(entry, { ...baseAttrs, change: 'diff' }, diff.text),
    changed: true,
  };
}

/** 构造 subscribe 工具 */
export function createSubscribeTool(deps: SubscribeToolDeps): ToolDefinition {
  return {
    name: 'subscribe',
    description:
      'Manage explicit per-session file subscriptions. add/remove/list/inspect concrete files; ' +
      'changes produce a short notice, and inspect returns the diff (full content on first read).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'list', 'inspect'],
          description: 'add | remove | list | inspect',
        },
        path: { type: 'string', description: 'Single file path (add / remove / inspect)' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple file paths (add only)',
        },
        id: { type: 'string', description: 'Subscription id (remove / inspect)' },
      },
      required: ['action'],
    },
    display: { label: 'Subscribe', kind: 'generic' },
    // 校验全部在 handler；工具不写日志
    checkPermission: async () => 'allow',
    handler: async (args: unknown, ctx: ToolContext): Promise<string> => {
      if (!isRecord(args)) return '错误：subscribe 需要 { action }';
      const action = args.action;
      if (action !== 'add' && action !== 'remove' && action !== 'list' && action !== 'inspect') {
        return '错误：action 必须是 add / remove / list / inspect。';
      }

      const sessionId = ctx.session_id ?? 'default';
      let state: SessionSubscriptionState;
      try {
        state = await deps.store.load(sessionId);
      } catch {
        return '错误：读取订阅状态失败。';
      }

      if (action === 'list') return formatList(state);

      if (action === 'inspect') {
        const outcome = await inspectSubscription(state, args, deps, Date.now());
        if (outcome.changed) {
          try {
            await deps.store.save(state);
          } catch {
            return '错误：保存订阅状态失败。';
          }
        }
        return outcome.output;
      }

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
        lines.push('Changes will produce a short notice; use action "inspect" to view them.');
      }
      if (rejected.length > 0) {
        lines.push(`rejected ${rejected.length}:`);
        for (const item of rejected) lines.push(`  ${item.reason}: ${item.input}`);
      }
      return lines.join('\n');
    },
  };
}
