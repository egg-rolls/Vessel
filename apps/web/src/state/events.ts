/**
 * 事件模型（纯函数）：按 run_id 分组，把 `llm.stream.chunk` 的 text_delta
 * 拼成文本块、reasoning_delta 拼成独立的思考块。去重不在这里：live 与 history 的
 * 同一个逻辑对象由 domains/chat/transcript-items.ts 的认领合并。
 */
import type { MessageRef, RunEvent, StreamChunk } from '../gateway/types';
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
 * - **落盘摘要跟着本集合走**：`llm.stream.summary`（流式**段落**骨架）与
 *   `llm.request` 的落盘元信息副本是「给人看日志 / 丢帧自查」的结构，不是对话内容
 *   —— 归到内部事件开关下（默认隐藏、展开可见），**不要**让它们降级成聊天里的原始
 *   JSON 卡，也不要在渲染层另写判据。它们永不成为内容权威：正文以 `llm.response` /
 *   `user.message` / `tool.*` 为准。
 * - **两个集合的分工**：本集合 = 「默认档隐藏，展开后（`ui.showInternalEvents` /
 *   `verbosity=debug`）仍以原始事件行出现」的状态同步；`CHAT_HIDDEN_EVENT_TYPES`
 *   = 「聊天窗无条件不展示」的会话 / 成员**元数据审计**（`session.created` /
 *   `session.activated` / `session.rewound` / `session.titled` …）与**已有专用 UI
 *   承接的交互事件**（`tool.permission.*` / `ask.user.*`，卡片在 Composer 槽位）。
 *   这两类的归宿只有 Observe / Runs：不要因为「它也能被 showInternal 放出来」就塞进
 *   本集合，否则打开「显示系统信息」后聊天里会重新冒出原始 JSON 卡。
 */
export const INTERNAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'context.changed',
  'session.saved',
  'llm.request',
  'llm.response',
  // 传输层 / 过载自动重试：一次重试一条，带 attempt / backoff_ms / 分类。
  // 它不是失败信号（终态失败仍走 `run.failed`），默认档不该逐条刷原始 JSON 卡。
  'llm.retry',
  // 流式**段落**摘要（不是正文、不是逐 delta）：一段 text/reasoning 结束时一条，
  // 只带段序/条数/字节/seq 跨度。落盘日志里的「思考→工具→正文」骨架靠它，
  // 聊天时间线默认档不该为每个段落多一张原始事件卡。
  'llm.stream.summary',
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
  // 上下文 / prompt / 上限的状态同步（run 内部状态变了，不是对话内容）。三条都**没有**
  // typed notice，展开后落回原始事件行，默认档不逐轮刷行：
  // - `message.compaction`：一次压缩的**落盘摘要镜像**（`removed` / `remaining` / `kept` /
  //   `reason` + 摘要消息本体）。用户能行动的信号由同一次压缩先发的 `context.compacted`
  //   （typed notice）承担，消息重建走 `projectMessages` 投影，不读时间线 —— 默认档再落一张
  //   原始 JSON 卡就是同一事实的第二份。
  // - `prompt.prefix_changed`：prompt 缓存前缀漂移（`diverged_at` / `system_changed` /
  //   `tools_changed`），纯诊断信号，只用于「为什么这次请求没命中缓存」。
  // - `limit.blocked`：硬上限（iterations / runtime / request / token / cost）触发的先行
  //   信号，随即 run 以 `run.failed` + `limit_blocked` envelope 收口；失败正文归
  //   `errorLevel`（`run.*` 是默认可见级），事件本级重复。
  'message.compaction',
  'prompt.prefix_changed',
  'limit.blocked',
  // hook.* 由 `ui.showInternalEvents` 统一控制（CONFIG 契约），失败仍走 errorLevel。
  'hook.started',
  'hook.completed',
  'hook.system_prompt_ignored',
  'hook.additional_context_deprecated',
]);

