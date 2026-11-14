// 探针：`inbox read` 的「读了还会重复投递」语义（离线，先不接 gates）。
//
// 跑法：bun run scripts/probe-inbox-read-delivery.ts
//
// 覆盖四条：
//   1. unread 只读即消费 —— read 缺省读完立刻 consumed，第二次 read 拿到 0 条；
//   2. held peek 不消费 —— 工具结果标 will_be_delivered:true，且投递真的还在队列上；
//   3. claim 之后真的不再投 —— beforeClaim 收回已排程的 run，再 claim 幂等跳过；
//   4. 回归锁 —— includeHeld 缺省行为与改动前一致（held 条目不吐正文、不消费、不标字段）。
//
// 为什么用假队列：真实投递点在 AgentService（service.ts:2596-2605 排程、:2781-2783 取一条
// 投递），本单禁改 service.ts。这里按同样的顺序复刻「排程 = 把消息挂到队列上」与「投递 =
// 从队列拿一条、不看 inbox 状态直接当 run input」，这正是 read 读过也不影响投递的机制。

import { mock } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const quietLogger: Record<string, unknown> = {};
quietLogger.debug = () => {};
quietLogger.info = () => {};
quietLogger.warn = () => {};
quietLogger.error = () => {};
quietLogger.child = () => quietLogger;

mock.module('@vessel-agent/core', () => ({
  atomicWrite: async (path: string, data: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, 'utf8');
  },
  HookType: { BeforeLlm: 'before_llm', AfterLlm: 'after_llm' },
  MESSAGE_REF_PATH_MAX: 4096,
  MESSAGE_REFS_MAX: 8,
  noopLogger: quietLogger,
}));

const { AgentInboxStore, createInboxTool } = await import('../packages/agent/src/inbox');

const TENANT = 'tenant-probe';
const AGENT = 'agent-probe';
const BODY = 'body-1';
const SESSION = 'session-probe';

interface QueuedRun {
  messageId: string;
  text: string;
  cancelled: boolean;
}

/** 复刻 scheduler 队列：submit = 排程，drain = executor 取一条投递，withdraw = beforeClaim 收回。 */
class FakeScheduler {
  readonly runs: QueuedRun[] = [];

  submit(messageId: string, text: string): void {
    this.runs.push({ messageId, text, cancelled: false });
  }

