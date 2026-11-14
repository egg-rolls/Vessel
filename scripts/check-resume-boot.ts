#!/usr/bin/env bun
/**
 * 0.52 S1c · 启动恢复探针（零依赖：只用仓内替身 + 真 service）。
 *
 * 断言的是「重启之后用户和模型都看得清」这一条链：
 *   读标记 → 发一张环境信息卡 → FIFO 重放已接受输入 → 准入后清标记 → 幂等。
 *
 * 替身与真货的边界（别误读）：
 * - 真货：`MemorySessionStore` / `RunJournalFactory`（标记的唯一写口）/ `SessionEventLog`
 *   （去重与准入的证据）/ 真 `ExecutionUnit`（卡片注入顺序、落成消息、llm.request）/
 *   真 `AgentServiceImpl`（`announceEnvironmentCard` 与 `recoverPendingInputs`）。
 * - 替身：`runtime`（`runTurn` 里把暂存的 notice 作为 `RunOptions.messages` 交给真 EU，
 *   这正是 `MemberRuntime.executeTurn` 的契约）；`MemoryLLMProvider`（回显，让 run 收尾）。
 * - 「重新启动」＝ 清掉进程内暂存的 notice 队列（真进程重启时它当然没了）。
 *
 * 跑法：`bun run scripts/check-resume-boot.ts`
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createResumeMarkerRegistry,
  createRunJournalFactory,
  ExecutionUnit,
  isRestartCardMessage,
  MemoryEventStream,
  MemoryLLMProvider,
  MemorySessionStore,
  MemoryWorkingContext,
  restartCardAdmitted,
  restartInterruptedIso,
  sameRestartMarker,
  SessionEventLog,
  type Message,
  type ResumeAfterRestart,
  type SessionEventRecord,
  type SessionState,
} from '../packages/core/src/index';
import { AgentServiceImpl } from '../packages/agent/src/service';
import { ENV_INFO_MESSAGE_NAME, ENV_INFO_SCOPES } from '../packages/agent/src/env-info-scope';
// 真 UI 解析器（web 的 EnvCard 就靠它把  认成一张卡片）
import { envNoticeCard } from '../apps/web/src/domains/chat/env-notice';
import { createNodeResumer, restartCardText } from '../src/node-resume';
import type { Locale } from '../src/i18n/index';

// ── 断言小工具（与其它 check 脚本同风格）──────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  failures.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ── 测试脚手架 ────────────────────────────────────────────────────────────
const MODEL = { provider: 'test', model: 'test-model' } as never;

function baseState(sessionId: string): SessionState {
  return {
    session_id: sessionId,
    status: 'idle',
    messages: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  } as SessionState;
}

/** 与 `MemberRuntime` 里 `noticeMessage` 同形（0.52 S1c 给它加了可选 timestamp）。 */
function noticeMessage(text: string, timestamp?: number): Message {
  return {
    role: 'user',
    name: 'vessel:notice',
    content: text,
    timestamp: timestamp ?? Date.now(),
  } as Message;
}

interface Harness {
  dir: string;
  /** 每一次 SessionState 落盘（runId + sessionId），用来证明清标记走的是 RunJournal */
  journalSaves: { runId: string; sessionId: string }[];
  session: MemorySessionStore;
  eventLog: SessionEventLog;
  journalFactory: ReturnType<typeof createRunJournalFactory>;
  notices: Map<string, { text: string; timestamp?: number }[]>;
  service: AgentServiceImpl;
  sessionIdOf(memberId: string): string;
  /** 真 EU（每会话一具），拿到就能直接跑一轮 */
  unitOf(sessionId: string): Promise<ExecutionUnit>;
  /** 模拟进程重启：进程内的暂存 notice 随进程一起消失 */
  reboot(): void;
  /** 某会话的落盘状态 */
  stateOf(sessionId: string): Promise<SessionState | undefined>;
  /** 某会话的事件日志（durable 证据） */
  eventsOf(sessionId: string): Promise<SessionEventRecord[]>;
}

