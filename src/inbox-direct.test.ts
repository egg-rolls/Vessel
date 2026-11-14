/**
 * inbox **队头直投**的窄属性测试（0.51 回归修复：idle 时投正文，不再一律发合成唤醒）。
 *
 * 形态沿用 `src/refs-notice-hook.test.ts`（仓库没有 test gate；这类窄属性测试是被允许的
 * 例外，直接跑 `bun run src/inbox-direct.test.ts`，判定看输出文本 `OK ... passed N / N`
 * —— 本机 bun 是 Windows 版，退出码不可信）。
 *
 * **为什么 mock `@vessel-agent/core`**：本 worktree 没有 node_modules、也不允许
 * `bun install`，而 `packages/agent/src/*` 都按 bare specifier 引 core。这里只替掉 core 的
 * **运行时出口**（写盘工具 / logger / 枚举 / 上限常量），被测的是**真实的** `AgentService`
 * 与**真实的** `AgentInboxStore`：四个用例都是真跑
 * `dispatch → wakeDelivery → dispatchInbox → admitInternal → scheduler → runTurn → settle`
 * 这条链路的结果，断言的是「模型这一轮到底收到了什么」。
 *
 * 覆盖这一单的四条行为（不是实现细节）：
 *
 * 1. **单条未读 + idle ⇒ 直投正文**：run input 就是那条消息本身（不是摘要唤醒那句固定串），
 *    且只消耗这一条；
 * 2. **多条 ⇒ 每轮抽一条队头**：第一轮投队头、第二轮投下一条。队列里同时放两条，并**故意
 *    构造 ts 与入队序相反**的用例 —— 先入队的那条 ts 更大，队头仍必须是它；按 ts 排序的实现
 *    会先投另一条，用例当场失败；
 * 3. **busy ⇒ 不出直投**：正在跑的时候只落 inbox（不打断、不灌正文），投递结果的
 *    `wake=false`、调度队列不涨；
 * 4. **agent 源直投的身份**：直投的输入带 `source: 'agent'` + `from_name: <alias>` ——
 *    runtime 的 `agentInputName`（`packages/agent/src/runtime.ts`）就是拿这两项拼
 *    `agent:<alias>`，Web 据此渲成 agent 卡片而不是环境信息。
 *
 * 外加两条：
 * - **直投投不进去 ⇒ 退回摘要唤醒**，而且被拒的那条仍以 unread 留在队列（不 discard、
 *   不自旋）：这是 `INBOX_WAKE_INPUT` 今天唯一还活着的用法；
 * - store 级：**quiet 留档条目永远不会成为直投的队头**（模型自述 / 投递失败留档的语义
 *   就是「不要执行」），并验证这个位真的落盘、新实例（= 重启后）读得回来。
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
  // 0.53 U1（ADR-104）：会话投射声明的出口（agent 服务创建路径用）。
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

const { AgentInboxStore, inboxPath } = await import('../packages/agent/src/inbox');
const { createAgentService } = await import('../packages/agent/src/service');

type AnyRecord = Record<string, unknown>;

/** 让后台收口（`void executeExecutionUnitTurn` / 落盘写链）跑到静止。 */
async function settleTicks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 调度器替身：**真的排队**（不立即执行），这样才能构造出 busy 窗口 —— 用例 3 要断言
 * 「忙的时候一条新任务都没进队列」。
 */
class FakeScheduler {
  readonly queue: { task: AnyRecord; state: string }[] = [];

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

  /** 跑一条排队任务（= 一轮 run 从 executor 到 settle）。 */
  async drainOne(): Promise<boolean> {
    const next = this.queue.shift();
    if (next === undefined) return false;
    next.state = 'running';
    await (next.task.executor as (id: string) => Promise<unknown>)(next.task.runId as string);
    await settleTicks();
    return true;
  }

  /** 跑光当前队列；直投链条会在一轮收口时补排下一条，所以循环到真的空。 */
  async drainAll(): Promise<void> {
    for (let guard = 0; guard < 60; guard += 1) {
      const ran = await this.drainOne();
      if (ran) continue;
      await settleTicks();
      if (this.queue.length === 0) return;
    }
  }

  /** 队列里下一条任务的 run input（不执行它）。 */
  nextInput(): string | undefined {
    return this.queue[0]?.task.input as string | undefined;
  }
}

interface HarnessOptions {
  /** 额外先建一个成员：`{ id, name }`，用于 agent 源用例。 */
  extraMembers?: readonly { id: string; name: string; visibility?: 'team' | 'tenant' }[];
  workerVisibility?: 'private' | 'team' | 'tenant';
}

