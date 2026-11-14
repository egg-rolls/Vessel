/**
 * 「部分已答 ⇒ 仍是 pending」的**跨 mode** 状态机测试（0.52 ask-batch-fix）。
 *
 * 为什么单独一份（而不是塞进 `src/ask-batch.test.ts`）：那一份按「一批答案」的角度测
 * 分批提交的 UI 契约，这一份只钉一条不变量 —— **`status` 是整条请求的收口标志，不是
 * 「这一批送到没送到」的日志**。两者用同一套状态机判据（`planAskAnswers` 的
 * `remaining.length === 0`），`sync` 与 `async` 的差别只在「这一批要不要通知投放」和
 * 「工具等不等」，不应该是状态机分叉。
 *
 * 触发这份测试的事故：线上一条 sync 2 题的请求只答了 q1，落盘却是
 * `status: 'answered'` + 只有 1 条答案，于是待批页按 `status: 'pending'` 筛不到它 ——
 * 用户看到「剩下那题直接消失了」。那次事故的写入方是**分批语义合入之前的代码**
 * （那份 `settleAnswer` 对任何一批答案都无条件 `status: 'answered'`，且不写
 * `answered_questions` / `batch_answers`），不是这里的 sync 分支；所以这份测试的
 * 职责是**把语义钉死**：无论哪一支、哪一批，未答的题留在 `pending`。
 *
 * 形态沿用 `src/ask-batch.test.ts`（仓库没有 test gate；这类窄属性测试是被允许的例外，
 * 直接跑 `bun run src/ask-batch-sync.test.ts`，判定看输出文本 `OK ... passed N / N`
 * —— 本机 bun 是 Windows 版，退出码不可信）。
 *
 * **为什么 mock `@vessel-agent/core`**：本 worktree 没有 node_modules、也不允许
 * `bun install`，而 `packages/serve` 按 bare specifier 引 core。这里只替掉 core / config
 * 在**运行时**真正被取用的出口；被测的是**真实的** `createInteractionsRegistry` /
 * `InteractionsStore` / `createAskAnswerDelivery`。
 *
 * 断言的是五类行为（不是实现细节）：
 * 1. sync 2 题只答 q1 ⇒ 记录 `pending` + `answered_questions: ['q1']`，剩余含 q2；
 * 2. 再答 q2 ⇒ `answered`，累计答案按**题序** q1/q2；
 * 3. async 同构：同样「部分已答 ⇒ pending」，只有通知次数不同（每批都通知）；
 * 4. 已答过的题重复提交 ⇒ `duplicate` + `skipped_questions`，记录一字未改、不重投；
 * 5. 投递观测点（`onAsyncAskAnswered`）上的次数：sync 第一批 0 次、第二批 1 次，
 *    async 每批 1 次；外加「旧脏记录读侧容忍」的一组断言。
 */

import { mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AskRespondResult,
  InteractionsRegistry,
} from '../packages/serve/src/interactions-registry';
import type { StoredInteraction } from '../packages/serve/src/interactions-store';

type AnyRecord = Record<string, unknown>;

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
 * core / config 的运行时替身。清单 = 这条 import 链上**运行时**取用的出口
 * （`import type` 的不算，编译后被抹掉）：少一个会在 import 期报「缺命名导出」。
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
  // 0.53 U1（ADR-104）：会话投射声明的出口（agent 服务 + sessions.get/create 用）。
  PROJECTION_MODE_STRICTNESS: {
    passthrough: 0,
    placeholder: 1,
    archive_notice: 1,
    externalize: Number.POSITIVE_INFINITY,
  },
  declareProjection: (input: { mode?: string; source?: string } = {}) => ({
    mode: input.mode ?? 'placeholder',
    declaration_id: '01MOCKDECLARATION0000000000',
    source: input.source ?? 'session_created',
    policy: 'core.context_projection',
    policy_version: 1,
    params: { keepRecentTokenRatio: 0.05, keepRecentMax: 10, volumeRatio: 0.2 },
    excluded_tools: [],
    declared_at: 0,
  }),
  armProjectionDeclaration: (_sessionId: string, declaration: unknown) => declaration,
  assertProjectionModeAllowedForChild: () => {},
  knownProjectionMode: () => undefined,
  forgetProjectionDeclaration: () => {},
  resolveProjection: () => ({
    mode: 'placeholder',
    source: 'legacy',
    declaration: null,
    error: null,
    audit: null,
    locked: true,
  }),
  resolveProjectionMode: (value: unknown) => value as string,
  ProjectionPolicyError: class extends Error {},
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
const { InteractionsStore } = await import('../packages/serve/src/interactions-store');
const { createAskAnswerDelivery } = await import('../src/ask-answer-delivery');

