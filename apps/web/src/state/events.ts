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
  /**
   * 该事件所属 run 的会话归属（EventStore 按 run 记住）。
   *
   * 流式增量与工具事件本身不带 `session_id`；一旦 `run.started` 被按 run 裁剪掉，
   * 只看事件字段会让分组失去 sessionId，从而被会话窗口整段过滤。
   */
  sessionId?: string;
}

export type TimelineItem =
  | {
      kind: 'text';
      text: string;
      key: string;
      /** 首/末个 text_delta 的事件时间：这一段的真实发生时间（不是 run 起始）。 */
      startedAt?: number;
      endedAt?: number;
    }
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
  /** 最后一个事件时间：尾部未闭合的正文/思考用它排序（落在自己真实发生的时刻）。 */
  lastTs?: number;
  /**
   * 首个进入分组的条目 seq（wire 序号）。
   *
   * 时间线合并时同 `ts` 用它做稳定回退：事件与 `sessions.get` 消息共用一条按时间
   * 排序的列表，毫秒级同刻只能靠 seq 决定先后，不能靠到达顺序。
   */
  firstSeq?: number;
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
 *
 * **口径契约（与 runtime-visibility 对称冻结，改动前先对账）**
 * - 本集合是**事件侧唯一分类表**：新增「系统信息」事件加在这里，不要在渲染层
 *   （EventRow / StreamItems）另写可见性判断。
 * - 策略侧只有一个布尔：`showsInternalEvents(visibility)` =
 *   `ui.showInternalEvents || verbosity === 'debug'`（ADR-080/082）。`debug` 等价于
 *   展开内部事件是既有契约，不得从 `showsInternalEvents()` 摘掉，也不得在此另立
 *   第二套判定；两边口径必须同源。
 * - 判据只有一句：进集合 ⇔ 默认档隐藏（失败类 `hook.failed` / `hook.error` 仍走
 *   `errorLevel`，永不进集合）。主内容（`llm.stream.chunk`、`tool.call.*`、
 *   `run.*` 终态、`user.message`）**永不进集合**。
 */
export const INTERNAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'context.changed',
  'session.saved',
  'llm.request',
  'llm.response',
  'message.injected',
  // run 生命周期的状态同步：每次 iteration 都发，默认档不该逐条落成原始事件卡。
  'run.checkpoint',
  'run.resumed',
  // 进程级通知（热应用 / 版本检查）：run_id 常为 `runtime`，内容经 BeforeLlm hook
  // 进模型上下文，聊天时间线不该每个周期多一张原始 JSON 卡。
  'runtime.notice',
  // trace 回放边界：只在批量回放 trace 时出现，是观测动作而不是对话内容。
  'replay.started',
  'replay.completed',
  // 上下文生命周期的过程信号（水位 / 压缩 / 轮换 / 重启 / compact fork）：
  // 仍按 typed notice 渲染，但归到「内部事件」开关下，默认档不逐轮刷行。
  // 例外：`agent.limit.warning`（限流 / 预算预警）必须默认可见，**不要**加进来。
  'context.pressure',
  'context.compacted',
  'agent.rotating',
  'agent.rotated',
  'agent.restarting',
  'agent.restarted',
  'agent.compact_forked',
  // hook.* 由 `ui.showInternalEvents` 统一控制（CONFIG 契约），失败仍走 errorLevel。
  'hook.started',
  'hook.completed',
  'hook.system_prompt_ignored',
  'hook.additional_context_deprecated',
]);

/**
 * 只属于观察面（Observe / Runs）的成员事件：聊天窗无条件不展示。
 *
 * 这些事件的 `run_id` 是成员 / 队列入队 id，不是 run id，落进聊天时间线只会变成
 * 与对话无关的原始 JSON 卡。用显式集合而不是 `hasRunEvent` 推断：成员事件将来
 * 若补上 `data.run_id`，也不能重新漏进聊天窗。lifecycle notice
 * （`agent.limit.warning` / `agent.rotating` / `agent.rotated` / `agent.restarting` /
 * `agent.restarted` / `agent.compact_forked`）不在此列，聊天窗继续显示。
 */
export const CHAT_HIDDEN_EVENT_TYPES: ReadonlySet<string> = new Set([
  // 0.39：session 创建 / 源退役 / primary 切换审计事件不是对话内容。
  'session.created',
  'session.activated',
  'agent.session.activated',
  // 0.39：create 失败只做审计；旧 `agent.fork.failed` 仍按旧日志渲染。
  'agent.create.failed',
  // 旧 fork 事件只读：web 隐藏原始 JSON 卡；`agent.compact_forked` 仍有 typed notice。
  'agent.forked',
  // rewind 是历史删除的持久化标记，不是对话内容：永不渲染。
  'session.rewound',
  'agent.spawned',
  'agent.message.queued',
  'agent.message.sent',
  // 0.41 notify：只观察 inbox 送入，不是对话内容。
  'agent.message.notified',
  'agent.closed',
  'agent.stale',
  'agent.permission.requested',
  'agent.permission.responded',
  'agent.queue.entered',
  'agent.queue.left',
]);