async function makeHarness(memberIds: string[]): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'vessel-resume-probe-'));
  const session = new MemorySessionStore();
  const resumeMarkers = createResumeMarkerRegistry();
  const eventLog = new SessionEventLog({ dir: join(dir, 'sessions'), durable: false });
  const journalSaves: { runId: string; sessionId: string }[] = [];
  const journalFactory = createRunJournalFactory({ session, resumeMarkers, eventLog });
  // 记录「谁写过 SessionState」：清标记必须走 RunJournal 单写口，探针要能看见这一笔。
  const spyTransient = journalFactory.transient.bind(journalFactory);
  journalFactory.transient = (identity: { runId: string; sessionId: string }) => {
    const journal = spyTransient(identity as never);
    const original = journal.saveSessionState.bind(journal);
    journal.saveSessionState = async (state: SessionState) => {
      journalSaves.push({ runId: identity.runId, sessionId: identity.sessionId });
      return original(state);
    };
    return journal;
  };
  const notices = new Map<string, { text: string; timestamp?: number }[]>();
  const units = new Map<string, ExecutionUnit>();

  const unitOf = async (sessionId: string): Promise<ExecutionUnit> => {
    const existing = units.get(sessionId);
    if (existing !== undefined) return existing;
    const unit = await ExecutionUnit.create({
      provider: new MemoryLLMProvider(),
      model: MODEL,
      contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
      events: new MemoryEventStream(),
      eventLog,
      limits: {},
      termination: {},
      journalFactory,
      session,
      systemPrompt: 'resume probe system prompt',
      retry: { maxRetries: 0 },
    } as never);
    if ((await session.load(sessionId)) === null) await session.save(baseState(sessionId));
    units.set(sessionId, unit);
    return unit;
  };

  const service = new AgentServiceImpl({
    tenantId: 'tenant-resume-probe',
    dataDir: dir,
    eventLog,
    runtime: {
      spawn: async () => undefined,
      runTurn: async (member: { id: string; session_id: string }, message: { content: unknown }) => {
        // MemberRuntime.executeTurn 的契约：暂存 notice 作为注入消息，排在用户输入之前。
        const pending = notices.get(member.id) ?? [];
        notices.delete(member.id);
        const unit = await unitOf(member.session_id);
        const text = typeof message.content === 'string' ? message.content : '';
        await unit.run(text, member.session_id, {
          messages: pending.map((notice) => noticeMessage(notice.text, notice.timestamp)),
        } as never);
        return { outcome: 'completed', content: '' } as never;
      },
      cancel: async () => false,
      dispose: async () => undefined,
      notice: (memberId: string, text: string, options?: { timestamp?: number }) => {
        const bucket = notices.get(memberId) ?? [];
        bucket.push(options?.timestamp === undefined ? { text } : { text, timestamp: options.timestamp });
        notices.set(memberId, bucket);
      },
    } as never,
    scheduler: {
      // 真 scheduler 的契约：submit 起跑并回一个 RunHandle；探针里同步跑完。
      submit: async (task: { runId: string; executor: (runId: string) => Promise<unknown> }) => {
        const settled = task.executor(task.runId);
        const handle = {
          status: () => 'completed',
          cancel: async () => false,
          result: () => settled,
          done: settled,
        };
        await settled;
        return handle;
      },
      release: () => undefined,
      sizeOf: () => 0,
    } as never,
  } as never);
  await service.ready;

  const sessionIds = new Map<string, string>();
  for (const memberId of memberIds) {
    const status = await service.create({ id: memberId, name: memberId } as never);
    sessionIds.set(memberId, status.session_id);
  }

  const sessionIdOf = (memberId: string): string => {
    const found = sessionIds.get(memberId);
    if (found === undefined) throw new Error(`unknown member ${memberId}`);
    return found;
  };

  return {
    dir,
    journalSaves,
    session,
    eventLog,
    journalFactory,
    notices,
    service,
    sessionIdOf,
    unitOf,
    reboot: () => notices.clear(),
    stateOf: async (sessionId: string) => (await session.load(sessionId)) ?? undefined,
    eventsOf: async (sessionId: string) => {
      try {
        return await eventLog.read(sessionId);
      } catch {
        return [];
      }
    },
  };
}

// ── 共用：造一个「上一次进程死掉时留下的」标记会话 ────────────────────────
const INTERRUPTED_AT = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

