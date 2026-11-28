/**
 * @vessel-agent/doc-subscription - `subscribe` 工具
 * @module @vessel-agent/doc-subscription/tool
 *
 * 显式订阅：add / remove / list / inspect。只接受具体文件（无 glob、无目录），
 * 权限与路径边界在 handler 内复用 read 工具的同一条 `evaluatePath` 判定。
 *
 * - BeforeLlm 发短通知；有 read 引用的条目可带 line-level diff 明细行（hook.ts），
 *   其余正文只在模型显式 `inspect` 时返回。
 * - `inspect` 成功才推进 `seen_rev`；失败 / 超限不推进。
 * - 工具不写日志，不主动把正文写进 trace；正文随工具结果进入上下文。
 * - 自动订阅入口：autoSubscribePath（edit/write，Phase 1）与 readSubscribePath
 *   （read line-level，蜂群协作增强）；origin 升级梯 manual > edit > read。
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  canonicalPath,
  DEFAULT_READ_LIMIT,
  evaluatePath,
  type PathBoundary,
  splitLines,
} from '@vessel-agent/basic-tools';
import type { ToolContext, ToolDefinition } from '@vessel-agent/core';
import {
  agentSignature,
  agentSubscriptionKey,
  describeAgentRev,
  isValidAgentTarget,
  readAgentSnapshot,
} from './agent.js';
import { type DocSubscriptionConfig, isValidScriptName, resolveInput } from './config.js';
import { unifiedDiff } from './diff.js';
import {
  describeHealthRev,
  healthSignature,
  healthSubscriptionKey,
  isValidHealthTarget,
  readHealthSnapshot,
} from './health.js';
import { observeEntry } from './hook.js';
import { type ScriptRunner, scriptFlightKey, scriptSubscriptionKey } from './script.js';
import {
  type ChangeOrigin,
  type ReadRef,
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
  /**
   * live 配置 getter（q-subscription-script；q-doc-subscription-hot-gate 扩到自动订阅入口）：
   * allowlist / 调度 / cwd / maxFullBytes / stateDir 热改即时生效；缺省回落 install 快照。
   */
  liveConfig?: () => DocSubscriptionConfig;
  /** script 执行器（inspect 诊断 peek 用）；缺省 ⇒ 无在飞诊断 */
  runner?: ScriptRunner;
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

/**
 * live 配置求值（hot-gate 同族修复，q-doc-subscription-hot-gate）：getter 缺省 / 抛错 ⇒
 * 回落 install 快照。工具 handler 与自动订阅入口（autoSubscribePath / readSubscribePath）
 * 共用同一口径 —— 热改 cwd / maxFullBytes / stateDir / allowlist 在两条路都即时生效。
 */
function liveConfigOf(deps: SubscribeToolDeps): DocSubscriptionConfig {
  if (deps.liveConfig === undefined) return deps.config;
  try {
    return deps.liveConfig();
  } catch {
    return deps.config;
  }
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
      // origin/reads 像 snapshot 一样携带 existing：重复订阅不丢引用计数；
      // 来源升级由各入口决定（manual add 恒 manual / edit-write 升 edit / read 只在新建时置 read）。
      origin: existing?.origin ?? 'manual',
      reads: existing?.reads ?? [],
      ...(existing?.snapshot !== undefined ? { snapshot: existing.snapshot } : {}),
      // last_writer 像 snapshot 一样携带 existing：重复订阅 / read 追加不丢来源归因。
      ...(existing?.last_writer !== undefined ? { last_writer: existing.last_writer } : {}),
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
  const rawNode =
    typeof args.node === 'string' && args.node.trim() !== '' ? args.node.trim() : undefined;
  const rawName =
    typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined;
  const rawTarget =
    typeof args.target === 'string' && args.target.trim() !== '' ? args.target.trim() : undefined;

  if (
    id === undefined &&
    rawPath === undefined &&
    rawNode === undefined &&
    rawName === undefined &&
    rawTarget === undefined
  ) {
    return '错误：remove 需要 path、node、target、name 或 id。';
  }

  let key: string | undefined;
  if (id !== undefined) {
    key = Object.keys(state.subscriptions).find(
      (candidate) => state.subscriptions[candidate]?.id === id,
    );
    if (key === undefined) return `not_found: id=${id}`;
  } else if (rawNode !== undefined) {
    key = healthSubscriptionKey(rawNode);
  } else if (rawTarget !== undefined) {
    key = agentSubscriptionKey(rawTarget);
  } else if (rawName !== undefined) {
    key = scriptSubscriptionKey(rawName);
  } else if (rawPath !== undefined) {
    key = canonicalPath(resolve(rawPath));
  }

  if (key === undefined || state.subscriptions[key] === undefined) {
    return `not_found: ${rawPath ?? rawNode ?? rawTarget ?? rawName ?? id}`;
  }
  delete state.subscriptions[key];
  return `removed: ${key}`;
}