/** 单个 run 的事件序列 → 可渲染分组。 */
export function buildGroup(runId: string, entries: readonly StoredEvent[]): RunGroup {
  const group: RunGroup = { runId, status: 'running', hasRunEvent: false, items: [] };
  let buf = '';
  let textIndex = 0;
  let textStartedAt: number | undefined;
  let textEndedAt: number | undefined;
  let reasoningBuf = '';
  let reasoningIndex = 0;
  let reasoningStartedAt: number | undefined;
  let reasoningEndedAt: number | undefined;
  const flushText = () => {
    if (buf) {
      group.items.push({
        kind: 'text',
        text: buf,
        key: `text-${runId}-${textIndex++}`,
        ...(textStartedAt !== undefined ? { startedAt: textStartedAt } : {}),
        ...(textEndedAt !== undefined ? { endedAt: textEndedAt } : {}),
      });
      buf = '';
      textStartedAt = undefined;
      textEndedAt = undefined;
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
  // `hook.started` / `hook.completed` 成对出现：只落一行 notice（completed 带 duration_ms），
  // 否则每轮 LLM 调用都会多出 2 行「hook · 名字」，把时间线冲成噪声。
  let pendingHook: { event: RunEvent; key: string; name: string } | undefined;
  const flushPendingHook = () => {
    if (!pendingHook) return;
    group.items.push({ kind: 'notice', event: pendingHook.event, key: pendingHook.key });
    pendingHook = undefined;
  };
  const flush = () => {
    flushPendingHook();
    flushReasoning();
    flushText();
  };

  for (const entry of entries) {
    const ev = entry.event;
    if (group.firstTs === undefined) group.firstTs = ev.ts;
    if (group.firstSeq === undefined) group.firstSeq = entry.seq;
    if (group.lastTs === undefined || ev.ts > group.lastTs) group.lastTs = ev.ts;
    if (entry.jobId) group.jobId = entry.jobId;
    // 载荷自报 run_id 的才是 run 事件；成员事件的 run_id 是成员 id（见 hasRunEvent）。
    const payloadRunId = (ev.data as { run_id?: unknown }).run_id;
    if (typeof payloadRunId === 'string' && payloadRunId === ev.run_id) {
      group.hasRunEvent = true;
    }
    // 中途连上 / run.started 已被环形缓冲裁剪时，仍按任一事件的 session_id 归属会话；
    // 否则成员 run 的实时卡片会因缺 sessionId 被会话窗口过滤掉。
    // `entry.sessionId` 是 EventStore 按 run 记住的归属：流式增量自身不带 session_id，
    // 只有它能兜住「run.started 被裁剪」的长 run。
    if (group.sessionId === undefined) {
      if (entry.sessionId !== undefined && entry.sessionId.length > 0) {
        group.sessionId = entry.sessionId;
      } else {
        const data = ev.data as { session_id?: unknown };
        if (typeof data.session_id === 'string' && data.session_id.length > 0) {
          group.sessionId = data.session_id;
        }
      }
    }
    switch (ev.type) {
      case 'run.started': {
        const d = ev.data as { input?: string; session_id?: string };
        group.input = d.input;
        if (d.session_id !== undefined) group.sessionId = d.session_id;
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
      case 'agent.rotated':
      case 'agent.restarting':
      case 'agent.restarted':
      case 'agent.compact_forked':
      case 'hook.system_prompt_ignored':
      case 'hook.additional_context_deprecated': {
        flush();
        group.items.push({ kind: 'notice', event: ev, key: `notice-${entry.seq}` });
        continue;
      }
      // hook 成对折叠：started 先暂存，同名 completed 到达就只落 completed 那一行；
      // 只有 started、没有 completed 时由 `flush()` 兜底落回，信息不丢。
      case 'hook.started': {
        flush();
        const name = (ev.data as { hook_name?: unknown }).hook_name;
        pendingHook = {
          event: ev,
          key: `notice-${entry.seq}`,
          name: typeof name === 'string' ? name : '',
        };
        continue;
      }
      case 'hook.completed': {
        const name = (ev.data as { hook_name?: unknown }).hook_name;
        const paired = typeof name === 'string' && pendingHook?.name === name;
        if (paired) pendingHook = undefined;
        flush();
        group.items.push({ kind: 'notice', event: ev, key: `notice-${entry.seq}` });
        continue;
      }
      case 'llm.stream.chunk': {
        const chunk = (ev.data as { chunk?: StreamChunk }).chunk;
        if (chunk?.type === 'text_delta' && chunk.delta) {
          // 正文开始前先落盘已累积的思考段，保持时间顺序。
          flushReasoning();
          if (textStartedAt === undefined) textStartedAt = ev.ts;
          textEndedAt = ev.ts;
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
  // 未配对的 `hook.started` 在这里落回，避免整行信息丢失。
  flushPendingHook();
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
  // 观察面事件无视 showInternal：聊天窗永远不展示，只在 Observe / Runs 可见。
  if (CHAT_HIDDEN_EVENT_TYPES.has(entry.event.type)) return false;
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
 *
 * **去重契约（时间线合并的唯一去重键）**：`sessions.get` 的已提交消息与 ws 缓冲里的
 * live 事件必然是同一份内容的两条来源，只允许渲染一份。判据固定为
 * `(status === 'completed') ∧ (run.input ∈ user 消息) ∧ (run.output ⊆ assistant 消息)`；
 * 缺任一项就保留 live 卡片（宁可重一次，也不能把 run 吞掉）。
 * 用户输入的重复显示由 `hideInput`（TranscriptWindow）用同一 key 的 input 半边兜住；
 * 因此**不要**在渲染层另外引入按时间/文本相似度的去重，会和这里漂移。
 */
/**
 * @deprecated 被  的「认领」（domains/chat/transcript-items.ts）取代：
 * 去重改成按 key 合并同一个逻辑对象，而不是猜「这条 run 是否已落盘」。
 * 该导出只为旧调用点保留；不要在渲染层再叠加第二套去重。
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
