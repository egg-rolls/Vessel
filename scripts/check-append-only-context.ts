#!/usr/bin/env bun

/**
 * append-only 上下文门禁：「同一会话落盘的 messages 只能 append，唯一的 pop 是压缩摘要替换」。
 *
 * 用户裁定（0.52）：落盘到 message 里的东西都不要动 —— 像堆栈一样只能 pop 或 append。
 * 身份 / 工具 / 模型 / 提示词变更一律以「追加一条环境信息」表达，**不得**改写已落盘消息。
 *
 * 三层判据，缺任何一层都会留下「看着对、其实在偷偷重写历史」的路：
 *
 * - **C0 判据自检**：先用构造快照证明判据既放行合法 append、也逮得住静默重写。没有这一层，
 *   判据可能退化成永远返回 OK 的空壳 —— 那种门禁比没有门禁更坏（它给的是虚假的安全感）。
 * - **C1 真实路径实测**：驱动**真 core**（`ExecutionUnit` + `createRunJournalFactory` + 内存
 *   SessionStore / 事件日志），把每一次 `SessionState` 落盘抓成快照，逐对比较：后一份的前 N
 *   条必须与前一份**逐字相同**；出现分歧时只认 `context.compacted` / `message.compaction`
 *   作凭据，且必须有**新的**压缩摘要顶上、幸存的尾部消息逐字不变。
 * - **C2 静态钉住**：环境信息的制造者（身份 / 工具 / 模型）只能往尾部追加 —— 不得删改上下文
 *   数组、不得写 system 消息、不得新造事件类型。C1 只能测「我跑过的路径」，C2 防的是
 *   「以后有人在别处加一条重写」。
 * - **C3 词表对拍**：环境信息的 scope 词表以 `packages/agent/src/env-info-scope.ts` 为唯一
 *   真相，Web 的 `ENV_NOTICE_SCOPES` 必须认得出每一个词（漏一个 = 那条卡静默退化成
 *   「上下文」，最难发现的那种坏）。
 *
 * 用法：bun run scripts/check-append-only-context.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ENV_NOTICE_SCOPES } from '../apps/web/src/domains/chat/env-notice';
import { ENV_INFO_SCOPES } from '../packages/agent/src/env-info-scope';
import {
  createRunJournalFactory,
  ExecutionUnit,
  MemoryEventStream,
  MemoryLLMProvider,
  MemorySessionStore,
  MemoryWorkingContext,
  type Message,
  type SessionEventInput,
  type SessionEventLogPort,
  type SessionEventRecord,
  type SessionState,
  withClearedToolResults,
} from '../packages/core/src/index';

const REPO = join(import.meta.dir, '..');

const failures: string[] = [];
/** 通过项只计数（门禁输出要能一眼看出跑了多少项，而不是「没输出 = 通过」）。 */
let passed = 0;
/** C1 跑过的路径清单（报告里要用：哪些路径实测满足、哪些没有覆盖）。 */
const paths: string[] = [];

function ok(label: string): void {
  passed += 1;
  paths.push(`OK   ${label}`);
}

function fail(where: string, message: string): void {
  failures.push(`${where}: ${message}`);
}

// ───────────────────────── C0 判据 ─────────────────────────

