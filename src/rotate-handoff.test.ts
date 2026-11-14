/**
 * rotate 交棒轮解耦（B′）的窄属性测试：把「自己交棒的那一轮」从「真迟到的旧轮」里分出来。
 *
 * 形态沿用 `src/inbox-direct.test.ts`（本仓没有 test gate；这类窄属性测试是被允许的例外，
 * 直接跑 `bun run src/rotate-handoff.test.ts`，判定看输出文本 `OK ... passed N / N` ——
 * 本机 bun 是 Windows 版，退出码不可信）。命名带 `.test.ts` 让 `package.json` 的 `files`
 * 排除规则把它挡在发布包外，同时 `bun run typecheck`（tsconfig 的 `src/` 范围）继续覆盖它。
 *
 * **为什么 mock `@vessel-agent/core`**：本 worktree 没有 node_modules、也不允许
 * `bun install`，而 `packages/agent/src/*` 都按 bare specifier 引 core。这里只替掉 core 的
 * **运行时出口**，被测的是**真实的** `AgentService`（含真实收口分支）：每个用例都真跑
 * `rotate（就是工具 handler 那一行 service.createSession allowActiveRun）→ 退役 → 本轮继续
 * 跑完 → 收口`，断言的是「这一轮到底有没有被采用 / 有没有留下解释」，不是实现细节。
 *
 * 覆盖这一单的四条行为：
 *
 * 1. **交棒轮 completed + 有正文 ⇒ 正常采用**：没有 `agent.reply.stale`、agent 终态写成
 *    `completed`、handle 带正文 settle（0.51 事故里这三条全是反的）；
 * 2. **交棒轮 failed / 空正文 ⇒ 必须有明确 notice**：`reason: handoff_no_reply`，并且
 *    Web 那句「已交棒，但这一轮没有留下收尾」真的存在（两侧 i18n 占位符一致、EventRow
 *    真按这个字面量分流）；
 * 3. **真迟到旧轮（外部退役）⇒ 旧行为一字不变**：仍然 `reason: epoch_fenced`、仍然不写
 *    agent 终态（`idle` 而不是 `completed`）；
 * 4. **判据的反向验证**：把「交棒」判据换成粗判（`retired` 即交棒，或只比 run id 不看
 *    退役原因），用例 3 的两条断言必须同时红 —— 判据不能靠 `retired` 一个布尔。
 */

import { mock } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messages as en } from '../apps/web/src/i18n/messages/en';
import { messages as zh } from '../apps/web/src/i18n/messages/zh-CN';
import type { AgentEvent } from '../packages/agent/src/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * core 的运行时替身。只列 `packages/agent/src` 真正会在运行时取用的出口：少一个就会在
 * import 时炸（缺命名导出），多一个没有意义。
 */
mock.module('@vessel-agent/core', () => ({
  assertTenantId: () => {},
  compactMessagesForSeed: () => [],
  LeaseExpiredError: class extends Error {},
  RunResumeError: class extends Error {},
  noopLogger: quietLogger,
  projectMessages: () => [],
  atomicWrite: async (path: string, data: string) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, 'utf8');
  },
  HookType: { BeforeLlm: 'before_llm', AfterLlm: 'after_llm' },
  MESSAGE_REFS_MAX: 8,
  MESSAGE_REF_PATH_MAX: 4096,
  // 0.53 U1（ADR-104）：会话创建 / 换 body 的投射声明。本测试不碰投射，
  // 给最小替身（declareProjection 一旦被调用就抛，说明测试真的走到那条路了）。
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
}));

const { classifyRetiredTurn, createAgentService } = await import('../packages/agent/src/service');

type AnyRecord = Record<string, unknown>;

/** 交棒轮的 startup_prompt（工具 rotate 的必填参数；新 body 首轮输入就是它）。 */
const STARTUP_PROMPT = 'HANDOFF-STARTUP-PROMPT';
/** 交棒轮的收尾正文：0.51 事故里这段是「轮换已提交…交接要点…」，被 fence 掉的那段。 */
const HANDOFF_REPLY = 'handoff turn closing reply';
/** 「没有被采用」的那个事件名（三条断言都盯它）。 */
const STALE_EVENT = 'agent.reply.stale';

/** 让后台收口（`void executeExecutionUnitTurn` / 落盘写链）跑到静止。 */
async function settleTicks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 一具 body 的收口现场（判据只读这两个字段，见 `classifyRetiredTurn`）。 */
interface EntrySnapshot {
  retired: boolean;
  retirement?: { runId: string; reason: string };
}

