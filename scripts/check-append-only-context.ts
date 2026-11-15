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
 *   「上下文」，最难发现的那种坏）。同一层还管三件「抄了副本」的事：插件包
 *   （`doc-subscription`）的 scope / 明细标记副本、每个词在中英两侧都有卡头标签、
 *   订阅通知不再发旧的 `vessel:subscription` 通道名。
 *
 * 用法：bun run scripts/check-append-only-context.ts（退出码 0 = 全过，1 = 有 FAIL）
 *       bun run scripts/check-append-only-context.ts --phase=1（历史 CI 命令，仍被接受；
 *       **已无 PENDING 条目**——最后一个（C1h）在 0.53 收口时改成按豁免事实判定的硬判据，
 *       所以这两种模式的结论从此必须**相同**）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ENV_NOTICE_SCOPES } from '../apps/web/src/domains/chat/env-notice';
import { ENV_INFO_DETAIL_MARK, ENV_INFO_SCOPES } from '../packages/agent/src/env-info-scope';
import {
  armProjectionDeclaration,
  createRunJournalFactory,
  declareProjection,
  ExecutionUnit,
  isClearedToolResult,
  MemoryEventStream,
  MemoryLLMProvider,
  MemorySessionStore,
  MemoryWorkingContext,
  type Message,
  type ProjectionRuntimeMode,
  resolveProjection,
  type SessionEventInput,
  type SessionEventLogPort,
  type SessionEventRecord,
  type SessionState,
  setWindowProjectionMode,
  windowProjectionMode,
  withClearedToolResults,
} from '../packages/core/src/index';

const REPO = join(import.meta.dir, '..');

const failures: string[] = [];
/**
 * 灰度一阶段（V1 修复单落地之前）曾经要打印但不拦 CI 的行。
 *
 * **0.53 收口时已清空并删除这套机制**：它最后一个条目（C1h「存档 = 请求投影，逐字一致」）
 * 改成了**按豁免事实判定**的硬判据（见 `judgeRequestProjection`）——「设计行为有声明 + 有
 * 审计 + 集合逐条相等」是可验证的事实，不需要灰度投放。红就是红。
 *
 * 留 `--phase=1` 的解析只为历史 CI 命令不用改（`bun run gates` 里带的仍是它）；它
 * 现在不改变任何判定，两种模式必须给出同一个结论。
 */
