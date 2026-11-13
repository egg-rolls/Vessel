/**
 * 「每问独立 + 可分批提交」的窄属性测试（ask-batch）。
 *
 * 形态沿用 `src/inbox-direct.test.ts`（仓库没有 test gate；这类窄属性测试是被允许的
 * 例外，直接跑 `bun run src/ask-batch.test.ts`，判定看输出文本 `OK ... passed N / N`
 * —— 本机 bun 是 Windows 版，退出码不可信）。
 *
 * **为什么 mock `@vessel-agent/core`**：本 worktree 没有 node_modules、也不允许
 * `bun install`，而 `packages/serve` / `packages/agent` 都按 bare specifier 引 core。
 * 这里只替掉 core 在**运行时**真正被取用的那几个出口；被测的是**真实的**
 * `createInteractionsRegistry` / `InteractionsStore` / `createAskAnswerDelivery` /
 * `createAskUserTool`。
 *
 * 断言的是这一单的六类行为（不是实现细节）：
 * 1. 3 题答 2 ⇒ 只 settle 那 2 条，第 3 条仍 `pending`（核心 bug：未答的题被提交带走）；
 * 2. 一次提交 = **一条**投递，且正文只含本批答案（`origin: 'ask_answer'`，来源 `ask`）；
 * 3. 第二批（第 3 题）⇒ 再来一条投递，这条请求随即收口；
 * 4. 同一题重复提交 ⇒ `duplicate` + `skipped_questions`，不落盘、不重投；
 * 5. `selected: string[]` 多选往返正确，且**旧的纯字符串答案仍可读**；
 * 6. 首批答案到达即返回（工具不阻塞等全部）。
 */

import { mock } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

/** 结构快照，失败时能看懂差在哪。 */
function show(value: unknown): string {
  return JSON.stringify(value);
}

function same(actual: unknown, expected: unknown): boolean {
  return show(actual) === show(expected);
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * core / config 的运行时替身。
 *
 * 清单 = `packages/serve` + `packages/agent` + `src/ask-*` 这条 import 链上**运行时**取用
 * 的全部出口（`import type` 的不算，编译后被抹掉）：少一个会在 import 期就报「缺命名
 * 导出」，多一个没有意义。被测的是真实的注册表 / 存储 / 投放 / 工具，这些替身只提供
 * 「存在且不炸」的语义。
 */
const atomicWriteStub = async (path: string, data: string) => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, 'utf8');
};

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

/** `@vessel-agent/config` 同理（serve 装配在 import 期取用这四个）。 */
mock.module('@vessel-agent/config', () => ({
  redactConfig: (config: unknown) => config,
  redactSourcePaths: (config: unknown) => config,
  DEFAULT_PLUGIN_HTTP_LIMITS: { body_bytes: 0, timeout_ms: 0 },
  DEFAULT_LEASE_OPTIONS: {},
}));

const { createInteractionsRegistry } = await import('../packages/serve/src/interactions-registry');
const { InteractionsStore } = await import('../packages/serve/src/interactions-store');
const { createAskAnswerDelivery } = await import('../src/ask-answer-delivery');
const { formatAnswersForModel } = await import('../src/ask-channel');
const { createAskUserTool } = await import('../packages/tui/src/renderer/ask-user');

type AnyRecord = Record<string, unknown>;

