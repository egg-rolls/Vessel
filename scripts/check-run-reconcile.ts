/**
 * run 收口对账探针（零依赖，不进 gates 链）。
 *
 * 症状（本次事故）：成员已被暂停 / 关闭，会话输入框仍显示停止按钮、对话里还挂着
 * 「正在思考」。
 *
 * 结构性原因：chat 的 live 状态（`runningGroup` → 停止按钮；`group.liveReasoning` →
 * 「正在思考」）**只吃事件流**，从不与「agent 生命周期 / 会话快照终态」对账。事件流是
 * 尽力而为的（背压丢帧 / 回放窗口淘汰 / hub 重启换 seq 纪元 / body 被关掉之后再没人发
 * 终态帧），任何一条成立，这条 run 就永久 `running`。详见 `RunGroup.reconciled` 与
 * `ItemSink.closeRuns` 的注释。
 *
 * 本探针守的是「第二条源真的能把屏幕收回来，而且不伤正常 run」：
 *
 *   R1  agent.closed 收口：只有 run.started + 未闭合 delta，没有终态帧
 *       ⇒ 无 running 组、无 live 尾巴、思考落地成**有 endedAt** 的 item（不是丢弃）
 *   R2  正常 run 不受影响：收到 run.completed 的组不会被对账改写成别的状态
 *   R3  幂等：终态先到再 close ⇒ 一行 item 都不多、stats.reconciled 不涨
 *   R4  重折叠不复活：refold（回填 / 重连）之后仍是终态、仍然没有 live 尾巴
 *   R5  会话快照：completed / failed / cancelled 才收口；running / interrupted 不收口
 *   R6  快照收口照抄状态（completed 不许被写成「取消」，failed 要带回 error）
 *   R7  不许杀掉更新的 run：关闭帧早于新 run 的最后一条事件 ⇒ 新 run 原样 running
 *   R8  `agent.retired` / `agent.stale` 不收口（retired 是 rotate 的旧 body 交棒，
 *       stale 可能恢复 —— 拿它们收口 = 把正常交棒记成取消）
 *
 * 用法：bun run scripts/check-run-reconcile.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { sessionTerminalOfDetail } from '../apps/web/src/domains/chat/transcript-items';
import type { RunEvent } from '../apps/web/src/gateway/types/runs';
import type { SessionDetail } from '../apps/web/src/gateway/types/sessions';
import { EventStore } from '../apps/web/src/state/event-store';
import type { RunGroup, StoredEvent } from '../apps/web/src/state/events';

/** 会话 / run 的身份（成员自己的 agent 流里 `run_id` 就是会话 id，见落盘事件）。 */
const SESSION = '59764f88-a4e6-4523-bac3-f62053ffa9e1';
const RUN = 'bf2be130-9920-4d17-92b0-b46e3d7e4e3a';
const T0 = 1_794_560_000_000;
const T_CALL_CLOSED = T0 + 600_000;

/** 一条 wire 条目：`seq` 是客户端水位，`ts` 在**事件**上（`StoredEvent` 没有自己的 ts）。 */
function ev(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  ts = T0 + seq * 1000,
): StoredEvent {
  const event: RunEvent = {
    type,
    run_id: String(data.run_id ?? RUN),
    ts,
    data,
  };
  return { seq, event };
}

/** run 自己的事件：带 `run_id` + `session_id`（真机 payload 就是一回事）。 */
function runEv(
  seq: number,
  type: string,
  extra: Record<string, unknown> = {},
  runId = RUN,
  ts = T0 + seq * 1000,
): StoredEvent {
  return ev(seq, type, { run_id: runId, session_id: SESSION, ...extra }, ts);
}

function reasoning(seq: number, delta: string, ts = T0 + seq * 1000): StoredEvent {
  return runEv(seq, 'llm.stream.chunk', { chunk: { type: 'reasoning_delta', delta } }, RUN, ts);
}

function text(seq: number, delta: string, ts = T0 + seq * 1000): StoredEvent {
  return runEv(seq, 'llm.stream.chunk', { chunk: { type: 'text_delta', delta } }, RUN, ts);
}

/**
 * `agent.closed`：成员会话被关掉。
 *
 * `run_id` 是**成员自己的** agent / 会话 id（落盘证据：`events/<session>.jsonl` 里
 * `agent.closed` 的 `run_id == data.session_id == 会话 id`），不是 run id —— 所以对账
 * 必须按 `session_id` 找组，不能按 run id。
 */
