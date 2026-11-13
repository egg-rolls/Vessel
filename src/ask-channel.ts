/**
 * headless ask 的“人类通道”（0.33 A）。
 *
 * 三件事共用同一份 `InteractionsStore` 文件，不引入第二套队列：
 * 1. headless 进程把 `ask.user.requested` 落盘；
 * 2. 没有 gateway 时，`vessel attention` 用离线 target 读写同一份文件；
 * 3. `--resume-run` 前把已回答的 ask 追加为一条 `user.message` 事件，
 *    让 `ExecutionUnit.resume` 从既有历史路径读到答案。
 *
 * 不做 run 调度、不持有运行时状态；只做文件读改写与事件注入。
 *
 * @module vessel/ask-channel
 */

import type { EventStream, RunEvent, SessionEventLogPort } from '../packages/core/src/index';
import {
  createInteractionMethods,
  createInteractionsRegistry,
  InteractionsStore,
  type RpcMethodContext,
  type RpcMethodDefinition,
  type StoredInteraction,
} from '../packages/serve/src/index';
import { RpcClientError } from './rpc';

/** 恢复注入的 user.message 来源标记；也用于幂等去重。 */
export const ASK_RESUME_SOURCE = 'ask_resume';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 交互目录里的全部记录（按创建时间排序）。
 *
 * 0.49 T4：单执行面只有一份 `interactions-<sid>.json`，记录不再带 tenant；
 * `tenantId` 参数保留给调用方（文件路径仍按单 id 选择）。
 */
export function loadTenantRecords(dir: string, _tenantId: string): StoredInteraction[] {
  return new InteractionsStore(dir).loadAllSync().sort((a, b) => a.created_at - b.created_at);
}

/** 该 run 已由人类回答的 ask（resume 注入的唯一数据源）。 */
export function answeredAsksForRun(
  dir: string,
  tenantId: string,
  runId: string,
): StoredInteraction[] {
  return loadTenantRecords(dir, tenantId).filter(
    (record) =>
      record.kind === 'ask' &&
      record.run_id === runId &&
      // 分批：部分已答（仍是 pending）的 ask 也要注入 —— 挂起后被人类答了 2/3 题，
      // 续跑的 run 不能连这 2 题都看不见。后面几批会以一条 inbox 消息补到。
      (record.status === 'answered' ||
        (record.status === 'pending' && (record.answered_questions?.length ?? 0) > 0)),
  );
}

/**
 * 把一条 ask 请求写入持久化记录（pending）。
 *
 * 以 requestId 幂等：重复事件不会造第二条；已有 answered/orphaned 记录不覆盖。
 */
export async function persistAskRequest(options: {
  dir: string;
  tenantId: string;
  requestId: string;
  runId: string;
  sessionId?: string;
  questions?: unknown;
  createdAt?: number;
  /** headless 挂起标记：run 的 checkpoint 是 interrupted，跨进程保留 pending。 */
  suspended?: boolean;
  /** 0.52：`async` = 工具已立即返回，记录跨进程保留 pending（提问的 run 已正常收口）。 */
  mode?: 'async';
}): Promise<void> {
  const records = loadTenantRecords(options.dir, options.tenantId);
  const existing = records.find((record) => record.requestId === options.requestId);
  if (existing !== undefined) {
    // 同进程 gateway 可能先落一条不带 suspended 的记录；这里补齐标记。
    if (options.suspended === true && existing.suspended !== true) {
      const next = records.map((record) =>
        record.requestId === options.requestId ? { ...record, suspended: true } : record,
      );
      await new InteractionsStore(options.dir).save(options.tenantId, next);
    }
    return;
  }
  const record: StoredInteraction = {
    requestId: options.requestId,
    run_id: options.runId,
    kind: 'ask',
    ...(options.sessionId !== undefined ? { session_id: options.sessionId } : {}),
    // 工具名写新名；历史记录里同字段仍可能是 `ask_user`（读侧按记录用，不做等值比较）。
    tool: 'ask',
    input: options.questions,
    created_at: options.createdAt ?? Date.now(),
    status: 'pending',
    ...(options.mode === 'async' ? { mode: 'async' as const } : {}),
    ...(options.suspended === true ? { suspended: true } : {}),
  };
  records.push(record);
  await new InteractionsStore(options.dir).save(options.tenantId, records);
}