/** rev 的展示形态 */
function describeRev(rev: string): string {
  if (rev === '') return 'never';
  if (rev === 'deleted') return 'deleted';
  if (rev === 'empty') return 'empty';
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
    // health 条目（additive）：独立展示行；file 条目输出逐字节不变（零回归）。
    if (entry.source === 'health') {
      lines.push(
        `  ${entry.path} id=${entry.id} source=health rev=${describeHealthRev(entry.rev)} ${changeLabel}`,
      );
      continue;
    }
    // agent 条目（q-sub-unify-p1，additive）：活动签名展示行；muted/friend 标记 additive。
    if (entry.source === 'agent') {
      const marks = `${entry.muted === true ? ' muted' : ''}${entry.friend !== undefined ? ` friend=${entry.friend.origin}` : ''}`;
      lines.push(
        `  ${entry.path} id=${entry.id} source=agent rev=${describeAgentRev(entry.rev)}${marks} ${changeLabel}`,
      );
      continue;
    }
    // script 条目（additive）：执行事实行（last_exit / last_run）。
    if (entry.source === 'script') {
      const facts = entry.script;
      const exitLabel =
        facts === undefined
          ? 'never_run'
          : facts.last_exit === null
            ? facts.last_error !== undefined
              ? 'failed'
              : 'running'
            : String(facts.last_exit);
      const lastRun =
        facts !== undefined && facts.last_started_at > 0
          ? new Date(facts.last_started_at).toISOString()
          : 'never';
      lines.push(
        `  ${entry.path} id=${entry.id} source=script rev=${describeRev(entry.rev)} ` +
          `last_exit=${exitLabel} last_run=${lastRun} ${changeLabel}`,
      );
      continue;
    }
    const unread = entry.seen_rev === '' || entry.seen_rev !== entry.rev;
    lines.push(
      `  ${entry.path} id=${entry.id} rev=${describeRev(entry.rev)} ` +
        `seen=${describeRev(entry.seen_rev)} bytes=${entry.size} ` +
        `${changeLabel} ${unread ? 'unread' : 'read'}`,
    );
  }
  return lines.join('\n');
}

/** 找到 inspect 的条目 key；id 优先于 node / path */
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
  const rawNode =
    typeof args.node === 'string' && args.node.trim() !== '' ? args.node.trim() : undefined;
  if (rawNode !== undefined) return healthSubscriptionKey(rawNode);
  const rawTarget =
    typeof args.target === 'string' && args.target.trim() !== '' ? args.target.trim() : undefined;
  if (rawTarget !== undefined) return agentSubscriptionKey(rawTarget);
  const rawName =
    typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined;
  if (rawName !== undefined) return scriptSubscriptionKey(rawName);
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

/** 解析 health add 的输入目标列表（node + nodes，保持顺序） */
function collectNodeInputs(args: Record<string, unknown>): string[] {
  const inputs: string[] = [];
  const single = args.node;
  if (typeof single === 'string' && single.trim() !== '') inputs.push(single);
  const multiple = args.nodes;
  if (Array.isArray(multiple)) {
    for (const item of multiple) {
      if (typeof item === 'string') inputs.push(item);
    }
  }
  return inputs;
}

/**
 * 校验并构造 health 条目（q-health-subscription）。
 * 基线：快照文件已在 ⇒ rev = notified_rev = 当前签名（订阅时的状态不出卡，与文件
 * manual add 同语义）；快照缺失（watcher 尚未探测）⇒ rev=''，首次观察通知当前状态
 * （health 的「首次通知」是基线确立，文件的首次全文在 inspect，口径差异有意）。
 * 重复 add 保留已有游标（避免无谓重通知）。
 */
async function prepareHealthEntry(
  input: string,
  deps: SubscribeToolDeps,
  existing: SubscriptionEntry | undefined,
): Promise<AddOutcome> {
  const trimmed = input.trim();
  if (trimmed === '') return { input, reason: 'empty' };
  if (!isValidHealthTarget(trimmed)) return { input, reason: 'invalid_node_target' };

  const snapshot = await readHealthSnapshot(deps.config.stateDir, trimmed);
  const baseline = snapshot !== undefined ? healthSignature(snapshot) : '';
  return {
    input: trimmed,
    entry: {
      id: subscriptionId(trimmed),
      path: trimmed,
      input: trimmed,
      source: 'health',
      rev: existing?.rev ?? baseline,
      notified_rev: existing?.notified_rev ?? baseline,
      seen_rev: existing?.seen_rev ?? '',
      size: 0,
      mtime_ms: snapshot?.checked_at ?? 0,
      notified_at: existing?.notified_at ?? 0,
      seen_at: existing?.seen_at ?? 0,
      origin: 'manual',
      reads: [],
    },
  };
}

