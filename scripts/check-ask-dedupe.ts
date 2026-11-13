#!/usr/bin/env bun

/**
 * ask 分批提交「重投即漂移」门禁（0.52 ask-dedupe）。
 *
 * 现场（从落盘记录读到的，不是猜）：一个人答了 2 题、分两批提交，落盘变成
 * - status: answered / answered_questions: [q1, q2]   —— 状态机是对的；
 * - batch_answers: [(null, 已重启), (q2, 一起答)]      —— 第一批的题号丢了；
 * - answers: q1 + q2 + (null)                          —— 同一条答案被记了两次。
 *
 * 两条根因各自都能独立复发，所以 fixture 分两组钉住：
 *
 * 服务端（真交互注册表 + 事件流回声 + 真投放实现）：
 * - A 归一：缺 question_id 的旧客户端提交，按正文 / 自己的题序位置回退到具体题，
 *   归一之后每一条都带题号 —— 记录里永远不出现「没有题号的答案」；
 * - B 归一之后才去重：第二批把第一批那一行又发一遍时，它必须进 skipped，绝不能被
 *   当成一条新答案追加（0.52 的漂移就是这里：认出了题、但已答过，被折叠成「认不出来」，
 *   于是原样追加，落盘多出一条空题号的答案）；
 * - C 位置回退：连正文都没有的旧提交按「第 i 条 = 第 i 题」归一；再投一次走 skipped；
 * - D 投递正文只含本批新增：inbox 那条 [ask answer ...] 不许把上一批的题再列一遍；
 * - E 双击：同一批提交连发两次 = duplicate，答案条数不变、不重复投递；
 * - G 退路：没有任何可枚举的题时退回旧语义（本批全算数、整条收口），别把历史形状改坏。
 *
 * 客户端（真的 ask-submit-plan / buildAskAnswer，不是另写一份逻辑）：
 * - F 载荷只含**还没落定**的题（服务端逐题进度 answeredQuestionIds），草稿留着展示但
 *   不进载荷，且每条答案都带 question_id —— 客户端漏题号，服务端就只能靠正文猜题；
 * - I 用户手快连点：提交动作一发出就本地记「这几题已答」，第二次**不可提交**（载荷为
 *   空），服务端那边同一批真发两次也只当 skipped；标记带 TTL，失败时自愈解锁。
 *
 * 用法：bun run scripts/check-ask-dedupe.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { mock } from 'bun:test';

import type { AskUserQuestion } from '../apps/web/src/gateway/types/sessions';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : name + ' | got: ' + got);
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

function same(actual: unknown, expected: unknown): boolean {
  return show(actual) === show(expected);
}

type AnyRecord = Record<string, any>;

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

const atomicWriteStub = async (path: string, data: string) => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, 'utf8');
};

/**
 * core / config 的运行时替身：清单照 src/ask-batch.test.ts 的口径（serve + src/ask-*
 * 这条 import 链上真正取用的出口）。少一个会在 import 期炸「缺命名导出」。
 */
mock.module('@vessel-agent/core', () => ({
  atomicWrite: atomicWriteStub,
  createDefaultTraceRedactor: () => (event: unknown) => event,
  projectedKeepCount: () => 0,
  summarizeBroadcastEvent: () => ({}),
  compareSessionInfo: () => 0,
  toSessionInfo: () => ({}),
  projectMessages: () => [],
  compactMessagesForSeed: () => [],
  assertTenantId: () => {},
  SessionCorruptError: class extends Error {},
  LeaseExpiredError: class extends Error {},
  LeaseConflictError: class extends Error {},
  RunResumeError: class extends Error {},
  MemoryEventStream: class {},
  MemoryPluginHost: class {},
  MemoryWorkingContext: class {},
  HookType: { BeforeLlm: 'before_llm', AfterLlm: 'after_llm' },
  MESSAGE_REFS_MAX: 8,
  MESSAGE_REF_PATH_MAX: 4096,
  BROADCAST_PREVIEW_LIMIT: 10,
  DEFAULT_COMPACT_THRESHOLD: 0.8,
  LIMIT_WARNING_THRESHOLD: 0.9,
  noopLogger: quietLogger,
}));