/** 一条消息的「逐字」指纹：键序无关的规范化 JSON（同一份内容必须给同一个串）。 */
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${fingerprint(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** 一份落盘快照：消息 + 它覆盖到的事件游标（`derived_upto_seq`）。 */
interface Snapshot {
  cursor: number;
  messages: Message[];
}

/** 两次落盘之间的比较结论。 */
type Verdict =
  | { kind: 'append'; grown: number }
  | { kind: 'compaction'; evidence: string[]; dropped: number }
  | { kind: 'violation'; why: string };

/** 压缩凭据：只有这两类事件能解释「前缀被替换」。 */
const COMPACTION_EVIDENCE: ReadonlySet<string> = new Set([
  'context.compacted',
  'message.compaction',
]);

/**
 * 两次落盘之间的凭据。
 *
 * 除了「有没有压缩事件」，还要看它说了什么：`message.compaction` 的
 * `cleared_tool_call_ids` 是压缩顺手清空旧工具结果的审计记录。**只有它点名的那些
 * tool_call_id 才允许内容变**——剩下的任何内容变化都是重写，凭据解释不了。
 */
interface Evidence {
  readonly types: readonly string[];
  readonly clearedToolCallIds: ReadonlySet<string>;
}

const NO_EVIDENCE: Evidence = { types: [], clearedToolCallIds: new Set() };

function evidenceOf(records: readonly SessionEventRecord[]): Evidence {
  const cleared = new Set<string>();
  for (const record of records) {
    if (record.type !== 'message.compaction') continue;
    const data = record.data as Record<string, unknown> | null | undefined;
    const ids = data?.cleared_tool_call_ids;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string') cleared.add(id);
    }
  }
  return { types: records.map((record) => record.type), clearedToolCallIds: cleared };
}

function isSummary(message: Message | undefined): boolean {
  return message?.role === 'system' && message.compaction_summary === true;
}

/**
 * 两份落盘快照 → 结论。
 *
 * 判据只有三条：
 * 1. 前缀逐字相同、尾部变长（或不变）⇒ append（唯一常态）；
 * 2. 出现分歧 ⇒ 必须能在 (prev.cursor, next.cursor] 之间找到压缩事件 —— 凭据；
 * 3. 有凭据时还要形状对：新的压缩摘要顶上、原先的 system 前缀原样保留、幸存的尾部消息
 *    **逐字不变**。压缩只能整段 pop + 摘要 append，**不许改留下的内容**（0.52 用户裁定：
 *    占位替换已搬到请求构建层，所以落盘序列上再没有「改内容」的正当理由）。
 */
function compareSnapshots(prev: Snapshot, next: Snapshot, evidence: Evidence): Verdict {
  const prevPrint = prev.messages.map(fingerprint);
  const nextPrint = next.messages.map(fingerprint);
  let divergence = 0;
  while (
    divergence < prevPrint.length &&
    divergence < nextPrint.length &&
    prevPrint[divergence] === nextPrint[divergence]
  ) {
    divergence += 1;
  }

  if (divergence === prevPrint.length) {
    // 前缀完整保留。短了就等于是「纯 pop」—— 没有压缩凭据的删除同样违规。
    if (nextPrint.length < prevPrint.length) {
      return { kind: 'violation', why: `纯 pop（${prevPrint.length} → ${nextPrint.length} 条）` };
    }
    return { kind: 'append', grown: nextPrint.length - prevPrint.length };
  }

  const compactionEvidence = evidence.types.filter((type) => COMPACTION_EVIDENCE.has(type));
  if (compactionEvidence.length === 0) {
    return {
      kind: 'violation',
      why: `第 ${divergence + 1} 条起被改写，但 (seq ${prev.cursor}, ${next.cursor}] 里没有压缩事件`,
    };
  }

  const summaryIndex = next.messages.findIndex((message) => isSummary(message));
  if (summaryIndex < 0) {
    return { kind: 'violation', why: '有压缩事件，但新的落盘窗口里找不到压缩摘要（角色 system）' };
  }
  const nextSummary = next.messages[summaryIndex];
  const prevSummaries = new Set(
    prev.messages.filter((message) => isSummary(message)).map(fingerprint),
  );
  if (nextSummary !== undefined && prevSummaries.has(fingerprint(nextSummary))) {
    return { kind: 'violation', why: '压缩事件之后摘要没有更新（凭据与落盘对不上）' };
  }

  // system 前缀原样保留（压缩只会把摘要插在 system 之后，不会改系统消息）。
  const prevSystems = prev.messages.filter(
    (message) => message.role === 'system' && !isSummary(message),
  );
  const nextSystems = next.messages.filter(
    (message) => message.role === 'system' && !isSummary(message),
  );
  if (prevSystems.length > nextSystems.length) {
    return {
      kind: 'violation',
      why: `压缩丢了 ${String(prevSystems.length - nextSystems.length)} 条 system 消息`,
    };
  }
  for (let index = 0; index < prevSystems.length; index += 1) {
    if (fingerprint(prevSystems[index]) !== fingerprint(nextSystems[index])) {
      return { kind: 'violation', why: `第 ${index + 1} 条 system 消息被改写` };
    }
  }

  // 幸存尾部必须逐字不变：压缩只能「删掉被摘要的那一段」，不能顺手改留下的内容。
  const kept = next.messages.slice(summaryIndex + 1).filter((message) => message.role !== 'system');
  const before = prev.messages.filter(
    (message) => message.role !== 'system' && !isSummary(message),
  );
  const tailStart = before.length - kept.length;
  if (tailStart < 0) {
    return { kind: 'violation', why: '压缩后幸存的尾部比压缩前更长（凭据解释不了）' };
  }
  for (let index = 0; index < kept.length; index += 1) {
    const after = kept[index];
    const prior = before[tailStart + index];
    if (fingerprint(prior) === fingerprint(after)) continue;
    return {
      kind: 'violation',
      why: `压缩改写了幸存消息第 ${index + 1} 条（压缩只能删，不能改留下的内容）`,
    };
  }
  return {
    kind: 'compaction',
    evidence: [...compactionEvidence],
    dropped: prevPrint.length - nextPrint.length,
  };
}

// ───────────────────────── C1 真实路径 ─────────────────────────

/** 内存事件日志（`SessionEventLogPort` 的最小实现：只追加 + 按 seq 读）。 */
class MemoryEventLog implements SessionEventLogPort {
  private readonly bySession = new Map<string, SessionEventRecord[]>();

  records(sessionId: string): SessionEventRecord[] {
    return this.bySession.get(sessionId) ?? [];
  }

  /** 事件记录（按 seq 升序）落在 (from, to] 区间里的那一段。 */
  eventsBetween(sessionId: string, from: number, to: number): SessionEventRecord[] {
    return this.records(sessionId).filter((record) => record.seq > from && record.seq <= to);
  }

  async append(input: SessionEventInput): Promise<SessionEventRecord> {
    const list = this.records(input.session_id);
    const previous = list.length === 0 ? 0 : (list[list.length - 1]?.seq ?? 0);
    const record: SessionEventRecord = { ...input, v: 1, seq: previous + 1 };
    list.push(record);
    this.bySession.set(input.session_id, list);
    return record;
  }

  async read(
    sessionId: string,
    opts?: { sinceSeq?: number; limit?: number },
  ): Promise<SessionEventRecord[]> {
    const since = opts?.sinceSeq ?? 0;
    const list = this.records(sessionId).filter((record) => record.seq > since);
    return opts?.limit === undefined ? list : list.slice(0, opts.limit);
  }

  lastPersistedSeq(sessionId: string): number | undefined {
    const list = this.records(sessionId);
    return list.length === 0 ? undefined : list[list.length - 1]?.seq;
  }

  async lastSeq(sessionId: string): Promise<number | undefined> {
    return this.lastPersistedSeq(sessionId);
  }

  async flush(): Promise<void> {
    // 内存实现没有写队列：append 已是同步生效。
  }
}

/** 会记下每一次落盘的 SessionStore（`messages` 深拷贝：内存后端是浅拷贝，会串）。 */
class RecordingSessionStore extends MemorySessionStore {
  readonly saves: Snapshot[] = [];

  override async save(state: SessionState): Promise<void> {
    await super.save(state);
    this.saves.push({
      cursor: state.derived_upto_seq ?? 0,
      messages: structuredClone(state.messages ?? []),
    });
  }
}

interface Stack {
  eu: ExecutionUnit;
  store: RecordingSessionStore;
  log: MemoryEventLog;
  events: MemoryEventStream;
}

/** 装配一套真 core（唯一假件是 provider：它按脚本回答，不联网）。 */
async function newStack(): Promise<Stack> {
  const provider = new MemoryLLMProvider();
  const events = new MemoryEventStream();
  const log = new MemoryEventLog();
  const store = new RecordingSessionStore();
  const eu = await ExecutionUnit.create({
    provider,
    model: 'probe-model',
    contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
    events,
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({ session: store, eventLog: log }),
    session: store,
    eventLog: log,
    systemPrompt: 'append-only probe system prompt',
    // 重试会掩盖并发/顺序问题；门禁要的是确定性。
    retry: { maxRetries: 0 },
  });
  return { eu, store, log, events };
}

/** 等到条件成立（journal 的写是异步排队的，`appendNotice` 又是 fire-and-forget）。 */
async function waitUntil(predicate: () => boolean, hint: string): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fail('C1', `等待超时：${hint}`);
}