const PHASE_ONE = process.argv.includes('--phase=1');
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
 * 同时验「请求期改写了什么 / 落盘是什么 / 审计怎么记」，那正是这一单元要钉住的分界。
 *
 * 会话创建即写投射声明（0.53 U1 的生产形态）：探针直连 `ExecutionUnit`，不走会话创建
 * 层，所以这里要自己走同一条登记入口（`armProjectionDeclaration`），否则测到的是
 * 「旧会话缺省兜底」而不是生产形态 —— 而 C1h 的豁免条件一正是「声明存在」。
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
  // 声明走 U1 的真入口（`declareProjection` → `armProjectionDeclaration`），
  // journal 在写盘前把它合并回 `SessionState.context_projection`。
  armProjectionDeclaration(sessionId, declareProjection({ mode: 'placeholder' }));
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

  // ①/②：同一时刻对照「请求里」与「落盘里」的同一批工具结果，按**豁免事实**判定
  //      （见 `judgeRequestProjection`）。0.52 那句「请求期改写一律违规」已被 ADR-104 修正：
  //      `placeholder` 下请求期改写是设计行为，成立条件是可验证的四份事实，不是灰度投放。
  const lastRequest = requests[requests.length - 1] ?? [];
  const persisted = await store.load(sessionId);
  judgeRequestProjection(persisted, lastRequest);

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
      // 硬断言（0.52 裁定）：落盘只能 append —— 幸存的工具结果正文不许变。
      // 占位必须在**写入侧**就落成占位符本身；「请求期把正文换成占位」等于改写历史，
      // 是 V1（见 docs/dev/research/invariant-audit-appendonly.md 与
      // scripts/check-request-append-only.ts 的 R1/R4）。
      fail(
        'C1h',
        `真 EU 的压缩改写了 ${String(rewritten)} 条已落盘且幸存的工具结果正文` +
          '（0.52 裁定：占位必须在写入侧落成占位符本身，请求期不得改写存档）',
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

/** 已实现的两种运行期投射模式（ADR-104：`externalize` / `archive_notice` 本轮未实现）。 */
const PROJECTION_BRANCHES = ['placeholder', 'passthrough'] as const;

/** 判据分支 = 已实现的运行期模式。 */
type ProjectionBranch = (typeof PROJECTION_BRANCHES)[number];

/** 请求期改写在设计上成立的两档（`externalize` 是词表合法但本版本不可用，留位不撒谎）。 */
const REQUEST_REWRITE_MODES: ReadonlySet<string> = new Set(['placeholder', 'externalize']);

/**
 * C1h 判据需要的会话事实（`SessionState` 的结构子集：只读判据用得上的那几项）。
 *
 * 比 `SessionState` 窄有两个用处：`SessionState` 可以直接传进来（结构子类型），
 * 而**判据自检**能拿构造出来的纯数据跑 —— 判据必须能被证明「该放行的放行、该拦的拦」，
 * 否则它随时可能退化成永远返回 OK 的空壳。
 */
interface RequestProjectionState {
  readonly messages?: readonly Message[] | undefined;
  readonly context_projection?: SessionState['context_projection'];
  readonly context_projection_audit?: SessionState['context_projection_audit'];
  readonly cleared_tool_call_ids?: readonly string[] | undefined;
}

/** C1h 对一个（落盘, 请求）对的结论。`why` 一律带 `mode=` / `audit=` / `request=` 现场。 */
type RequestProjectionVerdict =
  /** 请求与落盘逐字一致：判据的常态形态，不需要任何豁免。 */
  | { readonly kind: 'identical'; readonly why: string }
  /** 四真同时成立 ⇒ 请求期改写是已声明、已审计、范围恰好的设计行为。 */
  | { readonly kind: 'exempt'; readonly why: string }
  /** 改写解释不了（缺声明 / 缺审计 / 越界 / 漏改 / 非占位）⇒ 违规。 */
  | { readonly kind: 'violation'; readonly why: string };

/**
 * C1h 的豁免判据（0.53 正式裁定）：请求期改写**按豁免事实判定**（纯函数）。
 *
 * 「请求视图里的旧工具结果被换成占位」这件事有两种身份：要么是改写历史（违规），要么是
 * `placeholder` 投射模式下**声明过、审计过、范围恰好等于审计集合**的设计行为
 * （ADR-104 §2.3 / §5.1 / §6.2 的 D4 条件）。两者在数据上唯一的区别就是下面这四份事实，
 * 所以判据只看事实，**不看「现在允许不允许」**——不挂 PENDING、不读全局开关、不认白名单：
 *
 * 1. **声明存在**：`SessionState.context_projection.mode ∈ {placeholder, externalize}`。
 *    声明的是 `passthrough` / `archive_notice` 时，请求视图本来就该与落盘**逐字节相同**
 *    （前者语义如此；后者 `freezeSegmentClearedToolResults` 把冻结集合钉成空集）——
 *    出现差异就是 FAIL，而不是「换一档再判」。
 * 2. **审计行存在**：`SessionState.context_projection_audit`（段起点决策留痕，U2 的写入），
 *    且它的决策链尾（生效模式）必须就是声明解析出的模式 —— 声明与审计不许各说各话。
 * 3. **集合逐条相等**：审计点名的集合（`SessionState.cleared_tool_call_ids`，与
 *    `message.compaction` 的 `cleared_tool_call_ids` 同源、C1g 量的是同一份）∩ 落盘工具
 *    结果，必须**恰好等于**本次请求实际改写的集合 —— 「不少」= 审计点名的都得换（省 token
 *    的效果没丢）、「不多」= 集合之外一条都不许动（那是改写历史）。
 * 4. **每条确实是占位**：每条被改写的都是 `role=tool`、`tool_call_id` 在审计集合内、正文
 *    `isClearedToolResult` 为真（只允许把工具结果换成本函数产出的占位文本）。
 *
 * 任一条不成立 ⇒ **violation**（不是 pending、不是 skip）。四份事实在 `C0b` 自检里逐条
 * 反证过：少一份就红，所以这条判据的绿不是「没输出所以绿」。
 */
function requestProjectionVerdict(
  state: RequestProjectionState | null,
  request: readonly Message[],
): RequestProjectionVerdict {
  // 落盘的工具结果（`tool_call_id → 正文`）：判据的对照基线。
  const storedContent = new Map<string, string>();
  for (const message of state?.messages ?? []) {
    if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
    storedContent.set(message.tool_call_id, message.content);
  }
  // 请求期**实际**改写的集合：同一 tool_call_id 在请求里与落盘里正文不同。
  const rewritten = request.filter((message) => {
    if (message.role !== 'tool') return false;
    const raw = storedContent.get(message.tool_call_id ?? '');
    return raw !== undefined && raw !== message.content;
  });
  const rewrittenIds = rewritten.map((message) => message.tool_call_id ?? '<缺 tool_call_id>');
  const resolution = resolveProjection(state);
  const auditedIds = [...(state?.cleared_tool_call_ids ?? [])];
  const clearedOnDisk = [...storedContent.values()].filter((content) =>
    isClearedToolResult(content),
  ).length;
  // 现场三份（红绿都带）：模式怎么解析的、审计点名了什么、请求实际改了什么。
  const facts =
    `mode=${resolution.mode}（source=${resolution.source}）` +
    ` audit=${auditedIds.length > 0 ? auditedIds.join(',') : 'none'}` +
    ` request=${rewrittenIds.length > 0 ? rewrittenIds.join(',') : 'none'}` +
    ` disk_cleared=${String(clearedOnDisk)}/${String(storedContent.size)}`;

  if (rewritten.length === 0) return { kind: 'identical', why: facts };

  // ① 声明存在。没有声明 ⇒ 请求期改写失去授权（ADR-104 D4 条件 1）。
  const declaration = resolution.declaration;
  if (declaration === null) {
    return {
      kind: 'violation',
      why:
        `请求里改了 ${String(rewritten.length)} 条工具结果，但会话没有投射声明` +
        `（ADR-104 D4 条件 1 不成立，不是 PENDING）—— ${facts}`,
    };
  }
  if (resolution.error !== null) {
    return {
      kind: 'violation',
      why: `声明读不出可信模式（${String(resolution.error)}）⇒ 判据不能按兜底值放行 —— ${facts}`,
    };
  }
  if (!REQUEST_REWRITE_MODES.has(resolution.mode)) {
    return {
      kind: 'violation',
      why:
        `声明的模式 ${resolution.mode} 不该产生请求期改写（它的请求视图必须与落盘逐字节相同）` +
        `—— ${facts}`,
    };
  }

  // ② 审计行存在，且审计里的生效模式就是这个模式。
  const audit = resolution.audit;
  if (audit === null) {
    return {
      kind: 'violation',
      why:
        '会话没有投射审计行（`context_projection_audit`）⇒ 改写事后无从追查' +
        `（ADR-104 D4 条件 2 不成立）—— ${facts}`,
    };
  }
  const auditedEffective = audit.steps.length > 0 ? audit.steps[audit.steps.length - 1] : null;
  if (auditedEffective !== resolution.mode) {
    return {
      kind: 'violation',
      why:
        `声明解析出 ${resolution.mode}，但审计链尾写的生效模式是 ${String(auditedEffective)}` +
        `（声明与审计各说各话）—— ${facts}`,
    };
  }

  // ③ 集合逐条相等：允许被改写的 = 审计点名 ∩ 落盘工具结果（已占位的按幂等守卫排除）。
  const auditedSet = new Set(auditedIds);
  if (auditedSet.size === 0) {
    return {
      kind: 'violation',
      why:
        `请求里改了 ${String(rewritten.length)} 条，但落盘没有审计集合` +
        `（\`cleared_tool_call_ids\`）—— 改了什么没人点名，事后无从追查 —— ${facts}`,
    };
  }
  const allowed = new Set<string>();
  for (const [id, content] of storedContent) {
    if (!auditedSet.has(id)) continue;
    if (isClearedToolResult(content)) continue;
    allowed.add(id);
  }
  const actual = new Set(rewrittenIds);
  const extra = rewrittenIds.filter((id) => !allowed.has(id));
  if (extra.length > 0) {
    return {
      kind: 'violation',
      why:
        `请求期多改了 ${String(extra.length)} 条（不在「审计集合 ∩ 落盘工具结果」里）：` +
        `${extra.join('、')} —— 审计解释不了的改写就是改写历史 —— ${facts}`,
    };
  }
  const missing = [...allowed].filter((id) => !actual.has(id));
  if (missing.length > 0) {
    return {
      kind: 'violation',
      why:
        `请求期少改了 ${String(missing.length)} 条（审计点名的旧工具结果没换成占位）：` +
        `${missing.join('、')} —— 省 token 的效果没拿到、审计也名不副实 —— ${facts}`,
    };
  }

  // ④ 每条确实是占位（只允许「把审计集合内的工具结果换成本函数产出的占位文本」）。
  const bad = rewritten.filter(
    (message) =>
      !(
        typeof message.tool_call_id === 'string' &&
        auditedSet.has(message.tool_call_id) &&
        isClearedToolResult(message.content)
      ),
  );
  if (bad.length > 0) {
    return {
      kind: 'violation',
      why:
        `请求期改了 ${String(bad.length)} 条**非**占位替换的消息` +
        `（只允许把审计集合内的工具结果换成本函数产出的占位文本）—— ${facts}`,
    };
  }

  // 四真同时成立 ⇒ 豁免（打印 EXEMPT + 原因，不做成静默绿）。
  return {
    kind: 'exempt',
    why:
      `请求期改写 ${String(rewritten.length)} 条 = 审计集合 ∩ 落盘工具结果（声明 ` +
      `${String(declaration.declaration_id)}、审计行 at=${String(audit.at)}；${facts}）`,
  };
}

/** C1h 的落地：把纯判据的结论翻成门禁行（EXEMPT 也算 OK，但明写原因）。 */
function judgeRequestProjection(
  state: RequestProjectionState | null,
  request: readonly Message[],
): void {
  const verdict = requestProjectionVerdict(state, request);
  if (verdict.kind === 'violation') {
    fail('C1h', verdict.why);
    return;
  }
  ok(
    verdict.kind === 'exempt'
      ? `C1h EXEMPT ${verdict.why}`
      : `C1h 请求与落盘逐字一致（${verdict.why}）`,
  );
}

/**
 * 旧工具结果的占位替换：**按会话声明的投射模式分档判定**（ADR-104 §6.2 / D4）。
 *
 * 判据原文（0.52）是「任何请求视图改写落盘消息都是违规」。ADR-104 已裁定：`placeholder`
 * 模式下请求期改写是**设计行为**，成立条件是「有声明 + 有审计集合 + 改写范围恰好等于审计
 * 集合」。所以「必须为 0」只在 `passthrough` 下成立 —— 旧写法把 placeholder 的设计行为
 * 也一律判成违规，而 0.53 起默认模式就是 placeholder（`docs/adr/ADR-104`「默认全部改为
 * placeholder」），于是这条判据对默认模式**必然误报**。红的是判据范围，不是产品。
 *
 * 现在按模式分档，三档都是硬判据（不再挂 PENDING）：
 *
 * 1. **`passthrough`：请求视图改写必须 == 0**。同场景按 placeholder 口径会改写 N 条，
 *    这个反事实打在 ok 文案里 —— 「0 条」不能是真空绿（探针没覆盖占位路径时最坏）。
 * 2. **`placeholder`：改写集合必须恰好等于**「审计集合 ∩ 落盘工具结果」（不多不少），
 *    且每条被改写的必须是 `role=tool`、`tool_call_id` 在审计集合内、正文
 *    `isClearedToolResult` 为真。审计集合缺失 / 没有声明 ⇒ FAIL（不是 PENDING）。
 * 3. **声明与分支一致**：探针声明的模式、读侧 `resolveProjection` 解析出的模式、请求期
 *    `windowProjectionMode` 拿到的模式必须三者相同。不一致 ⇒ FAIL —— 否则实现可以把模式
 *    静默保底（声明 passthrough 却按 placeholder 跑），而判据按「自己选的分支」看不见。
 *
 * 探针只碰**请求视图**这一层：真压缩造出一份落盘，再按该模式的请求期口径构建视图。
 * ① 压缩后落盘（= `sessions.get` 的来源）里的旧工具结果必须仍是原文 —— 那是判据的对照
 *    基线；「落盘即占位」是 V1 的方向，届时这条改判「请求与落盘逐字一致」（C1h 的地盘）。
 * ② 请求视图只在 placeholder 下、且只在冻结集合内改写（分档判据见上）。
 * ③ 审计字段 `cleared_tool_call_ids` 点名了这些工具结果。
 */
async function runClearingProbe(): Promise<void> {
  // 两个已实现的运行期模式各跑一遍：判据**按模式分档**，不是「一条断言判所有模式」。
  for (const branch of PROJECTION_BRANCHES) {
    const probe = buildClearingProbe(branch);
    if (probe !== undefined) judgeClearingProbe(probe);
  }
}

/** 一个模式下的探针结果：真压缩后的落盘 + 该模式请求期的视图。 */
interface ClearingProbe {
  /** 探针声明的模式 = 判据选中的分支。 */
  readonly declared: ProjectionBranch;
  /** 读侧唯一入口 `resolveProjection` 解析出的模式。 */
  readonly resolved: string;
  /** 请求期真正生效的模式（`windowProjectionMode`：段起点钉死后才读）。 */
  readonly requestMode: ProjectionRuntimeMode;
  /** 压缩事件点名的审计集合（ADR-104 D4 条件 2）。 */
  readonly audited: readonly string[];
  /** 压缩后的落盘消息（`context.messages` 的来源 = `sessions.get` 的来源）。 */
  readonly stored: readonly Message[];
  /** 落盘里仍在窗口中的工具结果条数（= 判据的取样范围）。 */
  readonly survived: number;
  /** 交给请求层的冻结集合（同样的落盘、不同的模式会给不同的集合）。 */
  readonly frozen: readonly string[];
  /** 该模式下的请求视图。 */
  readonly requestView: readonly Message[];
  /** 本次压缩移除的条数（探针是否真的覆盖了清空路径）。 */
  readonly removed: number;
}

/** 视图里与落盘「不是同一条」的下标（同一对象 = 没被改写）。 */
function rewrittenIndexes(stored: readonly Message[], view: readonly Message[]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < stored.length; index += 1) {
    if (view[index] !== stored[index]) indexes.push(index);
  }
  return indexes;
}