mock.module('@vessel-agent/config', () => ({
  redactConfig: (config: unknown) => config,
  redactSourcePaths: (config: unknown) => config,
  DEFAULT_PLUGIN_HTTP_LIMITS: { body_bytes: 0, timeout_ms: 0 },
  DEFAULT_LEASE_OPTIONS: {},
  isLoopbackHostname: (host: string) =>
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '',
}));

const { createInteractionsRegistry } = await import('../packages/serve/src/interactions-registry');
const { createAskAnswerDelivery } = await import('../src/ask-answer-delivery');
const { buildAskAnswer } = await import('../apps/web/src/gateway/ask-answers');
const { askDraftKey } = await import('../apps/web/src/domains/pending/ask-drafts');
const { askIncludedAnswers, askOpenRows, askPendingAnswers, askPlanRows, askRowsComplete } =
  await import('../apps/web/src/domains/pending/ask-submit-plan');
const { askAnsweredMarksOf, clearAskAnsweredMarks, markAskAnswered } = await import(
  '../apps/web/src/domains/pending/ask-answered-marks'
);

/** 最小事件流：注册表只需要 publish / subscribe / waitFor 三条语义。 */
function memoryStream() {
  const handlers: Array<(event: AnyRecord) => void> = [];
  const stream = {
    publish(event: AnyRecord) {
      for (const handler of [...handlers]) handler(event);
    },
    subscribe(handler: (event: AnyRecord) => void) {
      handlers.push(handler);
      return () => {
        const at = handlers.indexOf(handler);
        if (at >= 0) handlers.splice(at, 1);
      };
    },
    waitFor(name: string, opts?: { requestId?: string }) {
      return new Promise<unknown>((resolve) => {
        const off = stream.subscribe((event: AnyRecord) => {
          if (event.type !== name) return;
          const data = (event.data ?? {}) as AnyRecord;
          if (opts?.requestId !== undefined && data.requestId !== opts.requestId) return;
          off();
          resolve(data);
        });
      });
    },
  };
  return stream;
}

type FakeStream = ReturnType<typeof memoryStream>;

/**
 * 两题、**都不带显式 id**：题号只能由位置推导（q1 / q2），与真实 ask 的形状一致 ——
 * 这也正是「缺 question_id 必须能按正文 / 位置归一」的前提。
 */
function twoQuestions(): AskUserQuestion[] {
  return [
    { header: 'Deploy', question: 'Deploy now?', options: ['yes', 'no'] },
    { header: 'Restart', question: 'How should I restart?' },
  ];
}

/** 旧客户端（0.51 及之前的 buildAnswer）：有正文、**没有 question_id**。 */
function legacyAnswer(index: number, text: string): AnyRecord {
  const question = twoQuestions()[index] ?? { header: '', question: '' };
  return { header: question.header, question: question.question, answer: text };
}

interface Harness {
  stream: FakeStream;
  registry: ReturnType<typeof createInteractionsRegistry>;
  /** 每次「该投递给成员」的通知（= 一条 inbox 消息的载荷）。 */
  deliveries: AnyRecord[];
  request: (options?: { questions?: unknown; mode?: 'sync' | 'async' }) => string;
  record: (requestId: string) => AnyRecord | undefined;
}