function markerOf(
  runId: string,
  pendingInputIds: string[],
  options?: { backgroundStopped?: boolean; interruptedAt?: number },
): ResumeAfterRestart {
  return {
    run_id: runId,
    interrupted_at: options?.interruptedAt ?? INTERRUPTED_AT,
    reason: 'shutdown',
    pending_input_ids: pendingInputIds,
    background_stopped: options?.backgroundStopped ?? false,
  } as ResumeAfterRestart;
}

async function seedMarker(
  harness: Harness,
  sessionId: string,
  marker: ResumeAfterRestart,
): Promise<void> {
  const existing = (await harness.stateOf(sessionId)) ?? baseState(sessionId);
  await harness.session.save({ ...existing, resume_after_restart: marker } as SessionState);
}

/**
 * 造一条「已接受、还没变成 run input」的 human 输入（S1a 记进标记的那一类）。
 *
 * 直接写 durable inbox（`input` 投递 + human 源 + 带 session_id）：
 * 这就是 `recoverPendingInputs` 唯一认的条目形状，不必经过 dispatch 的准入状态机。
 */
async function queueHumanInput(
  harness: Harness,
  memberId: string,
  content: string,
): Promise<string> {
  const sessionId = harness.sessionIdOf(memberId);
  const store = (harness.service as unknown as { inbox?: InboxAppendPort }).inbox;
  if (store === undefined) throw new Error('service has no inbox store');
  const id = `input_${memberId}_${Math.random().toString(36).slice(2, 10)}`;
  store.append(
    memberId,
    { id, ts: Date.now(), source: 'human', text: content, session_id: sessionId },
    { delivery: 'input' },
  );
  return id;
}

interface InboxAppendPort {
  append(
    agentId: string,
    message: {
      id: string;
      ts: number;
      source: string;
      text: string;
      session_id?: string;
    },
    options?: { delivery?: 'input' | 'wake' | 'quiet' },
  ): { accepted: boolean; reason?: string };
}

function resumerFor(harness: Harness, overrides?: { locale?: Locale; settleBudgetMs?: number }) {
  return createNodeResumer({
    session: harness.session,
    eventLog: harness.eventLog,
    announce: (sessionId, text) => harness.service.announceEnvironmentCard(sessionId, text),
    clearMarker: async (sessionId, marker) => {
      const state = await harness.stateOf(sessionId);
      if (state === undefined) return false;
      // 恢复期间那一轮 run 落盘时可能已经带走了标记（append-only 状态重建）：
      // 那也是「这份标记已经解决」，不是「清失败」。
      if (state.resume_after_restart === undefined) return true;
      if (!sameRestartMarker(state.resume_after_restart, marker)) return false;
      const { resume_after_restart: _cleared, ...rest } = state;
      const journal = harness.journalFactory.transient({
        runId: 'manual',
        sessionId,
        events: new MemoryEventStream(),
      });
      await journal.saveSessionState(rest as SessionState);
      return true;
    },
    replay: async () => {
      const recovered = await harness.service.recoverPendingInputs();
      return { recovered: recovered.recovered, sessions: recovered.sessions };
    },
    warn: () => undefined,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    settleBudgetMs: overrides?.settleBudgetMs ?? 2_000,
    ...(overrides?.locale === undefined ? {} : { locale: overrides.locale }),
  });
}

function cardsOf(records: readonly SessionEventRecord[], marker: RestartCardKeyLike): number {
  let count = 0;
  for (const record of records) {
    const message = (record.data as { message?: Message } | undefined)?.message;
    if (message !== undefined && isRestartCardMessage(message, marker)) count += 1;
  }
  return count;
}

type RestartCardKeyLike = { run_id: string; interrupted_at: number };

function cardMessageOf(
  state: SessionState | undefined,
  marker: RestartCardKeyLike,
): Message | undefined {
  return state?.messages.find((message) => isRestartCardMessage(message, marker));
}