/** 一段路径的落盘序列逐对比较。 */
function verifySequence(label: string, stack: Stack, from: number, sessionId: string): void {
  const saves = stack.store.saves;
  for (let index = from + 1; index < saves.length; index += 1) {
    const prev = saves[index - 1];
    const next = saves[index];
    if (prev === undefined || next === undefined) continue;
    const evidence = evidenceOf(stack.log.eventsBetween(sessionId, prev.cursor, next.cursor));
    const verdict = compareSnapshots(prev, next, evidence);
    if (verdict.kind === 'violation') {
      fail(
        label,
        `第 ${index} → ${index + 1} 份落盘违规：${verdict.why}` +
          `（${prev.messages.length} 条 → ${next.messages.length} 条，游标 ${prev.cursor} → ${next.cursor}）`,
      );
      return;
    }
  }
  const total = saves.length - from;
  const last = saves[saves.length - 1];
  ok(`${label}（${total} 份落盘，末态 ${last?.messages.length ?? 0} 条）`);
}

async function runRealPaths(): Promise<void> {
  const stack = await newStack();
  const sessionId = 'probe-session';
  const { eu, store, log } = stack;

  // 路径一：同会话连续两轮 run（seed 重建窗口 + 终态落盘都在这里）。
  await eu.run('first turn', sessionId);
  await eu.run('second turn', sessionId);
  verifySequence('C1a 同会话连续两轮 run', stack, 0, sessionId);
  if (store.saves.length < 3) {
    fail('C1a', `落盘次数太少（${store.saves.length}），探针没跑到真实路径`);
  }
  const secondTurn = store.saves[store.saves.length - 1];
  if (!secondTurn?.messages.some((message) => message.content === 'first turn')) {
    fail('C1a', '第二轮落盘里找不到第一轮的用户消息（历史被丢掉了？）');
  }

  // 路径二：无 active Run 的 `appendNotice` —— 身份 / 工具 / 模型变更走的就是这条通道。
  const beforeNotice = store.saves.length;
  eu.appendNotice('identity: probe rename');
  await waitUntil(() => store.saves.length > beforeNotice, 'idle appendNotice 落盘');
  verifySequence('C1b idle appendNotice（环境信息通道）', stack, beforeNotice - 1, sessionId);
  const afterNotice = store.saves[store.saves.length - 1];
  if (!afterNotice?.messages.some((message) => message.name === 'vessel:notice')) {
    fail('C1b', 'appendNotice 之后落盘里没有 vessel:notice 尾消息');
  }

  // 路径三：notice 之后继续跑（新 Run 从落盘快照重建窗口，位置不能漂）。
  await eu.run('third turn', sessionId);
  verifySequence('C1c notice 之后继续 run', stack, beforeNotice + 1, sessionId);

  // 路径四：手动压缩 —— 唯一被允许的「pop」。
  const beforeCompact = store.saves.length;
  const compacted = await eu.compactContext(sessionId);
  if (compacted.removed === 0) {
    fail('C1d', '手动压缩没有移除任何消息，探针没覆盖压缩路径');
  }
  if (!log.records(sessionId).some((record) => record.type === 'context.compacted')) {
    fail('C1d', '压缩之后没有 context.compacted 凭据（判据就没法解释前缀替换）');
  }
  verifySequence('C1d 手动压缩（唯一允许的 pop）', stack, beforeCompact - 1, sessionId);

  // 路径五：压缩之后继续 append（摘要在前、新消息在后，不许再动上下文数组的形状）。
  await eu.run('after compact turn', sessionId);
  verifySequence('C1e 压缩后继续 run', stack, beforeCompact + 1, sessionId);

  // 路径六：没有压缩凭据的删除 —— 判据必须逮住（用真实流水线里的同一比较函数）。
  const echoed: Snapshot = {
    cursor: 1,
    messages: [{ role: 'user', content: 'a' }],
  };
  const popped: Snapshot = { cursor: 1, messages: [] };
  if (compareSnapshots(echoed, popped, NO_EVIDENCE).kind !== 'violation') {
    fail('C1f', '没有压缩凭据的纯删除没有被判成违规');
  }
  ok('C1f 无凭据删除被判违规');

  await runClearingProbe();
  await runToolHistoryProbe();
  await eu.dispose();
}