function makeHarness(): Harness {
  const stream = memoryStream();
  const deliveries: AnyRecord[] = [];
  const registry = createInteractionsRegistry({
    eventsFor: () => stream as never,
    singleTenantId: 't1',
    onAsyncAskAnswered: (record) => {
      deliveries.push(record as unknown as AnyRecord);
    },
  });
  stream.subscribe((event) => registry.handleEvent(event as never));

  const request = (opts?: { questions?: unknown; mode?: 'sync' | 'async' }) => {
    const requestId = 'req-1';
    stream.publish({
      type: 'ask.user.requested',
      run_id: 'run-1',
      ts: 1000,
      data: {
        requestId,
        questions: opts?.questions ?? twoQuestions(),
        session_id: 'session-1',
        agent_id: 'member-1',
        team_id: 'team-1',
        ...(opts?.mode === 'async' ? { mode: 'async' } : {}),
      },
    });
    return requestId;
  };

  return {
    stream,
    registry,
    deliveries,
    request,
    record: (requestId: string) =>
      registry.interactionRecords.get(requestId) as unknown as AnyRecord | undefined,
  };
}

/** 真投放实现 + 假 admit：断言「投了几次、正文是什么」。 */
function makeDelivery() {
  const admits: AnyRecord[] = [];
  const service = {
    async admit(input: AnyRecord) {
      admits.push(input);
      return { result: { run_id: 'run-2' }, message: {} };
    },
  };
  return { admits, delivery: createAskAnswerDelivery(service as never) };
}

function answersOf(record: AnyRecord | undefined): AnyRecord[] {
  return (((record?.answer ?? {}) as AnyRecord).answers ?? []) as AnyRecord[];
}

function batchAnswersOf(payload: AnyRecord | undefined): AnyRecord[] {
  return (((payload?.answer ?? {}) as AnyRecord).batch_answers ?? []) as AnyRecord[];
}

// ── A + B + D：真实现场（先答 q1，再把 q1+q2 一起提交）────────

{
  const h = makeHarness();
  const { admits, delivery } = makeDelivery();
  const requestId = h.request();

  const first = (await h.registry.respondAsk(requestId, [legacyAnswer(0, 'yes')])) as AnyRecord;
  check('A 第一批：只写下 q1', same(first.answered_questions, ['q1']), show(first));
  check('A 第一批：q2 仍在等', same(first.remaining_questions, ['q2']), show(first));
  const afterFirst = answersOf(h.record(requestId));
  check(
    'A 第一批：答案带上题号 q1（不许落成空题号）',
    afterFirst[0]?.question_id === 'q1',
    show(afterFirst),
  );

  // 现场里第二批就是这样：旧客户端把 q1 那一行又发了一遍，然后才是新答的 q2。
  const second = (await h.registry.respondAsk(requestId, [
    legacyAnswer(0, 'yes'),
    legacyAnswer(1, 'restart softly'),
  ])) as AnyRecord;

  const record = h.record(requestId);
  const answers = answersOf(record);
  check('A 第二批：累计答案恰好 2 条（无重复）', answers.length === 2, show(answers));
  check(
    'A 第二批：题号恰好 q1/q2（无空题号）',
    same(
      answers.map((item) => item.question_id),
      ['q1', 'q2'],
    ),
    show(answers.map((item) => item.question_id)),
  );
  check(
    'A 第二批：记录里没有缺题号的答案',
    answers.every((item) => typeof item.question_id === 'string' && item.question_id.length > 0),
    show(answers),
  );
  check(
    'A 第二批：同一条答案没有被记两次',
    answers.filter((item) => item.answer === 'yes').length === 1,
    show(answers),
  );
  check('A 第二批：整条请求收口', record?.status === 'answered', show(record?.status));
  check('B 第二批：q1 被认成重复并 skipped', same(second.skipped_questions, ['q1']), show(second));
  check('B 第二批：只写下了 q2', same(second.answered_questions, ['q2']), show(second));

  const batchAnswers = batchAnswersOf(h.deliveries[0]);
  check('B 第二批的 batch_answers 只有 1 条', batchAnswers.length === 1, show(batchAnswers));
  check(
    'B 第二批的 batch_answers 就是 q2',
    batchAnswers[0]?.question_id === 'q2',
    show(batchAnswers),
  );

  // D：投递正文（inbox 那条）不许把第一批的 q1 再列一遍。
  await delivery(h.deliveries[0] as never);
  const content = String(admits[0]?.content ?? '');
  check('D 投递一次', admits.length === 1, show(admits.length));
  check('D 正文是 ask 答复格式', content.startsWith('[ask answer'), content.slice(0, 40));
  check('D 正文含本批新增的 q2', content.includes('Restart'), content);
  check(
    'D 正文不重复列 q1（题面出现一次都没有）',
    content.split('Deploy').length - 1 === 0,
    content,
  );
  check(
    'D 正文不重复列 q1（答案正文只出现一次）',
    content.split('restart softly').length - 1 === 1,
    content,
  );
}