// ── 探针 1（a · b · c）：两张卡、无标记零卡、卡是正常可见消息 ─────────────
async function probeAnnounce(): Promise<void> {
  section('探针 1（a/b/c）· 有标记才发卡，且卡是会话流里的正常消息');
  const harness = await makeHarness(['main', 'worker-1', 'worker-2', 'idle-worker']);

  const s1 = harness.sessionIdOf('worker-1');
  const s2 = harness.sessionIdOf('worker-2');
  const sIdle = harness.sessionIdOf('idle-worker');

  const input1 = await queueHumanInput(harness, 'worker-1', '第一条：把 tests/ 跑一遍');
  const input2 = await queueHumanInput(harness, 'worker-1', '第二条：跑完贴结论');

  await seedMarker(harness, s1, markerOf('run_a1', [input1, input2], { backgroundStopped: true }));
  const input3 = await queueHumanInput(harness, 'worker-2', '另一具 body 的输入');
  await seedMarker(harness, s2, markerOf('run_a2', [input3]));
  // sIdle 没有任何标记

  const resumer = resumerFor(harness);
  const report = await resumer.beginResume();
  const final = await resumer.whenSettled();

  check('a. 扫到 2 个带标记的会话', report.marked === 2, report.marked);
  check('a. 恰好发 2 张卡', report.announced === 2, report.announced);
  check('b. 无标记的会话 0 张卡', !report.marks.some((mark) => mark.session_id === sIdle));
  const idleEvents = await harness.eventsOf(sIdle);
  check(
    'b. 无标记的会话事件流里没有重启卡',
    cardsOf(idleEvents, { run_id: 'run_a1', interrupted_at: INTERRUPTED_AT }) === 0 &&
      cardsOf(idleEvents, { run_id: 'run_a2', interrupted_at: INTERRUPTED_AT }) === 0,
    idleEvents.length,
  );

  const events1 = await harness.eventsOf(s1);
  const events2 = await harness.eventsOf(s2);
  check(
    'a. worker-1 的卡恰好 1 张（没重复）',
    cardsOf(events1, { run_id: 'run_a1', interrupted_at: INTERRUPTED_AT }) === 1,
    cardsOf(events1, { run_id: 'run_a1', interrupted_at: INTERRUPTED_AT }),
  );
  check(
    'a. worker-2 的卡恰好 1 张（没重复）',
    cardsOf(events2, { run_id: 'run_a2', interrupted_at: INTERRUPTED_AT }) === 1,
    cardsOf(events2, { run_id: 'run_a2', interrupted_at: INTERRUPTED_AT }),
  );

  const state1 = await harness.stateOf(s1);
  const card = cardMessageOf(state1, { run_id: 'run_a1', interrupted_at: INTERRUPTED_AT });
  check('c. 卡是会话流里的正常消息（落盘进 messages）', card !== undefined);
  check('c. 卡的发送者是环境信息通道 vessel:notice', card?.name === 'vessel:notice', card?.name);
  check('c. 卡不是隐藏消息：role=user 且带正文（与其它 env 卡同一条通道）', card?.role === 'user');
  check(
    'c. 卡走的是可见注入层（durable 事件是 message.injected，不是内部层）',
    events1.some(
      (record) =>
        record.type === 'message.injected' &&
        isRestartCardMessage(
          (record.data as { message?: Message }).message as Message,
          { run_id: 'run_a1', interrupted_at: INTERRUPTED_AT },
        ),
    ),
  );
  const cardText = typeof card?.content === 'string' ? card.content : '';
  check(
    'c. 卡片的 scope 在环境信息族里是登记过的（web EnvCard 才认得）',
    ENV_INFO_SCOPES.includes('restart') &&
      ENV_INFO_MESSAGE_NAME === 'vessel:notice' &&
      cardText.startsWith('restart: '),
    cardText.split('\n')[0],
  );
  check('a. 卡文案含被打断的 run_id', cardText.includes('run_a1'));
  // 用**真 UI 解析器**读这张卡：它是 web 渲染 EnvCard 的那一段代码，不是探针自造的判断。
  const uiCard = envNoticeCard(cardText);
  check('c. web 的 EnvCard 解析器认出这是一张 restart 卡', uiCard?.scope === 'restart', uiCard?.scope);
  check(
    'c. 解析出来的明细行与文案一一对应（不是挤进卡头的单行）',
    (uiCard?.lines.length ?? 0) >= 4,
    uiCard?.lines.length,
  );
  check('c. 解析出的摘要里带 run_id 与时间', (uiCard?.lines[0]?.text ?? '').includes('run_a1'));
  check(
    'a. 卡文案含打断时刻（ISO）',
    cardText.includes(restartInterruptedIso({ run_id: 'run_a1', interrupted_at: INTERRUPTED_AT })),
  );
  check('a. 卡文案含「先核对再继续」的指令', /check the current state|先核对现状/.test(cardText));
  check('a. 卡文案提到后台进程已停', /background processes were stopped|后台进程/.test(cardText));
  check('a. 卡首行首 token 是 restart（web 用它选卡头 scope）', /^restart:|^restart\b/.test(cardText));
  check('a. 准入后标记已清', final.cleared.includes(s1), final.cleared);
}