/**
 * 预算端口替身：`blockDirect` 为 true 时**只拦直投**（`mode` 不是 `wake` 的投递检查），
 * wake 口径照旧放行 —— 这样才能构造出「wake 落盘成功、队头直投被预算拒掉」的那一步，
 * 用来验证兜底唤醒与「消息一条不丢」。
 */
function makeBudgetPort() {
  let blockDirect = false;
  const ok = { ok: true as const };
  const blocked = {
    ok: false as const,
    dimension: 'wall_clock' as const,
    reason: 'budget_exceeded' as const,
    current: 999,
    max: 1,
  };
  return {
    setBlockDirect: (value: boolean) => {
      blockDirect = value;
    },
    port: {
      checkDelivery: (input: { mode?: string }) =>
        blockDirect && input.mode !== 'wake' ? blocked : ok,
      canStartTurn: () => ok,
      noteTurnStarted: () => {},
      noteTurnFinished: () => {},
      status: () => [],
      override: () => ({ ok: false as const, reason: 'unsupported' }),
      release: () => [],
      flush: async () => {},
    },
  };
}

async function harness(options: HarnessOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'vessel-inbox-direct-'));
  const turns: { message: AnyRecord }[] = [];
  const runtime = {
    async spawn() {},
    async runTurn(_member: AnyRecord, message: AnyRecord) {
      turns.push({ message });
      return { content: '', outcome: 'completed' as const };
    },
    cancel() {},
    async dispose() {},
  };
  const scheduler = new FakeScheduler();
  const budget = makeBudgetPort();
  let idSeq = 0;
  let nowValue = 1000;
  const service = createAgentService({
    tenantId: 't1',
    dataDir,
    runtime: runtime as never,
    scheduler: scheduler as never,
    budget: budget.port as never,
    now: () => nowValue,
    newId: () => `id-${String(++idSeq)}`,
    logger: quietLogger as never,
  });

  for (const member of options.extraMembers ?? []) {
    await service.create({
      id: member.id,
      name: member.name,
      kind: 'contractor',
      owner: 'human',
      visibility: member.visibility ?? 'team',
    });
  }
  const worker = await service.create({
    name: 'worker',
    kind: 'contractor',
    owner: 'human',
    ...(options.workerVisibility !== undefined ? { visibility: options.workerVisibility } : {}),
  });

  return {
    service,
    scheduler,
    workerId: worker.id,
    workerSessionId: worker.session_id,
    /** 让「这一轮什么时候写盘」可控（用例 2 用倒序 ts 构造队列序与时间序相反）。 */
    setNow: (value: number) => {
      nowValue = value;
    },
    /** 只拦直投的预算闸（见 `makeBudgetPort`）。 */
    setBlockDirect: budget.setBlockDirect,
    /** 模型真正收到的输入正文，按轮序。 */
    inputs: () => turns.map((turn) => turn.message.content as string),
    lastInput: () => turns.at(-1)?.message,
    readInbox: async () => {
      // 落盘是异步写链（`enqueueWrite`），读到「文件还没出现」不算失败：等到它出现。
      // 断言的是**持久化事实**（status / session_id / conversation_id / quiet），所以读盘
      // 比读内存更严格 —— 重启恢复与条带都只看盘上这份。
      const path = inboxPath(dataDir, 't1', worker.id);
      let raw = '';
      for (let attempt = 0; attempt < 40 && raw === ''; attempt += 1) {
        try {
          raw = await readFile(path, 'utf8');
        } catch {
          await settleTicks(2);
        }
      }
      if (raw === '') throw new Error(`inbox file never appeared: ${path}`);
      return JSON.parse(raw) as {
        messages: {
          id: string;
          text: string;
          status: string;
          quiet?: true;
          session_id?: string;
          conversation_id?: string;
          consumed_by_session?: string;
        }[];
      };
    },
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

/** 摘要唤醒的固定输入串（`INBOX_WAKE_INPUT`）：直投用例必须证明模型收到的**不是**它。 */
const WAKE_MARKER = 'use the inbox tool';

/**
 * `dispatch` 的三分支结果里只关心 wake 投递那支（`notified`）：先收窄再取 `wake` /
 * `conversation_id`，顺手把「这条到底有没有被 wake 模式接住」也变成一条断言。
 */
function notifiedOutcome(
  result: unknown,
  label: string,
): { wake: boolean; conversation_id: string } | undefined {
  const value = result as { status?: string; wake?: boolean; conversation_id?: string };
  check(`${label} 投递结果是 notified`, value.status === 'notified', String(value.status));
  if (value.status !== 'notified') return undefined;
  return { wake: value.wake === true, conversation_id: String(value.conversation_id) };
}

async function main(): Promise<void> {
  // ── ① 单条未读 + idle ⇒ 直投正文，且只投这一条 ─────────────────────────────
  {
    const h = await harness();
    await h.service.dispatch({ to: h.workerId, from: 'human', content: 'warmup' });
    await h.scheduler.drainAll();
    check('① 预热轮先跑完', h.inputs().join('|') === 'warmup', h.inputs().join('|'));

    const sent = notifiedOutcome(
      await h.service.dispatch({
        to: h.workerId,
        from: 'human',
        content: 'MSG-ONE',
        notify: true,
      }),
      '①',
    );
    check('① 空闲即投：这一步真的动起来了', sent?.wake === true);
    check(
      '① run input 就是消息本体（不是摘要唤醒）',
      h.scheduler.nextInput() === 'MSG-ONE',
      String(h.scheduler.nextInput()),
    );
    check(
      '① 投出去的正文不含唤醒串',
      (h.scheduler.nextInput() ?? '').includes(WAKE_MARKER) === false,
    );
    await h.scheduler.drainAll();
    check('① 模型这一轮收到的就是这条', h.lastInput()?.content === 'MSG-ONE');
    // conversation_id 必须与投递侧一致（否则每次直投都会新开一个会话）。
    check(
      '① conversation_id 与投递一致',
      h.lastInput()?.conversation_id === sent?.conversation_id,
      `${String(h.lastInput()?.conversation_id)} vs ${String(sent?.conversation_id)}`,
    );
    const persisted = await h.readInbox();
    // 盘上只剩 MSG-ONE：早先 consumed 的 warmup 已被下次 append 的 pruneConsumed 裁掉。
    check(
      '① 这条落在盘上是 consumed',
      persisted.messages.length === 1 && persisted.messages[0]?.status === 'consumed',
      JSON.stringify(persisted.messages.map((message) => [message.text, message.status])),
    );
    check(
      '① consumed_by_session 指向执行它的 body',
      persisted.messages[0]?.consumed_by_session === h.workerSessionId,
      `${String(persisted.messages[0]?.consumed_by_session)} vs ${h.workerSessionId}`,
    );
    await h.cleanup();
  }

  // ── ②③ 多条：busy 不直投；队列序取队头（ts 与入队序相反） ──────────────────
  {
    const h = await harness();
    // HOLD 走 input 投递，占住这个 body（= 忙）。
    await h.service.dispatch({ to: h.workerId, from: 'human', content: 'HOLD' });
    // 队列里两条未读，**先入队的 ts 更大**：按 ts 升序会先投 SECOND，按队列序必须投 FIRST。
    h.setNow(5000);
    const firstSent = notifiedOutcome(
      await h.service.dispatch({
        to: h.workerId,
        from: 'human',
        content: 'FIRST-ts5000',
        notify: true,
      }),
      '③ 第一条',
    );
    h.setNow(1000);
    const secondSent = notifiedOutcome(
      await h.service.dispatch({
        to: h.workerId,
        from: 'human',
        content: 'SECOND-ts1000',
        notify: true,
      }),
      '③ 第二条',
    );
    check(
      '③ 忙时不出直投（调度队列只有 HOLD 那一轮）',
      h.scheduler.queue.length === 1,
      String(h.scheduler.queue.length),
    );
    check('③ 忙时投递结果 wake=false', firstSent?.wake === false && secondSent?.wake === false);
    check('③ 忙时模型还没收到任何新正文', h.inputs().length === 0, h.inputs().join('|'));
    let persisted = await h.readInbox();
    // HOLD 还没跑（unread），两条 notify 也只落盘未投 —— 盘上三条全是 unread。
    check(
      '③ 两条都留在队列里且都是 unread',
      persisted.messages.filter((message) => message.status === 'unread').length === 3,
      JSON.stringify(persisted.messages.map((message) => [message.text, message.status])),
    );

    // 第一轮（HOLD）跑完 ⇒ 收口补投一次：队头是 FIRST（先入队），不是 ts 更小的 SECOND。
    await h.scheduler.drainOne();
    check('② HOLD 先跑', h.inputs().join('|') === 'HOLD', h.inputs().join('|'));
    check(
      '② 队头按队列序取（ts 与入队序相反时先投先入队那条）',
      h.scheduler.nextInput() === 'FIRST-ts5000',
      String(h.scheduler.nextInput()),
    );
    await h.scheduler.drainOne();
    check('② 第二轮投的是队头那条', h.inputs().join('|') === 'HOLD|FIRST-ts5000');
    persisted = await h.readInbox();
    check(
      '② 只消耗一条：SECOND 仍是 unread',
      persisted.messages.find((message) => message.text === 'SECOND-ts1000')?.status === 'unread',
      JSON.stringify(persisted.messages.map((message) => [message.text, message.status])),
    );
    check(
      '② 下一轮投下一条',
      h.scheduler.nextInput() === 'SECOND-ts1000',
      String(h.scheduler.nextInput()),
    );
    await h.scheduler.drainAll();
    check('② 三条按队列序全部跑完', h.inputs().join('|') === 'HOLD|FIRST-ts5000|SECOND-ts1000');
    await h.cleanup();
  }

  // ── ④ agent 源直投：身份是 source=agent + from_name=<alias> ⇒ agent:<alias> ──
  {
    const h = await harness({
      extraMembers: [{ id: 'alpha', name: 'alpha' }],
      workerVisibility: 'team',
    });
    await h.service.dispatch({ to: h.workerId, from: 'alpha', content: 'from-alpha' });
    await h.scheduler.drainAll();
    const sent = notifiedOutcome(
      await h.service.dispatch({
        to: h.workerId,
        from: 'alpha',
        content: 'notify-alpha',
        notify: true,
      }),
      '④',
    );
    check('④ agent 源在空闲时直投', sent?.wake === true);
    await h.scheduler.drainAll();
    const delivered = h.lastInput();
    check('④ 直投的正文是消息本体', delivered?.content === 'notify-alpha');
    check('④ 来源标成 agent（runtime 据此判 A2A）', delivered?.source === 'agent');
    check('④ 带上发送者显示名（runtime 拼 agent:<alias>）', delivered?.from_name === 'alpha');
    check('④ 渲染身份 = agent:alpha', `agent:${String(delivered?.from_name)}` === 'agent:alpha');
    await h.cleanup();
  }

  // ── ⑤ 直投投不进去 ⇒ 退回摘要唤醒，且消息一条不丢 ──────────────────────────
  {
    const h = await harness();
    await h.service.dispatch({ to: h.workerId, from: 'human', content: 'warmup' });
    await h.scheduler.drainAll();
    // 从这里开始预算只拦「非 wake 口径」的投递 = 直投；wake 落盘照旧放行。
    h.setBlockDirect(true);
    const sent = notifiedOutcome(
      await h.service.dispatch({
        to: h.workerId,
        from: 'human',
        content: 'BLOCKED-BODY',
        notify: true,
      }),
      '⑤',
    );
    check('⑤ 直投被拒也算「动起来了」（退回唤醒）', sent?.wake === true);
    check(
      '⑤ 退回的是摘要唤醒输入，不是被拒的正文',
      (h.scheduler.nextInput() ?? '').includes(WAKE_MARKER) === true &&
        h.scheduler.nextInput() !== 'BLOCKED-BODY',
      String(h.scheduler.nextInput()),
    );
    await h.scheduler.drainAll();
    const persisted = await h.readInbox();
    check(
      '⑤ 被拒的那条仍留在队列（unread，没被 discard）',
      persisted.messages.some(
        (message) => message.text === 'BLOCKED-BODY' && message.status === 'unread',
      ),
      JSON.stringify(persisted.messages.map((message) => [message.text, message.status])),
    );
    // 兜底唤醒跑完就停：模型没读，不该自己反复重投 / 反复唤醒。
    check('⑤ 兜底之后不再自旋', h.scheduler.queue.length === 0, String(h.scheduler.queue.length));
    await h.cleanup();
  }

  // ── ⑥ store 级：quiet 留档永不成为直投队头，且这个位随条目落盘 ──────────────
  {
    const dataDir = await mkdtemp(join(tmpdir(), 'vessel-inbox-direct-store-'));
    const store = new AgentInboxStore({ dataDir, tenantId: 't1' });
    store.append(
      'w1',
      { id: 'note-1', ts: 3000, source: 'w1', text: 'self note' },
      { delivery: 'quiet' },
    );
    store.append('w1', { id: 'msg-1', ts: 1000, source: 'human', text: 'real message' });
    await store.flush();
    const head = store.inputHead('w1');
    check('⑥ 队头跳过 quiet 留档', head?.id === 'msg-1', String(head?.id));
    check('⑥ 队头带正文（不只是摘要）', head?.text === 'real message');
    // 新实例 = 进程重启后的视角：quiet 位必须从盘上读得回来。
    const reloaded = new AgentInboxStore({ dataDir, tenantId: 't1' });
    const note = reloaded.findByIds('w1', ['note-1'])[0];
    check('⑥ quiet 位落盘并可读回', note?.quiet === true, JSON.stringify(note));
    const reloadedHead = reloaded.inputHead('w1');
    check('⑥ 重启后队头仍然跳过留档', reloadedHead?.id === 'msg-1', String(reloadedHead?.id));
    await rm(dataDir, { recursive: true, force: true });
  }

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK inbox-direct: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED inbox-direct: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
