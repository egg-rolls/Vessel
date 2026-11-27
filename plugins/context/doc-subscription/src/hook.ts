/**
 * @vessel-agent/doc-subscription - BeforeLlm 变更通知
 * @module @vessel-agent/doc-subscription/hook
 *
 * 默认每个 run 的第一次 BeforeLlm 检查一次订阅文件（`envGranularity.files='request'` 时
 * 每请求检查），向 `ctx.messages` 追加一条
 * **只含元数据**的持久化尾部消息（`role: user` + `name: 'vessel:notice'`，正文首行
 * `files: …`，明细行 `  · …`），不改写 system、不再经 `HookResult.additionalContext` 注入。
 *
 * 为什么走 `vessel:notice` 而不是自造一个 kind（0.51 及以前是 `vessel:subscription`）：
 * 「模型需要知道的改变」只有一类东西 —— 环境信息（同一通道、同一张 Web 卡，scope 决定
 * 卡头标签）。文件变更就是其中一个 scope（`files`），自造 kind 等于在模型上下文里开第二种
 * 卡片形态。代价是**可见性变了**：以前订阅通知跟随 `ui.showInternalEvents`（默认隐藏），
 * 现在默认可见、渲染成「文件变更」环境卡 —— 这是有意的（订阅是用户自己开的）。老会话里的
 * `vessel:subscription` 消息不做特判，走「未登记 kind」的兜底渲染，仍是可读卡。
 *
 * - 通知默认只列 path、id、rev、bytes；**有 read 引用的条目**走 line-level 观察：
 *   内容锚重定位 + 范围 diff，第一个（path 序）line-level 变化条目可带 `  · <diff line>`
 *   明细行（行/字节预算见 notice.ts）；任一 ref 无 text / 锚歧义 / diff 超限 ⇒ 整文件兜底。
 * - 通知写入后推进 `notified_rev`，同一 rev 不再重复通知；全部 ref 未变 ⇒ 只刷新观察值，
 *   notified_rev 不动（下 run 幂等重查）。
 * - 整文件正文只在模型显式调用 `subscribe inspect` 时返回，届时才推进 `seen_rev`。
 * - 观察循环前先消费会话壳清除集合（lifecycle.ts，每 run 一次）：read 引用释放 / 过期；
 *   与观察循环合并落盘（每 run 一次 load/save）。
 * - 文件正文不进入 trace / 日志（插件不主动写）。
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { evaluatePath, type PathBoundary, splitLines } from '@vessel-agent/basic-tools';
import type { Hook, HookContext, HookResult } from '@vessel-agent/core';
import type { DocSubscriptionConfig } from './config.js';
import { unifiedDiff } from './diff.js';
import { consumeClearedToolResults } from './lifecycle.js';
import {
  formatSubscriptionNotice,
  SUBSCRIPTION_NOTICE_DETAILS_MAX,
  SUBSCRIPTION_NOTICE_MESSAGE_NAME,
  type SubscriptionNoticeContent,
} from './notice.js';
import type {
  ReadRef,
  SessionSubscriptionState,
  SubscriptionEntry,
  SubscriptionStore,
} from './store.js';

/** 与 read 工具同口径的单文件上限 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 单 run 处理的 run_id 上限；超过即清空（只影响“每 run 一次”的去重精度） */
const MAX_TRACKED_RUNS = 1000;

/** 单条通知最多列出的文件数；其余用 and N more 概括（口径见 notice.ts） */
const MAX_NOTICE_ENTRIES = SUBSCRIPTION_NOTICE_DETAILS_MAX;

/** hook 依赖 */
export interface BeforeLlmHookDeps {
  boundary: PathBoundary;
  store: SubscriptionStore;
  config: DocSubscriptionConfig;
}

/** 一次观察结果 */
interface Observation {
  rev: string;
  size: number;
  mtime_ms: number;
  /** 文件文本（仅文本、≤8MiB 且本次真正读了文件；便宜路径 / deleted / 超限 / 二进制不带） */
  text?: string;
}