/** run 正常收口时，把它遗留的 pending ask 标 orphaned（不再可回答）。 */
export async function orphanPendingAsksForRun(options: {
  dir: string;
  tenantId: string;
  runId: string;
}): Promise<number> {
  const records = loadTenantRecords(options.dir, options.tenantId);
  let changed = 0;
  const next = records.map((record) => {
    if (record.kind !== 'ask' || record.run_id !== options.runId) return record;
    if (record.status !== 'pending') return record;
    // 0.52：async ask 的 run 在工具返回后就收口了，请求本身仍然待批 —— 不许孤儿化。
    if (record.mode === 'async') return record;
    // 分批：部分已答的 ask 同理（提问的 run 已拿着首批答案继续跑，剩下几题还在等人）。
    if ((record.answered_questions?.length ?? 0) > 0) return record;
    changed += 1;
    return { ...record, status: 'orphaned' as const };
  });
  if (changed > 0) await new InteractionsStore(options.dir).save(options.tenantId, next);
  return changed;
}

/** 问题摘要的最大长度（模型看到的答案行里，原题只留摘要）。 */
export const ASK_QUESTION_SUMMARY_MAX = 120;

/**
 * 问题摘要：压掉换行 / 连续空白，并把冒号换成空格。
 *
 * 答案行格式是 `N. label: answer`；label 里出现冒号会让「哪部分是问题、哪部分是
 * 答案」不可分（Web 卡片按第一个冒号切分）。摘要只需要人认得出是哪一问，
 * 因此这里牺牲标点换结构确定性。
 */
export function askQuestionSummary(text: string): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/\s*[:：]\s*/g, ' ')
    .trim();
  if (flat.length <= ASK_QUESTION_SUMMARY_MAX) return flat;
  return `${flat.slice(0, ASK_QUESTION_SUMMARY_MAX)}…`;
}

/**
 * 把持久化 answers 转成模型可直接读的文本。空数组 = 人类拒绝回答。
 *
 * 每行是 `N. label: answer`：label 带原问题摘要（有 header 时 `header（问题摘要）`，
 * 没有 header 就用问题本身）。async ask 的答案可能隔几个小时才回到模型面前，
 * 只写 header 模型无从知道答的是哪一问。
 *
 * `N` 是**题号**（来自答案自带的 `question_id`，即 `q3` → 3），不是「第几行」——
 * 分批提交后一次可能只到第 3 题，按行号编会让模型把「第 3 题」读成「第 1 题」。
 * 旧答案没有 `question_id`，退回行号，文本与分批之前一字不差。
 *
 * `requestCount`：同一次提交里**合并**了几个 request（>1 时首行用复数 + 计数）；
 * 缺省 = 一次一个 request（旧文本一字不改）。
 */
export function formatAnswersForModel(
  answers: unknown[],
  options?: { requestCount?: number; remaining?: readonly string[] },
): string {
  if (answers.length === 0) {
    return 'The human declined to answer your pending ask request.';
  }
  const lines = answers.map((answer, index) => {
    if (typeof answer === 'string') return `${index + 1}. ${answer}`;
    if (isRecord(answer)) {
      const header = nonEmptyString(answer.header);
      const question = nonEmptyString(answer.question);
      const value = answerTextOf(answer);
      const summary = question === undefined ? undefined : askQuestionSummary(question);
      // header 缺失就用问题本身；两者都没有才退化成序号标签。
      const label =
        header === undefined
          ? (summary ?? `Answer ${index + 1}`)
          : summary === undefined || summary === header
            ? header
            : `${header}（${summary}）`;
      const position = questionPositionOf(answer.question_id) ?? index + 1;
      return `${position}. ${label}: ${value}`;
    }
    return `${index + 1}. ${JSON.stringify(answer)}`;
  });
  const remaining = options?.remaining ?? [];
  if (remaining.length > 0) {
    // 分批：这一批没答全时必须明说，否则模型最容易以为「我问的都答了」，
    // 或者以为这次提问已经作废而把同样的问题再问一遍。
    lines.push(
      `(${remaining.length} of ${answers.length + remaining.length} questions still unanswered: ` +
        `${remaining.join(', ')}. They stay in the human pending queue and the rest will arrive ` +
        'later as a separate message — do not wait for them, do not ask those questions again.)',
    );
  }
  const requestCount = options?.requestCount;
  const intro =
    requestCount !== undefined && requestCount > 1
      ? `Answers from the human to your ${requestCount} pending ask requests:`
      : 'Answers from the human to your pending ask request:';
  return [intro, ...lines].join('\n');
}