// ── C：连正文都没有的旧提交 ⇒ 按位置归一；再投一次 skipped ─────

{
  const h = makeHarness();
  const requestId = h.request();
  const first = (await h.registry.respondAsk(requestId, [{ answer: 'yes' }])) as AnyRecord;
  const afterFirst = answersOf(h.record(requestId));
  check('C 位置回退：第一条答案归一成 q1', afterFirst[0]?.question_id === 'q1', show(afterFirst));
  check('C 位置回退：只写 q1', same(first.answered_questions, ['q1']), show(first));

  const beforeText = show(h.record(requestId)?.answer);
  const again = (await h.registry.respondAsk(requestId, [{ answer: 'yes' }])) as AnyRecord;
  check('C 已答过 ⇒ duplicate（不抛冲突）', again.duplicate === true, show(again));
  check('C 已答过 ⇒ skipped 里点出 q1', same(again.skipped_questions, ['q1']), show(again));
  check('C 已答过 ⇒ 记录一字未改', show(h.record(requestId)?.answer) === beforeText);
  check('C 已答过 ⇒ 累计答案仍是 1 条', answersOf(h.record(requestId)).length === 1);
  check('C 已答过 ⇒ 不重复投递', h.deliveries.length === 0, show(h.deliveries.length));
}

// ── E：双击（同一批提交连发两次）─────────────────────────

{
  const h = makeHarness();
  const { admits, delivery } = makeDelivery();
  const requestId = h.request({ mode: 'async' });
  await h.registry.respondAsk(requestId, [legacyAnswer(0, 'yes')]);
  const beforeText = show(h.record(requestId)?.answer);
  const twice = (await h.registry.respondAsk(requestId, [legacyAnswer(0, 'yes')])) as AnyRecord;

  check('E 双击 ⇒ duplicate', twice.duplicate === true, show(twice));
  check('E 双击 ⇒ 记录一字未改', show(h.record(requestId)?.answer) === beforeText);
  check('E 双击 ⇒ 累计答案仍是 1 条', answersOf(h.record(requestId)).length === 1);
  check('E 双击 ⇒ 只投递过第一批那一次', h.deliveries.length === 1, show(h.deliveries.length));
  await delivery(h.deliveries[0] as never);
  check('E 双击 ⇒ inbox 只有一条', admits.length === 1, show(admits.length));
}

// ── F：客户端载荷（真的 ask-submit-plan）──────────────────