/** service 上被测判据要用、但对外不暴露的两处内部结构（只为构造退役现场）。 */
interface ServiceInternals {
  registry: { get(agentId: string): unknown };
  findEntry(agentId: string, bindingId: string): EntrySnapshot | undefined;
  retireExecutionUnitEntry(record: unknown, entry: unknown, reason: string): Promise<void>;
}

/**
 * 调度器替身：**真的排队**（不立即执行），并且把 executor 返回的真实 `RunHandle` 收下来
 * —— 用例 1 要断言「handle 带正文 settle」，而 RunHandle 只从 executor 的返回值拿到。
 */
class FakeScheduler {
  readonly queue: { task: AnyRecord; state: string }[] = [];
  readonly handles: { runId: string; handle: { status(): string; result: Promise<string> } }[] = [];

  async submit(task: AnyRecord): Promise<AnyRecord> {
    this.queue.push({ task, state: 'queued' });
    return {
      id: task.runId as string,
      status: () => 'queued',
      onEvent: () => () => {},
      cancel: () => true,
      wait: async () => ({ status: 'queued' }),
    };
  }

  cancel(): boolean {
    return true;
  }

  stats() {
    return { queued: this.queue.length, running: 0, completed: 0, failed: 0, cancelled: 0 };
  }

  async close(): Promise<void> {}

  /** 跑一条排队任务（= 一轮 run 从 executor 到收口）。 */
  async drainOne(): Promise<boolean> {
    const next = this.queue.shift();
    if (next === undefined) return false;
    next.state = 'running';
    const runId = next.task.runId as string;
    const executor = next.task.executor as (id: string) => Promise<unknown>;
    const handle = (await executor(runId)) as
      | { status(): string; result: Promise<string> }
      | undefined;
    if (handle !== undefined) this.handles.push({ runId, handle });
    await settleTicks();
    return true;
  }

  /** 跑光当前队列；投递链条会在一轮收口时补排下一条，所以循环到真的空。 */
  async drainAll(): Promise<void> {
    for (let guard = 0; guard < 40; guard += 1) {
      const ran = await this.drainOne();
      if (ran) continue;
      await settleTicks();
      if (this.queue.length === 0) return;
    }
  }
}