/** 内存事件流：`publish` **同步**扇出给订阅者 —— 这就是 gateway 的「流上回声」。 */
function memoryStream() {
  const listeners = new Set<(event: AnyRecord) => void>();
  const published: AnyRecord[] = [];
  const stream = {
    published,
    subscribe(handler: (event: AnyRecord) => void) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    publish(event: AnyRecord) {
      published.push(event);
      for (const handler of [...listeners]) handler(event);
    },
    clear() {},
    getHistory() {
      return published;
    },
    /** 只实现工具真正需要的那条语义：匹配即 resolve 一次。 */
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

/** 三题：q1 单选、q2 开放题、q3 多选。 */
function threeQuestions() {
  return [
    { id: 'q1', header: 'Deploy', question: 'Deploy now?', options: ['yes', 'no'] },
    { id: 'q2', header: 'Branch', question: 'Which branch should I use?' },
    {
      id: 'q3',
      header: 'Checks',
      question: 'Which checks should run?',
      options: ['lint', 'test', 'build'],
      multi_select: true,
    },
  ];
}

function answerFor(questionId: string, text: string, extra?: AnyRecord): AnyRecord {
  const question = threeQuestions().find((item) => item.id === questionId);
  return {
    question_id: questionId,
    header: question?.header ?? questionId,
    question: question?.question ?? questionId,
    answer: text,
    ...extra,
  };
}

interface Harness {
  stream: FakeStream;
  registry: ReturnType<typeof createInteractionsRegistry>;
  /** 每次「该投递给成员」的通知（= 一条 inbox 消息的载荷）。 */
  deliveries: AnyRecord[];
  request: (options?: { requestId?: string; mode?: 'sync' | 'async' }) => string;
  record: (requestId: string) => AnyRecord | undefined;
}

function makeHarness(options: { dir?: string } = {}): Harness {
  const stream = memoryStream();
  const deliveries: AnyRecord[] = [];
  const registry = createInteractionsRegistry({
    eventsFor: () => stream as never,
    singleTenantId: 't1',
    ...(options.dir !== undefined ? { interactionsDir: options.dir } : {}),
    onAsyncAskAnswered: (record) => {
      deliveries.push(record as unknown as AnyRecord);
    },
  });
  // gateway 的原始订阅者：流上的一切都回到注册表（应答走「回声」那条路）。
  stream.subscribe((event) => registry.handleEvent(event as never));

  const request = (opts?: { requestId?: string; mode?: 'sync' | 'async' }) => {
    const requestId = opts?.requestId ?? 'req-1';
    stream.publish({
      type: 'ask.user.requested',
      run_id: 'run-1',
      ts: 1000,
      data: {
        requestId,
        questions: threeQuestions(),
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

/**
 * 投放实现 + 一个假的 `AgentService.admit`：断言「投了几次、每次正文是什么」。
 *
 * `admit` 的返回体投放层不看，所以只要不抛。
 */
function makeDelivery() {
  const admits: AnyRecord[] = [];
  const service = {
    async admit(input: AnyRecord) {
      admits.push(input);
      return { result: { run_id: 'run-2' }, message: {} };
    },
  };
  const delivery = createAskAnswerDelivery(service as never);
  return { admits, delivery };
}

// ── ① 3 题答 2：只 settle 那 2 条 ──────────────────────

{
  const h = makeHarness();
  const requestId = h.request();
  const result = (await h.registry.respondAsk(requestId, [
    answerFor('q1', 'yes'),
    answerFor('q3', 'lint, test', { selected: ['lint', 'test'] }),
  ])) as AnyRecord;

  const record = h.record(requestId);
  check('① 本批写入 q1/q3', same(result.answered_questions, ['q1', 'q3']), show(result));
  check('① 第 2 题仍在等（remaining）', same(result.remaining_questions, ['q2']), show(result));
  check('① final = false', result.final === false, show(result.final));
  check(
    '① 记录仍 pending（未答的题没被带走）',
    record?.status === 'pending',
    show(record?.status),
  );
  check(
    '① 记录只记已答的两题',
    same(record?.answered_questions, ['q1', 'q3']),
    show(record?.answered_questions),
  );
  const answers = ((record?.answer ?? {}) as AnyRecord).answers as AnyRecord[];
  check('① 累计答案是 2 条（不含未答的 q2）', answers.length === 2, show(answers));
  check(
    '① 答案是按题序 q1/q3 落的',
    same(
      answers.map((item) => item.question_id),
      ['q1', 'q3'],
    ),
    show(answers.map((item) => item.question_id)),
  );
  check(
    '① 同步 ask 的首批不投递（工具当场取走）',
    h.deliveries.length === 0,
    show(h.deliveries.length),
  );
}

// ── ② 一次提交 = 一条 inbox 消息，正文只含本批答案 ──────

{
  const h = makeHarness();
  const { admits, delivery } = makeDelivery();
  const requestId = h.request({ mode: 'async' });
  await h.registry.respondAsk(requestId, [
    answerFor('q1', 'yes'),
    answerFor('q3', 'lint, test', { selected: ['lint', 'test'] }),
  ]);

  check('② async 首批：一次提交只通知一次投递', h.deliveries.length === 1, show(h.deliveries.length));
  const batch = h.deliveries[0] ?? {};
  const batchAnswers = ((batch.answer ?? {}) as AnyRecord).batch_answers as AnyRecord[];
  check('② 投递载荷只带本批 2 条', batchAnswers?.length === 2, show(batchAnswers?.length));
  check(
    '② 投递载荷是 q1/q3',
    same(
      batchAnswers?.map((item) => item.question_id),
      ['q1', 'q3'],
    ),
    show(batchAnswers?.map((item) => item.question_id)),
  );
  check(
    '② 请求仍 pending（第 2 题还没答）',
    h.record(requestId)?.status === 'pending',
    show(h.record(requestId)?.status),
  );

  // 真的走一遍投放实现：一条消息、一个 admit。
  const delivered = await delivery(batch as never);
  check('② 投放成功', delivered === true);
  check('② 一次提交 = 一次 admit（= 一条 inbox 消息）', admits.length === 1, show(admits.length));
  const admit = admits[0] ?? {};
  check('② 投递来源是 ask_answer', admit.origin === 'ask_answer', show(admit.origin));
  const content = String(admit.content ?? '');
  check('② 正文是 ask 答复格式', content.startsWith('[ask answer '), content.slice(0, 40));
  check('② 正文含本批两题', content.includes('Deploy') && content.includes('Checks'), content);
  check('② 正文不含未答的第 2 题', !content.includes('Which branch'), content);
  check('② 正文里第 3 题编成 3（按题号，不按行序）', content.includes('3. Checks'), content);
}

// ── ③ 第二批：再来一条，随即收口 ──────────────────────

{
  const h = makeHarness();
  const { admits, delivery } = makeDelivery();
  const requestId = h.request({ mode: 'async' });
  await h.registry.respondAsk(requestId, [answerFor('q1', 'yes'), answerFor('q3', 'lint')]);
  await h.registry.respondAsk(requestId, [answerFor('q2', 'main')]);

  check('③ 两批各通知一次投放', h.deliveries.length === 2, show(h.deliveries.length));
  const second = h.deliveries[1] ?? {};
  const secondAnswers = ((second.answer ?? {}) as AnyRecord).batch_answers as AnyRecord[];
  check('③ 第二批载荷只有第 2 题', secondAnswers?.length === 1, show(secondAnswers?.length));
  check(
    '③ 第二批载荷就是 q2',
    secondAnswers?.[0]?.question_id === 'q2',
    show(secondAnswers?.[0]),
  );
  const record = h.record(requestId);
  check('③ 全部答完 ⇒ answered', record?.status === 'answered', show(record?.status));
  const all = ((record?.answer ?? {}) as AnyRecord).answers as AnyRecord[];
  check(
    '③ 累计答案 3 条（按题序）',
    same(
      all.map((item) => item.question_id),
      ['q1', 'q2', 'q3'],
    ),
    show(all.map((item) => item.question_id)),
  );

  // 两批投出去是两条消息，第二条只含第 2 题。
  await delivery(h.deliveries[0] as never);
  await delivery(h.deliveries[1] as never);
  check('③ 两批 = 两条消息', admits.length === 2, show(admits.length));
  check(
    '③ 第二条只含第 2 题',
    String(admits[1]?.content ?? '').includes('Which branch'),
    String(admits[1]?.content ?? ''),
  );
  check(
    '③ 第二条不重复第一批',
    !String(admits[1]?.content ?? '').includes('Deploy'),
    String(admits[1]?.content ?? ''),
  );
}

// ── ④ 同一题重复提交 ⇒ skipped，不落盘、不重投 ──────────

{
  const h = makeHarness();
  const requestId = h.request({ mode: 'async' });
  await h.registry.respondAsk(requestId, [answerFor('q1', 'yes')]);
  const before = show(h.record(requestId)?.answer);

  const again = (await h.registry.respondAsk(requestId, [answerFor('q1', 'yes')])) as AnyRecord;
  check('④ 重复提交 ⇒ duplicate', again.duplicate === true, show(again));
  check('④ 明确说跳过了哪一题', same(again.skipped_questions, ['q1']), show(again));
  check('④ 本批没有写入任何题', same(again.answered_questions, []), show(again.answered_questions));
  check('④ 记录一字未改', show(h.record(requestId)?.answer) === before);
  check('④ 没有多发一次投放', h.deliveries.length === 1, show(h.deliveries.length));

  // 收口之后再交同一题：仍是 duplicate（不抛 conflict，旧客户端的重放不变差）。
  await h.registry.respondAsk(requestId, [answerFor('q2', 'main'), answerFor('q3', 'lint')]);
  const afterAnswered = (await h.registry.respondAsk(requestId, [
    answerFor('q1', 'yes'),
  ])) as AnyRecord;
  check('④ 收口后的重复提交也是 duplicate', afterAnswered.duplicate === true, show(afterAnswered));
  check('④ 收口后 final = true', afterAnswered.final === true, show(afterAnswered.final));
}

// ── ⑤ 拒答（answers: []）：整条收口，但不清空已答的题 ─────

{
  const h = makeHarness();
  const { admits, delivery } = makeDelivery();
  const requestId = h.request({ mode: 'async' });
  await h.registry.respondAsk(requestId, [answerFor('q1', 'yes')]);
  const declined = (await h.registry.respondAsk(requestId, [])) as AnyRecord;

  check('⑤ 拒答 ⇒ final = true', declined.final === true, show(declined));
  check('⑤ 拒答 ⇒ 没有剩余题', same(declined.remaining_questions, []), show(declined));
  const record = h.record(requestId);
  check('⑤ 拒答 ⇒ 整条 answered', record?.status === 'answered', show(record?.status));
  check(
    '⑤ 拒答不抹掉先前答过的题',
    (((record?.answer ?? {}) as AnyRecord).answers as AnyRecord[]).length === 1,
    show((record?.answer ?? {}) as AnyRecord),
  );
  await delivery(h.deliveries[1] as never);
  check(
    '⑤ 拒答那一批的正文仍是「人类拒绝」',
    String(admits[0]?.content ?? '').includes('declined'),
    String(admits[0]?.content ?? ''),
  );
}

// ── ⑥ selected: string[] 往返 + 旧字符串答案可读 ────────
{
  const h = makeHarness();
  const requestId = h.request();
  await h.registry.respondAsk(requestId, [
    answerFor('q1', 'yes'),
    answerFor('q2', 'main'),
    answerFor('q3', 'lint, test', { selected: ['lint', 'test'] }),
  ]);
  const record = h.record(requestId);
  const answers = ((record?.answer ?? {}) as AnyRecord).answers as AnyRecord[];
  const multi = answers.find((item) => item.question_id === 'q3');
  check('⑤ 多选的结构化选中项原样往返', same(multi?.selected, ['lint', 'test']), show(multi));
  check('⑤ 给模型读的 answer 字符串仍在', multi?.answer === 'lint, test', show(multi?.answer));

  const text = formatAnswersForModel(answers);
  check('⑤ 模型文本按题号编行', text.includes('3. Checks') && text.includes('1. Deploy'), text);
  check('⑤ 模型文本带得多选内容', text.includes('lint, test'), text);

  // 旧记录：只有 header/question/answer（没有 question_id、没有 selected）。
  const legacy = formatAnswersForModel([
    { header: 'Deploy', question: 'Deploy now?', answer: 'yes' },
    { header: 'Branch', question: 'Which branch?', answer: 'main' },
  ]);
  const legacyExpected = [
    'Answers from the human to your pending ask request:',
    '1. Deploy（Deploy now?）: yes',
    '2. Branch（Which branch?）: main',
  ].join('\n');
  check('⑤ 旧字符串答案的模型文本一字不变', legacy === legacyExpected, legacy);

  // 旧客户端（答案里没有题 id）也能按题序挂到题上，未答的题不被带走。
  const legacyHarness = makeHarness();
  const legacyId = legacyHarness.request();
  await legacyHarness.registry.respondAsk(legacyId, [
    { header: 'Deploy', question: 'Deploy now?', answer: 'yes' },
    { header: 'Branch', question: 'Which branch should I use?', answer: 'main' },
  ]);
  const legacyRecord = legacyHarness.record(legacyId);
  check(
    '⑤ 旧形状答案按题序挂到 q1/q2',
    same(legacyRecord?.answered_questions, ['q1', 'q2']),
    show(legacyRecord?.answered_questions),
  );
  check('⑤ 仍未答 q3 ⇒ 仍 pending', legacyRecord?.status === 'pending', show(legacyRecord?.status));
}

// ── ⑦ 首批即返回（工具不阻塞等全部） ────────────────────

{
  const stream = memoryStream();
  const tool = createAskUserTool();
  const pending = tool.handler(
    { questions: threeQuestions() },
    { events: stream, run_id: 'run-1', session_id: 'session-1' } as never,
  ) as Promise<string>;

  // 让 handler 先把请求事件发出去，再模拟「人只答了 3 题里的 2 题」。
  await new Promise((resolve) => setTimeout(resolve, 0));
  const requested = stream.published.find((event) => event.type === 'ask.user.requested');
  const askedData = (requested?.data ?? {}) as AnyRecord;
  const requestId = String(askedData.requestId ?? '');
  check(
    '⑥ 请求事件里的题目带题 id',
    show(askedData.questions).includes('"q3"'),
    show(askedData.questions),
  );

  stream.publish({
    type: 'ask.user.answered',
    run_id: 'run-1',
    ts: 1100,
    data: {
      requestId,
      answers: [answerFor('q1', 'yes'), answerFor('q3', 'lint')],
      final: false,
      remaining: ['q2'],
    },
  });
  // 工具必须**现在**就返回：不再等第 3 题。
  const text = await Promise.race([
    pending,
    new Promise<string>((resolve) => setTimeout(() => resolve('<仍阻塞>'), 50)),
  ]);
  check('⑥ 首批答案一到就返回', text !== '<仍阻塞>', text);
  check('⑥ 返回正文含两题答案', text.includes('Deploy') && text.includes('Checks'), text);
  check('⑥ 明确说出还剩几题未答', text.includes('1 of 3 questions still unanswered'), text);
  check('⑥ 未答的题点名为 q2', text.includes('q2'), text);
}

// ── 来源：inbox 条目的 source 写成 ask（跨包写入点，按源码断言） ──

{
  // 这条落在 `packages/agent/src/service.ts` 的 `trackInbox` 里（写 inbox 的唯一入口）。
  // 本 worktree 装不了 `packages/agent` 的依赖链，所以按仓库既有做法用源码断言钉住
  // 「ask 答复的条目来源不是 human」这条不变量（同 `src/ask-attribution.test.ts`）。
  const source = await readFile('packages/agent/src/service.ts', 'utf8');
  const inboxSource = /const ASK_ANSWER_INBOX_SOURCE = 'ask'/.test(source);
  const byOrigin = /origin === 'ask_answer' \? ASK_ANSWER_INBOX_SOURCE : message\.from/.test(
    source,
  );
  const wired = (source.match(/source: inboxSourceOf\(message\)/g) ?? []).length >= 2;
  check(
    '来源：inbox 条目对 ask 答复写 ask（不是 human）',
    inboxSource && byOrigin && wired,
    `${String(inboxSource)} / ${String(byOrigin)} / ${String(wired)}`,
  );
}

// ── ⑦ 持久化：分批进度跨重启仍可读 ────────────────────

{
  const dir = await mkdtemp(join(tmpdir(), 'vessel-ask-batch-'));
  try {
    const h = makeHarness({ dir });
    const requestId = h.request();
    await h.registry.respondAsk(requestId, [answerFor('q1', 'yes')]);
    // 落盘是 fire-and-forget 写链：等它跑完再读。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const loaded = new InteractionsStore(dir)
      .loadAllSync()
      .find((item) => item.requestId === requestId);
    check(
      '⑦ 落盘的记录带逐题进度',
      same(loaded?.answered_questions, ['q1']),
      show(loaded?.answered_questions),
    );
    check('⑦ 落盘的记录仍是 pending', loaded?.status === 'pending', show(loaded?.status));
    check(
      '⑦ 落盘的本批答案仍可读',
      ((loaded?.answer?.batch_answers ?? []) as AnyRecord[]).length === 1,
    );
    const reloaded = createInteractionsRegistry({
      eventsFor: () => memoryStream() as never,
      singleTenantId: 't1',
      interactionsDir: dir,
    });
    check(
      '⑦ 部分已答的 ask 重启后仍 pending（不被孤儿化）',
      reloaded.interactionRecords.get(requestId)?.status === 'pending',
      show(reloaded.interactionRecords.get(requestId)?.status),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 真实投放：inbox 里就是**一条**来源是 ask 的消息 ────────

{
  // 这一段跑真实的 `AgentService`：答案最终落在成员 inbox 的哪一格、来源写成什么、
  // 一条提交是不是只有一条 —— 这三件事只有真跑一遍才作数（前面的用例只断言到投放
  // 实现的门口）。调度器是替身：消息留在队里不执行，正好用来读「还没被消费的形状」。
  const { createAgentService } = await import('../packages/agent/src/service');
  const dataDir = await mkdtemp(join(tmpdir(), 'vessel-ask-batch-inbox-'));
  try {
    let idSeq = 0;
    const queued: AnyRecord[] = [];
    const scheduler = {
      async submit(task: AnyRecord) {
        queued.push(task);
        return {
          id: task.runId as string,
          status: () => 'queued',
          onEvent: () => () => {},
          cancel: () => true,
          wait: async () => ({ status: 'queued' }),
        };
      },
      cancel: () => true,
      stats: () => ({ queued: queued.length, running: 0, completed: 0, failed: 0, cancelled: 0 }),
      async close() {},
    };
    const runtime = {
      async spawn() {},
      async runTurn() {
        return { content: '', outcome: 'completed' };
      },
      cancel() {},
      async dispose() {},
    };
    const ok = { ok: true };
    const service = createAgentService({
      tenantId: 't1',
      dataDir,
      runtime: runtime as never,
      scheduler: scheduler as never,
      budget: {
        checkDelivery: () => ok,
        canStartTurn: () => ok,
        noteTurnStarted: () => {},
        noteTurnFinished: () => {},
        status: () => [],
        override: () => ({ ok: false, reason: 'unsupported' }),
        release: () => [],
        flush: async () => {},
      } as never,
      now: () => 1000,
      newId: () => `id-${String(++idSeq)}`,
      logger: quietLogger as never,
    });
    const member = await service.create({ name: 'worker', kind: 'contractor', owner: 'human' });

    // 一条 async ask（答案走 inbox 投放，不起在等的工具）。
    const h = makeHarness();
    const requestId = h.request({ mode: 'async' });
    await h.registry.respondAsk(requestId, [answerFor('q1', 'yes'), answerFor('q3', 'lint')]);
    // 记录得带上 agent_id 才能投给成员：上面的请求事件里写的是 member-1，换成真成员。
    const record = {
      ...(h.deliveries[0] ?? {}),
      agent_id: member.id,
      session_id: member.session_id,
    };
    const delivery = createAskAnswerDelivery(service);
    const delivered = await delivery(record as never);
    check('⑦ 投放成功', delivered === true, String(delivered));

    const inbox = service.inboxSnapshot(member.id);
    check('⑦ inbox 里只有一条', inbox.entries.length === 1, show(inbox.entries.length));
    const entry = inbox.entries[0] ?? {};
    check('⑦ 条目来源是 ask（不是 human）', entry.from === 'ask', show(entry.from));
    const text = await service.inboxSnapshot(member.id, { messageIds: [entry.message_id] });
    const body = String(text.entries[0]?.text ?? '');
    check('⑦ 正文是 ask 答复卡格式', body.startsWith('[ask answer '), body.slice(0, 60));
    check('⑦ 正文含两题（不多不少）', body.includes('Deploy') && body.includes('Checks'), body);
    check('⑦ 一条提交只起一次 run', queued.length === 1, show(queued.length));
    // 真实形状打一行出来（验收要「贴一条真实内容」，别让人再去翻代码猜）。
    console.log(`-- inbox 条目来源 ${entry.from}，正文：\n${body}`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`FAILED ${failures.length} / ${passed + failures.length}`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`OK ask-batch passed ${passed} / ${passed}`);