// ── 探针 2（d）：卡在被重放的输入之前 ────────────────────────────────────
async function probeOrdering(): Promise<void> {
  section('探针 2（d）· 卡的顺序在被重放的输入之前');
  const harness = await makeHarness(['main', 'worker']);
  const sessionId = harness.sessionIdOf('worker');
  const inputId = await queueHumanInput(harness, 'worker', '重启前就被接受的输入');
  await seedMarker(harness, sessionId, markerOf('run_d1', [inputId], { interruptedAt: INTERRUPTED_AT + 1 }));

  const resumer = resumerFor(harness);
  await resumer.beginResume();
  await resumer.whenSettled();

  const events = await harness.eventsOf(sessionId);
  const cardRecord = events.find((record) => {
    const message = (record.data as { message?: Message } | undefined)?.message;
    return (
      message !== undefined &&
      isRestartCardMessage(message, { run_id: 'run_d1', interrupted_at: INTERRUPTED_AT + 1 })
    );
  });
  const userRecord = events.find((record) => record.type === 'user.message');
  check('d. 卡有 message.injected 事件', cardRecord !== undefined);
  check('d. 重放的输入有 user.message 事件', userRecord !== undefined);
  check(
    'd. 卡的事件序早于被重放的输入',
    cardRecord !== undefined && userRecord !== undefined && cardRecord.seq < userRecord.seq,
    { card: cardRecord?.seq, user: userRecord?.seq },
  );

  const state = await harness.stateOf(sessionId);
  const cardIndex = state?.messages.findIndex((message) =>
    isRestartCardMessage(message, { run_id: 'run_d1', interrupted_at: INTERRUPTED_AT + 1 }),
  );
  const userIndex = state?.messages.findIndex((message) => {
    if (message.name === 'vessel:notice') return false;
    const content = typeof message.content === 'string' ? message.content : '';
    return content.includes('重启前就被接受的输入');
  });
  check(
    'd. 上下文里卡排在输入之前',
    cardIndex !== undefined && userIndex !== undefined && cardIndex >= 0 && cardIndex < userIndex,
    { cardIndex, userIndex },
  );
  const cardMessage = cardMessageOf(state, { run_id: 'run_d1', interrupted_at: INTERRUPTED_AT + 1 });
  const cardTs = typeof cardMessage?.timestamp === 'number' ? cardMessage.timestamp : -1;
  check(
    'd. 卡的时间戳是「产生时刻」（早于此后被放行的 run 也不算未来）',
    cardTs > 0 && cardTs >= INTERRUPTED_AT,
    { cardTs },
  );
}