{
  clearAskAnsweredMarks();
  const questions = twoQuestions();
  const requestId = 'req-plan';
  const drafts = {
    [askDraftKey(requestId, 0)]: { selected: ['yes'], custom: '', include: true },
    [askDraftKey(requestId, 1)]: { selected: [], custom: '', include: true },
  };

  // 第一题已落定（服务端逐题进度），第二题还没答：载荷里只能有……什么都没有。
  const half = askPlanRows([{ requestId, questions, answeredQuestionIds: ['q1'] }], drafts);
  check('F 已落定的题不进载荷', same(askPendingAnswers(half), []), show(askPendingAnswers(half)));
  check('F 已落定的题不影响「都答了吗」判定（未答的 q2 还没答）', askRowsComplete(half) === false);
  check(
    'F 已落定的行在界面上有 settled 标记（不再是可改的行）',
    half[0]?.settled === true && half[1]?.settled === false,
    show(half.map((row) => row.settled)),
  );

  // 两题都没落定、都答了：载荷两条，每条都带 question_id（服务端才有去重的键）。
  const bothDrafts = {
    ...drafts,
    [askDraftKey(requestId, 1)]: { selected: [], custom: 'restart softly', include: true },
  };
  const full = askPlanRows([{ requestId, questions }], bothDrafts);
  const payload = askIncludedAnswers(full);
  check('F 两条载荷', payload.length === 2, show(payload));
  check(
    'F 每条答案都带 question_id',
    payload.every((item) => typeof item.question_id === 'string' && item.question_id.length > 0),
    show(payload),
  );
  check(
    'F 题号按位置 q1/q2',
    same(
      payload.map((item) => item.question_id),
      ['q1', 'q2'],
    ),
    show(payload.map((item) => item.question_id)),
  );

  // 一边已落定、一边刚答完：待批页只提交刚答完的那条。
  const mixed = askPlanRows([{ requestId, questions, answeredQuestionIds: ['q1'] }], bothDrafts);
  check(
    'F 混合态只提交真正新增的那条',
    same(
      askIncludedAnswers(mixed).map((item) => item.question_id),
      ['q2'],
    ),
    show(askIncludedAnswers(mixed)),
  );
  check('F 混合态可以提交（未落定的题都答了）', askRowsComplete(mixed) === true);

  // 结构化字段走同一条路：多选不许被压成字符串（单题卡 / 待批页 / Composer 共用）。
  const multi = buildAskAnswer(
    { header: 'Checks', question: 'Which checks?', options: ['lint', 'test'], multi_select: true },
    { selected: ['lint', 'test'], custom: '' },
    2,
  );
  check('F 多选选中项原样保留', same(multi.selected, ['lint', 'test']), show(multi));
  check('F 多选的题号按位置给 q3', multi.question_id === 'q3', show(multi));
}

// ── H：静态接线（改了逻辑没接上界面 = 白改）──────────────