/**
 * 端到端版：把「带工具结果的历史」塞进**真 EU**，同时盯住**发出去的请求**与**落盘**两侧。
 *
 * C1g 量的是 `MemoryWorkingContext`（落盘数据就是从它来的），但装配层还有 seed / 投影 /
 * journal 三段。这里用 `RunOptions.messages` 注入 assistant(tool_calls) + tool 结果，让真
 * EU 自己把它们落盘，并给 provider 包一层把每一次请求的消息抓下来 —— 于是能在同一时刻
 * 同时验「请求里是占位 / 落盘里是原文」，那正是这一单要钉住的分界：
 *
 * ① 落盘（`SessionState.messages`，`sessions.get` 读的就是它）里的旧工具结果是**原文**；
 * ② 同一轮发出去的请求里它们是**占位**（省 token 的效果没丢）；
 * ③ 压缩时审计字段 `cleared_tool_call_ids` 点名了这些工具结果。
 */
async function runToolHistoryProbe(): Promise<void> {
  const provider = new MemoryLLMProvider();
  /** 每一次请求实际发出去的消息（深拷贝；用来和落盘逐条对照）。 */
  const requests: Message[][] = [];
  const events = new MemoryEventStream();
  const log = new MemoryEventLog();
  const store = new RecordingSessionStore();
  // 小预算：让「保留最近 5% 预算」的清空口径真的生效，逼出请求里必须有占位的那一刻。
  const eu = await ExecutionUnit.create({
    provider: {
      chat: async (request) => {
        requests.push(structuredClone(request.messages));
        return provider.chat(request);
      },
    },
    model: 'probe-model',
    contextFactory: () => new MemoryWorkingContext({ maxTokens: 2_000 }),
    events,
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({ session: store, eventLog: log }),
    session: store,
    eventLog: log,
    systemPrompt: 'append-only probe system prompt',
    retry: { maxRetries: 0 },
  });
  const sessionId = 'probe-tools';
  for (let turn = 0; turn < 10; turn += 1) {
    const callId = `call-${String(turn)}`;
    await eu.run(`turn ${String(turn)}`, sessionId, {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: callId, type: 'function', function: { name: 'probe', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          content: `output ${String(turn)} ${'x'.repeat(200)}`,
          tool_call_id: callId,
        },
      ],
    });
  }

  // ①/②：同一时刻对照「请求里」与「落盘里」的同一批工具结果。
  const lastRequest = requests[requests.length - 1] ?? [];
  const clearedInRequest = lastRequest.filter(
    (message) => message.role === 'tool' && message.content.startsWith('[cleared'),
  );
  if (clearedInRequest.length === 0) {
    fail('C1h', '发出去的请求里没有出现占位（省 token 的效果丢了）');
  } else {
    const persisted = await store.load(sessionId);
    const persistedById = new Map<string, string>();
    for (const message of persisted?.messages ?? []) {
      if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
        persistedById.set(message.tool_call_id, message.content);
      }
    }
    const rewritten = clearedInRequest.filter((message) => {
      const raw = persistedById.get(message.tool_call_id ?? '');
      return raw?.startsWith('[cleared') === true;
    });
    if (rewritten.length > 0) {
      fail(
        'C1h',
        `落盘里也有 ${String(rewritten.length)} 条工具结果是占位（应当只有请求里是占位）`,
      );
    } else {
      ok(
        `C1h 请求里 ${String(clearedInRequest.length)} 条占位 / 落盘同一条仍是原文` +
          `（请求共 ${String(requests.length)} 次）`,
      );
    }
  }

  const beforeCompact = store.saves.length;
  const result = await eu.compactContext(sessionId);
  if (result.removed === 0) {
    fail('C1h', '带工具结果的历史没有被压缩（探针没覆盖这条路径）');
    await eu.dispose();
    return;
  }
  if (!log.records(sessionId).some((record) => record.type === 'message.compaction')) {
    fail('C1h', '压缩没有落 message.compaction（缺 ③ 的审计凭据）');
  } else {
    // ③ 审计：压缩事件必须点名「哪些工具结果在请求里会被换成占位」，否则事后无从追查。
    const compaction = log
      .records(sessionId)
      .find((record) => record.type === 'message.compaction');
    const audited = (compaction?.data as { cleared_tool_call_ids?: unknown } | undefined)
      ?.cleared_tool_call_ids;
    const auditedCount = Array.isArray(audited) ? audited.length : 0;
    if (auditedCount === 0) {
      fail('C1h', '压缩事件没有点名 cleared_tool_call_ids（审计缺口）');
    } else {
      ok(`C1h 压缩事件点名 ${String(auditedCount)} 条占位工具结果（审计）`);
    }
  }
  const saves = store.saves;
  const prev = saves[beforeCompact - 1];
  const next = saves[saves.length - 1];
  if (prev === undefined || next === undefined) {
    fail('C1h', '压缩前后的落盘快照缺失');
    await eu.dispose();
    return;
  }
  const evidence = evidenceOf(log.eventsBetween(sessionId, prev.cursor, next.cursor));
  const verdict = compareSnapshots(prev, next, evidence);
  if (verdict.kind === 'violation') {
    fail('C1h', `真 EU 压缩改动了落盘内容且没有凭据解释：${verdict.why}`);
  } else {
    // 到底有没有「已落盘、压缩后仍在窗口里、内容却被换掉」的工具结果？有就必须报出来：
    // 那是从**磁盘上**改写了历史正文，与「只能 pop 或 append」的字面要求相抵。
    const prevToolIds = new Map<string, string>();
    for (const message of prev.messages) {
      if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
        prevToolIds.set(message.tool_call_id, fingerprint(message));
      }
    }
    let rewritten = 0;
    for (const message of next.messages) {
      if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
      const before = prevToolIds.get(message.tool_call_id);
      if (before === undefined) continue;
      if (before === fingerprint(message)) continue;
      rewritten += 1;
    }
    if (rewritten > 0) {
      // 硬断言（0.52 裁决）：占位替换已搬到请求构建层，落盘序列上任何幸存正文变化都是重写。
      fail(
        'C1h',
        `真 EU 的压缩改写了 ${String(rewritten)} 条已落盘且幸存的工具结果正文` +
          '（占位应当只出现在请求视图里）',
      );
      await eu.dispose();
      return;
    }
    ok(
      `C1h 真 EU + 工具结果历史压缩（移除 ${String(result.removed)} 条，` +
        `幸存正文被改写 ${String(rewritten)} 条，` +
        `凭据 ${evidence.types.filter((type) => COMPACTION_EVIDENCE.has(type)).join('/') || '无'}）`,
    );
  }
  await eu.dispose();
}