/** health inspect 的 XML 信封（与文件 inspect 同族；target 替代 path 属性） */
function healthInspectEnvelope(
  entry: SubscriptionEntry,
  attrs: Record<string, string>,
  body: string,
): string {
  const attrText = [
    `node="${escapeXmlAttr(entry.path)}"`,
    `id="${escapeXmlAttr(entry.id)}"`,
    ...Object.entries(attrs).map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`),
  ].join(' ');
  return `<subscription-inspect ${attrText}>\n${body}\n</subscription-inspect>`;
}

/**
 * 显式读取 health 订阅快照：返回宿主最近一次探测的事实（reachable / version /
 * started_at / node_id / name / checked_at / error）。成功返回才推进 seen_rev
 * （与文件 inspect 同口径）；快照缺失不推进任何游标。
 */
async function inspectHealth(
  state: SessionSubscriptionState,
  args: Record<string, unknown>,
  deps: SubscribeToolDeps,
  now: number,
): Promise<InspectOutcome> {
  const key = resolveKey(state, args, deps);
  if (key === undefined || state.subscriptions[key] === undefined) {
    return { output: 'not_found: inspect 需要已订阅的 node 或 id。', changed: false };
  }
  const entry = state.subscriptions[key];
  if (entry === undefined) return { output: 'not_found', changed: false };

  const snapshot = await readHealthSnapshot(deps.config.stateDir, entry.path);
  if (snapshot === undefined) {
    return {
      output: healthInspectEnvelope(
        entry,
        { status: 'no_snapshot' },
        'No health snapshot yet; the host health watcher has not probed this node.',
      ),
      changed: false,
    };
  }

  const rev = healthSignature(snapshot);
  const attrs: Record<string, string> = {
    rev,
    status: snapshot.reachable ? 'up' : 'down',
    change: entry.seen_rev === rev ? 'none' : 'full',
  };
  if (snapshot.version !== undefined) attrs.version = snapshot.version;
  if (snapshot.started_at !== undefined) attrs.started_at = String(snapshot.started_at);
  if (snapshot.node_id !== undefined) attrs.node_id = snapshot.node_id;
  if (snapshot.name !== undefined) attrs.name = snapshot.name;
  if (snapshot.error !== undefined) attrs.error = snapshot.error;

  const lines: string[] = [
    `target: ${snapshot.target}`,
    `reachable: ${snapshot.reachable ? 'yes' : 'no'}`,
  ];
  if (snapshot.node_id !== undefined) lines.push(`node_id: ${snapshot.node_id}`);
  if (snapshot.name !== undefined) lines.push(`name: ${snapshot.name}`);
  if (snapshot.version !== undefined) lines.push(`version: ${snapshot.version}`);
  if (snapshot.started_at !== undefined) {
    lines.push(
      `started_at: ${snapshot.started_at} (${new Date(snapshot.started_at).toISOString()})`,
    );
  }
  if (snapshot.pid !== undefined) lines.push(`pid: ${snapshot.pid}`);
  if (snapshot.via !== undefined) lines.push(`via: ${snapshot.via}`);
  lines.push(`checked_at: ${snapshot.checked_at} (${new Date(snapshot.checked_at).toISOString()})`);
  if (snapshot.error !== undefined) lines.push(`error: ${snapshot.error}`);

  state.subscriptions[key] = {
    ...entry,
    rev,
    notified_rev: rev,
    seen_rev: rev,
    mtime_ms: snapshot.checked_at,
    seen_at: now,
    notified_at: entry.notified_rev === rev ? entry.notified_at : now,
  };
  return { output: healthInspectEnvelope(entry, attrs, lines.join('\n')), changed: true };
}

/** 解析 agent add 的输入目标列表（target + targets，保持顺序；q-sub-unify-p1） */
function collectAgentInputs(args: Record<string, unknown>): string[] {
  const inputs: string[] = [];
  const single = args.target;
  if (typeof single === 'string' && single.trim() !== '') inputs.push(single);
  const multiple = args.targets;
  if (Array.isArray(multiple)) {
    for (const item of multiple) {
      if (typeof item === 'string') inputs.push(item);
    }
  }
  return inputs;
}

/**
 * 校验并构造 agent 条目（q-sub-unify-p1，照抄 prepareHealthEntry）。
 * 基线：快照已在 ⇒ rev = notified_rev = 当前签名；快照缺失（watcher 尚未落 /
 * private fail-closed）⇒ rev=''，首次观察通知当前状态。重复 add 保留已有游标。
 * 已有 friend 块 / muted / origin 保留（好友边是成员级事实，不被手动 add 覆盖）。
 */
async function prepareAgentEntry(
  input: string,
  deps: SubscribeToolDeps,
  existing: SubscriptionEntry | undefined,
): Promise<AddOutcome> {
  const trimmed = input.trim();
  if (trimmed === '') return { input, reason: 'empty' };
  if (!isValidAgentTarget(trimmed)) return { input, reason: 'invalid_agent_target' };

  const snapshot = await readAgentSnapshot(deps.config.stateDir, trimmed);
  const baseline = snapshot !== undefined ? agentSignature(snapshot) : '';
  return {
    input: trimmed,
    entry: {
      id: subscriptionId(trimmed),
      path: trimmed,
      input: trimmed,
      source: 'agent',
      rev: existing?.rev ?? baseline,
      notified_rev: existing?.notified_rev ?? baseline,
      seen_rev: existing?.seen_rev ?? '',
      size: 0,
      mtime_ms: snapshot?.checked_at ?? 0,
      notified_at: existing?.notified_at ?? 0,
      seen_at: existing?.seen_at ?? 0,
      origin: existing?.origin ?? 'manual',
      reads: [],
      ...(existing?.muted === true ? { muted: true } : {}),
      ...(existing?.friend !== undefined ? { friend: existing.friend } : {}),
    },
  };
}

/** agent inspect 的 XML 信封（与 health inspect 同族；target 替代 node 属性） */
function agentInspectEnvelope(
  entry: SubscriptionEntry,
  attrs: Record<string, string>,
  body: string,
): string {
  const attrText = [
    `agent="${escapeXmlAttr(entry.path)}"`,
    `id="${escapeXmlAttr(entry.id)}"`,
    ...Object.entries(attrs).map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`),
  ].join(' ');
  return `<subscription-inspect ${attrText}>\n${body}\n</subscription-inspect>`;
}

/**
 * 显式读取 agent 订阅快照：返回宿主最近一次折叠的活动事实（state / presence /
 * role / last_run_ts / name / team_id / checked_at）。成功返回才推进 seen_rev；
 * 快照缺失不推进任何游标（照抄 inspectHealth）。
 */