function agentClosed(seq: number, sessionId = SESSION, ts = T_CALL_CLOSED): StoredEvent {
  return {
    seq,
    event: {
      type: 'agent.closed',
      run_id: sessionId,
      ts,
      data: { run_id: sessionId, session_id: sessionId, agent_id: sessionId, state: 'closed' },
    },
  };
}

function feed(store: EventStore, entries: readonly StoredEvent[]): void {
  for (const entry of entries) store.push(entry.event, { seq: entry.seq });
  store.flush();
  store.items.flush();
}

function groups(store: EventStore): readonly RunGroup[] {
  return store.items.getSnapshot().groups;
}

/**
 * `useChatTranscript.ts` 里 `runningGroup` 的判据（停止按钮只在它非空时出现）。
 *
 * 这里是**逐字复刻**：`status === 'running' && hasRunEvent`（job 取消另有 `cancelledJobs`，
 * 与本探针无关）。探针断言它为空 ⇒ 输入框不会显示停止按钮。
 */
function runningGroups(list: readonly RunGroup[]): RunGroup[] {
  return list.filter((group) => group.status === 'running' && group.hasRunEvent === true);
}

function itemsOf(group: RunGroup): { kind: string; endedAt?: number; text?: string }[] {
  return group.items as unknown as { kind: string; endedAt?: number; text?: string }[];
}

/** 只有 run.started + 未闭合 delta 的「卡住的 run」。 */
function stuckEntries(): StoredEvent[] {
  return [
    runEv(1, 'run.started', { input: '查一下' }),
    reasoning(2, '先看看事件流'),
    reasoning(3, '再看裁窗'),
    text(4, '结论是一半'),
  ];
}

