/**
 * 事件模型（纯函数）：按 run_id 分组，把 `llm.stream.chunk` 的 text_delta
 * 拼成文本块、reasoning_delta 拼成独立的思考块，并在历史已落盘时抑制重复的 live 卡片。
 */
import type { Message, RunEvent, SessionDetail, StreamChunk } from '../gateway/types';
import {
  type ErrorMeta,
  type ErrorVisibility,
  errorMetaOf,
  isHiddenInternalError,
} from './error-visibility';

export interface StoredEvent {
  event: RunEvent;
  seq: number;
  jobId?: string;
}

export type TimelineItem =
  | { kind: 'text'; text: string; key: string }
  | {
      kind: 'reasoning';
      text: string;
      key: string;
      /** 首/末个 reasoning_delta 的事件时间，用于「思考过程 · Ns」。 */
      startedAt?: number;
      endedAt?: number;
    }
  /** 上下文生命周期事件：按语义 notice 渲染，不再落成原始事件卡。 */
  | { kind: 'notice'; event: RunEvent; key: string }
  | { kind: 'event'; event: RunEvent; key: string };

export interface RunGroup {
  runId: string;
  jobId?: string;
  sessionId?: string;
  /**
   * 该分组是否由真实 run 的事件构成。
   *
   * 成员级事件（`agent.spawned` / `agent.message.queued` …）的 `run_id` 是**成员 id**，
   * 不是 run id，也会按 run_id 聚成一组，但永远不会有终态事件。判据用事件载荷：
   * run 事件自报 `data.run_id === event.run_id`（core runtime / scheduler 都是这个形状），
   * 成员事件不带 `data.run_id`。Stop / 取消只认这里为 true 的分组，否则会把成员 id
   * （对新会话恰好等于 session id）当成 run id 发给 `runs.cancel`。
   */
  hasRunEvent: boolean;
  input?: string;
  output?: string;
  error?: string;
  /** 0.14 additive：run.failed 的结构化错误元数据（缺字段时 undefined）。 */
  errorMeta?: ErrorMeta;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** 首个事件时间（没有 run.started 时用于排序） */
  firstTs?: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  iterations?: number;
  /**
   * 0.17 additive：尚未 flush 的流式尾部缓冲。
   *
   * 流式期间不把每个 delta push 成 item（那会让运行段每 token 重建）；
   * 末尾未闭合的正文/思考通过 `liveText` / `liveReasoning` 直接渲染，
   * 下一个事件 `flush()` 后清空，避免与 item 重复。
   */
  liveText?: string;
  liveReasoning?: string;
  items: TimelineItem[];
}

/**
 * 默认隐藏的内部事件：状态同步/提示词上下文，不是用户关心的对话内容。
 *
 * `message.injected` 仍由 owner 注入（成员回复）与 `RunOptions.messages`（@file 等）生产；
 * `doc-subscription` 改为临时 `additionalContext` 后不再产生该事件。保留在这里，
 * 让所有“注入到 prompt 的上下文”默认不出现在 run 时间线。
 */
export const INTERNAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'context.changed',
  'session.saved',
  'llm.request',
  'llm.response',
  'message.injected',
]);