/**
 * 这条记录里**还剩哪几题没答**（题 id 列表；全部答完 / 旧记录无题可枚举时为空）。
 *
 * 与工具写侧同一套题 id 规则（`id` 优先，缺省按题序 `q1/q2/…`）—— 认不出题的记录
 * （`input` 不是数组）一律当作「没有缺口」，绝不凭空造出未答项。
 */
export function remainingQuestionsOf(record: StoredInteraction): string[] {
  if (!Array.isArray(record.input)) return [];
  const answered = new Set(record.answered_questions ?? []);
  const ids = record.input.map((item, index) => {
    const explicit = isRecord(item) ? nonEmptyString(item.id) : undefined;
    return explicit ?? `q${index + 1}`;
  });
  return ids.filter((id) => !answered.has(id));
}

/**
 * 一行的答案值：`answer` 是写侧渲染好的文本（旧记录只有它）。
 *
 * 缺 `answer` 但有多选结构 `selected` 时（理论上不会同时缺，容错用）拼成 `, ` ——
 * 分隔符只在这里定义一次，不给模型造第二套读法。
 */
function answerTextOf(answer: Record<string, unknown>): string {
  if (typeof answer.answer === 'string') return answer.answer;
  const selected = Array.isArray(answer.selected)
    ? answer.selected.filter((item): item is string => typeof item === 'string')
    : [];
  if (selected.length > 0) return selected.join(', ');
  return JSON.stringify(answer.answer ?? '');
}