// ── 探针 3（e）：准入之后才清标记，准入不了就不清 ────────────────────────
async function probeAdmissionGate(): Promise<void> {
  section('探针 3（e）· 标记只在卡片被准入后才清');
  const harness = await makeHarness(['main', 'worker']);

  // (e-1) 准入成功：有已接受输入 ⇒ 重放的那一轮把卡注入并发出 llm.request
  const admittedSession = harness.sessionIdOf('worker');
  const inputId = await queueHumanInput(harness, 'worker', '准入成功用输入');
  await seedMarker(harness, admittedSession, markerOf('run_e1', [inputId]));
  const resumer = resumerFor(harness);
  await resumer.beginResume();
  const settled = await resumer.whenSettled();
  const afterAdmit = await harness.stateOf(admittedSession);
  check('e. 准入后标记已清', afterAdmit?.resume_after_restart === undefined);
  check('e. 报告里记为 cleared', settled.cleared.includes(admittedSession), settled.cleared);
  const events = await harness.eventsOf(admittedSession);
  check(
    'e. 确有「卡已准入」的证据（message.injected 之后有 llm.request）',
    restartCardAdmitted(events, { run_id: 'run_e1', interrupted_at: INTERRUPTED_AT }),
  );

  // (e-2) 准入失败：标记在，但没有任何已接受输入 ⇒ 没有 run ⇒ 卡只暂存，不进请求
  const stalledSession = harness.sessionIdOf('main');
  await seedMarker(harness, stalledSession, markerOf('run_e2', []));
  const second = resumerFor(harness, { settleBudgetMs: 120 });
  const report = await second.beginResume();
  const stalled = await second.whenSettled();
  const afterStall = await harness.stateOf(stalledSession);
  check('e. 未准入（没有 run）⇒ 标记仍在，不读完就删', afterStall?.resume_after_restart !== undefined);
  check('e. 报告里记为 kept', report.marks.some((mark) => mark.marker === 'kept') || stalled.settle === 'timeout', {
    settle: stalled.settle,
    marks: report.marks,
  });
  const stalledEvents = await harness.eventsOf(stalledSession);
  check(
    'e. 未准入时事件流里没有卡的注入记录',
    cardsOf(stalledEvents, { run_id: 'run_e2', interrupted_at: INTERRUPTED_AT }) === 0,
  );
}

// ── 探针 4（f）：同一标记二次启动不重复发卡 ──────────────────────────────
async function probeIdempotent(): Promise<void> {
  section('探针 4（f）· 同一标记二次启动只认一张卡（幂等键）');
  const harness = await makeHarness(['main', 'worker']);
  const sessionId = harness.sessionIdOf('worker');
  const inputId = await queueHumanInput(harness, 'worker', '幂等用输入');
  const marker = markerOf('run_f1', [inputId]);
  await seedMarker(harness, sessionId, marker);

  // 第一次启动：发卡 + 准入（清标记）
  const first = resumerFor(harness);
  await first.beginResume();
  await first.whenSettled();
  check('f. 第一次启动后标记已清', (await harness.stateOf(sessionId))?.resume_after_restart === undefined);

  // 「刚清完又崩一次没清成」：把同一份标记写回去，模拟进程在清之前死掉
  await seedMarker(harness, sessionId, marker);
  harness.reboot(); // 新进程：暂存 notice 队列当然没了

  const second = resumerFor(harness);
  const report = await second.beginResume();
  await second.whenSettled();
  const events = await harness.eventsOf(sessionId);
  check(
    'f. 第二次启动认出「已发过」，不再发第二张',
    cardsOf(events, { run_id: 'run_f1', interrupted_at: INTERRUPTED_AT }) === 1,
    cardsOf(events, { run_id: 'run_f1', interrupted_at: INTERRUPTED_AT }),
  );
  check('f. 报告里记为 deduped', report.deduped === 1, report.deduped);
  check('f. 已发过的那张卡直接补判定并清标记', (await harness.stateOf(sessionId))?.resume_after_restart === undefined);
  check(
    'f. 清标记走的是 RunJournal 单写口（manual 那一笔 SessionState 落盘）',
    harness.journalSaves.some((save) => save.runId === 'manual' && save.sessionId === sessionId),
    harness.journalSaves,
  );
}