/**
 * 旧工具结果的占位替换：**落盘必须是原文、请求视图才是占位**（0.52 用户裁定）。
 *
 * 直接驱动与落盘同一个 `MemoryWorkingContext`：造一个旧工具结果多到会被清空的窗口，压缩，
 * 然后三条一起验：
 * ① 压缩后窗口（= 落盘 / `sessions.get` 的来源）里的旧工具结果**仍是原文**；
 * ② 同一轮要发出去的请求视图里它们是占位文本（省 token 的效果没丢）；
 * ③ 审计字段 `cleared_tool_call_ids` 点名了这些工具结果。
 */
async function runClearingProbe(): Promise<void> {
  const maxTokens = 2_000;
  const context = new MemoryWorkingContext({ maxTokens });
  context.setSessionId('clearing');
  const before: Message[] = [{ role: 'system', content: 'sys' }];
  // 12 轮「assistant 要工具 → tool 结果」：旧结果远超「保留最近 5% 预算 / 10 条」的口径，
  // 请求视图里必然有内容被替换成占位。
  for (let turn = 0; turn < 12; turn += 1) {
    before.push({ role: 'user', content: `turn ${String(turn)}` });
    before.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `call-${String(turn)}`,
          type: 'function',
          function: { name: 'probe', arguments: '{}' },
        },
      ],
    });
    before.push({
      role: 'tool',
      content: `output ${String(turn)} ${'x'.repeat(200)}`,
      tool_call_id: `call-${String(turn)}`,
    });
  }
  for (const message of before) context.add(message);
  const removed = context.compact(true);
  if (removed === 0) {
    fail('C1g', '工具结果场景下压缩没有移除任何消息（探针没覆盖清空路径）');
    return;
  }
  const stored = context.messages;
  const rawById = new Map<string, string>();
  for (const message of before) {
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      rawById.set(message.tool_call_id, message.content);
    }
  }
  let rewritten = 0;
  let survived = 0;
  for (const message of stored) {
    if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
    const raw = rawById.get(message.tool_call_id);
    if (raw === undefined) continue;
    survived += 1;
    if (message.content !== raw) rewritten += 1;
  }
  if (rewritten > 0) {
    fail('C1g', `压缩改写了 ${String(rewritten)} 条落盘工具结果正文（应当只改请求视图）`);
    return;
  }
  // ② 请求视图：同一份窗口，发出去的那一份必须有占位。
  const requestView = withClearedToolResults(stored, maxTokens);
  const clearedInView = requestView.filter(
    (message, index) => message !== stored[index] && message.role === 'tool',
  ).length;
  if (clearedInView === 0) {
    fail('C1g', '请求视图里没有出现占位（省 token 的效果丢了）');
    return;
  }
  // ③ 审计：压缩事件点名了这些工具结果。
  const audited = context.lastCompaction?.cleared_tool_call_ids ?? [];
  if (audited.length === 0) {
    fail('C1g', '压缩事件没有点名 cleared_tool_call_ids（审计缺口）');
    return;
  }
  ok(
    `C1g 工具结果：落盘 ${String(survived)} 条仍为原文、请求视图 ${String(clearedInView)} 条占位、` +
      `审计点名 ${String(audited.length)} 条（移除 ${String(removed)} 条）`,
  );
}