/**
 * 跑一遍「真压缩 → 段起点裁决 → 请求视图构建」，产出该模式的探针结果。
 *
 * `undefined` = 构造阶段就已经 FAIL（原因已记进 failures，不再往下判以免同一处报两遍）。
 */
function buildClearingProbe(declared: ProjectionBranch): ClearingProbe | undefined {
  const maxTokens = 2_000;
  const sessionId = `clearing-${declared}`;
  const label = `C1g ${declared}`;

  // ① 声明 → 读侧解析。判据不自己「猜」模式：声明的模式走 U1 的真入口
  //    `declareProjection`，再从读侧唯一入口 `resolveProjection` 拿回来。
  const declaration = declareProjection({ mode: declared });
  const resolution = resolveProjection({
    session_id: sessionId,
    context_projection: declaration,
  });
  if (resolution.declaration === null) {
    // ADR-104 D4 条件 1：placeholder 的请求期改写只在「有声明」时成立。
    fail(label, '会话没有投射声明（缺声明 ⇒ 请求期改写失去授权，判据 FAIL 而不是 PENDING）');
    return undefined;
  }
  if (resolution.error !== null) {
    fail(label, `声明解析失败（${String(resolution.error)}）—— 判据拿不到可信模式，不能按兜底值判`);
    return undefined;
  }
  if (resolution.mode !== declared) {
    fail(
      label,
      `声明与解析不一致：声明 ${declared}，读侧 resolveProjection 解析出 ${resolution.mode}` +
        '—— 判据不能按「自己以为的模式」判',
    );
    return undefined;
  }

  const context = new MemoryWorkingContext({ maxTokens });
  context.setSessionId(sessionId);
  const before: Message[] = [{ role: 'system', content: 'sys' }];
  // 12 轮「assistant 要工具 → tool 结果」：旧结果远超「保留最近 5% 预算 / 10 条」的口径，
  // 压缩必然移除一段、请求视图里必然有原文被替换成占位（判据要的就是这个可分档的场景）。
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
    fail(label, '工具结果场景下压缩没有移除任何消息（探针没覆盖清空路径）');
    return undefined;
  }

  // ② 段起点：runtime 把本段生效模式钉到窗口上（`freezeSegmentProjection`），run 内请求期
  //    只读 `windowProjectionMode`。这里做同一件事，再读回来当「请求期真正生效的模式」——
  //    这一读正是「实现别把模式静默保底」的抓手。
  setWindowProjectionMode(context, resolution.mode);
  const requestMode = windowProjectionMode(context);

  const stored = context.messages;
  const rawById = new Map<string, string>();
  for (const message of before) {
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      rawById.set(message.tool_call_id, message.content);
    }
  }
  let survived = 0;
  let rewrittenOnDisk = 0;
  for (const message of stored) {
    if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
    const raw = rawById.get(message.tool_call_id);
    if (raw === undefined) continue;
    survived += 1;
    if (message.content !== raw) rewrittenOnDisk += 1;
  }
  if (rewrittenOnDisk > 0) {
    // 判据的对照基线：落盘正文必须还是原文（改的话「请求视图 vs 落盘」比的就是两个都不对的
    // 东西）。落盘即占位是 V1 的方向，届时这条改判「请求与落盘逐字一致」—— 那是 C1h 的地盘。
    fail(
      label,
      `压缩改写了 ${String(rewrittenOnDisk)} 条落盘工具结果正文（落盘只能 append，` +
        '唯一允许的 pop 是压缩摘要替换；占位是请求视图的事，落盘正文是判据的对照基线）',
    );
    return undefined;
  }

  const audited = [...(context.lastCompaction?.cleared_tool_call_ids ?? [])];
  // 冻结集合：`placeholder` 下 runtime 交给请求层的就是审计点名的这一份
  // （`SessionState.cleared_tool_call_ids` 与 `message.compaction` 同源：段起点按保留预算
  // 算一次、run 内冻结）；`passthrough` 下集合恒为空、请求层直接放行（不跑 plan、不替换）。
  const frozen = requestMode === 'placeholder' ? audited : [];
  const requestView =
    requestMode === 'passthrough' ? stored : withClearedToolResults(stored, frozen);
  return {
    declared,
    resolved: resolution.mode,
    requestMode,
    audited,
    stored,
    survived,
    frozen,
    requestView,
    removed,
  };
}

