/**
 * 交互注册表（0.27）：从已删除的执行引擎中搬出的权限 / ask 职责。
 *
 * 只负责交互记录，不负责调度、run 队列或执行：
 * - pending / answered / orphaned 三态；`interactionRecords` 是唯一事实源；
 * - 按 tenant 落盘（`InteractionsStore`），启动 hydrate 时把无 run 的 pending 标 orphaned；
 * - 应答只发布到请求产生时的 tenant 流；tenant 不一致一律 `not_found`；
 * - run 终态（`run.completed|failed|cancelled`）把该 run 的 pending 转 orphaned；
 *   不再有旧 turn 生命周期事件 / 成员特判（F11 已删除）。
 *
 * @module @vessel-agent/serve/interactions-registry
 */

import type { EventStream, RunEvent } from '@vessel-agent/core';
import {
  InteractionsStore,
  type StoredInteraction,
  type StoredInteractionAnswer,
  type StoredInteractionStatus,
} from './interactions-store.js';
import { RpcError } from './rpc.js';

/** 权限应答 scope（DECISION-024 §2.1）。 */
export type PermissionScope = 'once' | 'session' | 'always';

/** 待答权限请求 */
export interface PendingPermission {
  run_id: string;
  tool: string;
  input: unknown;
  ts: number;
  /** 事件携带的 deadline_at（兼容保留）；不再作为过期依据。 */
  deadline_at?: number;
  session_id?: string;
  /**
   * bridge 请求的父 **agent**（0.51 additive；事件 `parent_agent_id`）—— ask 链路的
   * **唯一**归属维度。父会话由读侧从它 + roster 上溯出来（`apps/web/src/domains/pending/
   * attribution.ts`），本层不再记父会话 id：那是展示信息，多存一处就是第二个事实源。
   */
  parent_agent_id?: string;
  tool_call_id?: string;
  source?: string;
}

/** 应答者归属；agent 不是合法值（only-human）。 */
export interface InteractionActor {
  answered_by: 'human' | 'policy';
  answered_via?: 'tui' | 'rpc' | 'cli' | 'policy';
}

/**
 * 0.52：应答的「来路」上下文（additive，只影响答案投放的分组）。
 *
 * `batch_id` = 待批页的一次提交（一簇里每条 ask 各发一次 `ask.respond`，但那是
 * 一次人类动作）。它落进 `answer.batch_id`，投放实现按 (agent, session, batch_id)
 * 短窗口合并成一条消息 + 一次 run；缺省 = 单条应答（旧行为）。
 */
export interface AskRespondContext {
  batch_id?: string;
}

/** `permission.respond` 的结果（additive）。 */
export interface PermissionRespondResult {
  ok: true;
  decision: 'allow' | 'deny';
  scope: PermissionScope;
  /** 重复应答：沿用第一次的结果，不再发布事件。 */
  duplicate?: true;
  answered_by?: 'human' | 'policy';
  answered_via?: 'tui' | 'rpc' | 'cli' | 'policy';
  latency_ms?: number;
  team_id?: string;
}

/** `ask.respond` 的结果（与权限同一套幂等语义）。 */
export interface AskRespondResult {
  ok: true;
  duplicate?: true;
  answered_by: 'human' | 'policy';
  answered_via?: 'tui' | 'rpc' | 'cli' | 'policy';
  latency_ms?: number;
  team_id?: string;
  /** 这次真正写进去的题 id（additive：分批提交时只含本批）。 */
  answered_questions?: string[];
  /** 仍未答的题 id（additive；空 = 这条请求已收口，卡片该消失了）。 */
  remaining_questions?: string[];
  /** 已答过、本次被跳过的题 id（additive；幂等重复提交会全在这里）。 */
  skipped_questions?: string[];
  /** 这条请求是不是已经全部答完（additive；缺省 = 不知道 / 旧服务端）。 */
  final?: boolean;
}

/** 待答 ask 请求（legacy 只读视图，由 interactionRecords 派生）。 */
export interface PendingAsk {
  run_id: string;
  ts: number;
  session_id?: string;
  /** 父 agent id（0.51 additive；ask 链路的唯一归属维度）。 */
  parent_agent_id?: string;
  /** 原始 questions；只用于 `interactions.list` 展示，不持久化。 */
  questions?: unknown;
}

/** 注册表选项。 */
export interface InteractionsRegistryOptions {
  /**
   * 单运行时事件流：权限 / ask 应答直接投递到这里。
   * 找不到流说明 run 已结束，应答返回 `run_ended`。
   */
  eventsFor: () => EventStream | undefined;
  /** 单 id：只用于交互记录文件名（R1 路径形状不变）。 */
  singleTenantId: string;
  /** 交互持久化目录；缺省 = 不落盘。 */
  interactionsDir?: string;
  /**
   * 启动 hydrate 时如何对待磁盘上的 `pending`。
   *
   * gateway 的语义是「本进程没有对应 run」→ `orphaned`（默认）；
   * 离线 attention 只读写文件、没有 run，但请求可能属于一个 `interrupted`
   * 的 headless run，仍可被人类回答 → `pending`。
   */
  hydratePendingAs?: 'orphaned' | 'pending';
  /**
   * 0.52：async ask 拿到**第一次**答案时通知调用方（投放答案 / 起新 run）。
   *
   * **投放的唯一触发点**：RPC 应答（`respondAsk`）与流上应答
   * （`ask.user.answered`，TUI / policy）两条路共用 `settleAnswer` 这一个出口，
   * 而出口只在「记录此刻还是 pending」的那一次迁移上通知（见 `settleAnswer`）。
   * 装配层不要在同一个注册表上挂两份，也不要再加第二条触发路径（比如让
   * `ask.respond` 的 handler 自己再投一次）。同一条运行时流上并存多个 gateway
   * 装配时，重复通知由 gateway 的进程级单飞去重（`asyncAnswerDeliveries`）。
   * 实现方必须自吞全部错误（答案已经落定，投放失败只退化为「只记录答案」）。
   */
  onAsyncAskAnswered?: (record: StoredInteraction) => void;
}