/** 内存事件流：`publish` **同步**扇出 —— 这就是 gateway 的「流上回声」。 */
function memoryStream() {
  const listeners = new Set<(event: AnyRecord) => void>();
  const stream = {
    subscribe(handler: (event: AnyRecord) => void) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    publish(event: AnyRecord) {
      for (const handler of [...listeners]) handler(event);
    },
    clear() {},
    getHistory() {
      return [] as AnyRecord[];
    },
  };
  return stream;
}

type FakeStream = ReturnType<typeof memoryStream>;

/**
 * 事故里的**真实题形**：`input` 里的题没有 `id` 键，题号只能是位置推出来的
 * `q1` / `q2`（`questionIdOfIndex`）。用带 `id` 的题测不到这条路径。
 */
function twoQuestions(): AnyRecord[] {
  return [
    {
      header: '同步演示',
      question: '这是 sync 提问：我在这一轮里等。选一个数字？',
      options: ['1', '2', '3'],
      multi_select: false,
    },
    {
      header: '分批演示',
      question: '这道题先别答 —— 我只提交上面那道，看它会不会还挂着等？',
      options: ['会', '不会'],
      multi_select: false,
    },
  ];
}

/** 待批页的答案形状（`buildAskAnswer`）：题 id + 原题 + 渲染文本 + 多选结构。 */
function answerFor(index: 0 | 1, text: string, selected?: string[]): AnyRecord {
  const question = twoQuestions()[index] ?? {};
  return {
    question_id: `q${index + 1}`,
    header: question.header,
    question: question.question,
    answer: text,
    ...(selected !== undefined ? { selected } : {}),
  };
}

interface Harness {
  stream: FakeStream;
  registry: InteractionsRegistry;
  /** 投递观测点：注册表唯一的那次「该投给成员」的通知。 */
  deliveries: StoredInteraction[];
  request: (options?: { requestId?: string; mode?: 'sync' | 'async' }) => string;
  record: (requestId: string) => StoredInteraction | undefined;
}