/** 内容 hash */
function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** XML 属性值转义（& < > "） */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** rev 的短展示形态（通知里不暴露完整 hash） */
function shortRev(rev: string): string {
  if (rev === '') return 'never';
  if (rev === 'deleted') return 'deleted';
  if (rev.startsWith('too_large:')) return 'too_large';
  if (rev.startsWith('binary:'))
    return `binary:${rev.slice('binary:'.length, 'binary:'.length + 12)}`;
  return `sha256:${rev.slice(0, 12)}`;
}

/**
 * 单文件通知行：元数据；line-level 变化条目 additive 带 `lines="a-b"`（变化 ref 重定位范围并集）。
 * 来源可见（P1 origin）：last_writer 存在时附 `by="<短名>"`——member_id 优先、session_id 回退，
 * 取前 8 位（roster 全名解析候 Web 侧）；无 last_writer（旧状态 / 旁路写）不带 by=（零回归）。
 */
function noticeLine(entry: SubscriptionEntry, observation: Observation, lines?: string): string {
  const attrs = [
    `path="${escapeXmlAttr(entry.path)}"`,
    `id="${escapeXmlAttr(entry.id)}"`,
    `rev="${escapeXmlAttr(shortRev(observation.rev))}"`,
    `bytes="${observation.size}"`,
  ];
  if (lines !== undefined) attrs.push(`lines="${lines}"`);
  if (observation.rev === 'deleted') attrs.push('status="deleted"');
  else if (observation.rev.startsWith('too_large:')) attrs.push('status="too_large"');
  else if (observation.rev.startsWith('binary:')) attrs.push('status="binary"');
  if (entry.last_writer !== undefined) {
    const writer = entry.last_writer;
    attrs.push(`by="${escapeXmlAttr((writer.member_id ?? writer.session_id).slice(0, 8))}"`);
  }
  return `<file ${attrs.join(' ')} />`;
}

/**
 * 组装短通知。
 *
 * 「报哪几条」是本 hook 的事（边界 / 大小 / 二进制判定都在这边）；线格式交给 `notice.ts`：
 * 首行 `files: …` + 明细行 `  · …`，与 `tools:` / `identity:` 同形，Web 才认得出这是
 * 「文件变更」环境卡。`content` = 第一个 line-level 变化条目的 diff 明细（可缺省）。
 */
function buildNotice(lines: string[], total: number, content?: SubscriptionNoticeContent): string {
  return formatSubscriptionNotice(lines, total, content);
}

/** 有 reads 条目的 line-level 分析结果 */
type ReadsAnalysis =
  | { kind: 'unchanged'; reads: ReadRef[] }
  | { kind: 'line'; reads: ReadRef[]; diffLines: string[]; start: number; end: number }
  | { kind: 'fallback' };

/**
 * 逐 ref 内容锚重定位 + 范围 diff（CONTRACT-swarm-subscribe §4）。
 *
 * - oldLines = splitLines(ref.text)，在新文件行中找首尾行都匹配的候选；**恰 1 个**才重定位
 *   成功，0 或 >1 ⇒ 歧义 ⇒ 整条目整文件兜底（重复行多的文件漂移率待实测）。
 * - diff.text==='' ⇒ 范围未变：只更新 start/end；truncated ⇒ 整文件兜底；
 *   否则收集 diff 行并更新 ref.text/start/end。
 * - 任一 ref 无 text / 歧义 / truncated ⇒ fallback；ref 更新是**全有或全无**（兜底时不动 refs，
 *   旧锚仍是下次重定位的基准）。
 * - 全部 ref 未变 ⇒ unchanged（notified_rev 不动，下 run 幂等重查）。
 */