/** 交互注册表（serve 内唯一交互状态）。 */
export interface InteractionsRegistry {
  /** 内存 pending 权限索引；真相源是 `interactionRecords`。 */
  readonly pendingPermissions: Map<string, PendingPermission>;
  /** requestId → 持久化交互记录（pending / answered / orphaned）。 */
  readonly interactionRecords: Map<string, StoredInteraction>;
  /** pending ask 的 legacy 只读视图；由 `interactionRecords` 派生。 */
  readonly pendingAsks: Map<string, PendingAsk>;
  /** 由 gateway 的 hub 原始订阅调用。 */
  handleEvent(event: RunEvent): void;
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    scope?: PermissionScope,
    actor?: InteractionActor,
  ): PermissionRespondResult;
  respondAsk(
    requestId: string,
    answers: unknown[],
    actor?: InteractionActor,
    context?: AskRespondContext,
  ): AskRespondResult;
  /**
   * 0.52：把「答案已投放」写进记录（幂等标记，`answer.delivered_at`）。
   * 返回 false = 记录不存在或还不是 answered。
   */
  markAnswerDelivered(requestId: string, deliveredAt: number): boolean;
  /**
   * 0.52：从**持久化文件**重读一条记录（只读，不改内存、不改格式）。
   *
   * 用途是「跨进程 / 跨重启兜底」：`interactionRecords` 只在启动 hydrate 时与磁盘
   * 对齐，另一个进程（或本进程重启前的自己）写下的 `answer.delivered_at` 只存在于
   * 文件里。投放前用它确认一次「这条答案是不是已经被投过了」。
   * 读失败 / 无 store 一律返回 undefined（不阻断投放）。
   */
  peekPersistedAnswer(requestId: string): StoredInteraction | undefined;
}

/** 记录上限（防止长时间进程无界增长）；淘汰只碰非 pending。 */
const MAX_RECORDS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function eventTs(event: RunEvent): number {
  return typeof event.ts === 'number' && Number.isFinite(event.ts) && event.ts > 0
    ? event.ts
    : Date.now();
}

/** answers 是模型 / UI 产出的任意 JSON；按结构比较，不按 key 顺序。 */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}

/** `answered_by` 缺省视为 human；非法值（含伪造的 agent）返回 undefined。 */
function readAnsweredBy(value: unknown): 'human' | 'policy' | undefined {
  if (value === undefined) return 'human';
  return value === 'human' || value === 'policy' ? value : undefined;
}

// ── 逐题（问题是一等公民） ────────────────────────────

/** 一条请求里的一道题（题 id + 用来给旧答案兜底匹配的两个文本键）。 */
interface AskQuestionSlot {
  id: string;
  question?: string;
  header?: string;
}

/**
 * 题 id 的**唯一**推导规则：`q1` / `q2` / …（与工具写侧的 `questionIdOfIndex` 同值）。
 *
 * 旧请求（事件里的 `questions[]` 没有 id）与会话里既有的历史记录都靠这一条算回来，
 * 所以「已答 / 未答」对老数据同样成立，不需要迁移。
 */
export function questionIdOfIndex(index: number): string {
  return `q${index + 1}`;
}

/** 把 `input`（= 事件的 `questions`）摊成题槽；不是数组就当作「没有可枚举的题」。 */
function askQuestionSlots(input: unknown): AskQuestionSlot[] {
  if (!Array.isArray(input)) return [];
  return input.map((item, index) => {
    const record = isRecord(item) ? item : {};
    const explicit = nonEmptyString(record.id);
    const question = nonEmptyString(record.question);
    const header = nonEmptyString(record.header);
    return {
      id: explicit ?? questionIdOfIndex(index),
      ...(question !== undefined ? { question } : {}),
      ...(header !== undefined ? { header } : {}),
    };
  });
}

/**
 * 一条答案对应哪道题。
 *
 * 顺序（每步都只看**还没被本次占用**的题，避免两条答案抢同一题）：
 * 1. `question_id`（新客户端 / 新历史，唯一可靠的一步）；
 * 2. `question` 正文全等（旧客户端带了正文，最常见）；
 * 3. `header` 全等（正文被 UI 改写时的兜底）；
 * 4. 第一道没被占用的题（旧客户端一次答完 N 题、按题序发来 —— 位置就是答案）；
 * 5. 都没有 ⇒ undefined（对不上题的答案原样收下，不参与逐题状态）。
 */
function matchQuestionId(
  answer: unknown,
  slots: readonly AskQuestionSlot[],
  taken: ReadonlySet<string>,
): string | undefined {
  const identified = identifyQuestion(answer, slots);
  if (identified !== undefined) return taken.has(identified) ? undefined : identified;
  const free = slots.filter((slot) => !taken.has(slot.id));
  // 位置兜底：旧客户端一次答完 N 题、按题序发来，位置就是答案。
  return free[0]?.id;
}

/**
 * 只按答案自带的身份键认题（不看位置）：`question_id` → `question` 正文 → `header`。
 *
 * 与 {@link matchQuestionId} 分开的理由：判断「这行是不是重复」时不能有位置兜底 ——
 * 一份重复提交的三行答案会被位置兜底全部认成第 1 题，于是 skipped 里出现三个 `q1`。
 */