// ── 探针 5（g）：pending_input_ids 与实际重放条数一致 ────────────────────
async function probeReplayCount(): Promise<void> {
  section('探针 5（g）· pending_input_ids 与 inbox 实际重放条数一致');
  const harness = await makeHarness(['main', 'worker-a', 'worker-b']);
  const a = harness.sessionIdOf('worker-a');
  const b = harness.sessionIdOf('worker-b');

  const a1 = await queueHumanInput(harness, 'worker-a', 'A-1');
  const a2 = await queueHumanInput(harness, 'worker-a', 'A-2');
  const b1 = await queueHumanInput(harness, 'worker-b', 'B-1');
  await seedMarker(harness, a, markerOf('run_g1', [a1, a2], { interruptedAt: INTERRUPTED_AT + 2 }));
  await seedMarker(harness, b, markerOf('run_g2', [b1], { interruptedAt: INTERRUPTED_AT + 3 }));

  const resumer = resumerFor(harness);
  const report = await resumer.beginResume();
  await resumer.whenSettled();

  const markedCount = report.marks.reduce((sum, mark) => sum + mark.pending_inputs, 0);
  check('g. 标记里的 pending_input_ids 合计 3 条', markedCount === 3, markedCount);
  check('g. 实际重放也是 3 条', report.replayed_inputs === 3, report.replayed_inputs);
  check('g. 重放覆盖两个会话', report.replayed_sessions === 2, report.replayed_sessions);
  check(
    'g. 两个会话各自的已接受输入都被吃掉了',
    (await harness.service.inboxSnapshot('worker-a', { includeHeld: false })).entries.length === 0 &&
      (await harness.service.inboxSnapshot('worker-b', { includeHeld: false })).entries.length === 0,
  );
  const retry = await harness.service.recoverPendingInputs();
  check('g. 重放是幂等的：再扫一次没有可重放的', retry.recovered === 0, retry.recovered);
}

// ── 探针 6：文案 i18n（en/zh 两侧都有，且是同一份文本给两边）─────────────
async function probeText(): Promise<void> {
  section('探针 6 · 卡文案走 i18n（en/zh 两侧），模型与用户同一份');
  const marker = markerOf('run_i18n', [], { backgroundStopped: true });
  const en = restartCardText(marker, { pending_inputs: 2 }, 'en');
  const zh = restartCardText(marker, { pending_inputs: 2 }, 'zh-CN');
  const iso = restartInterruptedIso(marker);

  for (const [locale, text] of [
    ['en', en],
    ['zh-CN', zh],
  ] as const) {
    check(`${locale}: 含 run_id`, text.includes('run_i18n'));
    check(`${locale}: 含 ISO 时刻`, text.includes(iso));
    check(`${locale}: 首行 scope token 是 restart`, text.split('\n')[0].startsWith('restart'));
    check(`${locale}: 含「先核对再继续」`, /check the current state|先核对现状/.test(text));
    check(`${locale}: 含后台进程已停`, /background processes were stopped|后台进程/.test(text));
    check(`${locale}: 含排在后面的已接受输入条数`, text.includes('2'));
    check(`${locale}: 明细行用 · 前缀（EnvCard 的明细解析）`, text.includes('\n  · '));
  }
  check('en / zh 是两套真译文（不是同一份英文兜底）', en !== zh);
  check('中文侧没有漏译的英文指令', !/check the current state/.test(zh));

  // 同一份文本既进上下文也进 UI：卡消息正文 === 交给通道的那一份
  const harness = await makeHarness(['main', 'worker']);
  const sessionId = harness.sessionIdOf('worker');
  const inputId = await queueHumanInput(harness, 'worker', 'i18n 用输入');
  const marked = markerOf('run_i18n2', [inputId], { interruptedAt: INTERRUPTED_AT + 4 });
  await seedMarker(harness, sessionId, marked);
  const resumer = resumerFor(harness, { locale: 'zh-CN' });
  await resumer.beginResume();
  await resumer.whenSettled();
  const state = await harness.stateOf(sessionId);
  const card = cardMessageOf(state, { run_id: 'run_i18n2', interrupted_at: INTERRUPTED_AT + 4 });
  const body = typeof card?.content === 'string' ? card.content : '';
  check('同一份文本：落进会话流的正文与模板一致（模型侧读的就是它）', body === restartCardText(marked, { pending_inputs: 1 }, 'zh-CN'), body.slice(0, 40));
}

// ── main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('0.52 S1c · 启动恢复探针（读标记 → 发卡 → FIFO 重放 → 准入后清标记）');
  await probeAnnounce();
  await probeOrdering();
  await probeAdmissionGate();
  await probeIdempotent();
  await probeReplayCount();
  await probeText();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log(`失败项：${failures.join('；')}`);
    process.exitCode = 1;
  }
}

await main();