const FIXTURES: { name: string; check: () => string | null }[] = [
  {
    name: 'R1 agent.closed 收口（没有终态帧的成员 run）',
    check: () => {
      const store = new EventStore(0);
      feed(store, [...stuckEntries(), agentClosed(5)]);
      const list = groups(store);
      if (list.length !== 1) return `期望 1 个 run 组，实得 ${list.length}`;
      const group = list[0]!;
      const running = runningGroups(list);
      if (running.length !== 0) {
        return `停止按钮还在：${running.map((g) => `${g.runId}=${g.status}`).join(',')}`;
      }
      if (group.status !== 'cancelled')
        return `收口状态错了：${group.status}（不许冒充 completed）`;
      if (group.reconciled !== 'agent-closed')
        return `没有留下对账痕迹：reconciled=${group.reconciled}`;
      if (group.liveReasoning !== undefined)
        return `「正在思考」还在：liveReasoning=${group.liveReasoning}`;
      if (group.liveText !== undefined) return `尾部正文还挂在 live 上：liveText=${group.liveText}`;
      const reasoningItems = itemsOf(group).filter((item) => item.kind === 'reasoning');
      if (reasoningItems.length !== 1) return `思考没有落地成 1 条 item：${reasoningItems.length}`;
      if (reasoningItems[0]!.endedAt === undefined) return '落地的思考没有 endedAt（等于没终止）';
      const textItems = itemsOf(group).filter((item) => item.kind === 'text');
      if (textItems.length !== 1 || textItems[0]!.text !== '结论是一半') {
        return `尾部正文没落地：${JSON.stringify(textItems.map((item) => item.text))}`;
      }
      if (group.completedAt !== T_CALL_CLOSED)
        return `completedAt 不是收口时刻：${group.completedAt}`;
      return null;
    },
  },
  {
    name: 'R2 正常 run 不受影响（run.completed 先到）',
    check: () => {
      const store = new EventStore(0);
      feed(store, [
        ...stuckEntries(),
        runEv(5, 'run.completed', { output: 'done' }),
        agentClosed(6),
      ]);
      const list = groups(store);
      const group = list[0]!;
      if (group.status !== 'completed') return `正常 run 被改坏了：${group.status}`;
      if (group.reconciled !== undefined) return `正常 run 被标成对账收口：${group.reconciled}`;
      if (runningGroups(list).length !== 0) return '完成的 run 还在 running';
      if (store.items.getSnapshot().stats.reconciled !== 0) {
        return `stats.reconciled 不该涨：${store.items.getSnapshot().stats.reconciled}`;
      }
      const reasoningItems = itemsOf(group).filter((item) => item.kind === 'reasoning');
      if (reasoningItems.length !== 1) return `思考条数不对：${reasoningItems.length}`;
      return null;
    },
  },
  {
    name: 'R3 幂等：终态先到再 close 不写第二条记录',
    check: () => {
      const store = new EventStore(0);
      feed(store, [...stuckEntries(), runEv(5, 'run.completed', { output: 'done' })]);
      const before = itemsOf(groups(store)[0]!).length;
      const completedAt = groups(store)[0]!.completedAt;
      // 重复对账：agent.closed 来两次 + 快照再来一次。
      feed(store, [agentClosed(6)]);
      feed(store, [agentClosed(7, SESSION, T_CALL_CLOSED + 60_000)]);
      store.items.closeRuns(SESSION, {
        status: 'cancelled',
        at: T_CALL_CLOSED + 60_000,
        via: 'agent-closed',
      });
      store.items.flush();
      const group = groups(store)[0]!;
      if (itemsOf(group).length !== before) {
        return `重复收口写了新 item：${before} → ${itemsOf(group).length}`;
      }
      if (group.status !== 'completed') return `重复收口改了状态：${group.status}`;
      if (group.completedAt !== completedAt)
        return `重复收口改了完成时刻：${completedAt} → ${group.completedAt}`;
      if (group.reconciled !== undefined) return `重复收口留了对账痕迹：${group.reconciled}`;
      if (group.liveReasoning !== undefined) return '重复收口之后又出现 live 尾巴';
      return null;
    },
  },
  {
    name: 'R4 重折叠不复活（回填 / 重连之后仍是终态、对账痕迹还在）',
    check: () => {
      const store = new EventStore(0);
      feed(store, [...stuckEntries(), agentClosed(5)]);
      const first = groups(store)[0]!;
      if (first.status !== 'cancelled') return `前提不成立：${first.status}`;
      // 环里只剩 run.started + agent.closed（正文 / 思考 delta 不进环）⇒ 重折叠必然折出
      // running 且没有任何 live 尾巴。**对账痕迹（reconciled）只有台账能补回来** ——
      // `mergeGroupScalars` 只保留 base 的 status，不保留这个字段。
      store.beginBackfill(store.currentSeq);
      store.endBackfill();
      store.items.flush();
      const group = groups(store)[0]!;
      if (group.status !== 'cancelled') return `重折叠把 run 复活成 ${group.status}`;
      if (group.reconciled !== 'agent-closed') {
        return `重折叠丢了对账痕迹：reconciled=${group.reconciled}（台账没补上）`;
      }
      if (group.liveReasoning !== undefined) return '重折叠把「正在思考」复活了';
      if (runningGroups(groups(store)).length !== 0) return '重折叠之后停止按钮又出现了';
      // 再来一次：幂等。
      store.beginBackfill(store.currentSeq);
      store.endBackfill();
      store.items.flush();
      if (itemsOf(groups(store)[0]!).length !== itemsOf(group).length) {
        return '二次重折叠改了 item 条数（收口不幂等）';
      }
      return null;
    },
  },
  {
    name: 'R5 会话快照只认真终态（interrupted / running 不收口）',
    check: () => {
      const base = {
        session_id: SESSION,
        run_id: RUN,
        created_at: T0,
        updated_at: T0 + 5000,
        item_count: 3,
      } as unknown as SessionDetail;
      const completed = sessionTerminalOfDetail({
        ...base,
        status: 'completed',
        completed_at: T0 + 5000,
      });
      if (completed === undefined) return 'completed 快照没有被认成终态';
      if (completed.status !== 'completed' || completed.runId !== RUN) {
        return `快照解析错了：${JSON.stringify(completed)}`;
      }
      for (const status of ['running', 'interrupted', 'idle', '']) {
        const got = sessionTerminalOfDetail({ ...base, status } as unknown as SessionDetail);
        if (got !== undefined) return `「${status}」不该被当成终态收口（会把可恢复的 run 杀掉）`;
      }
      const failed = sessionTerminalOfDetail({
        ...base,
        status: 'failed',
        error: 'body 退役',
      } as unknown as SessionDetail);
      if (failed === undefined || failed.status !== 'failed' || failed.error !== 'body 退役') {
        return `failed 快照丢了 error：${JSON.stringify(failed)}`;
      }
      const cancelled = sessionTerminalOfDetail({
        ...base,
        status: 'cancelled',
      } as unknown as SessionDetail);
      if (cancelled === undefined || cancelled.status !== 'cancelled')
        return 'cancelled 快照没被认成终态';
      if (sessionTerminalOfDetail(undefined) !== undefined) return 'undefined 快照被认成终态';
      return null;
    },
  },
  {
    name: 'R6 会话快照收口照抄状态（completed 不许写成取消，failed 带回 error）',
    check: () => {
      const store = new EventStore(0);
      feed(store, stuckEntries());
      if (runningGroups(groups(store)).length !== 1) return '前提不成立：没有 running 组';
      store.items.closeRuns(SESSION, {
        runIds: [RUN],
        status: 'completed',
        at: T0 + 9000,
        via: 'session-snapshot',
      });
      store.items.flush();
      const group = groups(store)[0]!;
      if (group.status !== 'completed') return `快照说 completed，组却是 ${group.status}`;
      if (group.reconciled !== 'session-snapshot') return `没有对账痕迹：${group.reconciled}`;
      if (group.liveReasoning !== undefined) return '快照收口之后还有「正在思考」';
      if (runningGroups(groups(store)).length !== 0) return '快照收口之后停止按钮还在';
      // failed + error：错误文本要落到组上（失败卡由 runFailureOfGroup 出，不重复造卡）。
      const store2 = new EventStore(0);
      feed(store2, stuckEntries());
      store2.items.closeRuns(SESSION, {
        runIds: [RUN],
        status: 'failed',
        at: T0 + 9000,
        error: 'body 退役',
        via: 'session-snapshot',
      });
      store2.items.flush();
      const failedGroup = groups(store2)[0]!;
      if (failedGroup.status !== 'failed') return `快照说 failed，组却是 ${failedGroup.status}`;
      if (failedGroup.error !== 'body 退役') return `错误文本没落到组上：${failedGroup.error}`;
      return null;
    },
  },
  {
    name: 'R7 不许杀掉更新的 run（关闭帧早于新 run 的事件）',
    check: () => {
      const store = new EventStore(0);
      feed(store, [...stuckEntries(), agentClosed(5)]);
      if (groups(store)[0]!.status !== 'cancelled') return '前提不成立：旧 run 没被收口';
      // 同一会话里**之后**又起了一个 run（关闭帧是过去时，它不该被牵连）。
      const later: StoredEvent[] = [
        runEv(6, 'run.started', { input: '下一轮' }, 'run-later', T_CALL_CLOSED + 5000),
        reasoning(7, '新的思考', T_CALL_CLOSED + 6000),
      ];
      feed(store, later);
      const fresh = groups(store).find((group) => group.runId === 'run-later');
      if (fresh === undefined) return '新 run 的组没建起来';
      if (fresh.status !== 'running') return `新起的 run 被关闭帧误杀：${fresh.status}`;
      if (runningGroups(groups(store)).length !== 1) return '新 run 应当仍是 running';
      return null;
    },
  },
  {
    name: 'R8 agent.retired / agent.stale 不收口（rotate 交棒、可恢复）',
    check: () => {
      for (const type of ['agent.retired', 'agent.stale']) {
        const store = new EventStore(0);
        feed(store, [
          ...stuckEntries(),
          {
            seq: 5,
            event: {
              type,
              run_id: SESSION,
              ts: T_CALL_CLOSED,
              data: { run_id: SESSION, session_id: SESSION, reason: 'rotate', presence: 'gone' },
            },
          },
        ]);
        const group = groups(store)[0]!;
        if (group.status !== 'running') {
          return `${type} 把 run 收口成了 ${group.status}（rotate 交棒 / 可恢复状态不许收口）`;
        }
        if (group.reconciled !== undefined) return `${type} 留下了对账痕迹：${group.reconciled}`;
      }
      return null;
    },
  },
  {
    name: 'R9 agent.closed 缺 session_id 时退化为 run_id（成员 agent 流里两者相等）',
    check: () => {
      const store = new EventStore(0);
      feed(store, [
        ...stuckEntries(),
        {
          seq: 5,
          event: {
            type: 'agent.closed',
            run_id: SESSION,
            ts: T_CALL_CLOSED,
            data: { agent_id: SESSION, state: 'closed' },
          },
        },
      ]);
      const group = groups(store)[0]!;
      if (group.status !== 'cancelled') return `退化路径没生效：${group.status}`;
      if (group.reconciled !== 'agent-closed') return `没有对账痕迹：${group.reconciled}`;
      return null;
    },
  },
  {
    name: 'R10 快照先到、run 的帧后到（帧全丢 / 还没回填）也要收口',
    check: () => {
      const store = new EventStore(0);
      // 会话详情先到（此时本地一个 fold 都没有）——「快照早就是 terminal」。
      const closedNow = store.items.closeRuns(SESSION, {
        runIds: [RUN],
        status: 'failed',
        at: T0 + 9000,
        error: 'body 退役',
        via: 'session-snapshot',
      });
      if (closedNow !== 0) return `还没有 fold 就收口了东西：${closedNow}`;
      // 之后才从环里补回这一 run 的帧（终态帧不在其中）。
      feed(store, stuckEntries());
      const group = groups(store)[0]!;
      if (group.status !== 'failed') return `晚到的 run 没收口：${group.status}`;
      if (group.reconciled !== 'session-snapshot') return `没有对账痕迹：${group.reconciled}`;
      if (group.error !== 'body 退役') return `错误文本没落到组上：${group.error}`;
      if (group.liveReasoning !== undefined) return '晚到的 run 还挂着「正在思考」';
      if (runningGroups(groups(store)).length !== 0) return '晚到的 run 让停止按钮又出现了';
      return null;
    },
  },
  {
    name: 'R11 收口之后又到晚到的 delta：live 尾巴不许复活',
    check: () => {
      const store = new EventStore(0);
      feed(store, [...stuckEntries(), agentClosed(5)]);
      if (groups(store)[0]!.status !== 'cancelled') return '前提不成立：没收口';
      // 乱序 / 重放：收口之后仍可能补进来一段 delta（回放合并、慢帧）。
      feed(store, [
        reasoning(6, '晚到的思考', T_CALL_CLOSED + 1000),
        text(7, '晚到的正文', T_CALL_CLOSED + 1100),
      ]);
      const group = groups(store)[0]!;
      if (group.status !== 'cancelled') return `晚到的 delta 改了状态：${group.status}`;
      if (group.liveReasoning !== undefined)
        return `晚到的 delta 让「正在思考」复活：${group.liveReasoning}`;
      if (group.liveText !== undefined) return `晚到的 delta 让 live 正文复活：${group.liveText}`;
      if (runningGroups(groups(store)).length !== 0) return '晚到的 delta 让停止按钮复活';
      return null;
    },
  },
  {
    name: 'R12 真终态晚于对账到达：真证据赢，且抹掉对账痕迹',
    check: () => {
      const store = new EventStore(0);
      feed(store, [...stuckEntries(), agentClosed(5)]);
      if (groups(store)[0]!.reconciled !== 'agent-closed') return '前提不成立：没有对账痕迹';
      feed(store, [
        runEv(
          6,
          'run.completed',
          { output: '其实跑完了', duration_ms: 1234 },
          RUN,
          T_CALL_CLOSED + 2000,
        ),
      ]);
      const group = groups(store)[0]!;
      if (group.status !== 'completed') return `真终态没赢：${group.status}`;
      if (group.reconciled !== undefined) return `真终态到了还留着对账痕迹：${group.reconciled}`;
      if (group.output !== '其实跑完了') return `产物没写进来：${group.output}`;
      if (store.items.getSnapshot().stats.reconciled !== 1) {
        return `stats.reconciled 计数不对：${store.items.getSnapshot().stats.reconciled}`;
      }
      return null;
    },
  },
];

const failures: { name: string; detail: string }[] = [];
for (const fixture of FIXTURES) {
  let detail: string | null = null;
  try {
    detail = fixture.check();
  } catch (error) {
    detail = `抛出异常：${error instanceof Error ? error.message : String(error)}`;
  }
  if (detail !== null) failures.push({ name: fixture.name, detail });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`);
    console.log(`     ${failure.detail}`);
  }
  console.error(`run reconcile: ${failures.length}/${FIXTURES.length} fixture(s) FAILED`);
  process.exit(1);
}

console.log(`run reconcile: ${FIXTURES.length} fixtures passed`);