/** 单个 run 的事件序列 → 可渲染分组。 */
export function buildGroup(runId: string, entries: readonly StoredEvent[]): RunGroup {
  const group: RunGroup = { runId, status: 'running', hasRunEvent: false, items: [] };
  let buf = '';
  let textIndex = 0;
  let reasoningBuf = '';
  let reasoningIndex = 0;
  let reasoningStartedAt: number | undefined;
  let reasoningEndedAt: number | undefined;
  const flushText = () => {
    if (buf) {
      group.items.push({ kind: 'text', text: buf, key: `text-${runId}-${textIndex++}` });
      buf = '';
    }
  };
  const flushReasoning = () => {
    if (reasoningBuf) {
      group.items.push({
        kind: 'reasoning',
        text: reasoningBuf,
        key: `reasoning-${runId}-${reasoningIndex++}`,
        ...(reasoningStartedAt !== undefined ? { startedAt: reasoningStartedAt } : {}),
        ...(reasoningEndedAt !== undefined ? { endedAt: reasoningEndedAt } : {}),
      });
      reasoningBuf = '';
      reasoningStartedAt = undefined;
      reasoningEndedAt = undefined;
    }
  };
  const flush = () => {
    flushReasoning();
    flushText();
  };

  for (const entry of entries) {
    const ev = entry.event;
    if (group.firstTs === undefined) group.firstTs = ev.ts;
    if (entry.jobId) group.jobId = entry.jobId;
    // 载荷自报 run_id 的才是 run 事件；成员事件的 run_id 是成员 id（见 hasRunEvent）。
    const payloadRunId = (ev.data as { run_id?: unknown }).run_id;
    if (typeof payloadRunId === 'string' && payloadRunId === ev.run_id) {
      group.hasRunEvent = true;
    }
    // 中途连上 / run.started 已被环形缓冲裁剪时，仍按任一事件的 session_id 归属会话；
    // 否则成员 run 的实时卡片会因缺 sessionId 被会话窗口过滤掉。
    if (group.sessionId === undefined) {
      const data = ev.data as { session_id?: unknown };
      if (typeof data.session_id === 'string' && data.session_id.length > 0) {
        group.sessionId = data.session_id;
      }
    }
    switch (ev.type) {
      case 'run.started': {
        const d = ev.data as { input?: string; session_id?: string };
        group.input = d.input;
        group.sessionId = d.session_id;
        group.startedAt = ev.ts;
        continue;
      }
      case 'run.completed': {
        flush();
        const d = ev.data as { output?: string; duration_ms?: number; iterations?: number };
        group.output = d.output;
        group.durationMs = d.duration_ms;
        group.iterations = d.iterations;
        group.status = 'completed';
        group.completedAt = ev.ts;
        continue;
      }
      case 'run.failed': {
        flush();
        const d = ev.data as { error?: string; duration_ms?: number };
        group.error = d.error;
        group.errorMeta = errorMetaOf(ev.data);
        group.durationMs = d.duration_ms;
        group.status = 'failed';
        group.completedAt = ev.ts;
        continue;
      }
      case 'run.cancelled': {
        flush();
        const d = ev.data as { duration_ms?: number };
        group.durationMs = d.duration_ms;
        group.status = 'cancelled';
        group.completedAt = ev.ts;
        continue;
      }
      case 'user.message': {
        // 持久化后的用户输入（可能已被 guardrail 改写）；不回退成 raw JSON 卡。
        const d = ev.data as { message?: unknown; content?: unknown; session_id?: unknown };
        const message =
          typeof d.message === 'object' && d.message !== null && !Array.isArray(d.message)
            ? (d.message as Record<string, unknown>)
            : undefined;
        if (
          message?.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.length > 0
        ) {
          group.input = message.content;
        } else if (typeof d.content === 'string' && d.content.length > 0) {
          group.input = d.content;
        }
        if (group.sessionId === undefined && typeof d.session_id === 'string') {
          group.sessionId = d.session_id;
        }
        continue;
      }
      // 上下文生命周期：percent → pressure → compacted → rotating/rotated 的因果链，
      // 由 NoticeRow 按类型渲染，避免默认分支的原始 JSON 卡。
      case 'context.pressure':
      case 'context.compacted':
      case 'agent.limit.warning':
      case 'agent.rotating':
      case 'agent.rotated': {
        flush();
        group.items.push({ kind: 'notice', event: ev, key: `notice-${entry.seq}` });
        continue;
      }
      case 'llm.stream.chunk': {
        const chunk = (ev.data as { chunk?: StreamChunk }).chunk;
        if (chunk?.type === 'text_delta' && chunk.delta) {
          // 正文开始前先落盘已累积的思考段，保持时间顺序。
          flushReasoning();
          buf += chunk.delta;
        } else if (chunk?.type === 'reasoning_delta' && chunk.delta) {
          // 思考流独立累积，绝不并入正文 Markdown。
          flushText();
          if (reasoningStartedAt === undefined) reasoningStartedAt = ev.ts;
          reasoningEndedAt = ev.ts;
          reasoningBuf += chunk.delta;
        } else if (chunk?.type === 'finish') {
          flush();
        }
        continue;
      }
      default:
        flush();
        group.items.push({ kind: 'event', event: ev, key: `ev-${entry.seq}` });
    }
  }
  // 尾部仍在流式中的缓冲不 push 成 item：运行段直接渲染 liveText/liveReasoning。
  // flush() 已清空的部分不会出现在这里，因此不会与 items 重复。
  if (reasoningBuf) group.liveReasoning = reasoningBuf;
  if (buf) group.liveText = buf;
  return group;
}