type TurnResult = { content: string; outcome: 'completed' | 'failed' | 'cancelled' };
type TurnHandler = (message: { id: string; content: string }) => Promise<TurnResult>;

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'vessel-rotate-handoff-'));
  const events: AgentEvent[] = [];
  const turns: { content: string }[] = [];
  let onTurn: TurnHandler = async () => ({ content: '', outcome: 'completed' });
  const runtime = {
    async spawn() {},
    async runTurn(_member: AnyRecord, message: AnyRecord) {
      turns.push({ content: message.content as string });
      return onTurn({ id: message.id as string, content: message.content as string });
    },
    cancel() {},
    async dispose() {},
  };
  const scheduler = new FakeScheduler();
  let idSeq = 0;
  const service = createAgentService({
    tenantId: 't1',
    dataDir,
    runtime: runtime as never,
    scheduler: scheduler as never,
    now: () => 1000,
    newId: () => `id-${String(++idSeq)}`,
    logger: quietLogger as never,
  });
  service.subscribe((event) => events.push(event));
  const worker = await service.create({
    name: 'worker',
    kind: 'contractor',
    owner: 'human',
    // team 可见：rotate 的 startup_prompt 以 `SYSTEM_PRINCIPAL` 投递，private body 会被
    // 可见性闸门挡住（`member_not_visible`），新身体就永远收不到交接书。
    visibility: 'team',
  });

  const internals = service as unknown as ServiceInternals;

  return {
    service,
    scheduler,
    events,
    workerId: worker.id,
    workerSessionId: worker.session_id,
    setTurn: (handler: TurnHandler) => {
      onTurn = handler;
    },
    /** 模型真正收到的输入正文，按轮序。 */
    inputs: () => turns.map((turn) => turn.content),
    /**
     * 交棒：内置 rotate 工具 handler 干的就是这一行（同一对参数、同一个内部选项）。
     * 不经过 tool.ts 是为了不搭人类审批通道：本用例测的是**引擎收口判据**，
     * 而审批只决定「要不要发请求」，不改变退役时序。
     */
    rotate: () =>
      service.createSession(
        { agent_id: worker.id, startup_prompt: STARTUP_PROMPT },
        { allowActiveRun: true },
      ),
    /** 白盒读一具 body 的退役现场（判据 ④ 要吃真实 entry 形态，不留手抄副本）。 */
    entrySnapshot: (bindingId: string): EntrySnapshot | undefined => {
      const entry = internals.findEntry(worker.id, bindingId);
      if (entry === undefined) return undefined;
      return { retired: entry.retired, retirement: entry.retirement };
    },
    /**
     * 白盒构造「外部退役」：现实里外部退役只有 TTL 回收 / close / delete / RPC rotate 四条，
     * 且每条都先被 idle 判据挡住（报告 §2 Q2）。这里直接调私有退役函数，正是为了构造
     * 「退役赶在 run 内」这个竞态 —— 也就是「真迟到旧轮」唯一可能落到收口处的形态。
     */
    externalRetire: async (reason: string): Promise<void> => {
      const entry = internals.findEntry(worker.id, worker.session_id);
      if (entry === undefined) throw new Error('externalRetire: no live entry');
      await internals.retireExecutionUnitEntry(internals.registry.get(worker.id), entry, reason);
    },
    staleEvents: () => events.filter((event) => event.type === STALE_EVENT),
    state: async () => (await service.identify(worker.id))?.state,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

/** i18n 模板渲染（只替占位符；Web 侧真渲染在 EventRow，本仓 worktree 起不来 React）。 */
function render(template: string, values: Record<string, string>): string {
  let text = template;
  for (const [key, value] of Object.entries(values)) text = text.split(`{${key}}`).join(value);
  return text;
}

/** 同一 key 在两侧 catalog 的占位符集合（`check-i18n` I4 的同一条规则）。 */
function placeholders(template: string): string {
  return (template.match(/\{[a-z_]+\}/g) ?? []).sort().join(',');
}

/** 一条 `agent.reply.stale` 的载荷（只取断言要用的三个字段）。 */
interface StalePayload {
  reason?: string;
  epoch?: number;
  outcome?: string;
}

/** 断言失败时的一个安全值（`{}` 直接取属性在类型上不成立，见下面 `EMPTY_PAYLOAD`）。 */
const EMPTY_PAYLOAD: StalePayload = {};

/**
 * 读一条 AgentEvent 的载荷。
 *
 * `emitForSession` 把 extra 摊在**事件顶层**（`{ type, ...data }`），不是塞进 `data` ——
 * 读错位置会让所有断言静默变成 `undefined`，所以载荷只在这一处读。
 */
function stalePayload(event: AgentEvent): StalePayload {
  return { reason: event.reason, epoch: event.epoch, outcome: event.outcome };
}

async function main(): Promise<void> {
  // ── ① 交棒轮 completed + 有正文 ⇒ 正常采用（不 fence） ─────────────────────
  const handoffSnapshot: { entry?: EntrySnapshot; runId?: string } = {};
  let case1StaleCount = -1;
  let case1State: string | undefined;
  {
    const h = await harness();
    h.setTurn(async (message) => {
      if (message.content === 'ROTATE') {
        await h.rotate();
        // 退役现场：此刻旧 body 的 run 还活着（`entry.active` 就是这一轮）。
        handoffSnapshot.entry = h.entrySnapshot(h.workerSessionId);
        return { content: HANDOFF_REPLY, outcome: 'completed' };
      }
      return { content: 'new body first turn', outcome: 'completed' };
    });
    await h.service.dispatch({ to: h.workerId, from: 'human', content: 'ROTATE' });
    await h.scheduler.drainOne();
    handoffSnapshot.runId = h.scheduler.handles[0]?.runId;

    case1StaleCount = h.staleEvents().length;
    check('① 交棒轮不发 stale', case1StaleCount === 0, String(case1StaleCount));

    case1State = await h.state();
    check('① agent 终态写成 completed', case1State === 'completed', String(case1State));

    const handle = h.scheduler.handles[0]?.handle;
    check('① 拿到这一轮的 handle', handle !== undefined);
    check('① handle 状态 completed', handle?.status() === 'completed', String(handle?.status()));
    const settled = await handle?.result;
    check('① handle 带正文 settle', settled === HANDOFF_REPLY, String(settled));

    // 交棒没有打断新身体：启动嘱托照常成为它的第一轮输入。
    await h.scheduler.drainAll();
    check('① 新 body 照常开跑', h.inputs().includes(STARTUP_PROMPT), h.inputs().join('|'));
    check('① 全部跑完仍没有 stale', h.staleEvents().length === 0, String(h.staleEvents().length));
    await h.cleanup();
  }

  // ── ② 交棒轮没有收尾（失败 / 空正文 / 取消）⇒ 必须留下明确 notice ──────────
  //
  // 三格覆盖「交棒了但没有收尾」的三种现实形态。注意 `throw` 那一格的 outcome 是
  // `completed`：退役 body 上的异常**有意不记失败**（`executeExecutionUnitTurn` 里
  // `!entry.closing` 这条既有语义，本单不改），所以引擎手上没有失败原因、也没有正文 ——
  // 这正是「必须显式说一句」的场景：除了这条 notice，外面什么都看不到。
  const variants = [
    {
      label: 'throw',
      outcome: 'completed',
      state: 'completed',
      act: async (h: Awaited<ReturnType<typeof harness>>) => {
        await h.rotate();
        throw new Error('model blew up after rotate');
      },
    },
    {
      label: 'empty',
      outcome: 'completed',
      state: 'completed',
      act: async (h: Awaited<ReturnType<typeof harness>>) => {
        await h.rotate();
        return { content: '', outcome: 'completed' as const };
      },
    },
    {
      label: 'cancelled',
      outcome: 'cancelled',
      state: 'cancelled',
      act: async (h: Awaited<ReturnType<typeof harness>>) => {
        await h.rotate();
        return { content: '', outcome: 'cancelled' as const };
      },
    },
  ];
  const observed: { first?: { reason?: string; outcome?: string; epoch?: number } } = {};
  for (const variant of variants) {
    const marker = `ROTATE-${variant.label.toUpperCase()}`;
    const h = await harness();
    h.setTurn(async (message) => {
      if (message.content === marker) return await variant.act(h);
      return { content: '', outcome: 'completed' as const };
    });
    await h.service.dispatch({ to: h.workerId, from: 'human', content: marker });
    await h.scheduler.drainOne();

    const stale = h.staleEvents();
    check(`② ${variant.label}: 有一条 notice`, stale.length === 1, String(stale.length));
    const payload = stale[0] === undefined ? EMPTY_PAYLOAD : stalePayload(stale[0]);
    check(
      `② ${variant.label}: reason = handoff_no_reply`,
      payload.reason === 'handoff_no_reply',
      String(payload.reason),
    );
    check(
      `② ${variant.label}: 不是 epoch_fenced`,
      payload.reason !== 'epoch_fenced',
      String(payload.reason),
    );
    check(
      `② ${variant.label}: notice 带 outcome`,
      payload.outcome === variant.outcome,
      String(payload.outcome),
    );
    const state = await h.state();
    check(`② ${variant.label}: 仍然正常记账`, state === variant.state, String(state));
    if (observed.first === undefined) observed.first = payload;
    await h.cleanup();
  }

  // 文案：Web 侧那句必须存在、说真话，且两侧占位符一致（`check-i18n` I4 的口径）。
  const handoffTemplate = zh['chat.notice.handoffNoReply'];
  check(
    '② 文案说「交棒了，但没有收尾」',
    handoffTemplate.includes('交棒') && handoffTemplate.includes('没有留下收尾'),
    handoffTemplate,
  );
  const renderedNoReply = render(handoffTemplate, {
    outcome: String(observed.first?.outcome),
    epoch: String(observed.first?.epoch),
  });
  check('② 文案渲染出 outcome', renderedNoReply.includes('completed'), renderedNoReply);
  check(
    '② 两侧占位符一致',
    placeholders(handoffTemplate) === placeholders(en['chat.notice.handoffNoReply']),
    `${placeholders(handoffTemplate)} vs ${placeholders(en['chat.notice.handoffNoReply'])}`,
  );
  // EventRow 是 JSX 组件，本 worktree 起不来 React：按源码字面量对拍（同 `check-*` 的口径），
  // 保证「引擎发的 reason」与「界面认的 reason」是同一个字符串。
  const eventRow = await readFile(
    join(import.meta.dir, '..', 'apps/web/src/domains/chat/EventRow.tsx'),
    'utf8',
  );
  check('② EventRow 按 handoff_no_reply 分流', eventRow.includes("'handoff_no_reply'"));
  check('② EventRow 用新 key', eventRow.includes("t('chat.notice.handoffNoReply'"));

  // ── ③ 真迟到旧轮（外部退役）⇒ epoch fencing 一字不变 ─────────────────────
  const lateSnapshot: { entry?: EntrySnapshot; runId?: string } = {};
  let case3State: string | undefined;
  let case3Reason: string | undefined;
  {
    const h = await harness();
    h.setTurn(async (message) => {
      if (message.content === 'LATE') {
        await h.externalRetire('idle_ttl');
        lateSnapshot.entry = h.entrySnapshot(h.workerSessionId);
        return { content: 'late reply nobody should adopt', outcome: 'completed' };
      }
      return { content: '', outcome: 'completed' };
    });
    await h.service.dispatch({ to: h.workerId, from: 'human', content: 'LATE' });
    await h.scheduler.drainOne();
    lateSnapshot.runId = h.scheduler.handles[0]?.runId;

    const stale = h.staleEvents();
    case3Reason = stale[0] === undefined ? undefined : stalePayload(stale[0]).reason;
    check('③ 迟到轮仍发 stale', stale.length === 1, String(stale.length));
    check('③ reason 仍是 epoch_fenced', case3Reason === 'epoch_fenced', String(case3Reason));

    case3State = await h.state();
    check('③ 不写 agent 终态（idle 而不是 completed）', case3State === 'idle', String(case3State));
    check('③ 不是 completed', case3State !== 'completed', String(case3State));
    await h.cleanup();
  }

  // ── ④ 判据本身：真判据 vs 两种粗判 ───────────────────────────────────────
  // 判据表（纯函数）：三种「差点被写成粗判」的输入都必须判成 late。
  check('判据：未退役 ⇒ 迟到', classifyRetiredTurn({ retired: false }, 'r1') === 'late');
  check(
    '判据：退役但没有现场记录（close 路径）⇒ 迟到',
    classifyRetiredTurn({ retired: true }, 'r1') === 'late',
  );
  check(
    '判据：本轮 rotate 退役 ⇒ 交棒',
    classifyRetiredTurn(
      { retired: true, retirement: { runId: 'r1', reason: 'rotation' } },
      'r1',
    ) === 'handoff',
  );
  check(
    '判据：上一轮留下的 rotate 记录 ⇒ 迟到',
    classifyRetiredTurn(
      { retired: true, retirement: { runId: 'r0', reason: 'rotation' } },
      'r1',
    ) === 'late',
  );
  check(
    '判据：本轮 ttl 退役 ⇒ 迟到',
    classifyRetiredTurn(
      { retired: true, retirement: { runId: 'r1', reason: 'idle_ttl' } },
      'r1',
    ) === 'late',
  );

  // 现场比对：同一份判据跑在 ①（自己交棒）与 ③（外部退役）的真实 entry 上，结论必须相反 —
  // 这两具 body 在退役现场的唯一区别就是 retirement 的 run id / 原因。
  const snapshot1 = handoffSnapshot.entry ?? { retired: false };
  const snapshot3 = lateSnapshot.entry ?? { retired: false };
  check(
    '④ ① 的真实 entry 判成交棒',
    classifyRetiredTurn(snapshot1, handoffSnapshot.runId ?? '') === 'handoff',
    JSON.stringify(snapshot1),
  );
  check(
    '④ ③ 的真实 entry 判成迟到',
    classifyRetiredTurn(snapshot3, lateSnapshot.runId ?? '') === 'late',
    JSON.stringify(snapshot3),
  );
  check(
    '④ 两具 entry 的 retired 都是 true（差别的确是判据而不是布尔）',
    snapshot1.retired && snapshot3.retired,
    `${String(snapshot1.retired)} / ${String(snapshot3.retired)}`,
  );

  // 反向验证：把判据换成粗判（`retired` 即交棒），③ 必须红。
  const coarse = (entry: EntrySnapshot, _runId: string): string =>
    entry.retired ? 'handoff' : 'late';
  const runIdOnly = (entry: EntrySnapshot, runId: string): string =>
    entry.retired && entry.retirement?.runId === runId ? 'handoff' : 'late';
  const coarse3 = coarse(snapshot3, lateSnapshot.runId ?? '');
  check('④ 粗判（retired 即交棒）在 ③ 上判成交棒', coarse3 === 'handoff', coarse3);
  check(
    '④ 只比 run id（漏掉退役原因）在 ③ 上也判成交棒',
    runIdOnly(snapshot3, lateSnapshot.runId ?? '') === 'handoff',
  );
  // 走 ①（交棒）分支的签名是实测来的：没有 stale + 终态 completed —— 正好是 ③ 两条断言
  // 的反面，所以粗判会让 ③ 同时红。
  check(
    '④ 粗判 ⇒ ③「仍有 epoch_fenced」变红',
    coarse3 === 'handoff' && case1StaleCount === 0 && case3Reason === 'epoch_fenced',
    `${coarse3} / stale①=${String(case1StaleCount)} / reason③=${String(case3Reason)}`,
  );
  check(
    '④ 粗判 ⇒ ③「不写终态」变红',
    coarse3 === 'handoff' && case1State === 'completed' && case3State === 'idle',
    `${coarse3} / state①=${String(case1State)} / state③=${String(case3State)}`,
  );

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK rotate-handoff: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED rotate-handoff: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