function analyzeReads(
  reads: readonly ReadRef[],
  text: string | undefined,
  config: DocSubscriptionConfig,
): ReadsAnalysis {
  if (text === undefined) return { kind: 'fallback' };
  const newLines = splitLines(text);
  const updated: ReadRef[] = [];
  const diffLines: string[] = [];
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;
  for (const ref of reads) {
    if (ref.text === undefined) return { kind: 'fallback' };
    const oldLines = splitLines(ref.text);
    const len = oldLines.length;
    if (len === 0 || len > newLines.length) return { kind: 'fallback' };
    let found = -1;
    let count = 0;
    for (let i = 0; i + len <= newLines.length; i += 1) {
      if (newLines[i] === oldLines[0] && newLines[i + len - 1] === oldLines[len - 1]) {
        count += 1;
        if (count > 1) break;
        found = i;
      }
    }
    if (count !== 1) return { kind: 'fallback' };
    const start = found + 1;
    const end = found + len;
    const newRangeText = newLines.slice(found, found + len).join('\n');
    const diff = unifiedDiff(ref.text, newRangeText, {
      maxBytes: config.maxDiffBytes,
      maxLines: config.maxDiffLines,
    });
    if (diff.text === '') {
      // 范围未变：只刷新位置；ref 对象尽量复用（调用方按引用判 reads 是否变化）。
      updated.push(start === ref.start && end === ref.end ? ref : { ...ref, start, end });
      continue;
    }
    if (diff.truncated) return { kind: 'fallback' };
    updated.push({ ...ref, text: newRangeText, start, end });
    diffLines.push(...diff.text.split('\n'));
    if (start < minStart) minStart = start;
    if (end > maxEnd) maxEnd = end;
  }
  if (diffLines.length === 0) return { kind: 'unchanged', reads: updated };
  return { kind: 'line', reads: updated, diffLines, start: minStart, end: maxEnd };
}

/**
 * 观察一个条目：边界、stat、大小、二进制、hash。
 * `undefined` = 跳过（边界拒绝 / 非普通文件 / 读取失败），不推进任何游标。
 */