async function inspectAgent(
  state: SessionSubscriptionState,
  args: Record<string, unknown>,
  deps: SubscribeToolDeps,
  now: number,
): Promise<InspectOutcome> {
  const key = resolveKey(state, args, deps);
  if (key === undefined || state.subscriptions[key] === undefined) {
    return { output: 'not_found: inspect 需要已订阅的 agent 或 id。', changed: false };
  }
  const entry = state.subscriptions[key];
  if (entry === undefined) return { output: 'not_found', changed: false };

  const snapshot = await readAgentSnapshot(deps.config.stateDir, entry.path);
  if (snapshot === undefined) {
    return {
      output: agentInspectEnvelope(
        entry,
        { status: 'no_snapshot' },
        'No activity snapshot yet; the host agent watcher has not observed this member (private members never produce snapshots).',
      ),
      changed: false,
    };
  }

  const rev = agentSignature(snapshot);
  const attrs: Record<string, string> = {
    rev,
    state: snapshot.state ?? '-',
    change: entry.seen_rev === rev ? 'none' : 'full',
  };
  if (snapshot.presence !== undefined) attrs.presence = snapshot.presence;
  if (snapshot.role !== undefined) attrs.role = snapshot.role;
  if (snapshot.last_run_ts !== undefined) attrs.last_run_ts = String(snapshot.last_run_ts);
  if (snapshot.name !== undefined) attrs.name = snapshot.name;
  if (snapshot.team_id !== undefined) attrs.team_id = snapshot.team_id;

  const lines: string[] = [`target: ${snapshot.target}`];
  if (snapshot.name !== undefined) lines.push(`name: ${snapshot.name}`);
  if (snapshot.team_id !== undefined) lines.push(`team_id: ${snapshot.team_id}`);
  if (snapshot.visibility !== undefined) lines.push(`visibility: ${snapshot.visibility}`);
  lines.push(`state: ${snapshot.state ?? '-'}`);
  lines.push(`presence: ${snapshot.presence ?? '-'}`);
  lines.push(`role: ${snapshot.role ?? '-'}`);
  if (snapshot.last_run_ts !== undefined) {
    lines.push(
      `last_run_ts: ${snapshot.last_run_ts} (${new Date(snapshot.last_run_ts).toISOString()})`,
    );
  }
  if (snapshot.last_event_type !== undefined)
    lines.push(`last_event_type: ${snapshot.last_event_type}`);
  if (snapshot.via !== undefined) lines.push(`via: ${snapshot.via}`);
  lines.push(`checked_at: ${snapshot.checked_at} (${new Date(snapshot.checked_at).toISOString()})`);
  if (entry.friend !== undefined) {
    lines.push(
      `friend: origin=${entry.friend.origin} since=${entry.friend.since}${entry.friend.nick !== undefined ? ` nick=${entry.friend.nick}` : ''}`,
    );
  }

  state.subscriptions[key] = {
    ...entry,
    rev,
    notified_rev: rev,
    seen_rev: rev,
    mtime_ms: snapshot.checked_at,
    seen_at: now,
    notified_at: entry.notified_rev === rev ? entry.notified_at : now,
  };
  return { output: agentInspectEnvelope(entry, attrs, lines.join('\n')), changed: true };
}

/** 解析 script add 的输入名列表（name + names，保持顺序） */
function collectNameInputs(args: Record<string, unknown>): string[] {
  const inputs: string[] = [];
  const single = args.name;
  if (typeof single === 'string' && single.trim() !== '') inputs.push(single);
  const multiple = args.names;
  if (Array.isArray(multiple)) {
    for (const item of multiple) {
      if (typeof item === 'string') inputs.push(item);
    }
  }
  return inputs;
}

/**
 * 校验并构造 script 条目（q-subscription-script，设计 §2.7 fail-closed）：
 * 名字必须合法且在 **live allowlist**（用户配置 plugins.doc-subscription.config.scripts）
 * 里 —— 模型只能按名订阅已声明的脚本，不能注入 / 修改命令。
 * 基线：rev=''（首次成功输出全量投递，裁点 2：存量问题立刻可见；不同于 file/health
 * 的订阅时基线抑制）。重复 add 保留已有游标 / snapshot / 执行事实。
 */
function prepareScriptEntry(
  input: string,
  config: DocSubscriptionConfig,
  existing: SubscriptionEntry | undefined,
): AddOutcome {
  const trimmed = input.trim();
  if (trimmed === '') return { input, reason: 'empty' };
  if (!isValidScriptName(trimmed)) return { input, reason: 'invalid_script_name' };
  if (!config.scripts.some((spec) => spec.name === trimmed)) {
    return { input, reason: 'not_in_allowlist' };
  }
  return {
    input: trimmed,
    entry: {
      id: subscriptionId(trimmed),
      path: trimmed,
      input: trimmed,
      source: 'script',
      rev: existing?.rev ?? '',
      notified_rev: existing?.notified_rev ?? '',
      seen_rev: existing?.seen_rev ?? '',
      size: existing?.size ?? 0,
      mtime_ms: existing?.mtime_ms ?? 0,
      notified_at: existing?.notified_at ?? 0,
      seen_at: existing?.seen_at ?? 0,
      origin: 'manual',
      reads: [],
      ...(existing?.snapshot !== undefined ? { snapshot: existing.snapshot } : {}),
      ...(existing?.script !== undefined ? { script: existing.script } : {}),
    },
  };
}

