/**
 * 事件模型（纯函数）：按 run_id 分组，把 `llm.stream.chunk` 的 text_delta
 * 拼成文本块、reasoning_delta 拼成独立的思考块。去重不在这里：live 与 history 的
 * 同一个逻辑对象由 domains/chat/transcript-items.ts 的认领合并。
 */
import type { MessageRef, RunEvent, StreamChunk } from '../gateway/types';
import { type ErrorMeta, type ErrorVisibility, errorMetaOf } from './error-visibility';
import { eventSpecOf, isVisibleInChat } from './event-visibility';

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
  /**
   * 输入的身份：`Message.name`（A2A 投递是 `agent:<alias>`）。
   *
   * 两个来源填同一个字段，**先到的非空值赢**：`run.started` 的 `input_name`
   * （首帧就能到，见 core `RunStartedPayload`）与 `user.message` 的 `message.name`
   * （要过完 Input guardrail）。name 不会被 guardrail 改写，所以先到先得是安全的；
   * 旧 gateway 两处都不带时保持 undefined —— 与今天的行为一致（首帧可能闪一下），
   * 不做回填、不按正文猜。
   */
  inputName?: string;
  /**
   * 这一轮的附件引用（0.52；来自 `user.message` 的 `message.refs`，只有路径与种类）。
   *
   * 只用于运行态气泡上方的 chip：`run.started` 不带 refs（首帧还只知道文本），
   * 等 `user.message`（过完 Input guardrail）到了再补。历史落盘后由
   * `sessions.get` 的 `messages[].refs` 接管，两条路径渲染同一行 chip。
   */
  inputRefs?: MessageRef[];
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

/*
 * 可见性分类**不在这里**：唯一分类表是 `./event-visibility.ts`（三档 + 家族前缀 +
 * `tierOf` / `isVisibleInChat`）。本文件只负责分组与渲染形态。
 */

/**
 * 单个 run 的 fold（纯状态机）：把一条条事件折成 `RunGroup` + 尾部流式缓冲。
 *
 * **同一段代码服务两条路径**（DESIGN.md §5.1）：
 * - 路径②（重建）：`buildGroup`（一次性喂完）/ 回填 `resume` / 冷启动重建；
 * - 路径①（实时）：`LiveItemStore.ingest` 在事件到达时喂一条。
 *
 * 因此「增量折叠 == 从全量事件重建」是**结构性**结论，不是巧合 —— 改这里就是同时改两条路。
 * `apply()` 的分支与 DESIGN.md §3.2 的「事件 → 动作」表逐行对应；`flush()` 的调用位置
 * 逐行照搬历史实现（原 `buildGroup` 的 47 处），动它会动 item 顺序。
 */
export interface RunFold {
  readonly runId: string;
  /** 应用一条事件（「同一条只生效一次」由调用侧的水位保证，见 `LiveItemStore.ingest`）。 */
  apply(entry: StoredEvent): void;
  /** 当前状态 → `RunGroup` 副本（快照对象不能被后续 apply 改到）。 */
  toGroup(): RunGroup;
}