// ───────────────────────── C2 静态钉住 ─────────────────────────

/** 环境信息的制造者：身份 / 工具 / 模型三条都只能 append。 */
const ENV_INFO_PRODUCERS = [
  'packages/agent/src/self-card-delta.ts',
  'packages/agent/src/tool-surface-delta.ts',
];

async function source(path: string): Promise<string> {
  try {
    return await readFile(join(REPO, path), 'utf8');
  } catch {
    fail(path, '读不到这个文件（改名 / 删除？门禁需要它存在）');
    return '';
  }
}

async function runStaticChecks(): Promise<void> {
  for (const file of ENV_INFO_PRODUCERS) {
    const text = await source(file);
    if (text.length === 0) continue;
    // 正向：注入必须是「尾部追加一条 user 消息」这一种形状。
    if (!/ctx\.messages\s*=\s*\[\.\.\.\(ctx\.messages\s*\?\?\s*\[\]\)/.test(text)) {
      fail(file, '没有「把新消息追加到 ctx.messages 尾部」这条唯一注入形状');
    } else {
      ok(`C2 ${file} 只尾部追加`);
    }
    // 反向：上下文数组上的破坏性操作一律不许。
    const mutations = text.match(/\.(splice|shift|unshift|sort|reverse|pop)\(/g) ?? [];
    if (mutations.length > 0) {
      fail(file, `出现了破坏性数组操作：${mutations.join(' / ')}`);
    }
    // 反向：不许写 system 消息（身份/工具/模型变更都不是系统消息）。
    if (/role:\s*'system'/.test(text)) {
      fail(file, '出现了 role: system —— 环境信息不得伪装成系统消息');
    }
    // 反向：不许就地改消息内容（改写已落盘内容的另一条路）。
    if (/\.content\s*=[^=]/.test(text)) {
      fail(file, '出现了就地改消息正文（.content = …）');
    }
    // 反向：不许新造事件类型（同一条 vessel:notice 通道就够）。
    if (/events?\.publish\(|publishEvent\(/.test(text)) {
      fail(file, '环境信息不得自己发布事件（同一条 vessel:notice 通道）');
    }
    // 通道名必须与其它环境信息同一条。
    if (!text.includes('vessel:notice') && !text.includes('ENV_INFO_MESSAGE_NAME')) {
      fail(file, '没有使用 vessel:notice 通道');
    }
  }

  // 唯一写口：SessionState 的持久化只能经 RunJournal，EU 不得直连 SessionStore。
  const eu = await source('packages/core/src/runtime/execution-unit.ts');
  if (/this\.session\s*\??\.\s*save\(/.test(eu)) {
    fail('packages/core/src/runtime/execution-unit.ts', '绕过 RunJournal 直接写 SessionStore');
  } else {
    ok('C2 SessionState 唯一写口 = RunJournal');
  }
  // 投影的「替换语义」只有压缩 / 撤回两类事件能触发（多一类就是新的重写后门）。
  if (!eu.includes("event.type === 'message.compaction'")) {
    fail('packages/core/src/runtime/execution-unit.ts', '全量重投影的触发条件里没有压缩事件');
  } else {
    ok('C2 全量重投影只认压缩/撤回事件');
  }
}

// ───────────────────────── C3 词表对拍 ─────────────────────────

/**
 * 旧词：`selfcard` 是 0.52 之前 `self-card-delta` 用的首词，落盘消息里还有历史存量。
 * Web 必须继续认得它（否则旧消息的卡头会静默退化成「上下文」），生产者不得再发。
 */
const LEGACY_SCOPES = ['selfcard'] as const;

async function runVocabularyChecks(): Promise<void> {
  const web = new Set<string>(ENV_NOTICE_SCOPES);
  for (const scope of ENV_INFO_SCOPES) {
    if (!web.has(scope)) {
      fail('C3', `Web 的 ENV_NOTICE_SCOPES 认不出生产者的 scope「${scope}」`);
    }
  }
  if (failures.every((entry) => !entry.startsWith('C3'))) {
    ok(`C3 scope 词表对拍（${ENV_INFO_SCOPES.length} 个生产词）`);
  }
  for (const legacy of LEGACY_SCOPES) {
    if (!web.has(legacy)) fail('C3', `Web 丢了旧词「${legacy}」：历史消息会掉回 context`);
  }
  // 生产者不得再发旧词（否则词表永远收不拢）。
  const delta = await source('packages/agent/src/self-card-delta.ts');
  if (/['"`]selfcard:/.test(delta)) {
    fail('packages/agent/src/self-card-delta.ts', '仍在发旧 scope「selfcard:」');
  } else {
    ok('C3 生产者不再发旧词');
  }
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  // C0：判据自检。构造四组快照，证明它会放行该放行的、拦该拦的。
  const base: Snapshot = {
    cursor: 10,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ],
  };
  const grown: Snapshot = {
    cursor: 12,
    messages: [...base.messages, { role: 'user', content: 'u2' }],
  };
  const rewritten: Snapshot = {
    cursor: 12,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'U1-CHANGED' },
      { role: 'assistant', content: 'a1' },
    ],
  };
  const compacted: Snapshot = {
    cursor: 14,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'system', content: '[summary]', compaction_summary: true },
      { role: 'assistant', content: 'a1' },
    ],
  };
  const compactedButMutated: Snapshot = {
    cursor: 14,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'system', content: '[summary]', compaction_summary: true },
      { role: 'assistant', content: 'a1-cleared' },
    ],
  };

  if (compareSnapshots(base, grown, NO_EVIDENCE).kind !== 'append') {
    fail('C0', '合法追加被误判');
  }
  if (
    compareSnapshots(base, rewritten, { types: ['llm.response'], clearedToolCallIds: new Set() })
      .kind !== 'violation'
  ) {
    fail('C0', '无压缩凭据的改写没有被判违规');
  }
  if (compareSnapshots(base, { cursor: 12, messages: [] }, NO_EVIDENCE).kind !== 'violation') {
    fail('C0', '无压缩凭据的删除没有被判违规');
  }
  const allowed = compareSnapshots(base, compacted, {
    types: ['context.compacted', 'message.compaction'],
    clearedToolCallIds: new Set(),
  });
  if (allowed.kind !== 'compaction') {
    fail('C0', `有凭据的压缩被误判：${JSON.stringify(allowed)}`);
  }
  if (
    compareSnapshots(base, compactedButMutated, {
      types: ['message.compaction'],
      clearedToolCallIds: new Set(),
    }).kind !== 'violation'
  ) {
    fail('C0', '压缩时顺手改写幸存消息没有被判违规');
  }
  // 同一份压缩结果克隆一遍再比：判据必须看内容，不看对象引用（否则每次比较都是假红）。
  if (
    compareSnapshots(
      base,
      { cursor: 14, messages: compacted.messages.map((message) => ({ ...message })) },
      { types: ['context.compacted'], clearedToolCallIds: new Set() },
    ).kind === 'violation'
  ) {
    fail('C0', '同一份压缩结果被判成了违规（判据不稳定）');
  }
  // 旧工具结果被「压缩顺手清空」：0.52 起不允许 —— 占位只发生在请求构建层，
  // 落盘序列上任何幸存消息的内容变化都是重写（哪怕审计里点了名）。
  const toolBase: Snapshot = {
    cursor: 10,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'tool', content: 'raw output', tool_call_id: 'call-1' },
      { role: 'assistant', content: 'a1' },
    ],
  };
  const toolCompacted: Snapshot = {
    cursor: 14,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'system', content: '[summary]', compaction_summary: true },
      { role: 'tool', content: '[cleared]', tool_call_id: 'call-1' },
      { role: 'assistant', content: 'a1' },
    ],
  };
  if (
    compareSnapshots(toolBase, toolCompacted, {
      types: ['message.compaction'],
      clearedToolCallIds: new Set(['call-1']),
    }).kind !== 'violation'
  ) {
    fail('C0', '压缩改写了幸存的旧工具结果却没有被判违规（凭据不能当改写许可证）');
  }
  ok('C0 判据自检（放行追加/凭据压缩，拦下改写与删除）');

  await runRealPaths();
  await runStaticChecks();
  await runVocabularyChecks();

  const total = passed + failures.length;
  // 通过时也把「跑了哪些路径」打出来：门禁的结论要能被人复核，尤其这条不变量是
  // 「我实测到了什么」而不是「我读代码觉得没问题」。
  for (const line of paths) console.log(line);
  if (failures.length === 0) {
    console.log(`OK append-only-context: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED append-only-context: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