/**
 * 单条事件是否进入时间线分组。`groupEvents` 与增量缓存共用同一口径，
 * 避免两套过滤规则漂移。
 */
export function isVisibleForGrouping(
  entry: StoredEvent,
  showInternal: boolean,
  errorLevel: ErrorVisibility = 'user',
): boolean {
  if (!showInternal && INTERNAL_EVENT_TYPES.has(entry.event.type)) return false;
  // 子 agent 事件属于内部执行细节：默认不按 child run_id 拆成 raw JSON 卡片。
  if (!showInternal && entry.event.type.startsWith('subagent.')) return false;
  if (isHiddenInternalError(entry.event.type, errorLevel, showInternal)) return false;
  return true;
}

/**
 * 按 run_id 分组并按开始时间正序排列。
 * `errorLevel` 默认 `user`：internal 级错误只在 `all` 或展开内部事件时进入时间线。
 */
export function groupEvents(
  entries: readonly StoredEvent[],
  showInternal: boolean,
  errorLevel: ErrorVisibility = 'user',
): RunGroup[] {
  const byRun = new Map<string, StoredEvent[]>();
  for (const entry of entries) {
    if (!isVisibleForGrouping(entry, showInternal, errorLevel)) continue;
    const runId = entry.event.run_id;
    const list = byRun.get(runId);
    if (list) list.push(entry);
    else byRun.set(runId, [entry]);
  }
  return [...byRun.entries()]
    .map(([runId, list]) => buildGroup(runId, list))
    .sort((a, b) => (a.startedAt ?? a.firstTs ?? 0) - (b.startedAt ?? b.firstTs ?? 0));
}

/**
 * 事件流里已经真正开始执行的 run id。
 *
 * 排队阶段先到的是 `agent.queue.entered`（`run_id` 是排队 run 的真实 id），
 * 它只说明 run 进了队列，**不代表事件流已接管**；排队占位卡片必须保留到
 * `run.started` 出现，否则用户既看不到排队位置也点不到取消。
 */
export function startedRunIds(entries: readonly StoredEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.event.type === 'run.started') ids.add(entry.event.run_id);
  }
  return ids;
}

/** 只保留属于某个会话的 run 分组。 */
export function groupsForSession(groups: readonly RunGroup[], sessionId: string): RunGroup[] {
  return groups.filter((group) => group.sessionId === sessionId);
}

/**
 * 已完成 run 的 live 卡片是否应隐藏（历史里已经有同一条用户输入 + 最终输出）。
 * 无法确认输出已落盘时保留卡片，避免 hydrate 失败时整个 run 消失。
 */
export function isGroupPersisted(group: RunGroup, detail: SessionDetail | null): boolean {
  if (group.status !== 'completed' || !detail) return false;
  const messages: Message[] = detail.messages;
  const input = group.input?.trim();
  const userSaved = !input || messages.some((m) => m.role === 'user' && m.content.trim() === input);
  if (!userSaved) return false;
  const output = group.output?.trim();
  if (!output) return false;
  return messages.some(
    (m) =>
      m.role === 'assistant' &&
      (m.content.trim() === output || (output.length >= 8 && m.content.includes(output))),
  );
}

/** 事件类型 → 时间线标签与颜色类名。 */
export function eventTag(type: string): { label: string; cls: string } {
  if (type.startsWith('tool.call.')) {
    if (type.endsWith('.failed')) return { label: 'tool.fail', cls: 'tag-tool-fail' };
    if (type.endsWith('.completed')) return { label: 'tool.ok', cls: 'tag-tool-done' };
    return { label: 'tool', cls: 'tag-tool-start' };
  }
  if (type.startsWith('guardrail.')) return { label: type, cls: 'tag-guard' };
  if (type.startsWith('llm.')) return { label: type, cls: 'tag-llm' };
  if (type === 'error') return { label: 'error', cls: 'tag-error' };
  return { label: type, cls: 'tag-raw' };
}