export function createFold(runId: string): RunFold {
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

  const apply = (entry: StoredEvent): void => {
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
        const d = ev.data as { input?: string; session_id?: string; input_name?: string };
        group.input = d.input;
        // 首帧身份：`input_name` 与 `input` 同一次发布，渲染不会先看到「没有身份的输入」。
        if (
          group.inputName === undefined &&
          typeof d.input_name === 'string' &&
          d.input_name.length > 0
        ) {
          group.inputName = d.input_name;
        }
        if (d.session_id !== undefined) group.sessionId = d.session_id;
        group.startedAt = ev.ts;
        return;
      }
      case 'run.completed': {
        flush();
        const d = ev.data as { output?: string; duration_ms?: number; iterations?: number };
        group.output = d.output;
        group.durationMs = d.duration_ms;
        group.iterations = d.iterations;
        group.status = 'completed';
        group.completedAt = ev.ts;
        // 同一 run 可能先收到一条 `run.failed`（典型：session-liveness 的误判
        // `run lost`，见 src/session-liveness.ts 的 lease 探针），随后又正常
        // `run.completed`。状态已由这里覆盖，但 error / errorMeta 不清就会永久残留
        // —— 今天没人渲染，可只要将来出现「有 error 就提示」的判定，它就会把一条
        // 成功的 run 报成失败。终态以最后一次为准：completed 显式清掉前面那份错误。
        group.error = undefined;
        group.errorMeta = undefined;
        return;
      }
      case 'run.failed': {
        flush();
        const d = ev.data as { error?: string; duration_ms?: number };
        group.error = d.error;
        group.errorMeta = errorMetaOf(ev.data);
        group.durationMs = d.duration_ms;
        group.status = 'failed';
        group.completedAt = ev.ts;
        return;
      }
      case 'run.cancelled': {
        flush();
        const d = ev.data as { duration_ms?: number };
        group.durationMs = d.duration_ms;
        group.status = 'cancelled';
        group.completedAt = ev.ts;
        return;
      }
      case 'user.message': {
        // 持久化后的用户输入（可能已被 guardrail 改写）；不回退成 raw JSON 卡。
        const d = ev.data as { message?: unknown; content?: unknown; session_id?: unknown };
        const message =
          typeof d.message === 'object' && d.message !== null && !Array.isArray(d.message)
            ? (d.message as Record<string, unknown>)
            : undefined;
        // 同一身份的第二个来源（晚于 run.started）：先到的非空值赢，不改写已填的值。
        if (group.inputName === undefined && message !== undefined) {
          const name = message.name;
          if (typeof name === 'string' && name.length > 0) group.inputName = name;
        }
        if (
          message?.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.length > 0
        ) {
          group.input = message.content;
        } else if (typeof d.content === 'string' && d.content.length > 0) {
          group.input = d.content;
        }
        // 附件引用（0.52）：只有路径，宽松解析，坏条目逐条丢（与投影同一口径）。
        if (group.inputRefs === undefined && message !== undefined) {
          const refs = refsOf(message.refs);
          if (refs.length > 0) group.inputRefs = refs;
        }
        if (group.sessionId === undefined && typeof d.session_id === 'string') {
          group.sessionId = d.session_id;
        }
        return;
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
        return;
      }
      // 失败类：`run.finalize.failed`（终态持久化失败）与 `guardrail.error`
      // （guardrail `check()` 抛错，fail-closed）都是**真失败**，可见性在
      // `event-visibility.ts` 里是 `content`（`run.` / `guardrail.` 前缀）。这里只换
      // 表示层：原始 JSON 卡 → 折叠 notice（错误文本 + 来源阶段）。失败类永不降档
      // （塞进默认隐藏 / observe 等于静默真失败）。
      case 'run.finalize.failed':
      case 'guardrail.error': {
        flush();
        group.items.push({ kind: 'notice', event: ev, key: `notice-${entry.seq}` });
        return;
      }
      // 退役 / 作废回复：**有承接才允许藏**。`agent.retired` 是 `internal` + typed
      // notice（默认档不出卡，`ui.showInternalEvents` / `debug` 时以 notice 出现 ——
      // 它的 `reason` 在服务端 DTO 里没有，藏成「什么都不显示」就丢了「为什么换身体」）；
      // `agent.reply.stale` 是 `content`（「那一轮回复为何作废」的唯一解释）。
      // 两者都必须走 notice，不得落成原始 JSON 卡。
      case 'agent.retired':
      case 'agent.reply.stale': {
        flush();
        group.items.push({ kind: 'notice', event: ev, key: `notice-${entry.seq}` });
        return;
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
        return;
      }
      case 'hook.completed': {
        const name = (ev.data as { hook_name?: unknown }).hook_name;
        const paired = typeof name === 'string' && pendingHook?.name === name;
        if (paired) pendingHook = undefined;
        flush();
        group.items.push({ kind: 'notice', event: ev, key: `notice-${entry.seq}` });
        return;
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
        return;
      }
      default: {
        flush();
        // **未登记类型（第三方插件 / 上游事件 / 旧 trace）绝不落裸 JSON 卡**：
        // `tierOf` 返回 undefined 时按 `internal` 口径处理，并渲染成一条
        // 「未知事件类型 · 已折叠」notice（展开是原始载荷，见 EventRow.noticeView）。
        // 已登记但没有专用分支的类型（如 `guardrail.blocked`）仍走原始事件行 ——
        // 它们的摘要由 EventRow 逐类型给出，属于「明细只能看原始事件」的那一档。
        if (eventSpecOf(ev.type) === undefined) {
          group.items.push({ kind: 'notice', event: ev, key: `unknown-${entry.seq}` });
        } else {
          group.items.push({ kind: 'event', event: ev, key: `ev-${entry.seq}` });
        }
      }
    }
  };

  const toGroup = (): RunGroup => {
    // 副本：50ms 快照与后续 apply 之间不能共享可变数组 / 标量。
    const snapshot: RunGroup = { ...group, items: [...group.items] };
    // 未配对的 `hook.started` 在快照里落回，避免整行信息丢失；**不写回** fold 状态 ——
    // 紧接着到达的同名 `hook.completed` 仍要与它配成一行（配对见 apply 的 hook 分支）。
    if (pendingHook !== undefined) {
      snapshot.items.push({ kind: 'notice', event: pendingHook.event, key: pendingHook.key });
    }
    // 尾部仍在流式中的缓冲不 push 成 item：运行段直接渲染 liveText / liveReasoning。
    // flush() 已清空的部分不会出现在这里，因此不会与 items 重复。
    if (reasoningBuf) snapshot.liveReasoning = reasoningBuf;
    if (buf) snapshot.liveText = buf;
    return snapshot;
  };

  return { runId, apply, toGroup };
}