/** 分档判定：`declared` 决定用哪一档的硬判据（每档都必须真跑，没有一档是 PENDING）。 */
function judgeClearingProbe(probe: ClearingProbe): void {
  const label = `C1g ${probe.declared}`;
  // ③ 声明 / 读侧解析 / 请求期生效三者必须是同一个模式。不一致说明实现把模式静默保底了
  //    （例如声明了 passthrough 却按 placeholder 跑），此时判据若只按「自己选的分支」判，
  //    就会给出一个与实现无关的绿。
  if (probe.resolved !== probe.declared || probe.requestMode !== probe.declared) {
    fail(
      label,
      `模式不一致：声明 ${probe.declared} / 读侧解析 ${probe.resolved} / 请求期生效 ` +
        `${String(probe.requestMode)} —— 判据的分支必须与实现真跑的模式一致`,
    );
    return;
  }
  const actual = rewrittenIndexes(probe.stored, probe.requestView);
  if (probe.declared === 'passthrough') {
    judgePassthroughRewrites(probe, actual);
    return;
  }
  judgePlaceholderRewrites(probe, actual);
}

/** `passthrough`：请求视图改写必须 == 0（ADR-104：与「完全没有投射机制」逐字节相同）。 */
function judgePassthroughRewrites(probe: ClearingProbe, actual: readonly number[]): void {
  const label = 'C1g passthrough';
  if (actual.length > 0) {
    fail(
      label,
      `请求视图改写了 ${String(actual.length)} 条落盘消息（passthrough 的语义是「与完全没有` +
        '投射机制逐字节相同」⇒ 改写必须为 0；实现是否按模式选对了分支？）',
    );
    return;
  }
  // 反事实：同一份落盘按 placeholder 口径（审计集合）跑会改写几条。若这个数也是 0，
  // 「改写 0 条」就是**真空绿**（探针根本没覆盖占位路径）—— 那比红更坏。
  const counterfactual = rewrittenIndexes(
    probe.stored,
    withClearedToolResults(probe.stored, probe.audited),
  ).length;
  if (counterfactual === 0) {
    fail(
      label,
      `反事实对照失效：同一份落盘按 placeholder 口径（审计 ${String(probe.audited.length)} 条）` +
        `也一条都没改写（落盘工具结果 ${String(probe.survived)} 条）—— 这条 0 是真空绿`,
    );
    return;
  }
  ok(
    `C1g passthrough 模式：请求视图改写 0 条（同场景按 placeholder 口径会改写 ` +
      `${String(counterfactual)} 条 ⇒ 非真空绿；落盘工具结果 ${String(probe.survived)} 条）`,
  );
}