function identifyQuestion(answer: unknown, slots: readonly AskQuestionSlot[]): string | undefined {
  const record = isRecord(answer) ? answer : {};
  const explicit = nonEmptyString(record.question_id);
  if (explicit !== undefined && slots.some((slot) => slot.id === explicit)) return explicit;
  const question = nonEmptyString(record.question);
  if (question !== undefined) {
    const hit = slots.find((slot) => slot.question === question);
    if (hit !== undefined) return hit.id;
  }
  const header = nonEmptyString(record.header);
  if (header !== undefined) {
    const hit = slots.find((slot) => slot.header === header);
    if (hit !== undefined) return hit.id;
  }
  return undefined;
}

/** 一批提交的逐题计划（纯函数：不碰记录、不落盘，好被测试直接钉）。 */
export interface AskAnswerPlan {
  /** 本批真正新写入的答案（已补上 `question_id`）。 */
  fresh: unknown[];
  /** 已答过、本次被跳过的题 id（幂等，不覆盖）。 */
  skipped: string[];
  /** 合并后已答的题 id（旧 + 本批）。 */
  answered: string[];
  /** 仍未答的题 id。 */
  remaining: string[];
  /** 整条请求是否已全部答完。 */
  final: boolean;
}

/**
 * 把一批答案规划到「题」上。
 *
 * 三条不变量：
 * - **未答的题不会因为别人被答而被带走**：`answered` 只加不减，`remaining` 只减不增；
 * - **同一题不得被答两次**：已答过的题进 `skipped`，不覆盖、不重投；
 * - **没有可枚举的题**（`input` 不是数组 / 空数组）时退回旧语义：本批答案全部算数，
 *   整条请求当场收口 —— 历史记录与异常形状都走这条，行为与分批之前一致。
 */
export function planAskAnswers(
  record: StoredInteraction,
  answers: readonly unknown[],
): AskAnswerPlan {
  const slots = askQuestionSlots(record.input);
  const answeredBefore = record.answered_questions ?? [];
  const taken = new Set(answeredBefore);
  const fresh: unknown[] = [];
  const skipped: string[] = [];

  for (const answer of answers) {
    if (slots.length === 0) {
      fresh.push(answer);
      continue;
    }
    const explicit = isRecord(answer) ? nonEmptyString(answer.question_id) : undefined;
    // 自报题号且这题已答过：这就是重复提交，直接抄进 skipped（不要再猜别的题）。
    if (explicit !== undefined && taken.has(explicit)) {
      skipped.push(explicit);
      continue;
    }
    if (slots.every((slot) => taken.has(slot.id))) {
      // 题已全被答过：任何还来的一行只能是重复（或对不上题的尾巴）。
      // 绝不追加成「新答案」—— 那会让一次双击把整条请求再投一遍。
      const id = explicit ?? identifyQuestion(answer, slots);
      if (id !== undefined) skipped.push(id);
      continue;
    }
    const questionId = matchQuestionId(answer, slots, taken);
    if (questionId === undefined) {
      fresh.push(answer);
      continue;
    }
    taken.add(questionId);
    fresh.push(isRecord(answer) ? { ...answer, question_id: questionId } : answer);
  }

  const answered = slots.map((slot) => slot.id).filter((id) => taken.has(id));
  const remaining = slots.map((slot) => slot.id).filter((id) => !taken.has(id));
  return {
    fresh,
    skipped: [...new Set(skipped)],
    answered,
    remaining,
    final: slots.length === 0 ? true : remaining.length === 0,
  };
}