/** 单个 run 的事件序列 → 可渲染分组（路径②：一次性重建）。 */
export function buildGroup(runId: string, entries: readonly StoredEvent[]): RunGroup {
  const fold = createFold(runId);
  for (const entry of entries) fold.apply(entry);
  return fold.toGroup();
}

/*
 * ── 「这条事件在时间线上有没有产物」的唯一判据 ──────────────────────────────
 *
 * `EventStore` 用它做两件事：不产产物的流式增量**不进缓冲**，以及裁剪时**先丢**
 * 不产产物的条目（`oldestEvictableIndex` 的两档）。所以它必须与上面 `buildGroup`
 * 的分支表**同源**：这里不维护任何独立的事件名名单，只把那个 switch 的分支归属
 * 表达出来；改 `buildGroup` 的分支就要改这里（相距不到 40 行，语义由
 * `check-transcript-items` 的 fixtures 与 `buildLiveItems` 守着）。
 */

/**
 * 事件在时间线分组里有没有产物。
 *
 * - `true`：`buildGroup` 会为它 push 一条 item（text / reasoning / notice / event），
 *   或写一个**被渲染**的分组态字段 —— `run.started` / `user.message` 的 `input`
 *   （`run-input` 气泡）、终态事件的 `status` / `output` / `error`（终态与失败卡）。
 * - `false`：什么都不留。`buildGroup` 的 `case 'llm.stream.chunk'` 只认
 *   `text_delta` / `reasoning_delta`（累积成正文/思考段）；`tool_call_delta` 落进
 *   该分支的兜底什么都不做，`finish` 只 `flush()` 收口边界、自己不产 item，
 *   载荷缺失 / 未识别的 chunk 子类型同样什么都不做。
 *
 * **不看可见性档位**：`internal` / `observe` 档在 `buildGroup` 里照样产 item
 * （原始事件行 / typed notice），档位过滤发生在更外层的 `isVisibleForGrouping`。
 * **也不判「别的视图读不读它」**：`agent.*` / `subagent.*` 是成员树与子 agent 面板的
 * 输入（`state/agents.ts#reduceAgents`），所以它们在这里恒为 true —— 这个函数只回答
 * 「时间线上有没有东西」，不能据此认为一条事件可以丢。
 */
export function producesTimelineItem(event: { type: string; data?: unknown }): boolean {
  if (event.type !== 'llm.stream.chunk') return true;
  const chunk = (event.data as { chunk?: { type?: unknown; delta?: unknown } } | undefined)?.chunk;
  // 与 `buildGroup` 的两条累积分支逐字对应：必须同 kind 且有非空 delta。
  if (chunk?.type !== 'text_delta' && chunk?.type !== 'reasoning_delta') return false;
  return typeof chunk.delta === 'string' && chunk.delta.length > 0;
}

/**
 * 事件里的引用快照（宽松解析）：只认 `{kind, path}`，坏条目逐条丢。
 *
 * 与 core 投影同一口径，但 Web 不信任事件载荷（旧 gateway / 半成品数据都可能出现）；
 * 条数上限也照抄（32 条），避免一条被手改的事件把气泡上方撑成一面墙。
 */
function refsOf(value: unknown): MessageRef[] {
  if (!Array.isArray(value)) return [];
  const refs: MessageRef[] = [];
  for (const entry of value) {
    if (refs.length >= 32) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    const path = record.path;
    if (kind !== 'file' && kind !== 'image' && kind !== 'document') continue;
    if (typeof path !== 'string' || path.length === 0) continue;
    const ref: MessageRef = { kind, path };
    if (typeof record.name === 'string') ref.name = record.name;
    if (typeof record.mime === 'string') ref.mime = record.mime;
    if (typeof record.bytes === 'number' && Number.isFinite(record.bytes) && record.bytes >= 0) {
      ref.bytes = Math.floor(record.bytes);
    }
    refs.push(ref);
  }
  return refs;
}

/**
 * 单条事件是否进入时间线分组。`groupEvents` 与增量缓存共用同一口径，
 * 避免两套过滤规则漂移。
 *
 * 判据只有 `event-visibility.ts` 的 `isVisibleInChat` 一处：`content` 恒可见、
 * `observe` 恒不可见、`internal`（含**未登记**）只随 `showInternal` / `errorLevel: all`
 * 放开。`showInternal` 由调用方传入 `showsInternalEvents()` 的结果
 * （`ui.showInternalEvents || verbosity === 'debug'`）。
 */
export function isVisibleForGrouping(
  entry: StoredEvent,
  showInternal: boolean,
  errorLevel: ErrorVisibility = 'user',
): boolean {
  return isVisibleInChat(entry.event.type, { showInternal, errorLevel });
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