/**
 * 只属于观察面（Observe / Runs）的事件：聊天窗无条件不展示。
 *
 * 判据是**内容性质**，不是「默认档是否隐藏」：会话 / 成员的**元数据审计**（创建、
 * 激活、改名、rewind、删除）既不是对话内容，也没有 typed notice 承接，落成事件卡就只是
 * 一坨原始 JSON。因此本集合的成员**不受 `ui.showInternalEvents` 影响**——打开
 * 「显示系统信息」也不进聊天（`debug` 同理），只在 Observe / Runs 查看；这也是它
 * 与 `INTERNAL_EVENT_TYPES`（默认隐藏、展开可见）的分工。
 *
 * 第二类成员是**已有专用 UI 承接的交互事件**（`tool.permission.*` → `PermissionCard`、
 * `ask.user.*` → `AskCard`）：交互数据源是 `interactions.list` hydration 与
 * `connection-handlers` 的 add / settle，**不经时间线分组**，所以原始卡只是
 * requestId / decision 的重复噪声；`ask.user.timeout`（headless 等不到人）同理，
 * 卡片收起由应答事件或 run 终态负责，这条事件只是一行审计。判据仍是内容性质：
 * 聊天窗里它没有独立信息量。
 *
 * 这些事件的 `run_id` 通常是成员 / 队列入队 id 或常量伪 run id（`session` /
 * `runtime` / `config` / `plugins`），不是 run id。用显式集合而不是 `hasRunEvent`
 * 推断：成员事件将来若补上 `data.run_id`，也不能重新漏进聊天窗。lifecycle notice
 * （`agent.limit.warning` / `agent.rotating` / `agent.rotated` / `agent.restarting` /
 * `agent.restarted` / `agent.compact_forked`）不在此列，聊天窗继续显示。
 *
 * 隐藏的是**条目**而不是分组：`groupEvents` / `EventGroupCache` 在过滤阶段就丢掉这些
 * 事件，伪 run 组若因此没有任何剩余条目，整组不会进入分组表（不留空组 / 空 item）。
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
  // AI 命名成功（`{session_id,title}`，run_id 恒为常量 `session`）是会话元数据审计：
  // 标题已经由会话头 / 会话列表展示，聊天窗不该再落一张原始 JSON 卡。
  'session.titled',
  // 会话删除审计：`run_id` 是 sessionId（伪 run），载荷只有计数（sessions / runs /
  // events）。删除结果由删除对话框与 `sessions.list` 重启后的会话列表呈现
  // （`useSessionDelete` 走 RPC 后本地 removeSession + 跳转，不读这条事件）。
  'session.deleted',
  // 权限 / ask 的请求-应答是**已有交互卡的重复噪声**：卡片在 Composer 槽位
  // （`PromptSlots` → `PermissionCard` / `AskCard`），数据源是 `interactions.list`
  // hydration + `connection-handlers` 的 add / settle（在分组之前直接写
  // `useInteractionStore`），**不经过**时间线分组；原始卡里只有 requestId /
  // requestId+decision，藏掉不丢任何可交互内容。
  'tool.permission.request',
  'tool.permission.response',
  'ask.user.requested',
  'ask.user.answered',
  // headless ask 超时：服务端标 suspended（`interactions-registry`），web 侧靠 run
  // 终态 `run-finished` 收起卡片，它本身只是一条审计行。
  'ask.user.timeout',
  'agent.spawned',
  // 收件箱投递只有一条事件（`queued` + `delivery`）：入队 / 唤醒 / 只落 inbox 都是
  // 观察面的送达记录，不是对话内容。旧名 `agent.message.notified` 只读兼容历史行。
  'agent.message.queued',
  'agent.message.notified',
  'agent.message.sent',
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
        // 同一 run 可能先收到一条 `run.failed`（典型：session-liveness 的误判
        // `run lost`，见 src/session-liveness.ts 的 lease 探针），随后又正常
        // `run.completed`。状态已由这里覆盖，但 error / errorMeta 不清就会永久残留
        // —— 今天没人渲染，可只要将来出现「有 error 就提示」的判定，它就会把一条
        // 成功的 run 报成失败。终态以最后一次为准：completed 显式清掉前面那份错误。
        group.error = undefined;
        group.errorMeta = undefined;
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
      // 失败类：`run.finalize.failed`（终态持久化失败）与 `guardrail.error`
      // （guardrail `check()` 抛错，fail-closed）都是**真失败**，可见性归
      // `errorLevel`（`run.` / `guardrail.` 前缀，默认可见级）。这里只换表示层：
      // 原始 JSON 卡 → 折叠 notice（错误文本 + 来源阶段），刻意**不**进
      // `INTERNAL_EVENT_TYPES` / `CHAT_HIDDEN_EVENT_TYPES` —— 任何集合都在
      // `errorLevel` 之前过滤，塞进去等于静默真失败。
      case 'run.finalize.failed':
      case 'guardrail.error': {
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