/** script inspect 的 XML 信封（与 file / health 同族；name 替代 path 属性） */
function scriptInspectEnvelope(
  entry: SubscriptionEntry,
  attrs: Record<string, string>,
  body: string,
): string {
  const attrText = [
    `name="${escapeXmlAttr(entry.path)}"`,
    `id="${escapeXmlAttr(entry.id)}"`,
    ...Object.entries(attrs).map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`),
  ].join(' ');
  return `<subscription-inspect ${attrText}>\n${body}\n</subscription-inspect>`;
}

/**
 * 显式读取 script 订阅：返回最近一次成功 stdout 全文（设计 §2.6：通知只带 diff /
 * 摘要，全文在 inspect）+ 执行事实（last_exit / duration / schedule / output）。
 * 成功返回才推进 seen_rev（与 file / health 同口径）；无输出不推进。
 * 命令本体来自 live allowlist（只读展示；模型不能经工具修改）。
 */
function inspectScript(
  state: SessionSubscriptionState,
  args: Record<string, unknown>,
  deps: SubscribeToolDeps,
  config: DocSubscriptionConfig,
  now: number,
): InspectOutcome {
  const key = resolveKey(state, args, deps);
  if (key === undefined || state.subscriptions[key] === undefined) {
    return { output: 'not_found: inspect 需要已订阅的 name 或 id。', changed: false };
  }
  const entry = state.subscriptions[key];
  if (entry === undefined || entry.source !== 'script') {
    return { output: 'not_found', changed: false };
  }
  const spec = config.scripts.find((candidate) => candidate.name === entry.path);
  const facts = entry.script;
  const attrs: Record<string, string> = {
    rev:
      entry.rev === ''
        ? 'never'
        : entry.rev === 'empty'
          ? 'empty'
          : `sha256:${entry.rev.slice(0, 12)}`,
    exit:
      facts === undefined
        ? 'never_run'
        : facts.last_exit === null
          ? facts.last_error !== undefined
            ? 'failed'
            : 'running'
          : String(facts.last_exit),
  };
  if (spec !== undefined) {
    attrs.schedule =
      typeof spec.schedule === 'object'
        ? `interval:${spec.schedule.intervalSeconds}s`
        : spec.schedule;
    attrs.output = spec.output;
  } else {
    attrs.status = 'not_in_allowlist';
  }

  const factLines: string[] = [];
  if (facts !== undefined) {
    const exitText =
      facts.last_exit === null
        ? facts.last_error !== undefined
          ? 'failed'
          : 'running'
        : String(facts.last_exit);
    factLines.push(`last_exit: ${exitText}`);
    factLines.push(`last_duration_ms: ${facts.last_duration_ms}`);
    if (facts.last_started_at > 0) {
      factLines.push(
        `last_started_at: ${facts.last_started_at} (${new Date(facts.last_started_at).toISOString()})`,
      );
    }
    if (facts.last_error !== undefined) factLines.push(`last_error: ${facts.last_error}`);
  }
  if (spec !== undefined) factLines.push(`command: ${JSON.stringify(spec.command)}`);
  const inFlight = deps.runner?.isInFlight(scriptFlightKey(state.session_id, entry.path)) ?? false;
  if (inFlight) factLines.push('status: running (a new execution is in flight)');

  // 无全文可给：从未完成 / 空输出 / 超 maxFullBytes 未存 snapshot。
  if (entry.snapshot === undefined) {
    const body =
      entry.rev === 'empty'
        ? 'Script produced no output (empty = no issues).'
        : entry.rev === ''
          ? 'No output yet; the script has not completed a run.'
          : `Output is ${entry.size} bytes (over the full-content limit); use bash to run the script directly.`;
    return {
      output: scriptInspectEnvelope(entry, attrs, [...factLines, body].join('\n')),
      changed: false,
    };
  }

  state.subscriptions[key] = { ...entry, seen_rev: entry.rev, seen_at: now };
  const body = [...factLines, '', entry.snapshot].join('\n');
  return {
    output: scriptInspectEnvelope(entry, { ...attrs, change: 'full' }, body),
    changed: true,
  };
}

/** 构造 subscribe 工具 */
export function createSubscribeTool(deps: SubscribeToolDeps): ToolDefinition {
  return {
    name: 'subscribe',
    description:
      'Manage per-session subscriptions. add/remove/list/inspect concrete files; ' +
      'changes produce a short notice, and inspect returns the diff (full content on first read). ' +
      'edit/write auto-subscribe the files they touch (subscribe:false on those tools opts out); ' +
      'read auto-subscribes the line ranges it reads (subscribe:false on read opts out). ' +
      'source:"health" subscribes a node\'s health instead of a file: node is a local node_id ' +
      'or a federation address <principal>@<node_id>:<team_id>; reachability flips, version ' +
      'changes and restarts (started_at) produce a health notice, inspect returns the snapshot. ' +
      'source:"script" subscribes a detection script declared in the user config allowlist ' +
      '(plugins.doc-subscription.config.scripts): name must match a declared script (you cannot ' +
      'add or change commands); its stdout changes produce a script notice (empty output = no ' +
      'notice), inspect returns the latest full output. ' +
      'source:"agent" subscribes a member\'s activity instead of a file: target is a local ' +
      'agent_id or a federation address <principal>@<node_id>:<team_id>; state/presence flips, ' +
      'role changes and run completions produce an agent notice, inspect returns the activity ' +
      'snapshot (private members never produce snapshots). ' +
      'use remove to clear subscriptions you no longer need (e.g. when switching tasks).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'list', 'inspect'],
          description: 'add | remove | list | inspect (default list)',
        },
        source: {
          type: 'string',
          enum: ['file', 'health', 'script', 'agent'],
          description: 'Subscription source type (add only; default file)',
        },
        path: { type: 'string', description: 'Single file path (add / remove / inspect)' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple file paths (add only)',
        },
        node: {
          type: 'string',
          description:
            'Single node target (source:health add / remove / inspect): local node_id or <principal>@<node_id>:<team_id>',
        },
        nodes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple node targets (source:health add only)',
        },
        target: {
          type: 'string',
          description:
            'Single agent target (source:agent add / remove / inspect): local agent_id or <principal>@<node_id>:<team_id>',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple agent targets (source:agent add only)',
        },
        name: {
          type: 'string',
          description:
            'Single script name (source:script add / remove / inspect): must be declared in the user config allowlist',
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple script names (source:script add only)',
        },
        id: { type: 'string', description: 'Subscription id (remove / inspect)' },
      },
    },
    display: { label: 'Subscribe', kind: 'generic' },
    // 校验全部在 handler；工具不写日志
    checkPermission: async () => 'allow',
    handler: async (args: unknown, ctx: ToolContext): Promise<string> => {
      if (!isRecord(args)) return '错误：subscribe 需要 { action }';
      // 零参 peek 范式（对齐 skills/recall）：缺省 action = list，只读计数不消费。
      const action = args.action ?? 'list';
      if (action !== 'add' && action !== 'remove' && action !== 'list' && action !== 'inspect') {
        return '错误：action 必须是 add / remove / list / inspect。';
      }

      const sessionId = ctx.session_id ?? 'default';
      // live 配置（q-subscription-script）：allowlist / 调度每次调用求值，热改即时生效。
      const config = liveConfigOf(deps);
      const effectiveDeps: SubscribeToolDeps = { ...deps, config };
      let state: SessionSubscriptionState;
      try {
        state = await deps.store.load(sessionId);
      } catch {
        return '错误：读取订阅状态失败。';
      }

      if (action === 'list') return formatList(state);

      if (action === 'inspect') {
        // health / script 源（additive）：按条目 source 分派；file 路径逐字节不变。
        const inspectKey = resolveKey(state, args, effectiveDeps);
        const inspectSource =
          inspectKey !== undefined ? state.subscriptions[inspectKey]?.source : undefined;
        const outcome =
          inspectSource === 'health'
            ? await inspectHealth(state, args, effectiveDeps, Date.now())
            : inspectSource === 'agent'
              ? await inspectAgent(state, args, effectiveDeps, Date.now())
              : inspectSource === 'script'
                ? inspectScript(state, args, effectiveDeps, config, Date.now())
                : await inspectSubscription(state, args, effectiveDeps, Date.now());
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
          (typeof args.node !== 'string' || args.node.trim() === '') &&
          (typeof args.target !== 'string' || args.target.trim() === '') &&
          (typeof args.name !== 'string' || args.name.trim() === '') &&
          (typeof args.id !== 'string' || args.id.trim() === '')
        ) {
          return '错误：remove 需要 path、node、target、name 或 id。';
        }
        const result = formatRemove(state, args, (input) => resolveInput(config, input));
        if (result.startsWith('removed:')) {
          // script 源 remove ⇒ disarm interval 真 timer（q-subscription-script-p1；
          // 在飞进程不杀，受各自超时闸约束，结果丢一次可接受——订阅已删不再 drain）。
          const removedKey = result.slice('removed: '.length);
          if (removedKey.startsWith('script:')) {
            deps.runner?.disarmInterval(
              scriptFlightKey(sessionId, removedKey.slice('script:'.length)),
            );
          }
          try {
            await deps.store.save(state);
          } catch {
            return '错误：保存订阅状态失败。';
          }
        }
        return result;
      }

      // add：source 泛化（q-health-subscription / q-subscription-script / q-sub-unify-p1）——
      // 缺省 'file'（零回归）；'health' 走 node/nodes；'script' 走 name/names；'agent' 走 target/targets。
      const source = args.source ?? 'file';
      if (source !== 'file' && source !== 'health' && source !== 'script' && source !== 'agent') {
        return '错误：source 必须是 file / health / script / agent。';
      }

      if (source === 'agent') {
        const inputs = collectAgentInputs(args);
        if (inputs.length === 0) return '错误：source:agent add 需要 target 或 targets。';
        const added: SubscriptionEntry[] = [];
        const rejected: Array<{ input: string; reason: string }> = [];
        const seen = new Set<string>();
        for (const input of inputs) {
          const target = input.trim();
          if (seen.has(target)) continue;
          seen.add(target);
          const key = agentSubscriptionKey(target);
          const outcome = await prepareAgentEntry(target, deps, state.subscriptions[key]);
          if (outcome.entry === undefined) {
            rejected.push({ input: outcome.input, reason: outcome.reason ?? 'invalid' });
            continue;
          }
          state.subscriptions[key] = outcome.entry;
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
          for (const entry of added) {
            const friendMark = entry.friend !== undefined ? ` (friend=${entry.friend.origin})` : '';
            lines.push(`  ${entry.path} (agent)${friendMark}`);
          }
          lines.push(
            'Activity changes (state / presence / role / run completion) will produce a short notice; ' +
              'use action "inspect" to view the activity snapshot.',
          );
        }
        if (rejected.length > 0) {
          lines.push(`rejected ${rejected.length}:`);
          for (const item of rejected) lines.push(`  ${item.reason}: ${item.input}`);
        }
        return lines.join('\n');
      }

      if (source === 'script') {
        const inputs = collectNameInputs(args);
        if (inputs.length === 0) return '错误：source:script add 需要 name 或 names。';
        const added: SubscriptionEntry[] = [];
        const rejected: Array<{ input: string; reason: string }> = [];
        const seen = new Set<string>();
        for (const input of inputs) {
          const name = input.trim();
          if (seen.has(name)) continue;
          seen.add(name);
          const key = scriptSubscriptionKey(name);
          const outcome = prepareScriptEntry(name, config, state.subscriptions[key]);
          if (outcome.entry === undefined) {
            rejected.push({ input: outcome.input, reason: outcome.reason ?? 'invalid' });
            continue;
          }
          state.subscriptions[key] = outcome.entry;
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
          for (const entry of added) lines.push(`  ${entry.path} (script)`);
          lines.push(
            'Script output changes will produce a short notice (empty output = no notice); ' +
              'use action "inspect" to view the latest full output.',
          );
        }
        if (rejected.length > 0) {
          lines.push(`rejected ${rejected.length}:`);
          for (const item of rejected) lines.push(`  ${item.reason}: ${item.input}`);
          lines.push(
            'not_in_allowlist: only scripts declared in plugins.doc-subscription.config.scripts ' +
              'can be subscribed; ask the user to declare the script in config.',
          );
        }
        return lines.join('\n');
      }

      if (source === 'health') {
        const inputs = collectNodeInputs(args);
        if (inputs.length === 0) return '错误：source:health add 需要 node 或 nodes。';
        const added: SubscriptionEntry[] = [];
        const rejected: Array<{ input: string; reason: string }> = [];
        const seen = new Set<string>();
        for (const input of inputs) {
          const target = input.trim();
          if (seen.has(target)) continue;
          seen.add(target);
          const key = healthSubscriptionKey(target);
          // live deps（hot-gate 残留修复）：stateDir 热改后基线快照读新目录，与 inspect 同口径。
          const outcome = await prepareHealthEntry(target, effectiveDeps, state.subscriptions[key]);
          if (outcome.entry === undefined) {
            rejected.push({ input: outcome.input, reason: outcome.reason ?? 'invalid' });
            continue;
          }
          state.subscriptions[key] = outcome.entry;
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
          for (const entry of added) lines.push(`  ${entry.path} (health)`);
          lines.push(
            'Health changes (reachability / version / restart) will produce a short notice; ' +
              'use action "inspect" to view the snapshot.',
          );
        }
        if (rejected.length > 0) {
          lines.push(`rejected ${rejected.length}:`);
          for (const item of rejected) lines.push(`  ${item.reason}: ${item.input}`);
        }
        return lines.join('\n');
      }

      // add（file）
      const inputs = collectAddInputs(args);
      if (inputs.length === 0) return '错误：add 需要 path 或 paths。';

      const added: SubscriptionEntry[] = [];
      const rejected: Array<{ input: string; reason: string }> = [];
      const seen = new Set<string>();

      for (const input of inputs) {
        const existingCanonical = canonicalPath(resolveInput(config, input.trim()));
        if (seen.has(existingCanonical)) continue;
        seen.add(existingCanonical);

        // live deps（hot-gate 残留修复）：cwd 热改后条目解析与上方 dedup 键同一份活配置，
        // 不再「dedup 用 live、落盘用快照」分裂出两条不同 canonical 的重复条目。
        const outcome = await prepareEntry(
          input,
          effectiveDeps,
          state.subscriptions[existingCanonical] ?? undefined,
        );
        if (outcome.entry === undefined) {
          rejected.push({ input: outcome.input, reason: outcome.reason ?? 'invalid' });
          continue;
        }
        // manual add 恒置 'manual'（升级梯顶端：永不自过期）；reads 引用计数保留。
        outcome.entry.origin = 'manual';
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

/**
 * 自动订阅入口（edit/write AfterTool hook 用，蜂群 Phase 1 第二重保险）。
 * 复用 prepareEntry（边界 / 大小 / 敏感判定与手动 add 同口径）；成功后把当前观察记为
 * **基线**（rev = notified_rev）：自己刚做的改动不出卡，只有他人再改（rev 不同）才通知。
 * seen_rev 保持 ''（模型尚未 inspect）。任何拒绝（deny / 越界 / 不存在 / 过大 / 敏感）静默跳过。
 * 返回是否写入了状态（无变化不写盘）。
 */
/**
 * edit/write 来源事实（AfterTool hook 从 HookContext 取，设计 §2.2）。
 * 缺省（旧 caller / 装配未填）⇒ 不标 last_writer、cwd 回退 config.cwd（现状基线，零回归）。
 */
export interface WriteOrigin {
  tool: 'edit' | 'write';
  /** 成员 id（HookContext.agent_id）；缺省 ⇒ last_writer.member_id 缺省，抑制回退 session_id 判等 */
  member_id?: string;
  /** 成员实际 cwd（HookContext.cwd）；缺省回退 config.cwd（现状） */
  cwd?: string;
}

/** last_writer 实质判等：ts 只作诊断不参与（同 rev/成员/工具/session ⇒ 抑制语义相同） */
function sameOrigin(a: ChangeOrigin | undefined, b: ChangeOrigin | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.rev === b.rev &&
    a.member_id === b.member_id &&
    a.tool === b.tool &&
    a.session_id === b.session_id
  );
}

export async function autoSubscribePath(
  deps: SubscribeToolDeps,
  sessionId: string,
  rawPath: string,
  origin?: WriteOrigin,
): Promise<boolean> {
  const trimmed = rawPath.trim();
  if (trimmed === '') return false;
  // live 配置（hot-gate 残留修复）：自动订阅与手动 add 同口径读活配置（cwd / maxFullBytes
  // 热改即时生效）；洞1 修复不变：成员实际 cwd 优先（HookContext.cwd），缺省回退活 config.cwd。
  const base = liveConfigOf(deps);
  const config = origin?.cwd !== undefined ? { ...base, cwd: origin.cwd } : base;
  const effectiveDeps: SubscribeToolDeps = { ...deps, config };
  const canonical = canonicalPath(resolveInput(config, trimmed));
  let wrote = false;
  // 原子读改写（设计 §2.2 修洞 3）：load→改→save 整段在 per-session 串行链内，并发批不丢更新。
  await deps.store.mutate(
    sessionId,
    async (state) => {
      const existing = state.subscriptions[canonical] ?? undefined;
      const outcome = await prepareEntry(trimmed, effectiveDeps, existing);
      if (outcome.entry === undefined) return undefined;
      const entry = outcome.entry;
      // 升级梯 manual > edit > read：manual 不降级；read 条目被 edit/write 触碰升为 'edit'
      // （清除后不再自过期）；新建置 'edit'。
      entry.origin = existing?.origin === 'manual' ? 'manual' : 'edit';

      const observation = await observeEntry(entry, effectiveDeps);
      if (observation !== undefined) {
        entry.rev = observation.rev;
        entry.size = observation.size;
        entry.mtime_ms = observation.mtime_ms;
        // 基线抑制：该 rev 视为「已通知」，自己刚做的改动不出卡；他人再改时 BeforeLlm 才通知。
        entry.notified_rev = observation.rev;
        entry.notified_at = Date.now();
        // 来源标记（设计 §2.2）：基线化同时记 last_writer；origin 缺省（旧 caller）不标。
        if (origin !== undefined) {
          entry.last_writer = {
            session_id: sessionId,
            ...(origin.member_id !== undefined ? { member_id: origin.member_id } : {}),
            tool: origin.tool,
            ts: Date.now(),
            rev: observation.rev,
          };
        }
      }

      if (
        existing !== undefined &&
        existing.rev === entry.rev &&
        existing.notified_rev === entry.notified_rev &&
        existing.seen_rev === entry.seen_rev &&
        existing.size === entry.size &&
        existing.mtime_ms === entry.mtime_ms &&
        // origin 升级（read → edit）也算变化；reads 原样携带不改，无需比较。
        existing.origin === entry.origin &&
        // last_writer 实质判等（ts 除外）：同来源同内容重触不写盘。
        sameOrigin(existing.last_writer, entry.last_writer)
      ) {
        return undefined; // 无变化不写盘
      }
      state.subscriptions[entry.path] = entry;
      wrote = true;
      return state;
      // 成员指针（§2.6）：edit/write 落盘同步更新（origin.member_id 可得时）。
    },
    origin?.member_id,
  );
  return wrote;
}

/** 从记录读取有限数字（镜像 basic-tools readNumber：非有限数字 ⇒ undefined ⇒ 走缺省） */
function readRequestNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * read 自动订阅入口（line-level，蜂群协作增强；AfterTool hook 用）。
 *
 * 口径（CONTRACT-swarm-subscribe §0/§2）：
 * - **attempt-based + 自然成功近似**：offset/limit 校验镜像 read 工具，clamp 校验天然滤掉
 *   失败 read（不存在 / 目录 / 二进制 / 超 8MiB / offset>total / 非法 offset、limit ⇒ 不订阅）。
 * - **clamp 范围 = 请求范围 ∩ 文件实际行数**，是实际返回范围的超集（token 闸只裁不增）⇒
 *   只会多通知不会漏通知。诚实标注：clamp 用 AfterTool 时刻的文件行数，read 执行与 hook
 *   之间文件被改有小竞态，由观察期内容锚重定位兜底。
 * - 行切分用 basic-tools 导出的 splitLines（与 read 工具行号逐字同源）。
 * - 已有条目：只追加 ReadRef，**不动 rev/notified_rev/seen_rev 任何游标**（保留待发通知；
 *   ref.text = 当前内容 ⇒ 范围级天然基线抑制）。
 * - 新条目：prepareEntry 全套边界/敏感校验 + origin='read' + 基线抑制（notified_rev=当前
 *   观察 rev，autoSubscribePath 同款）；seen_rev=''。
 * - best-effort：任何失败静默跳过；无变化不写盘。
 * - 相对路径按成员实际 cwd 归一化（HookContext.cwd，P1 修洞1）；装配未填时回退 config.cwd（现状）。
 * 返回是否写入了状态。
 */
export async function readSubscribePath(
  deps: SubscribeToolDeps,
  sessionId: string,
  args: Record<string, unknown>,
  cwd?: string,
  memberId?: string,
): Promise<boolean> {
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  if (rawPath === '') return false;

  // offset/limit 校验镜像 read（basic-tools readFileSlice）：非法 ⇒ 该 read 本身已失败，不订阅。
  const offset = readRequestNumber(args, 'offset') ?? 1;
  if (!Number.isInteger(offset) || offset < 1) return false;
  const limit = readRequestNumber(args, 'limit') ?? DEFAULT_READ_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return false;

  // live 配置（hot-gate 残留修复）：与 autoSubscribePath / 手动 add 同口径读活配置；
  // 洞1 修复不变：成员实际 cwd 优先（HookContext.cwd），缺省回退活 config.cwd。
  const base = liveConfigOf(deps);
  const config = cwd !== undefined ? { ...base, cwd } : base;
  const canonical = canonicalPath(resolveInput(config, rawPath));
  // 边界前置（observeEntry / prepareEntry 同口径）：deny/ask 的 read 本身已失败，不订阅；
  // 也避免热应用收紧边界后仍把已拒路径的字节读进引用。
  if (evaluatePath(canonical, deps.boundary) !== 'allow') return false;

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(canonical);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  if (info.size > MAX_SUBSCRIBE_BYTES) return false;
  let buffer: Buffer;
  try {
    buffer = await readFile(canonical);
  } catch {
    return false;
  }
  if (buffer.includes(0)) return false;

  const lines = splitLines(buffer.toString('utf-8'));
  const total = lines.length;
  if (offset > total) return false; // 含空文件（total=0）
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const ref: ReadRef = { offset, limit, start: offset, end: offset - 1 + slice.length };
  const rangeText = slice.join('\n');
  // 仅当字节数 ≤ maxFullBytes 才存 text；存不下 ⇒ 无 text 的 ref（仍计引用，观察时整文件兜底）。
  if (Buffer.byteLength(rangeText, 'utf-8') <= config.maxFullBytes) ref.text = rangeText;

  // 原子读改写（设计 §2.2 修洞 3）：read 只追加引用 / 新建条目，不记 last_writer（read 非编辑）。
  let wrote = false;
  await deps.store.mutate(
    sessionId,
    async (state) => {
      const existing = state.subscriptions[canonical];
      if (existing !== undefined) {
        existing.reads.push(ref);
        wrote = true;
        return state;
      }

      const outcome = await prepareEntry(rawPath, { ...deps, config }, undefined);
      if (outcome.entry === undefined) return undefined;
      const entry = outcome.entry;
      entry.origin = 'read';
      entry.reads = [ref];
      // 基线抑制：订阅时的观察视为「已通知」，read 本身不出卡；他人再改才通知。
      // rev 直接用刚读 buffer 的 hash（与 observeEntry 同口径），避免二次整文件读。
      entry.rev = sha256Hex(buffer);
      entry.notified_rev = entry.rev;
      entry.notified_at = Date.now();
      entry.size = buffer.byteLength;
      entry.mtime_ms = info.mtimeMs;
      state.subscriptions[entry.path] = entry;
      wrote = true;
      return state;
      // 成员指针（§2.6）：read 订阅落盘同步更新（memberId 可得时；read 不记 last_writer）。
    },
    memberId,
  );
  return wrote;
}