  /** 对应 service.ts 的 withdrawQueuedRuns：hold 住的那些 run 真的取消了。 */
  withdraw(messageIds: readonly string[]): number {
    let cancelled = 0;
    for (const run of this.runs) {
      if (!run.cancelled && messageIds.includes(run.messageId)) {
        run.cancelled = true;
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** 对应 service.ts:2781-2783：不看 inbox 状态，拿到就投（取消的跳过）。 */
  drain(): QueuedRun[] {
    const delivered: QueuedRun[] = [];
    for (const run of this.runs.splice(0)) {
      if (!run.cancelled) delivered.push(run);
    }
    return delivered;
  }

  get live(): number {
    return this.runs.filter((run) => !run.cancelled).length;
  }
}

const failures: string[] = [];
let passed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail === undefined ? name : `${name} :: ${JSON.stringify(detail)}`);
}

interface ReadItem {
  id: string;
  text?: string;
  held?: boolean;
  will_be_delivered?: boolean;
}

interface ReadOut {
  read: number;
  unread: number;
  pending: number;
  messages: ReadItem[];
  hint?: string;
}

interface ClaimOut {
  claimed: number;
  messages: ReadItem[];
  skipped: { id: string; reason: string }[];
}

const dir = await mkdtemp(join(tmpdir(), 'vessel-inbox-peek-'));

try {
  const scheduler = new FakeScheduler();
  const store = new AgentInboxStore({
    dataDir: dir,
    tenantId: TENANT,
    logger: quietLogger as never,
    // 生产里这个钩子由 AgentService 注入（service.ts:851），claim 才能收回已排程的 run。
    beforeClaim: (_agentId: string, ids: readonly string[]) => scheduler.withdraw(ids),
  } as never);
  const tool = createInboxTool({ agentId: AGENT, inbox: store });
  const ctx = { session_id: SESSION } as never;

  const call = async (args: Record<string, unknown>): Promise<string> =>
    await tool.handler(args, ctx);

  /** 一条「投给 agent 的消息」：append 进来就是 unread；再 hold 就是被 body mailbox 接管。 */
  const deliver = (id: string, text: string, ts: number): void => {
    const result = store.append(AGENT, { id, ts, source: 'main@team', text });
    if (!result.accepted) throw new Error(`append rejected: ${id}`);
  };
  const holdAndSchedule = (id: string, text: string): void => {
    store.hold(AGENT, id, BODY);
    scheduler.submit(id, text);
  };

  // ---- 1. unread：只读即消费 -------------------------------------------------
  deliver('m-unread', '第一条：只读即消费', 1000);
  const unreadRead = JSON.parse(await call({ action: 'read' })) as ReadOut;
  check('1 read 返回 1 条', unreadRead.read === 1, unreadRead);
  check(
    '1 正文拿到',
    unreadRead.messages[0]?.text === '第一条：只读即消费',
    unreadRead.messages[0],
  );
  check(
    '1 非 held 不标 will_be_delivered',
    unreadRead.messages[0]?.will_be_delivered === undefined,
    unreadRead.messages[0],
  );
  check('1 无 hint', unreadRead.hint === undefined, unreadRead.hint);
  const unreadAgain = JSON.parse(await call({ action: 'read' })) as ReadOut;
  check('1 再读 0 条（已 consumed）', unreadAgain.read === 0, unreadAgain);
  check('1 unread 归零', unreadAgain.unread === 0, unreadAgain);

  // ---- 2. held peek：不消费、标 will_be_delivered、投递还在队列上 ----------------
  deliver('m-held', '第二条：held 会被再投一次', 2000);
  holdAndSchedule('m-held', '第二条：held 会被再投一次');
  const heldRead = JSON.parse(await call({ action: 'read', includeHeld: true })) as ReadOut;
  const heldItem = heldRead.messages.find((message) => message.id === 'm-held');
  check('2 peek 拿到 held 正文', heldItem?.text === '第二条：held 会被再投一次', heldItem);
  check('2 held:true 保留', heldItem?.held === true, heldItem);
  check('2 明标 will_be_delivered:true', heldItem?.will_be_delivered === true, heldItem);
  check('2 hint 说清还会再投', (heldRead.hint ?? '').includes('will_be_delivered'), heldRead.hint);
  const afterPeek = JSON.parse(await call({ action: 'list' })) as {
    unread: number;
    pending: number;
  };
  check(
    '2 peek 没消费（unread 仍 0、pending 仍 1）',
    afterPeek.pending === 1 && afterPeek.unread === 0,
    afterPeek,
  );
  check('2 投递真的还在队列上', scheduler.live === 1, scheduler.live);
  // 这就是用户报的那个路径：同一份正文，peek 拿到一次，run input 再来一次。
  const redelivered = scheduler.drain();
  check(
    '2 同一正文被投第二次（陷阱复现）',
    redelivered[0]?.text === '第二条：held 会被再投一次',
    redelivered,
  );
  // 投递侧收尾（service.ts:2782 consumeAsRunInput）：投出去的那条标 consumed 并解 hold。
  await store.markConsumed(
    AGENT,
    redelivered.map((run) => run.messageId),
    SESSION,
  );
  check('2 投递把 held 收尾为 consumed', store.unreadCount(AGENT) === 0, store.unreadCount(AGENT));

  // ---- 3. claim：读完就认领，之后真的不再投 ------------------------------------
  deliver('m-claim', '第三条：claim 之后不该再投', 3000);
  holdAndSchedule('m-claim', '第三条：claim 之后不该再投');
  const peekClaim = JSON.parse(await call({ action: 'read', includeHeld: true })) as ReadOut;
  check(
    '3 claim 前先看到 will_be_delivered',
    peekClaim.messages.find((message) => message.id === 'm-claim')?.will_be_delivered === true,
    peekClaim.messages,
  );
  const claimed = JSON.parse(await call({ action: 'claim', message_ids: ['m-claim'] })) as ClaimOut;
  check(
    '3 claim 拿到 1 条正文',
    claimed.claimed === 1 && claimed.messages[0]?.id === 'm-claim',
    claimed,
  );
  check('3 beforeClaim 收回了排程', scheduler.live === 0, scheduler.runs);
  const afterClaim = scheduler.drain();
  check('3 队列里什么都没投出来', afterClaim.length === 0, afterClaim);
  const claimAgain = JSON.parse(
    await call({ action: 'claim', message_ids: ['m-claim'] }),
  ) as ClaimOut;
  check(
    '3 再 claim 幂等跳过（consumed）',
    claimAgain.claimed === 0 && claimAgain.skipped[0]?.reason === 'consumed',
    claimAgain,
  );

  // ---- 4. 回归锁：includeHeld 缺省行为一字不改 ----------------------------------
  deliver('m-default', '第四条：缺省 read 看得到', 4000);
  deliver('m-held2', '第四条：held 缺省不给正文', 5000);
  holdAndSchedule('m-held2', '第四条：held 缺省不给正文');
  const defaultRead = JSON.parse(await call({ action: 'read' })) as ReadOut;
  check('4 缺省 read 只吐非 held', defaultRead.read === 1, defaultRead);
  check(
    '4 缺省 read 吐的是 m-default',
    defaultRead.messages[0]?.id === 'm-default',
    defaultRead.messages,
  );
  const afterDefault = JSON.parse(await call({ action: 'list' })) as {
    unread: number;
    pending: number;
    messages: { id: string; held: boolean }[];
  };
  check(
    '4 缺省 read 不动 held',
    afterDefault.pending === 1 && afterDefault.unread === 0,
    afterDefault,
  );
  check(
    '4 held 那条还在（m-held2）',
    afterDefault.messages[0]?.id === 'm-held2',
    afterDefault.messages,
  );
  const storeDefaultRead = await store.read(AGENT, {}, SESSION);
  check('4 store 层缺省 read 仍是空', storeDefaultRead.length === 0, storeDefaultRead);
  const storeHeldRead = await store.read(AGENT, { includeHeld: true }, SESSION);
  check('4 store 层 held 条目仍带 held:true', storeHeldRead[0]?.held === true, storeHeldRead[0]);
  check(
    '4 store 层不加 will_be_delivered（只在工具层）',
    storeHeldRead[0] !== undefined && !('will_be_delivered' in storeHeldRead[0]),
    storeHeldRead[0],
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} check(s) failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`OK: ${passed} checks passed`);