function makeHarness(options: { dir?: string } = {}): Harness {
  const stream = memoryStream();
  const deliveries: StoredInteraction[] = [];
  const registry = createInteractionsRegistry({
    eventsFor: () => stream as never,
    singleTenantId: 't1',
    ...(options.dir !== undefined ? { interactionsDir: options.dir } : {}),
    onAsyncAskAnswered: (record) => {
      deliveries.push(record);
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
        questions: twoQuestions(),
        session_id: 'session-1',
        agent_id: 'member-1',
        team_id: 'team-1',
        // 缺省不写该键 = sync（与真实事件逐字节同形）。
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
    record: (requestId: string) => registry.interactionRecords.get(requestId),
  };
}

/** 一次提交写进去的题号（记录侧，按题序）。 */
function answeredIdsOf(record: StoredInteraction | undefined): string[] | undefined {
  const answers = record?.answer?.answers;
  if (!Array.isArray(answers)) return undefined;
  return answers.map((item) => String((item as AnyRecord).question_id));
}

/** 落盘是 fire-and-forget 写链：给它几个 tick 再读文件。 */
async function settlePersistence(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ── ① sync 2 题只答 q1：记录仍 pending，未答的题不被带走 ──────────

const syncHarness = makeHarness();
const syncId = syncHarness.request();
const syncFirst = await syncHarness.registry.respondAsk(syncId, [answerFor(0, '3', ['3'])]);

check('① sync 第一批：本批写入 q1', same(syncFirst.answered_questions, ['q1']), show(syncFirst));
check(
  '① sync 第一批：剩余只有 q2（另一题还在等人）',
  same(syncFirst.remaining_questions, ['q2']),
  show(syncFirst),
);
check('① sync 第一批：final = false', syncFirst.final === false, show(syncFirst.final));
{
  const record = syncHarness.record(syncId);
  check(
    '① sync 第一批：记录 status 仍是 pending（不是 answered）',
    record?.status === 'pending',
    show(record?.status),
  );
  check(
    '① sync 第一批：记录带 answered_questions = [q1]',
    same(record?.answered_questions, ['q1']),
    show(record?.answered_questions),
  );
  check(
    '① sync 第一批：累计答案只有 q1（未答的 q2 没有凭空多一条）',
    same(answeredIdsOf(record), ['q1']),
    show(answeredIdsOf(record)),
  );
  check(
    '① sync 第一批：本批增量只含 q1（第二批不会重发第一批）',
    same(
      (record?.answer?.batch_answers ?? []).map((item) => String((item as AnyRecord).question_id)),
      ['q1'],
    ),
    show(record?.answer?.batch_answers),
  );
}
check(
  '① sync 第一批不投递（还在等的 ask 工具当场取走这一批）',
  syncHarness.deliveries.length === 0,
  show(syncHarness.deliveries.length),
);

// ── ② 再答 q2：这时才收口，累计答案按题序 ──────────────────────

const syncSecond = await syncHarness.registry.respondAsk(syncId, [answerFor(1, '不会')]);
check('② sync 第二批：final = true', syncSecond.final === true, show(syncSecond));
check('② sync 第二批：没有剩余题', same(syncSecond.remaining_questions, []), show(syncSecond));
{
  const record = syncHarness.record(syncId);
  check('② 全部答完 ⇒ answered', record?.status === 'answered', show(record?.status));
  check(
    '② 累计答案按题序 q1/q2',
    same(answeredIdsOf(record), ['q1', 'q2']),
    show(answeredIdsOf(record)),
  );
  check(
    '② 已答的题一道都没丢（2 条）',
    (record?.answer?.answers ?? []).length === 2,
    show(record?.answer?.answers),
  );
}
check(
  '② sync 第二批通知投放（工具已经返回，只能走 inbox 消息）',
  syncHarness.deliveries.length === 1,
  show(syncHarness.deliveries.length),
);
{
  // 投递实现真的跑一遍：第二批**只**带 q2，正文不重复第一批的答案。
  const admits: AnyRecord[] = [];
  const service = {
    async admit(input: AnyRecord) {
      admits.push(input);
      return { result: { run_id: 'run-2' }, message: {} };
    },
  };
  const delivered = await createAskAnswerDelivery(service as never)(
    syncHarness.deliveries[0] as never,
  );
  check('② 第二批投放成功', delivered === true, String(delivered));
  check('② 第二批 = 一次 admit（一条 inbox 消息）', admits.length === 1, show(admits.length));
  const content = String(admits[0]?.content ?? '');
  check('② 第二批正文只含第 2 题', content.includes('分批演示'), content);
  check('② 第二批正文不重发第 1 题', !content.includes('同步演示'), content);
}

// ── ③ async 同构：同一套判据，只有「每批都通知」不同 ────────────────

const asyncHarness = makeHarness();
const asyncId = asyncHarness.request({ mode: 'async' });
const asyncFirst = await asyncHarness.registry.respondAsk(asyncId, [answerFor(0, '3', ['3'])]);
check('③ async 第一批：也只剩 q2', same(asyncFirst.remaining_questions, ['q2']), show(asyncFirst));
check('③ async 第一批：final = false', asyncFirst.final === false, show(asyncFirst.final));
{
  const asyncRecord = asyncHarness.record(asyncId);
  check(
    '③ async 第一批：记录同样 pending',
    asyncRecord?.status === 'pending',
    show(asyncRecord?.status),
  );
  check(
    '③ async 第一批：answered_questions 同样是 [q1]',
    same(asyncRecord?.answered_questions, ['q1']),
    show(asyncRecord?.answered_questions),
  );
}
check(
  '③ async 第一批就通知投放（提问的 run 早结束了，没人等接答案）',
  asyncHarness.deliveries.length === 1,
  show(asyncHarness.deliveries.length),
);
const asyncSecond = await asyncHarness.registry.respondAsk(asyncId, [answerFor(1, '不会')]);
check('③ async 第二批：收口', asyncSecond.final === true, show(asyncSecond.final));
check(
  '③ async 全部答完 ⇒ answered',
  asyncHarness.record(asyncId)?.status === 'answered',
  show(asyncHarness.record(asyncId)?.status),
);
check(
  '③ async 累计答案按题序 q1/q2',
  same(answeredIdsOf(asyncHarness.record(asyncId)), ['q1', 'q2']),
  show(answeredIdsOf(asyncHarness.record(asyncId))),
);
check(
  '③ async 两批各通知一次',
  asyncHarness.deliveries.length === 2,
  show(asyncHarness.deliveries.length),
);

// 对照表：两种 mode 的**状态机**逐字段同构，只有通知次数不同。
{
  const syncRecord = syncHarness.record(syncId);
  const asyncRecord = asyncHarness.record(asyncId);
  const shape = (record: StoredInteraction | undefined) => ({
    status: record?.status,
    answered_questions: record?.answered_questions,
    answers: (record?.answer?.answers ?? []).map((item) => String((item as AnyRecord).question_id)),
  });
  check(
    '③ 收口后两种 mode 的记录状态机逐字段同构',
    same(shape(syncRecord), shape(asyncRecord)),
    `${show(shape(syncRecord))} vs ${show(shape(asyncRecord))}`,
  );
}

// ── ④ 已答过的题重复提交：skipped + 记录一字未改 + 不重投 ────────────

{
  const h = makeHarness();
  const requestId = h.request();
  await h.registry.respondAsk(requestId, [answerFor(0, '3', ['3'])]);
  const before = show(h.record(requestId));

  const again = await h.registry.respondAsk(requestId, [answerFor(0, '3', ['3'])]);
  check('④ pending 时重复提交 ⇒ duplicate', again.duplicate === true, show(again));
  check('④ 明说跳过了 q1', same(again.skipped_questions, ['q1']), show(again));
  check('④ 本批没有写入任何题', same(again.answered_questions, []), show(again.answered_questions));
  check('④ 仍未收口（另一题还在等人）', again.final === false, show(again.final));
  check(
    '④ 记录一字未改（答案 / 逐题进度都没被重复提交改写）',
    show(h.record(requestId)) === before,
    show(h.record(requestId)),
  );
  check('④ 没有多通知一次投放', h.deliveries.length === 0, show(h.deliveries.length));

  // 收口之后再交同一题：仍是 duplicate（不抛 conflict，旧客户端的重放不变差）。
  await h.registry.respondAsk(requestId, [answerFor(1, '不会')]);
  const deliveredAfterClose = h.deliveries.length;
  const afterClose = await h.registry.respondAsk(requestId, [answerFor(0, '3', ['3'])]);
  check('④ 收口后的重复提交也是 duplicate', afterClose.duplicate === true, show(afterClose));
  check('④ 收口后 final = true', afterClose.final === true, show(afterClose.final));
  check(
    '④ 收口后的重复提交不重投',
    h.deliveries.length === deliveredAfterClose,
    show(h.deliveries.length),
  );
}

// ── ⑤ 旧脏记录：不迁移，读侧容忍（不崩、不篡改、不凭空造剩余） ──────

{
  const dir = await mkdtemp(join(tmpdir(), 'vessel-ask-batch-sync-'));
  try {
    // 事故留下的脏记录形状：`answered` 但 `answer.answers` 少于 `input` 里的题，
    // 且没有 `answered_questions`（这是旧代码写的，不是当前写侧的产物）。
    const dirty: StoredInteraction = {
      requestId: 'dirty-1',
      run_id: 'run-0',
      kind: 'ask',
      tool: 'ask',
      input: twoQuestions(),
      created_at: 1000,
      status: 'answered',
      answer: {
        answered_at: 2000,
        answered_by: 'human',
        answered_via: 'rpc',
        latency_ms: 1000,
        answers: [answerFor(0, '3', ['3'])],
      },
    };
    await new InteractionsStore(dir).save('t1', [dirty]);

    const h = makeHarness({ dir });
    const loaded = h.record('dirty-1');
    check(
      '⑤ 脏记录原样加载（不迁移、不猜 answered_questions）',
      loaded?.status === 'answered' && loaded?.answered_questions === undefined,
      show({ status: loaded?.status, answered_questions: loaded?.answered_questions }),
    );
    check(
      '⑤ 脏记录不计入 pending ask 视图（它不再等任何人）',
      !h.registry.pendingAsks.has('dirty-1'),
      show([...h.registry.pendingAsks.keys()]),
    );
    // 容忍 = 可预期：重复提交同一题仍是幂等的 duplicate，不是 conflict。
    const replay = await h.registry.respondAsk('dirty-1', [answerFor(0, '3', ['3'])]);
    check(
      '⑤ 脏记录上重复提交同一题 ⇒ duplicate（不是 conflict）',
      replay.duplicate === true,
      show(replay),
    );
    check(
      '⑤ 脏记录没有被这次重复提交改动',
      show(h.record('dirty-1')) === show(loaded),
      show(h.record('dirty-1')),
    );
    // 历史请求已收口：未答的那题不再可答（明确 conflict，而不是假装还能答）。
    let conflict: unknown;
    try {
      await h.registry.respondAsk('dirty-1', [answerFor(1, '不会')]);
    } catch (error) {
      conflict = error;
    }
    check(
      '⑤ 脏记录上补答未答的题 ⇒ conflict（已收口的历史请求不复活）',
      (conflict as { code?: string } | undefined)?.code === 'conflict',
      show((conflict as { code?: string } | undefined)?.code),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── ⑥ 落盘：部分已答的记录在文件里也是 pending（不是只在内存里对） ─────

{
  const dir = await mkdtemp(join(tmpdir(), 'vessel-ask-batch-sync-disk-'));
  try {
    const h = makeHarness({ dir });
    const requestId = h.request();
    await h.registry.respondAsk(requestId, [answerFor(0, '3', ['3'])]);
    await settlePersistence();
    const onDisk = new InteractionsStore(dir)
      .loadAllSync()
      .find((item) => item.requestId === requestId);
    check('⑥ 落盘记录 status = pending', onDisk?.status === 'pending', show(onDisk?.status));
    check(
      '⑥ 落盘记录带 answered_questions = [q1]',
      same(onDisk?.answered_questions, ['q1']),
      show(onDisk?.answered_questions),
    );
    check(
      '⑥ 落盘记录没有任何投递标记（部分已答不许被当成已投递）',
      onDisk?.answer?.delivered_at === undefined,
      show(onDisk?.answer?.delivered_at),
    );
    const reloaded = createInteractionsRegistry({
      eventsFor: () => memoryStream() as never,
      singleTenantId: 't1',
      interactionsDir: dir,
    });
    check(
      '⑥ 重启 hydrate 后仍是 pending（不被孤儿化，剩下那题还能答）',
      reloaded.interactionRecords.get(requestId)?.status === 'pending',
      show(reloaded.interactionRecords.get(requestId)?.status),
    );
    const finish = reloaded.respondAsk(requestId, [answerFor(1, '不会')]);
    check(
      '⑥ 重启后补答剩余那题仍可收口',
      (finish as AskRespondResult).final === true,
      show(finish),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`FAILED ${failures.length} / ${passed + failures.length}`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`OK ask-batch-sync passed ${passed} / ${passed}`);