/**
 * `placeholder`：请求视图改写集合必须**恰好等于**「审计集合 ∩ 落盘工具结果」。
 *
 * 「不少」= 审计点名的旧工具结果必须都换成占位（否则省 token 的效果没拿到、审计也名不副实）；
 * 「不多」= 审计集合之外一条都不许动（那是改写历史）。另外每条被改写的形状必须是
 * `role=tool` + `tool_call_id ∈ 审计集合` + 正文 `isClearedToolResult` 为真 —— 只允许
 * 把工具结果换成本函数产出的占位文本，不允许顺手改别的东西。
 */
function judgePlaceholderRewrites(probe: ClearingProbe, actual: readonly number[]): void {
  const label = 'C1g placeholder';
  const auditedSet = new Set(probe.audited);
  if (auditedSet.size === 0) {
    fail(
      label,
      '压缩事件没有点名 cleared_tool_call_ids（缺审计集合 ⇒ 请求期改写事后无从追查，' +
        'ADR-104 D4 条件 2 不满足 ⇒ FAIL，不是 PENDING）',
    );
    return;
  }
  // 对照：没有决策（空集合）时必须一条都不改，且逐条同对象。没有这条，「传 ids 改写 N 条」
  // 可能只是函数在乱改，看起来却像抓到了违规。
  const noDecisionView = withClearedToolResults(probe.stored, []);
  const untouched =
    noDecisionView.length === probe.stored.length &&
    noDecisionView.every((message, index) => message === probe.stored[index]);
  if (!untouched) {
    fail(
      label,
      '对照判据失效：传空 cleared ids 时请求视图仍改写了落盘消息（没有决策必须逐字、逐条同对象）',
    );
    return;
  }
  // 允许被改写的下标 = 审计集合 ∩ 落盘工具结果。已是占位的成员（幂等：不二次格式化）
  // 不进这一集；若视图把它们也改了，下面的 `extra` 会逮住 —— 那正是写侧幂等守卫守的东西。
  const allowed = new Set<number>();
  for (let index = 0; index < probe.stored.length; index += 1) {
    const message = probe.stored[index];
    if (message === undefined) continue;
    if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
    if (!auditedSet.has(message.tool_call_id)) continue;
    if (isClearedToolResult(message.content)) continue;
    allowed.add(index);
  }
  if (allowed.size === 0) {
    fail(
      label,
      `审计集合（${String(auditedSet.size)} 条）与落盘工具结果（${String(probe.survived)} 条）` +
        '没有交集 —— 探针没覆盖占位路径，这条判据等于没跑',
    );
    return;
  }
  const actualSet = new Set(actual);
  const extra = actual.filter((index) => !allowed.has(index));
  const missing = [...allowed].filter((index) => !actualSet.has(index));
  if (extra.length > 0) {
    fail(
      label,
      `请求视图多改了 ${String(extra.length)} 条（不在「审计集合 ∩ 落盘工具结果」里）：` +
        `第 ${extra.map((index) => String(index + 1)).join('、')} 条（冻结集合 ` +
        `${String(probe.frozen.length)} 条 / 审计 ${String(auditedSet.size)} 条）`,
    );
    return;
  }
  if (missing.length > 0) {
    fail(
      label,
      `请求视图少改了 ${String(missing.length)} 条（审计点名的旧工具结果没换成占位）：` +
        `第 ${missing.map((index) => String(index + 1)).join('、')} 条（冻结集合 ` +
        `${String(probe.frozen.length)} 条 / 审计 ${String(auditedSet.size)} 条）`,
    );
    return;
  }
  const bad = actual.filter((index) => {
    const after = probe.requestView[index];
    return !(
      after !== undefined &&
      after.role === 'tool' &&
      typeof after.tool_call_id === 'string' &&
      auditedSet.has(after.tool_call_id) &&
      isClearedToolResult(after.content)
    );
  });
  if (bad.length > 0) {
    fail(
      label,
      `请求视图改写了 ${String(bad.length)} 条**非**占位替换的消息（只允许把审计集合内的` +
        '工具结果换成本函数产出的占位文本）',
    );
    return;
  }
  ok(
    `C1g placeholder 模式：请求视图改写 ${String(actual.length)} 条 = 审计集合 ∩ 落盘工具结果` +
      `（审计 ${String(auditedSet.size)} 条、落盘工具结果 ${String(probe.survived)} 条、` +
      `压缩移除 ${String(probe.removed)} 条；对照传空集合改写 0 条）`,
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
  //
  // 0.54 B3 更新（判据**加强**，不是放宽）：以前这里断言的是「`loadStoredHistory` 的
  // 事件读取里出现 `event.type === 'message.compaction'` 这个触发串」—— 那要求的是
  // 「尾部有压缩/撤回时才重放整份日志」，前提是读侧会按缓存水位裁剪读取范围。
  // B3 把那个裁剪整个删掉了（ADR-105 D2：投影 = `fold(timeline[1..seq])` 的纯函数结果），
  // 换来的不变量**更强**，所以这里改钉更强的三条：
  //   ① 投影的事件读取**不许**出现 `sinceSeq` 裁剪（旧写法 `read({sinceSeq: derived})`
  //      正是 P7「运行中刷新只剩 4 条」的入口）；
  //   ② 缓存只按**内容**对账（`reconcileCachedProjection`），不认任何游标字段；
  //   ③ 投影恒取原文口径（`applyClearedReplacements: false`），替换语义无条件生效。
  // 另外把「替换语义只认压缩/撤回」这条钉回它真正的归属地：投影函数本身。
  const historyStart = eu.indexOf('private async loadStoredHistory');
  const historyEnd =
    historyStart < 0 ? -1 : eu.indexOf('\n  private ', historyStart + 'private async '.length);
  const historyBody =
    historyStart < 0 ? '' : eu.slice(historyStart, historyEnd < 0 ? eu.length : historyEnd);
  // 只看代码行：注释里提 `sinceSeq`（解释为什么不能这么写）不算违规。
  const historyCode = historyBody
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
  if (historyBody.length === 0) {
    fail('packages/core/src/runtime/execution-unit.ts', '找不到 loadStoredHistory（改名了？）');
  } else if (/sinceSeq\s*:/.test(historyCode)) {
    fail(
      'packages/core/src/runtime/execution-unit.ts',
      '投影的事件读取被游标裁剪（`sinceSeq:` 又出现在 loadStoredHistory 里）—— 那是 P7 的入口',
    );
  } else if (!historyCode.includes('reconcileCachedProjection(')) {
    fail(
      'packages/core/src/runtime/execution-unit.ts',
      '缓存没有走「按内容对账」的纯读侧函数（reconcileCachedProjection）',
    );
  } else if (!historyBody.includes('applyClearedReplacements: false')) {
    fail('packages/core/src/runtime/execution-unit.ts', '投影没有显式取原文口径（会物化占位）');
  } else {
    ok('C2 投影恒为整份日志（无游标裁剪）+ 缓存按内容对账 + 原文口径');
  }

  const projection = await source('packages/core/src/session/project-messages.ts');
  if (projection.length > 0) {
    const triggers = ["event.type === 'message.compaction'", "event.type === 'session.rewound'"];
    const missing = triggers.filter((trigger) => !projection.includes(trigger));
    if (missing.length > 0) {
      fail(
        'packages/core/src/session/project-messages.ts',
        `替换语义的两类触发事件不齐：缺 ${missing.join(' / ')}`,
      );
    } else {
      ok('C2 全量重投影只认压缩/撤回事件（判据落在投影函数上）');
    }
  }
}

// ───────────────────────── C3 词表对拍 ─────────────────────────

/**
 * 旧词：`selfcard` 是 0.52 之前 `self-card-delta` 用的首词，落盘消息里还有历史存量。
 * Web 必须继续认得它（否则旧消息的卡头会静默退化成「上下文」），生产者不得再发。
 */
const LEGACY_SCOPES = ['selfcard'] as const;

/**
 * 插件侧的词表副本。
 *
 * `plugins/context/doc-subscription` 只依赖 core、不依赖 `packages/agent`（依赖方向反了），
 * 所以它的首词（`files`）与明细标记只能抄一份字面量。抄了就必须对拍：单边改词时卡头标签
 * 会静默掉回「上下文」—— 正文看着正常、标签是错的，靠人复查抓不住。
 */
const PLUGIN_NOTICE = 'plugins/context/doc-subscription/src/notice.ts';

/** 插件通知的 scope 词 / 明细标记必须与生产侧真相逐字一致。 */
async function runPluginVocabularyChecks(): Promise<void> {
  const text = await source(PLUGIN_NOTICE);
  if (text.length === 0) return;
  const scope = /SUBSCRIPTION_NOTICE_SCOPE = '([^']+)'/.exec(text)?.[1];
  if (scope === undefined) {
    fail(`C3 ${PLUGIN_NOTICE}`, '读不到 SUBSCRIPTION_NOTICE_SCOPE 字面量（对拍没抓手了）');
  } else if (!(ENV_INFO_SCOPES as readonly string[]).includes(scope)) {
    fail(`C3 ${PLUGIN_NOTICE}`, `scope 字面量「${scope}」不在 ENV_INFO_SCOPES 里`);
  } else {
    ok(`C3 插件通知 scope「${scope}」在词表里`);
  }
  const mark = /SUBSCRIPTION_NOTICE_DETAIL_MARK = '([^']*)'/.exec(text)?.[1];
  if (mark !== ENV_INFO_DETAIL_MARK) {
    fail(
      `C3 ${PLUGIN_NOTICE}`,
      `明细标记「${mark ?? '读不到'}」≠ ENV_INFO_DETAIL_MARK「${ENV_INFO_DETAIL_MARK}」` +
        '（对不上时整条通知会被 Web 读成一整行，明细永远展开不出来）',
    );
  } else {
    ok('C3 插件通知明细标记与 ENV_INFO_DETAIL_MARK 逐字相同');
  }
}

