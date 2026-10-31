/**
 * headless ask 的“人类通道”（0.33 A）。
 *
 * 三件事共用同一份 `InteractionsStore` 文件，不引入第二套队列：
 * 1. headless 进程把 `ask.user.requested` 落盘；
 * 2. 没有 gateway 时，`vessel attention` 用离线 target 读写同一份文件；
 * 3. `--resume-run` 前把已回答的 ask 追加为一条 `user.message` 事件，
 *    让 `AgentRuntime.resume` 从既有历史路径读到答案。
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

/** 某个 tenant 的全部交互记录（按创建时间排序）。 */
export function loadTenantRecords(dir: string, tenantId: string): StoredInteraction[] {
  return new InteractionsStore(dir)
    .loadAllSync()
    .filter((record) => record.tenant_id === tenantId)
    .sort((a, b) => a.created_at - b.created_at);
}

/** 该 run 已由人类回答的 ask（resume 注入的唯一数据源）。 */
export function answeredAsksForRun(
  dir: string,
  tenantId: string,
  runId: string,
): StoredInteraction[] {
  return loadTenantRecords(dir, tenantId).filter(
    (record) => record.kind === 'ask' && record.run_id === runId && record.status === 'answered',
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
    tenant_id: options.tenantId,
    kind: 'ask',
    ...(options.sessionId !== undefined ? { session_id: options.sessionId } : {}),
    tool: 'ask_user',
    input: options.questions,
    created_at: options.createdAt ?? Date.now(),
    status: 'pending',
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
    changed += 1;
    return { ...record, status: 'orphaned' as const };
  });
  if (changed > 0) await new InteractionsStore(options.dir).save(options.tenantId, next);
  return changed;
}

/** 把持久化 answers 转成模型可直接读的文本。空数组 = 人类拒绝回答。 */
export function formatAnswersForModel(answers: unknown[]): string {
  if (answers.length === 0) {
    return 'The human declined to answer your pending ask_user request.';
  }
  const lines = answers.map((answer, index) => {
    if (typeof answer === 'string') return `${index + 1}. ${answer}`;
    if (isRecord(answer)) {
      const header = nonEmptyString(answer.header);
      const question = nonEmptyString(answer.question);
      const value =
        typeof answer.answer === 'string' ? answer.answer : JSON.stringify(answer.answer ?? '');
      const label = header ?? question ?? `Answer ${index + 1}`;
      return `${index + 1}. ${label}: ${value}`;
    }
    return `${index + 1}. ${JSON.stringify(answer)}`;
  });
  return ['Answers from the human to your pending ask_user request:', ...lines].join('\n');
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
    tenantEventsFor: () => stream,
    defaultTenantId: options.tenantId,
    interactionsDir: options.dir,
    // 文件里的 pending 可能属于一个 interrupted 的 headless run：仍可回答。
    hydratePendingAs: 'pending',
  });
  const methods = createInteractionMethods({
    respondPermission: (requestId, decision, remember, tenantId, scope, actor) =>
      interactions.respondPermission(requestId, decision, remember, tenantId, scope, actor),
    respondAsk: (requestId, answers, tenantId, actor) =>
      interactions.respondAsk(requestId, answers, tenantId, actor),
    interactions,
  });
  const byName = new Map<string, RpcMethodDefinition>(
    methods.map((method) => [method.name, method]),
  );
  const ctx: RpcMethodContext = {
    principal: { tenant_id: options.tenantId, role: 'admin' },
    tenantId: options.tenantId,
    isAdmin: true,
    allTenants: false,
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
      const records = [...interactions.interactionRecords.values()]
        .filter((record) => record.tenant_id === options.tenantId)
        .sort((a, b) => a.created_at - b.created_at);
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