/** `q3` → 3；不是这个形状（旧答案 / 手写值）→ undefined（调用方退回行号）。 */
function questionPositionOf(value: unknown): number | undefined {
  const id = nonEmptyString(value);
  if (id === undefined) return undefined;
  const match = /^q(\d+)$/.exec(id);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * resume 前把已回答 ask 注入 session 事件日志。
 *
 * 走既有 `user.message` 事件（projection 已有路径），因此不需要改 core 的 resume；
 * 以 `source + request_id` 去重，重复 resume 不会重复注入。
 */
export async function deliverAnsweredAsksToSession(options: {
  eventLog?: SessionEventLogPort;
  dir: string;
  tenantId: string;
  runId: string;
  sessionId: string;
}): Promise<number> {
  if (options.eventLog === undefined) return 0;
  const answered = answeredAsksForRun(options.dir, options.tenantId, options.runId);
  if (answered.length === 0) return 0;

  let events: Awaited<ReturnType<SessionEventLogPort['read']>> = [];
  try {
    events = await options.eventLog.read(options.sessionId);
  } catch {
    // 读失败按"没投递过"处理；append 仍会尝试，重复风险由下方 no-op 兜底。
    events = [];
  }
  const delivered = new Set<string>();
  for (const event of events) {
    if (event.type !== 'user.message' || !isRecord(event.data)) continue;
    if (event.data.source !== ASK_RESUME_SOURCE) continue;
    const requestId = nonEmptyString(event.data.request_id);
    if (requestId !== undefined) delivered.add(requestId);
  }

  let count = 0;
  for (const record of answered) {
    if (delivered.has(record.requestId)) continue;
    const content = formatAnswersForModel(record.answer?.answers ?? []);
    await options.eventLog.append({
      session_id: options.sessionId,
      run_id: options.runId,
      type: 'user.message',
      ts: Date.now(),
      data: {
        run_id: options.runId,
        session_id: options.sessionId,
        message: { role: 'user', content },
        source: ASK_RESUME_SOURCE,
        request_id: record.requestId,
      },
    });
    delivered.add(record.requestId);
    count += 1;
  }
  return count;
}

/** 从 `ask.user.requested` 事件里取出落盘所需字段。 */
export function askRequestFromEvent(event: RunEvent):
  | {
      requestId: string;
      runId: string;
      sessionId?: string;
      questions?: unknown;
      /** 0.52：`async` = 工具已立即返回，run 不该因此挂起。 */
      mode?: 'async';
    }
  | undefined {
  if (event.type !== 'ask.user.requested') return undefined;
  const data = isRecord(event.data) ? event.data : {};
  const requestId = nonEmptyString(data.requestId);
  if (requestId === undefined) return undefined;
  return {
    requestId,
    runId: event.run_id,
    ...(nonEmptyString(data.session_id) !== undefined
      ? { sessionId: nonEmptyString(data.session_id) }
      : {}),
    ...(data.questions !== undefined ? { questions: data.questions } : {}),
    ...(data.mode === 'async' ? { mode: 'async' as const } : {}),
  };
}

/** 离线 attention 的假事件流：回答只落盘，不投递给任何等待者。 */
function discardedStream(): EventStream {
  return {
    subscribe: () => () => undefined,
    publish: () => undefined,
    clear: () => undefined,
    getHistory: () => [],
    waitFor: () => new Promise<never>(() => undefined),
  };
}

/**
 * 无 gateway 时的本地控制面 target。
 *
 * 复用 serve 的 `interactions.list` / `ask.respond` / `permission.respond`
 * 方法表与交互状态机，只把传输换成同一份文件；不新增 RPC 语义。
 */
export function createOfflineAttentionTarget(options: {
  dir: string;
  tenantId: string;
  nodeId: string;
}): {
  target: {
    kind: 'local';
    baseUrl: string;
    token: string;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    close(): Promise<void>;
  };
  note: string;
} {
  const stream = discardedStream();
  const interactions = createInteractionsRegistry({
    eventsFor: () => stream,
    singleTenantId: options.tenantId,
    interactionsDir: options.dir,
    // 文件里的 pending 可能属于一个 interrupted 的 headless run：仍可回答。
    hydratePendingAs: 'pending',
  });
  const methods = createInteractionMethods({
    respondPermission: (requestId, decision, remember, scope, actor) =>
      interactions.respondPermission(requestId, decision, remember, scope, actor),
    respondAsk: (requestId, answers, actor, context) =>
      interactions.respondAsk(requestId, answers, actor, context),
    interactions,
    // 0.52：离线 attention 没有 live runtime —— async 答案只能记录，投放者是空的：
    // `() => undefined` 让 `ask.respond` 的返回体照旧带 `delivered: false`，
    // `vessel attention respond` 因此仍打出「没投出去」（不假装起了新 run）。
    // 注意这里不注册任何投放者：投放的唯一触发点是注册表的 `pending → answered`，
    // 离线装配没有 `onAsyncAskAnswered`。
    awaitAsyncAskDelivery: () => undefined,
  });
  const byName = new Map<string, RpcMethodDefinition>(
    methods.map((method) => [method.name, method]),
  );
  const ctx: RpcMethodContext = {
    principal: { role: 'admin' },
    isAdmin: true,
    connection: 'local',
  };

  const request = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
    if (method === 'health.get') {
      return {
        node: {
          node_id: options.nodeId,
          name: options.nodeId,
          status: 'idle',
          role: 'standalone',
        },
      } as T;
    }
    if (method === 'teams.get') {
      return { members: [] } as T;
    }
    const definition = byName.get(method);
    if (definition === undefined) {
      throw new RpcClientError('not_found', `Offline attention does not support ${method}`);
    }
    const result = await definition.handler((params ?? {}) as Record<string, unknown>, ctx);
    if (method === 'ask.respond' || method === 'permission.respond') {
      // registry 的落盘是 fire-and-forget；离线命令可能在写完成前退出，
      // 这里按同一份内存状态再同步 await 一次，保证回答不丢。
      const records = [...interactions.interactionRecords.values()].sort(
        (a, b) => a.created_at - b.created_at,
      );
      await new InteractionsStore(options.dir).save(options.tenantId, records);
    }
    return result as T;
  };

  return {
    target: {
      kind: 'local',
      baseUrl: '',
      token: '',
      request,
      close: async () => undefined,
    },
    note:
      'No local gateway is running; using the local interaction records at ' +
      `${options.dir} (offline mode).`,
  };
}