/**
 * 标签侧对拍：每个生产词都得有本地化标签（`chat.env.scope.<scope>`），中英两侧都要有。
 *
 * 词加了、标签没加时，卡头会把 i18n key 原样渲染给用户看（或者回退成生词）—— 这类缺口
 * 词表对拍看不见（词是有的），只有对着 i18n 文件点 key 才看得见。
 */
async function runScopeLabelChecks(): Promise<void> {
  const missing: string[] = [];
  for (const locale of ['en', 'zh-CN'] as const) {
    const text = await source(`apps/web/src/i18n/messages/${locale}.ts`);
    if (text.length === 0) continue;
    for (const scope of ENV_INFO_SCOPES) {
      if (!text.includes(`'chat.env.scope.${scope}':`)) missing.push(`${locale}:${scope}`);
    }
  }
  if (missing.length > 0) {
    fail('C3 标签', `这些 scope 没有卡头标签：${missing.join(' / ')}`);
    return;
  }
  ok(`C3 scope 卡头标签（${ENV_INFO_SCOPES.length} 个词 × 2 语言）`);
}

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
  // 插件侧：`vessel:subscription` 不得再当生产侧的通道名（历史消息不做特判，走未登记
  // kind 的兜底）。只看字符串字面量：注释里提到这个老名是必要的（说明它为什么不在了）。
  const hook = await source('plugins/context/doc-subscription/src/hook.ts');
  if (/['"]vessel:subscription['"]/.test(hook)) {
    fail('plugins/context/doc-subscription/src/hook.ts', '仍在发旧通道 vessel:subscription');
  } else {
    ok('C3 订阅通知只发 vessel:notice');
  }
  await runPluginVocabularyChecks();
  await runScopeLabelChecks();
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

  // C0b：C1h 豁免判据的自检。四真少一条就必须红 —— 否则「按豁免事实判定」随时可能
  //      退化成「永远 EXEMPT」的空壳，那种绿比红更坏（它给的是虚假的安全感）。
  const c1hDeclaration = declareProjection({ mode: 'placeholder' });
  const c1hAudit: NonNullable<SessionState['context_projection_audit']> = {
    schema_version: 1,
    declaration: c1hDeclaration,
    steps: ['placeholder', 'placeholder'],
    reason: null,
    requested_mode: null,
    at: 1,
  };
  const c1hDisk: readonly Message[] = [
    { role: 'system', content: 'sys' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'p', arguments: '{}' } }],
    },
    { role: 'tool', content: 'raw output 1', tool_call_id: 'call-1' },
    { role: 'tool', content: 'raw output 2', tool_call_id: 'call-2' },
  ];
  /** 该状态下四真齐全的一份会话事实（各反例从此处改一处得到）。 */
  const c1hState: RequestProjectionState = {
    messages: c1hDisk,
    context_projection: c1hDeclaration,
    context_projection_audit: c1hAudit,
    cleared_tool_call_ids: ['call-1'],
  };
  const c1hGoodView = withClearedToolResults(c1hDisk, ['call-1']);
  const c1hOverreachView = withClearedToolResults(c1hDisk, ['call-1', 'call-2']);
  const c1hMaskedView = c1hDisk.map((message) =>
    message.tool_call_id === 'call-1' ? { ...message, content: '[masked]' } : message,
  );
  const c1hCases: Array<{
    readonly name: string;
    readonly state: RequestProjectionState;
    readonly request: readonly Message[];
    readonly want: RequestProjectionVerdict['kind'];
  }> = [
    { name: '逐字一致', state: c1hState, request: c1hDisk, want: 'identical' },
    { name: '四真齐全', state: c1hState, request: c1hGoodView, want: 'exempt' },
    {
      name: '缺声明',
      state: { ...c1hState, context_projection: undefined },
      request: c1hGoodView,
      want: 'violation',
    },
    {
      name: '声明 passthrough 却有改写',
      state: { ...c1hState, context_projection: declareProjection({ mode: 'passthrough' }) },
      request: c1hGoodView,
      want: 'violation',
    },
    {
      name: '缺审计行',
      state: { ...c1hState, context_projection_audit: null },
      request: c1hGoodView,
      want: 'violation',
    },
    {
      name: '审计链尾与声明不一致',
      state: {
        ...c1hState,
        context_projection_audit: { ...c1hAudit, steps: ['passthrough', 'passthrough'] },
      },
      request: c1hGoodView,
      want: 'violation',
    },
    {
      name: '缺审计集合',
      state: { ...c1hState, cleared_tool_call_ids: [] },
      request: c1hGoodView,
      want: 'violation',
    },
    { name: '越界多改', state: c1hState, request: c1hOverreachView, want: 'violation' },
    {
      name: '审计点名但漏改',
      state: { ...c1hState, cleared_tool_call_ids: ['call-1', 'call-2'] },
      request: c1hGoodView,
      want: 'violation',
    },
    { name: '改了但不是占位', state: c1hState, request: c1hMaskedView, want: 'violation' },
  ];
  for (const testCase of c1hCases) {
    const verdict = requestProjectionVerdict(testCase.state, testCase.request);
    if (verdict.kind !== testCase.want) {
      fail(
        'C0b',
        `「${testCase.name}」期望 ${testCase.want}，实际 ${verdict.kind}（${verdict.why}）`,
      );
    }
  }
  if (failures.every((entry) => !entry.startsWith('C0b'))) {
    ok(
      `C0b C1h 判据自检（${String(c1hCases.length)} 例：四真放行，缺声明/错模式/缺审计/` +
        '越界/漏改/非占位逐条拦下）',
    );
  }

  await runRealPaths();
  await runStaticChecks();
  await runVocabularyChecks();

  const total = passed + failures.length;
  // 通过时也把「跑了哪些路径」打出来：门禁的结论要能被人复核，尤其这条不变量是
  // 「我实测到了什么」而不是「我读代码觉得没问题」。
  for (const line of paths) console.log(line);
  // `--phase=1` 只留兼容：已无 PENDING 条目可降级，所以两种模式必须结论相同。
  if (PHASE_ONE) {
    console.log(
      'NOTE --phase=1：已无 PENDING 条目（C1h 在 0.53 收口改成按豁免事实判定的硬判据）——' +
        '本模式与默认模式必须给出同一个结论',
    );
  }
  if (failures.length === 0) {
    console.log(`OK append-only-context: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED append-only-context: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