{
  const { readFile } = await import('node:fs/promises');
  const source = async (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8');
  const musts: Array<{ path: string; needles: string[] }> = [
    {
      // 共用规划自己必须真的走「按题号取草稿 + 已答判定 + 带题号建答案」。
      path: 'apps/web/src/domains/pending/ask-submit-plan.ts',
      needles: [
        'askDraftOf(',
        'askQuestionSettled(',
        'buildAskAnswer(',
        'askAnsweredMarksOf(',
        'reconcileAskAnsweredMarks(',
      ],
    },
    {
      // 待批页：载荷只从共用规划来，已答的行不再能勾。
      path: 'apps/web/src/domains/pending/PendingClusterCard.tsx',
      needles: ['askPlanRows(', 'askIncludedAnswers(', 'settled={row.settled}'],
    },
    {
      // 单题卡 / Composer：同一个载荷出口，已答的题锁输入。
      path: 'apps/web/src/domains/chat/AskCard.tsx',
      needles: ['askPendingAnswers(rows)', 'askPlanRows([request], drafts)', 'settled'],
    },
    {
      // 提交入口：发出前先本地记「已答」，手快连点也无门。
      path: 'apps/web/src/domains/pending/usePendingBatch.ts',
      needles: ['markAskAnswered('],
    },
    {
      // Composer 单题卡：答案构造必须带题号（0.52 漂移的第一推动力就是这里漏了题号）。
      path: 'apps/web/src/domains/chat/PromptSlots.tsx',
      needles: ['buildAskAnswer(item, askDraftOf(', ', index)'],
    },
  ];
  for (const wiring of musts) {
    const text = await source(wiring.path);
    for (const needle of wiring.needles) {
      check('H 接线：' + wiring.path + ' 含 ' + needle, text.includes(needle));
    }
  }

  // 根因回归：不带题号的旧答案构造器不许复活（谁再拼一份 payload，漂移就回来了）。
  const askCard = await source('apps/web/src/domains/chat/AskCard.tsx');
  check(
    'H 接线：不带题号的旧构造器 buildAnswer 已不在 AskCard 里',
    !askCard.includes('export function buildAnswer('),
  );
  const promptSlots = await source('apps/web/src/domains/chat/PromptSlots.tsx');
  check('H 接线：PromptSlots 不再调用旧构造器 buildAnswer', !promptSlots.includes('buildAnswer('));
}

// ── I：用户手快连点提交（UI 层不可再提交 + 服务端仍然幂等）────

{
  clearAskAnsweredMarks();
  const questions = twoQuestions();
  const requestId = 'req-click';
  const drafts = {
    [askDraftKey(requestId, 0)]: { selected: ['yes'], custom: '', include: true },
    [askDraftKey(requestId, 1)]: { selected: [], custom: 'restart softly', include: true },
  };

  const before = askPlanRows([{ requestId, questions }], drafts);
  check(
    'I 首次可提交两条',
    askIncludedAnswers(before).length === 2,
    show(askIncludedAnswers(before)),
  );

  // 第一下点击：本地立刻记「这几题已答」（服务端逐题进度要等一次 hydrate 才回来）。
  markAskAnswered(requestId, ['q1', 'q2']);
  const after = askPlanRows([{ requestId, questions }], drafts);
  check(
    'I 提交后这几行原地变成已答',
    after.every((row) => row.settled),
    show(after.map((row) => row.settled)),
  );
  check('I 第二次不可提交：待批页载荷为空', same(askIncludedAnswers(after), []));
  check('I 第二次不可提交：单题卡载荷为空', same(askPendingAnswers(after), []));
  check('I 没有还开着的行（卡片判定为收口）', askOpenRows(after).length === 0);

  // 自愈：提交失败（服务端进度永远不覆盖）时标记会自己过期，不会把题永久锁死。
  clearAskAnsweredMarks();
  markAskAnswered(requestId, ['q1'], 5);
  await new Promise((resolve) => setTimeout(resolve, 25));
  check('I 标记过期后这道题重新可答（失败自愈）', askAnsweredMarksOf(requestId).length === 0);

  // 服务端最后一道闸：同一批真的发两次也只当 skipped，答案条数不变、不出空题号。
  const h = makeHarness();
  const serverRequestId = h.request();
  await h.registry.respondAsk(serverRequestId, [legacyAnswer(0, 'yes')]);
  const twice = (await h.registry.respondAsk(serverRequestId, [
    legacyAnswer(0, 'yes'),
  ])) as AnyRecord;
  const finalAnswers = answersOf(h.record(serverRequestId));
  check('I 服务端：连提两次后答案仍恰好 1 条', finalAnswers.length === 1, show(finalAnswers));
  check('I 服务端：第二次 duplicate', twice.duplicate === true, show(twice));
  check('I 服务端：没有写出空题号的脏答案', finalAnswers[0]?.question_id === 'q1', show(finalAnswers));
}

// ── G：没有可枚举的题 ⇒ 旧语义（回归保护）────────────────

{
  const h = makeHarness();
  const requestId = h.request({ questions: { note: 'free form' } });
  const result = (await h.registry.respondAsk(requestId, [
    { header: 'Deploy', question: 'Deploy now?', answer: 'yes' },
  ])) as AnyRecord;
  const record = h.record(requestId);
  check('G 无题可枚举 ⇒ 整条收口', record?.status === 'answered', show(record?.status));
  check('G 无题可枚举 ⇒ 本批答案原样算数', answersOf(record).length === 1, show(answersOf(record)));
  check('G 无题可枚举 ⇒ final = true', result.final === true, show(result));
}

// ── 汇总 ────────────────────────────────────────────────

if (failures.length > 0) {
  const total = String(passed + failures.length);
  console.error('check-ask-dedupe: ' + String(failures.length) + ' 项 FAIL（共 ' + total + ' 项）');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log(
  'check-ask-dedupe: OK（' +
    String(passed) +
    ' 项：归一 / 之后去重 / 位置回退 / 投递不重复 / 双击幂等 / 连点不可提交 / 载荷 / 旧语义）',
);