export async function observeEntry(
  entry: SubscriptionEntry,
  deps: BeforeLlmHookDeps,
): Promise<Observation | undefined> {
  if (evaluatePath(entry.path, deps.boundary) !== 'allow') return undefined;

  let info: Stats | undefined;
  try {
    info = await stat(entry.path);
  } catch {
    info = undefined;
  }

  if (info === undefined || info.isDirectory()) {
    return { rev: 'deleted', size: 0, mtime_ms: 0 };
  }
  if (!info.isFile()) return undefined;

  // 便宜路径：stat 未变且**无待发通知**，不读文件。
  // rev ≠ notified_rev 意味着待处理的 line-level 重查（上次全部 ref 未变、notified_rev 没动），
  // 必须读内容才能重定位锚点 —— 走便宜路径会缺 text，被误判成整文件兜底通知。
  if (
    entry.rev !== '' &&
    entry.rev === entry.notified_rev &&
    info.mtimeMs === entry.mtime_ms &&
    info.size === entry.size
  ) {
    return { rev: entry.rev, size: entry.size, mtime_ms: entry.mtime_ms };
  }

  if (info.size > MAX_FILE_BYTES) {
    return {
      rev: `too_large:${info.size}:${info.mtimeMs}`,
      size: info.size,
      mtime_ms: info.mtimeMs,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(entry.path);
  } catch {
    return undefined;
  }
  const hash = sha256Hex(buffer);
  if (buffer.includes(0)) {
    return { rev: `binary:${hash}`, size: buffer.byteLength, mtime_ms: info.mtimeMs };
  }
  // 顺手给出文本（line-level 观察用；仅文本且 ≤8MiB —— 超限在上面已走 too_large）。
  return {
    rev: hash,
    size: buffer.byteLength,
    mtime_ms: info.mtimeMs,
    text: buffer.toString('utf-8'),
  };
}

/**
 * 观察侧自改抑制判定（设计 §2.3，sameOrigin 跳过）。
 *
 * 即将通知的变更恰是本 session/agent 最近一次写入的内容（观察 rev === last_writer.rev）
 * 且写入者与自身同源 ⇒ 跳过通知、静默推进 notified_rev（自改不提示，用户裁定）。
 * 身份以 member_id 为主键（跨 body 稳定）、缺省回退 session_id —— 与 tool.ts sameOrigin
 * 的「同源」语义一致；观察侧没有第二个写入事件可逐字段比 tool/session，故按身份标量判等。
 * 无 last_writer（旧状态 / bash 等旁路写）⇒ false ⇒ 照常通知（外部改动）。
 */
function isSelfWrite(
  entry: SubscriptionEntry,
  observedRev: string,
  agentId: string | undefined,
  sessionId: string,
): boolean {
  const writer = entry.last_writer;
  if (writer === undefined) return false;
  if (observedRev !== writer.rev) return false;
  return (writer.member_id ?? writer.session_id) === (agentId ?? sessionId);
}

/**
 * 创建 BeforeLlm hook。
 * 每个插件实例持有自己的 run 去重集合（每 run 只检查一次）。
 */
export function createBeforeLlmHook(deps: BeforeLlmHookDeps): Hook {
  const processedRuns = new Set<string>();

  return {
    name: 'doc-subscription',
    // 插件不做 core 的**运行时值**导入（见 docs/architecture/plugins.md「插件与宿主的模块边界」）：
    // 这里用字面量 + `Hook['type']` 保住类型一致性 —— core 里 HookType 改了值这里会报错，
    // 但运行时不再从 core 取枚举对象（.tgz 插件不共享宿主模块实例时也不会崩）。
    type: 'before_llm' as Hook['type'],
    priority: 150,
    run: async (ctx: HookContext): Promise<HookResult | undefined> => {
      const runId = ctx.run_id;
      // files 检测节奏（env_injection 框架轴 A）：装配层经 envGranularity.files 注入，
      // 缺省 'run' = 原 processedRuns gate（每 run 首请求观察一次，零回归）；
      // 'request' 跳过该 gate，每请求观察（去重轴 notified_rev 不动，不会重复发卡）。
      const filesCadence = deps.config.envGranularity?.files ?? 'run';
      // off（P2 轴 A）：整段跳过——不观察、不产卡、不注入（先于 run gate）。
      if (filesCadence === 'off') return;
      if (filesCadence === 'run') {
        if (processedRuns.has(runId)) return;
        if (processedRuns.size >= MAX_TRACKED_RUNS) processedRuns.clear();
        processedRuns.add(runId);
      }

      const sessionId = ctx.session_id ?? 'default';

      // rotate 订阅迁移（设计 §2.6）：新 body 首访惰性收养旧 session 状态（member 指针，
      // notified_rev/reads/last_writer 全量）。ctx.agent_id 可得才收养；无 agent_id（非成员
      // session）行为=现状。best-effort：收养失败退回现状基线，不阻断观察/通知。
      if (ctx.agent_id !== undefined) {
        try {
          await deps.store.adoptMemberSession(ctx.agent_id, sessionId);
        } catch {
          // 收养失败不阻断观察。
        }
      }

      let state: SessionSubscriptionState;
      try {
        state = await deps.store.load(sessionId);
      } catch {
        return;
      }

      let dirty = false;
      // 生命周期消费在观察循环前（每 run 一次）：清除驱动的引用释放 / 过期。
      // subscriptions 为空也要消费 ledger —— 否则「remove 清空 → 同段再 read」后，
      // 旧 cleared id 会误释放新引用（见 lifecycle.ts）。
      try {
        dirty = await consumeClearedToolResults(state, sessionId, deps.config);
      } catch {
        // best-effort：生命周期失败不打断观察 / 通知。
      }

      const entries = Object.values(state.subscriptions).sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );

      const now = Date.now();
      const lines: string[] = [];
      let changedCount = 0;
      let content: SubscriptionNoticeContent | undefined;

      for (const entry of entries) {
        let observation: Observation | undefined;
        try {
          observation = await observeEntry(entry, deps);
        } catch {
          observation = undefined;
        }
        if (observation === undefined) continue;

        // 已在通知里出现过：只刷新观察值，不再通知。
        if (observation.rev === entry.notified_rev) {
          if (
            entry.rev !== observation.rev ||
            entry.size !== observation.size ||
            entry.mtime_ms !== observation.mtime_ms
          ) {
            state.subscriptions[entry.path] = {
              ...entry,
              rev: observation.rev,
              size: observation.size,
              mtime_ms: observation.mtime_ms,
            };
            dirty = true;
          }
          continue;
        }

        // 自改抑制（设计 §2.3，sameOrigin 跳过）：即将通知的变更恰是本 session/agent
        // 最近一次写入 ⇒ 静默推进 notified_rev，不出卡、不出 diff；外部改动（无 last_writer /
        // 异源 / rev 不符）落到下面照常通知。reads 不动（下次外部变更观察时重定位锚）。
        if (isSelfWrite(entry, observation.rev, ctx.agent_id, sessionId)) {
          state.subscriptions[entry.path] = {
            ...entry,
            rev: observation.rev,
            size: observation.size,
            mtime_ms: observation.mtime_ms,
            notified_rev: observation.rev,
            notified_at: now,
          };
          dirty = true;
          continue;
        }

        // 有 reads 的条目走 line-level 分析；无 reads ⇒ 既有整文件路径逐字节不变。
        let lineLevel: Extract<ReadsAnalysis, { kind: 'line' }> | undefined;
        if (entry.reads.length > 0) {
          const analysis = analyzeReads(entry.reads, observation.text, deps.config);
          if (analysis.kind === 'unchanged') {
            // 全部 ref 未变：只刷新观察值（及重定位后的 start/end），notified_rev 不动，
            // 下 run 幂等重查。无变化不写盘。
            const readsChanged = analysis.reads.some((ref, i) => ref !== entry.reads[i]);
            if (
              readsChanged ||
              entry.rev !== observation.rev ||
              entry.size !== observation.size ||
              entry.mtime_ms !== observation.mtime_ms
            ) {
              state.subscriptions[entry.path] = {
                ...entry,
                rev: observation.rev,
                size: observation.size,
                mtime_ms: observation.mtime_ms,
                reads: analysis.reads,
              };
              dirty = true;
            }
            continue;
          }
          if (analysis.kind === 'line') lineLevel = analysis;
          // kind === 'fallback' ⇒ 整文件通知（既有 noticeLine 语义），refs 不动。
        }

        changedCount += 1;
        if (lines.length < MAX_NOTICE_ENTRIES) {
          if (lineLevel !== undefined) {
            lines.push(noticeLine(entry, observation, `${lineLevel.start}-${lineLevel.end}`));
            // 内容行只跟第一个（path 序）line-level 变化条目；其元数据行被 8 条上限
            // 裁掉时没有插入点，content 保持缺省。
            if (content === undefined) {
              content = {
                afterIndex: lines.length - 1,
                diffLines: lineLevel.diffLines,
                maxBytes: deps.config.maxTotalBytesPerRun,
              };
            }
          } else {
            lines.push(noticeLine(entry, observation));
          }
        }
        state.subscriptions[entry.path] = {
          ...entry,
          rev: observation.rev,
          size: observation.size,
          mtime_ms: observation.mtime_ms,
          notified_rev: observation.rev,
          notified_at: now,
          ...(lineLevel !== undefined ? { reads: lineLevel.reads } : {}),
        };
        dirty = true;
      }

      if (!dirty) return;

      try {
        // 成员指针（§2.6）：观察落盘同步更新，指向本成员当前 session（agent_id 可得时）。
        await deps.store.save(state, ctx.agent_id);
      } catch {
        // 保存失败时通知仍返回；下个 run 可能重复一次（at-most-once 风险）。
      }

      if (changedCount === 0) return;
      const message = {
        role: 'user' as const,
        name: SUBSCRIPTION_NOTICE_MESSAGE_NAME,
        content: buildNotice(lines, changedCount, content),
        timestamp: now,
      };
      // P2 轴 C：ui-only ⇒ 只落 UI 卡事实（message.injected，Web 既有投影渲染 EnvCard），
      // 不写 ctx.messages（模型不收）。notified_rev 游标已推进（上方 save）⇒ 不重复发卡。
      // 缺省 emitFact（旧 core / 裸宿主）⇒ 回退 ctx.messages 注入（model+ui 现状，additive）。
      if (deps.config.envChannels?.files === 'ui-only' && ctx.emitFact !== undefined) {
        ctx.emitFact({
          type: 'message.injected',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: ctx.session_id,
            message: { ...message, message_id: `${runId}:notice:${String(now)}` },
          },
          ts: now,
        });
        return;
      }
      ctx.messages = [...(ctx.messages ?? []), message];
      return;
    },
  };
}