/** `q3` → 3（题号）；不是这个形状（旧答案 / 手写值）→ undefined。 */
function questionIndexOfId(questionId: string | undefined): number | undefined {
  if (questionId === undefined) return undefined;
  const match = /^q(\d+)$/.exec(questionId);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 累计答案按**题序**排：分批到达的答案在记录里保持「第 1、2、3 题」的顺序，
 * 与到达先后无关（答复卡 / resume 注入 / 模型文本都按这个顺序读）。
 *
 * 认不出题号的答案（旧记录 / 手写）排在最后并保持它们自己的相对顺序 —— 绝不重排
 * 老数据，否则「读旧记录」会和分批之前长得不一样。
 */
function sortAnswersByQuestion(answers: readonly unknown[]): unknown[] {
  const decorated = answers.map((answer, index) => ({
    answer,
    index,
    order: isRecord(answer) ? questionIndexOfId(nonEmptyString(answer.question_id)) : undefined,
  }));
  decorated.sort((left, right) => {
    if (left.order !== undefined && right.order !== undefined && left.order !== right.order) {
      return left.order - right.order;
    }
    if (left.order !== undefined && right.order === undefined) return -1;
    if (left.order === undefined && right.order !== undefined) return 1;
    return left.index - right.index;
  });
  return decorated.map((item) => item.answer);
}

/** 创建交互注册表。 */
export function createInteractionsRegistry(
  options: InteractionsRegistryOptions,
): InteractionsRegistry {
  const { eventsFor, singleTenantId } = options;

  /** 内存 pending 权限索引；真相源是 `interactionRecords`。 */
  const pendingPermissions = new Map<string, PendingPermission>();
  /** requestId → 持久化交互记录（pending / answered / orphaned）。 */
  const interactionRecords = new Map<string, StoredInteraction>();
  /**
   * headless 因等不到人类而挂起的 ask（0.33）。
   *
   * 这类请求的 run 会以 `run.failed` 收口（checkpoint 是 `interrupted`），
   * 不能按普通终态转 `orphaned`——人类稍后仍要回答它。
   */
  const suspendedAskIds = new Set<string>();
  const interactionsStore =
    options.interactionsDir !== undefined && options.interactionsDir !== ''
      ? new InteractionsStore(options.interactionsDir)
      : undefined;

  /** 记录有界：只淘汰非 pending 的记录，绝不丢未应答请求。 */
  function rememberRecord(record: StoredInteraction): void {
    interactionRecords.set(record.requestId, record);
    if (interactionRecords.size <= MAX_RECORDS) return;
    for (const [id, item] of interactionRecords) {
      if (interactionRecords.size <= MAX_RECORDS) break;
      if (item.status !== 'pending') interactionRecords.delete(id);
    }
  }

  /**
   * 落盘串行链（0.33）。
   *
   * `save` 是 fire-and-forget；并发 atomicWrite 可能乱序落盘，
   * 让较早的快照（例如 `suspended` 之前的 ask）覆盖较新的状态。串行化后，
   * 最后一次调用的快照一定最后落盘。
   */
  let persistChain: Promise<void> = Promise.resolve();

  /** 重写交互记录文件；写失败只记 stderr（RPC 不因此失败）。 */
  function persist(): void {
    const store = interactionsStore;
    if (!store) return;
    const records = [...interactionRecords.values()].sort((a, b) => a.created_at - b.created_at);
    const next = persistChain
      .catch(() => undefined)
      .then(() => store.save(singleTenantId, records))
      .catch(() => undefined);
    persistChain = next;
  }

  /**
   * 启动时加载持久化记录。
   *
   * gateway：本进程尚未执行任何 run，加载到的 `pending` 一定没有对应 run，
   * 标记为 `orphaned`，应答返回 `run_ended`，不假装可执行。
   * 离线 attention：`hydratePendingAs: 'pending'`，让 headless run 挂起后
   * 仍可被人类回答（文件是唯一事实源）。
   */
  function hydrateInteractions(): void {
    if (!interactionsStore) return;
    const pendingStatus = options.hydratePendingAs ?? 'orphaned';
    let changed = false;
    for (const loaded of interactionsStore.loadAllSync()) {
      // 0.33：headless 挂起的 ask（suspended）即使重启后也要保持 pending，
      // 否则人类永远答不了、--resume-run 也拿不到答案。
      // 0.52：async ask 同理 —— 它的 run 早就在工具返回后正常结束了，请求仍然有效。
      // 分批：**部分已答**的 ask 也一样 —— 已答的题不许随着重启被孤儿化，
      // 否则「剩下那 1 题」从此再也答不了。
      const keepPending =
        loaded.status === 'pending' &&
        (pendingStatus === 'pending' ||
          (loaded.kind === 'ask' &&
            (loaded.suspended === true ||
              loaded.mode === 'async' ||
              (loaded.answered_questions?.length ?? 0) > 0)));
      const record: StoredInteraction =
        loaded.status === 'pending' && !keepPending
          ? { ...loaded, status: 'orphaned' as StoredInteractionStatus }
          : loaded;
      if (record.status !== loaded.status) changed = true;
      interactionRecords.set(record.requestId, record);
    }
    if (changed) persist();
  }

  hydrateInteractions();

  /** 应答投递目标：单运行时流（工具 / 权限策略正在等它）。 */
  function answerStream(): EventStream {
    const stream = eventsFor();
    if (stream === undefined) {
      throw new RpcError('run_ended', 'Runtime event stream is no longer available');
    }
    return stream;
  }

  /** 这条记录是不是「部分已答」（还有题在等人）。 */
  function hasPartialAnswers(record: StoredInteraction): boolean {
    return (record.answered_questions?.length ?? 0) > 0;
  }

  /** 一批答案（`ask.respond` 或流上的 `ask.user.answered` 都是这一形状）。 */
  interface AnswerBatch {
    answers: unknown[];
    answered_at: number;
    answered_by: 'human' | 'policy';
    answered_via?: StoredInteractionAnswer['answered_via'];
    latency_ms?: number;
    batch_id?: string;
  }

  /** 收口结果：本批真的写进去了什么 + 逐题进度。 */
  interface SettleOutcome extends AskAnswerPlan {
    /** false = 幂等重放 / 全部重复：一个字节都没改，也没有投递。 */
    applied: boolean;
  }

  /**
   * 答案写入的唯一收口：**逐题**累积 + 按题幂等 + 只在需要时通知投放。
   *
   * 批量语义（用户裁决）：
   * - 一次提交只写「这次答了的题」，其余题**仍是 `pending`**（这就是「未答的题不能被
   *   提交带走」的落点：状态机不新增档，pending + `answered_questions` 就够了）；
   * - 同一题重复提交不覆盖、不重投，进 `skipped`；
   * - 全部题答完才 `pending → answered`（这时才写 `answer.delivered_at`，
   *   见 `markAnswerDelivered` —— gateway 那边现成的「终结后不再重投」因此自动成立）。
   *
   * 投放通知的判据（为什么不是「每次迁移」）：
   * - **拒绝回答**（`answers: []`）：整条收口，照旧通知（旧行为）；
   * - `async`：每一批都要通知（提问的 run 早就结束了，没人等着接答案）；
   * - `sync`：**第一批不通知** —— 它由还在 `waitFor` 的 ask 工具当场取走，再投一次就是
   *   同一批答案两份（模型读两遍、还多起一次 run）。从第二批起工具已经返回了，
   *   只能走 inbox 消息，所以通知。
   *
   * 幂等靠 `planAskAnswers` 的 `fresh`：两条应答路径（RPC 与流上回声）都调这里，第二次
   * 拿到的 `fresh` 一定是空的 —— 既不会重复投放，也不需要「是否仍 pending」这种和状态
   * 绑死的判定（分批之后 pending 不再是「还没人答」的意思）。
   */
  function settleAnswer(record: StoredInteraction, batch: AnswerBatch): SettleOutcome {
    const current = interactionRecords.get(record.requestId) ?? record;
    const declined = batch.answers.length === 0;
    const plan = planAskAnswers(current, batch.answers);
    const applied = plan.fresh.length > 0 || (declined && current.status === 'pending');
    if (!applied) return { ...plan, applied: false };

    // 拒绝回答（`answers: []`）不清空已记录的答案：人先前答过的那几题是事实，抹掉它
    // 等于让答复记录变成「什么都没答」。投递层看的是 `batch_answers`（拒绝时为空）→
    // 模型仍然读到「人类拒绝回答」那句原文。
    const mergedAnswers = declined
      ? (current.answer?.answers ?? [])
      : sortAnswersByQuestion([...(current.answer?.answers ?? []), ...plan.fresh]);
    const answer: StoredInteractionAnswer = {
      ...(current.answer ?? {}),
      answered_at: batch.answered_at,
      answered_by: batch.answered_by,
      ...(batch.answered_via !== undefined ? { answered_via: batch.answered_via } : {}),
      ...(batch.latency_ms !== undefined ? { latency_ms: batch.latency_ms } : {}),
      ...(batch.batch_id !== undefined ? { batch_id: batch.batch_id } : {}),
      answers: mergedAnswers,
      // 本批新增的那些：投放只该带这一批，否则第二批会重发第一批的答案。
      batch_answers: declined ? [] : plan.fresh,
    };
    const final = declined || plan.final;
    const next: StoredInteraction = {
      ...current,
      status: final ? ('answered' as const) : ('pending' as const),
      answered_questions: plan.answered,
      answer,
    };
    if (final) suspendedAskIds.delete(current.requestId);
    rememberRecord(next);
    persist();

    const wasAnsweredBefore = hasPartialAnswers(current);
    const shouldDeliver =
      declined ||
      (plan.fresh.length > 0 &&
        (current.kind ?? 'permission') === 'ask' &&
        (current.mode === 'async' || wasAnsweredBefore));
    if (shouldDeliver) options.onAsyncAskAnswered?.(next);
    return { ...plan, final, applied: true };
  }

  /** 直接发布到流上的应答（TUI / policy 定时器）也要落审计；不重新发布。 */
  function recordStreamResponse(event: RunEvent): void {
    const data = isRecord(event.data) ? event.data : {};
    const requestId = nonEmptyString(data.requestId);
    if (requestId === undefined) return;
    const record = interactionRecords.get(requestId);
    if (record === undefined || record.status !== 'pending') return;
    const isAsk = event.type === 'ask.user.answered';
    if (((record.kind ?? 'permission') === 'ask') !== isAsk) return;
    const answeredBy = readAnsweredBy(data.answered_by);
    // 非法归属（含伪造的 agent）不得写进审计。
    if (answeredBy === undefined) return;
    const answers = Array.isArray(data.answers) ? data.answers : undefined;
    const decision =
      data.decision === 'allow' || data.decision === 'deny' ? data.decision : undefined;
    if (isAsk) {
      if (answers === undefined) return;
    } else if (decision === undefined) {
      return;
    }

    const answeredAt = eventTs(event);
    const rawScope = data.scope;
    const scope: PermissionScope =
      rawScope === 'once' || rawScope === 'session' || rawScope === 'always' ? rawScope : 'once';
    const answeredVia =
      data.answered_via === 'tui' ||
      data.answered_via === 'rpc' ||
      data.answered_via === 'cli' ||
      data.answered_via === 'policy'
        ? data.answered_via
        : undefined;
    const policy =
      data.policy === 'deny_after' || data.policy === 'auto_allow' ? data.policy : undefined;
    const batchId = nonEmptyString(data.batch_id);
    const latency = Math.max(0, answeredAt - record.created_at);
    pendingPermissions.delete(requestId);
    if (!isAsk) {
      settlePermission(record, {
        decision: decision as 'allow' | 'deny',
        scope,
        answered_at: answeredAt,
        answered_by: answeredBy,
        latency_ms: latency,
        ...(answeredVia !== undefined ? { answered_via: answeredVia } : {}),
        ...(policy !== undefined ? { policy } : {}),
      });
      return;
    }
    settleAnswer(record, {
      answers: answers as unknown[],
      answered_at: answeredAt,
      answered_by: answeredBy,
      latency_ms: latency,
      ...(answeredVia !== undefined ? { answered_via: answeredVia } : {}),
      ...(batchId !== undefined ? { batch_id: batchId } : {}),
    });
  }

  /**
   * 权限应答的收口（`answered` 是唯一终态，没有逐题概念）。
   *
   * 与 ask 的 {@link settleAnswer} 分家：权限没有「部分已答」，把两者塞进一个函数
   * 会让 `planAskAnswers` 的逐题语义渗进只看 `decision` 的权限记录里。
   */
  function settlePermission(record: StoredInteraction, answer: StoredInteractionAnswer): void {
    suspendedAskIds.delete(record.requestId);
    rememberRecord({ ...record, status: 'answered' as const, answer });
    persist();
  }

  function handleEvent(event: RunEvent): void {
    if (event.type === 'tool.permission.request') {
      const data = isRecord(event.data) ? event.data : {};
      const requestId = nonEmptyString(data.requestId);
      if (requestId !== undefined) {
        const requestTs = eventTs(event);
        const tool = typeof data.tool === 'string' ? data.tool : 'tool';
        const sessionId = nonEmptyString(data.session_id);
        const toolCallId = nonEmptyString(data.tool_call_id);
        const parentAgentId = nonEmptyString(data.parent_agent_id);
        const agentId = nonEmptyString(data.agent_id);
        const teamId = nonEmptyString(data.team_id);
        const deadlineAt =
          typeof data.deadline_at === 'number' &&
          Number.isFinite(data.deadline_at) &&
          data.deadline_at > 0
            ? data.deadline_at
            : undefined;
        pendingPermissions.set(requestId, {
          run_id: event.run_id,
          tool,
          input: data.input,
          ts: requestTs,
          ...(deadlineAt !== undefined ? { deadline_at: deadlineAt } : {}),
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
          ...(parentAgentId !== undefined ? { parent_agent_id: parentAgentId } : {}),
          ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
          ...(typeof data.source === 'string' && data.source.length > 0
            ? { source: data.source }
            : {}),
        });
        rememberRecord({
          requestId,
          run_id: event.run_id,
          kind: 'permission',
          ...(agentId !== undefined ? { agent_id: agentId } : {}),
          ...(teamId !== undefined ? { team_id: teamId } : {}),
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
          ...(parentAgentId !== undefined ? { parent_agent_id: parentAgentId } : {}),
          ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
          tool,
          input: data.input,
          created_at: requestTs,
          status: 'pending',
        });
        persist();
      }
      return;
    }
    if (event.type === 'ask.user.requested') {
      const data = isRecord(event.data) ? event.data : {};
      const requestId = nonEmptyString(data.requestId);
      if (requestId !== undefined) {
        const sessionId = nonEmptyString(data.session_id);
        const parentAgentId = nonEmptyString(data.parent_agent_id);
        const agentId = nonEmptyString(data.agent_id);
        const teamId = nonEmptyString(data.team_id);
        const toolCallId = nonEmptyString(data.tool_call_id);
        rememberRecord({
          requestId,
          run_id: event.run_id,
          kind: 'ask',
          ...(agentId !== undefined ? { agent_id: agentId } : {}),
          ...(teamId !== undefined ? { team_id: teamId } : {}),
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
          ...(parentAgentId !== undefined ? { parent_agent_id: parentAgentId } : {}),
          ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
          // 0.52：投递语义跟着请求走；缺省不写该键 = sync（旧事件逐字节不变）。
          ...(data.mode === 'async' ? { mode: 'async' as const } : {}),
          // 读侧兜底：事件没带 tool 时按现行工具名写；历史事件里该字段是 `ask_user`，
          // 原样保留（记录只被读、不被比较）。
          tool: typeof data.tool === 'string' && data.tool.length > 0 ? data.tool : 'ask',
          input: data.questions,
          created_at: eventTs(event),
          status: 'pending',
        });
        persist();
      }
      return;
    }
    if (event.type === 'ask.user.timeout') {
      // headless 等不到人类：run 即将以 `interrupted` 收口。标住 requestId，
      // 下面的终态清理会保留它以等待迟到的回答；同时把 suspended 写进记录，
      // 让下一个 gateway 进程启动 hydrate 时也不把它转 orphaned。
      const data = isRecord(event.data) ? event.data : {};
      const requestId = nonEmptyString(data.requestId);
      if (requestId !== undefined) {
        suspendedAskIds.add(requestId);
        const record = interactionRecords.get(requestId);
        if (
          record !== undefined &&
          record.status === 'pending' &&
          (record.kind ?? 'permission') === 'ask' &&
          record.suspended !== true
        ) {
          rememberRecord({ ...record, suspended: true });
          persist();
        }
      }
      return;
    }
    if (event.type === 'tool.permission.response' || event.type === 'ask.user.answered') {
      recordStreamResponse(event);
      return;
    }
    if (
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled'
    ) {
      // run 终态：该 run 的 pending（permission + ask）全部转 orphaned；
      // 迟到应答返回 run_ended，不再假装可以继续。
      for (const [id, record] of interactionRecords) {
        if (record.status !== 'pending' || record.run_id !== event.run_id) continue;
        if ((record.kind ?? 'permission') === 'ask') {
          // headless ask 的 run 以 interrupted 收口：请求仍然有效，保留 pending。
          if (suspendedAskIds.has(id)) continue;
          // 0.52：async ask 的 run 在工具返回后照常收口，请求本身还没被回答 —— 保留 pending。
          if (record.mode === 'async') continue;
          // 分批：**部分已答**的 ask 也保留 —— 提问的 run 已经拿到首批答案继续跑了，
          // 剩下那几题还在等人；孤儿化会让「第 3 题」永远答不了。
          if (hasPartialAnswers(record)) continue;
        }
        pendingPermissions.delete(id);
        rememberRecord({ ...record, status: 'orphaned' as StoredInteractionStatus });
      }
      persist();
    }
  }

  function respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    scope?: PermissionScope,
    actor?: InteractionActor,
  ): PermissionRespondResult {
    // scope 优先；remember 是旧客户端的兼容写法（等价 always）。
    const resolvedScope: PermissionScope = scope ?? (remember ? 'always' : 'once');
    const attribution: InteractionActor = actor ?? { answered_by: 'human' };
    const pending = pendingPermissions.get(requestId);
    if (pending !== undefined) {
      const record = interactionRecords.get(requestId);
      const now = Date.now();
      const latency = Math.max(0, now - (record?.created_at ?? pending.ts));
      // 先投递；流缺失抛 run_ended，pending 保持不变（迟到的流仍可重试）。
      answerStream().publish({
        type: 'tool.permission.response',
        run_id: pending.run_id,
        data: {
          requestId,
          decision,
          scope: resolvedScope,
          ...(resolvedScope === 'always' ? { remember: true } : {}),
          ...(pending.session_id !== undefined ? { session_id: pending.session_id } : {}),
          answered_by: attribution.answered_by,
          ...(attribution.answered_via !== undefined
            ? { answered_via: attribution.answered_via }
            : {}),
          latency_ms: latency,
          ...(record?.team_id !== undefined ? { team_id: record.team_id } : {}),
        },
        ts: now,
      });
      pendingPermissions.delete(requestId);
      rememberRecord({
        ...(record ?? {
          requestId,
          run_id: pending.run_id,
          kind: 'permission' as const,
          tool: pending.tool,
          input: pending.input,
          created_at: pending.ts,
        }),
        status: 'answered',
        answer: {
          decision,
          scope: resolvedScope,
          answered_at: now,
          answered_by: attribution.answered_by,
          ...(attribution.answered_via !== undefined
            ? { answered_via: attribution.answered_via }
            : {}),
          latency_ms: latency,
        },
      });
      persist();
      return {
        ok: true,
        decision,
        scope: resolvedScope,
        ...(actor !== undefined
          ? {
              answered_by: attribution.answered_by,
              ...(attribution.answered_via !== undefined
                ? { answered_via: attribution.answered_via }
                : {}),
              latency_ms: latency,
              ...(record?.team_id !== undefined ? { team_id: record.team_id } : {}),
            }
          : {}),
      };
    }

    // 幂等：首次应答生效，重复应答返回上次结果（不发布新事件）。
    const record = interactionRecords.get(requestId);
    if (record !== undefined) {
      if (record.status === 'answered' && record.answer !== undefined) {
        if (record.answer.decision !== decision) {
          throw new RpcError(
            'conflict',
            `Permission request already answered as ${record.answer.decision}: ${requestId}`,
          );
        }
        return {
          ok: true,
          decision,
          scope: record.answer.scope ?? 'once',
          duplicate: true,
          ...(actor !== undefined
            ? {
                answered_by: record.answer.answered_by ?? 'human',
                ...(record.answer.answered_via !== undefined
                  ? { answered_via: record.answer.answered_via }
                  : {}),
                ...(record.answer.latency_ms !== undefined
                  ? { latency_ms: record.answer.latency_ms }
                  : {}),
                ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
              }
            : {}),
        };
      }
      // run 已终止 / 进程重启后找不到 run：明确告知，不伪装成 not_found。
      throw new RpcError(
        'run_ended',
        `Run has ended; permission request is no longer valid: ${requestId}`,
        {
          status: record.status === 'pending' ? 'orphaned' : record.status,
          run_id: record.run_id,
          requestId,
        },
      );
    }

    throw new RpcError('not_found', `Permission request not found: ${requestId}`);
  }

  function respondAsk(
    requestId: string,
    answers: unknown[],
    actor?: InteractionActor,
    context?: AskRespondContext,
  ): AskRespondResult {
    const attribution: InteractionActor = actor ?? { answered_by: 'human' };
    const record = interactionRecords.get(requestId);
    if (record === undefined || (record.kind ?? 'permission') !== 'ask') {
      throw new RpcError('not_found', `Ask request not found: ${requestId}`);
    }
    const batchId =
      context?.batch_id !== undefined && context.batch_id !== '' ? context.batch_id : undefined;
    if (record.status === 'pending') {
      const now = Date.now();
      const latency = Math.max(0, now - record.created_at);
      const declined = answers.length === 0;
      const plan = planAskAnswers(record, answers);
      if (!declined && plan.fresh.length === 0) {
        // 每一题都已经答过：这是幂等重放（双击 / 多端重复提交）。
        // 不发事件、不落盘、不投放 —— 只把「跳过了哪些题」明确回给调用方，
        // 免得前端把一次重复提交当成「又答了一遍」。
        return {
          ok: true,
          duplicate: true,
          answered_by: attribution.answered_by,
          ...(attribution.answered_via !== undefined
            ? { answered_via: attribution.answered_via }
            : {}),
          latency_ms: Math.max(0, now - (record.answer?.answered_at ?? record.created_at)),
          ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
          answered_questions: [],
          remaining_questions: plan.remaining,
          // 旧客户端的三行答案认不出题（没有 question_id 也没有题序可依）时，
          // 用「已答的题」回答「跳过的题」—— 语义上就是那几题不重复记录。
          skipped_questions: plan.skipped.length > 0 ? plan.skipped : plan.answered,
          final: plan.final,
        };
      }
      // 直接投递到单运行时流（ask 工具在那里等待）。
      //
      // 注意：这次 publish 是**同步**扇出的 —— 原始订阅者（hub → gateway → 本注册表）
      // 会立刻走 `recordStreamResponse` → `settleAnswer`，也就是「流上回声」这一次才是
      // 真正落记录 + 通知投放。下面那次 `settleAnswer` 用的是 publish 之前的快照，
      // 它被 `fresh` 幂等判定挡成重放（`applied: false`），不会二次投放。
      //
      // 事件里只带**本批**答案（`plan.fresh`）：`final: false` 时它就是「先答了这几题」，
      // 未答的题仍在待批队列；工具拿到这一批就返回，不等其余题。
      answerStream().publish({
        type: 'ask.user.answered',
        run_id: record.run_id,
        data: {
          requestId,
          answers: declined ? [] : plan.fresh,
          final: declined || plan.final,
          ...(declined || plan.final ? {} : { remaining: plan.remaining }),
          ...(batchId !== undefined ? { batch_id: batchId } : {}),
          ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
          answered_by: attribution.answered_by,
          ...(attribution.answered_via !== undefined
            ? { answered_via: attribution.answered_via }
            : {}),
          latency_ms: latency,
          ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
        },
        ts: now,
      });
      // publish 之后的本地兜底：装配里没有原始订阅者时（离线 attention / 测试）要靠
      // 这一句落记录。`settleAnswer` 自己按 `fresh` 幂等，所以回声已落盘时它是空操作。
      settleAnswer(record, {
        answers: declined ? [] : plan.fresh,
        answered_at: now,
        answered_by: attribution.answered_by,
        ...(attribution.answered_via !== undefined
          ? { answered_via: attribution.answered_via }
          : {}),
        latency_ms: latency,
        ...(batchId !== undefined ? { batch_id: batchId } : {}),
      });
      // 返回体描述的是**这次提交**写成了什么（不是上面那次空转）：题号来自本批的规划，
      // 其余字段以落定后的记录为准。客户端据此决定「卡片还能不能收」。
      const answeredBefore = new Set(record.answered_questions ?? []);
      const writtenNow = declined ? [] : plan.answered.filter((id) => !answeredBefore.has(id));
      return {
        ok: true,
        answered_by: attribution.answered_by,
        ...(attribution.answered_via !== undefined
          ? { answered_via: attribution.answered_via }
          : {}),
        latency_ms: latency,
        ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
        answered_questions: writtenNow,
        remaining_questions: declined ? [] : plan.remaining,
        ...(plan.skipped.length > 0 ? { skipped_questions: plan.skipped } : {}),
        final: declined || plan.final,
      };
    }
    if (record.status === 'answered') {
      // 已收口的请求：同题再来 = 幂等（duplicate + skipped）；不同答案仍是冲突。
      const plan = planAskAnswers(record, answers);
      const recordedAnswers = record.answer?.answers ?? [];
      const sameAnswers = jsonEqual(recordedAnswers, answers);
      // 逐题幂等：这一批里一题都没新增，且至少认出了一题是「已答过」的。
      const perQuestionDuplicate = plan.fresh.length === 0 && plan.skipped.length > 0;
      if (sameAnswers || perQuestionDuplicate) {
        return {
          ok: true,
          duplicate: true,
          answered_by: record.answer?.answered_by ?? 'human',
          ...(record.answer?.answered_via !== undefined
            ? { answered_via: record.answer.answered_via }
            : {}),
          ...(record.answer?.latency_ms !== undefined
            ? { latency_ms: record.answer.latency_ms }
            : {}),
          ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
          answered_questions: [],
          remaining_questions: [],
          ...(plan.skipped.length > 0 ? { skipped_questions: plan.skipped } : {}),
          final: true,
        };
      }
      throw new RpcError(
        'conflict',
        `Ask request already answered with different answers: ${requestId}`,
      );
    }
    throw new RpcError('run_ended', `Run has ended; ask request is no longer valid: ${requestId}`, {
      status: record.status,
      run_id: record.run_id,
      requestId,
    });
  }

  /**
   * 0.52：async 答案投放成功后写幂等标记（`answer.delivered_at`）。
   *
   * 只认已经 answered 的记录；返回 false 表示没有可标记的状态（记录不存在 /
   * 还没答完 / 已被别处投放）。重复应答时调用方据此跳过第二次投放。
   *
   * **分批的一部分**：部分已答的记录仍是 `pending`（还有题在等人），这里于是拒写标记 ——
   * 下一批答案因此还能再投一次。这不是漏洞，正是「每批各投一次」的实现方式：
   * 整条请求一收口（`answered`）就写标记，终结之后的重复应答不再重投。
   */
  function markAnswerDelivered(requestId: string, deliveredAt: number): boolean {
    const record = interactionRecords.get(requestId);
    if (record === undefined || record.status !== 'answered' || record.answer === undefined) {
      return false;
    }
    if (record.answer.delivered_at !== undefined) return true;
    rememberRecord({ ...record, answer: { ...record.answer, delivered_at: deliveredAt } });
    persist();
    return true;
  }

  /**
   * 0.52：从磁盘重读一条记录（只读；见接口注释里的跨进程用途）。
   *
   * 整文件读一次而不是缓存：这条路径每次 async 答案最多走一次，换「永不陈旧」。
   * 任何读失败都当作「没有这条记录」，不阻断投放（宁可多投一次也不丢答案）。
   */
  function peekPersistedAnswer(requestId: string): StoredInteraction | undefined {
    const store = interactionsStore;
    if (store === undefined) return undefined;
    try {
      return store.loadAllSync().find((record) => record.requestId === requestId);
    } catch (error) {
      console.warn('[vessel] interactions: persisted record reload failed', {
        request_id: requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** pending ask 只读视图：从 interactionRecords 派生，不维护第二份状态。 */
  function pendingAskView(): Map<string, PendingAsk> {
    const view = new Map<string, PendingAsk>();
    for (const [requestId, record] of interactionRecords) {
      if ((record.kind ?? 'permission') !== 'ask' || record.status !== 'pending') continue;
      view.set(requestId, {
        run_id: record.run_id,
        ts: record.created_at,
        ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
        ...(record.parent_agent_id !== undefined
          ? { parent_agent_id: record.parent_agent_id }
          : {}),
        ...(record.input !== undefined ? { questions: record.input } : {}),
      });
    }
    return view;
  }

  return {
    pendingPermissions,
    interactionRecords,
    get pendingAsks() {
      return pendingAskView();
    },
    handleEvent,
    respondPermission,
    respondAsk,
    markAnswerDelivered,
    peekPersistedAnswer,
  };
}

/** 导出给 web / 测试使用的状态类型别名。 */
export type { StoredInteraction, StoredInteractionStatus };
