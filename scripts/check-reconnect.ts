/**
 * 断线 / 重连抖动抑制 + 重连强制 hydrate 探针（零依赖，不进 gates 链）。
 *
 * 症状：平台层重启 node 时 WS 会断 ~0.6s，重连起来像没事发生；旧行为是
 * `connectionState !== 'open'` 就闪一条「已断开」，于是用户每次重启都看到一次
 * 「已断开 → 已连接」的闪烁。比闪烁更糟的是**收口**：断线期间 run 的终态帧丢了，
 * 重连后客户端也不主动拉快照，屏上就永久停在「停止按钮 + 正在思考」。
 *
 * 本探针守的三条（对应任务书 a/b/c，外加接线守卫和一条端到端）：
 *
 *   C1  退避序列：0.5 → 1 → 2 → 4 → 8，封顶 8s（random 注入到抖动中心）
 *   C2  抖动：random=0/1 落在 ±20% 边界，任何档位都不越过 8s 封顶
 *   C3  断开 <2s 又连上 ⇒ **全程不产生任何「断开」状态**（平台层 0.6s 重启不可见）
 *   C4  平台层抖动 ×10（0.6s 断-连反复）⇒ visible 一次都不为 true
 *   C5  越过 2s 才提示；恢复即清；下一次断线重新计时（不继承旧起点）
 *   C6  长断线里 connecting ↔ reconnecting 抖动**不重置**宽限起点（否则永远等不到提示）
 *   C7  重连判定：首次 hello 不算重连；之后每次 hello 触发**恰好一次** hydrate
 *   C8  端到端：断线期间卡住的 run + 重连触发强制 hydrate + 快照 interrupted
 *       ⇒ 停止按钮消失、live 思考清空、状态是 interrupted（不是 completed）
 *   C9  接线守卫（源码文本）：handler 用 afterConnectionHello / nextReconnectDelay、
 *       Provider 用 useLinkStatus 且 stale 依赖 linkStatus.visible、退避只有一套实现
 *
 * 纪律：只测纯模块 + 生产接线函数，不碰 DOM、不碰 React 运行时；时间与随机数全部注入。
 *
 * 用法：bun run scripts/check-reconnect.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  nextReconnectDelay,
  reconnectBaseDelay,
} from '../apps/web/src/gateway/backoff';
import {
  LINK_GRACE_MS,
  afterConnectionHello,
  createLinkStatusMachine,
  createReconnectDetector,
} from '../apps/web/src/gateway/link-status';
import { sessionTerminalOfDetail } from '../apps/web/src/domains/chat/transcript-items';
import type {
  ConnectionState,
} from '../apps/web/src/gateway/node/protocol';
import type { SessionDetail } from '../apps/web/src/gateway/types/sessions';
import type { RunEvent } from '../apps/web/src/gateway/types/runs';
import { EventStore } from '../apps/web/src/state/event-store';
import type { RunGroup, StoredEvent } from '../apps/web/src/state/events';

const SESSION = '59764f88-a4e6-4523-bac3-f62053ffa9e1';
const RUN = 'bf2be130-9920-4d17-92b0-b46e3d7e4e3a';
const T0 = 1_794_560_000_000;

/** 抖动中心：random=0.5 ⇒ 乘性抖动 = 1.0 ⇒ 延迟就是标称值（断言序列用这个）。 */
const MID = (): number => 0.5;

function ev(seq: number, type: string, data: Record<string, unknown>, ts = T0 + seq * 1000): StoredEvent {
  const event: RunEvent = { type, run_id: String(data.run_id ?? RUN), ts, data };
  return { seq, event };
}

function runEv(
  seq: number,
  type: string,
  extra: Record<string, unknown> = {},
  ts = T0 + seq * 1000,
): StoredEvent {
  return ev(seq, type, { run_id: RUN, session_id: SESSION, ...extra }, ts);
}

function feed(store: EventStore, entries: readonly StoredEvent[]): void {
  for (const entry of entries) store.push(entry.event, { seq: entry.seq });
  store.flush();
  store.items.flush();
}

function groups(store: EventStore): readonly RunGroup[] {
  return store.items.getSnapshot().groups;
}

/** `useChatTranscript.ts` 里 `runningGroup` 的判据（逐字复刻）：停止按钮只在它非空时出现。 */
function runningGroups(list: readonly RunGroup[]): RunGroup[] {
  return list.filter((group) => group.status === 'running' && group.hasRunEvent === true);
}

function itemsOf(group: RunGroup): { kind: string; endedAt?: number; text?: string }[] {
  return group.items as unknown as { kind: string; endedAt?: number; text?: string }[];
}

/** 只有 run.started + 未闭合 delta 的「断线卡住的 run」。 */
function stuckEntries(): StoredEvent[] {
  return [
    runEv(1, 'run.started', { input: '查一下' }),
    runEv(2, 'llm.stream.chunk', { chunk: { type: 'reasoning_delta', delta: '先看看事件流' } }),
    runEv(3, 'llm.stream.chunk', { chunk: { type: 'text_delta', delta: '结论是一半' } }),
  ];
}

/** 假 clock：探针自己推进时间，不等真实 2 秒。 */
function fakeClock(start = 0): { now: () => number; set: (at: number) => void; advance: (by: number) => void } {
  let at = start;
  return {
    now: () => at,
    set: (next) => {
      at = next;
    },
    advance: (by) => {
      at += by;
    },
  };
}

const REPO = join(import.meta.dir, '..');

function source(relativePath: string): string {
  return readFileSync(join(REPO, relativePath), 'utf8');
}

const FIXTURES: { name: string; check: () => string | null }[] = [
  {
    name: 'C1 退避序列 0.5→1→2→4→8 封顶（random 注入到抖动中心）',
    check: () => {
      const expected = [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000];
      const actual = expected.map((_, attempt) => nextReconnectDelay(attempt, MID));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        return `退避序列错了：${actual.join('→')}（期望 ${expected.join('→')}）`;
      }
      if (RECONNECT_BASE_MS !== 500) return `首档不是 0.5s：${RECONNECT_BASE_MS}`;
      if (RECONNECT_MAX_MS !== 8000) return `封顶不是 8s：${RECONNECT_MAX_MS}`;
      // 封顶是「不早也不晚」：3 档还在涨，第 4 档到头。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!(reconnectBaseDelay(attempt + 1) > reconnectBaseDelay(attempt))) {
          return `第 ${attempt} 档没有翻倍：${reconnectBaseDelay(attempt)} → ${reconnectBaseDelay(attempt + 1)}`;
        }
      }
      return null;
    },
  },
  {
    name: 'C2 抖动 ±20% 且任何档位都不越过 8s 封顶',
    check: () => {
      const low = nextReconnectDelay(0, () => 0);
      const high = nextReconnectDelay(0, () => 1);
      if (low !== 400) return `抖动下界不对：${low}（期望 400 = 500×0.8）`;
      if (high !== 600) return `抖动上界不对：${high}（期望 600 = 500×1.2）`;
      for (let attempt = 0; attempt <= 12; attempt += 1) {
        for (const unit of [0, 0.25, 0.5, 0.75, 1]) {
          const delay = nextReconnectDelay(attempt, () => unit);
          if (delay > RECONNECT_MAX_MS) return `第 ${attempt} 档越过了封顶：${delay}`;
          const base = reconnectBaseDelay(attempt);
          if (delay < Math.floor(base * 0.8) || delay > Math.ceil(base * 1.2)) {
            return `第 ${attempt} 档抖动跑出 ±20%：${delay}（base ${base}）`;
          }
        }
        // 抖动必须真的在抖：同一档不同 random 不给同一个数（除非被封顶压平）。
        const spread = nextReconnectDelay(attempt, () => 1) - nextReconnectDelay(attempt, () => 0);
        if (reconnectBaseDelay(attempt) < RECONNECT_MAX_MS && spread <= 0) {
          return `第 ${attempt} 档没有抖动（spread=${spread}）`;
        }
      }
      // 非法 random 不许产生 NaN/Infinity
      const weird = nextReconnectDelay(2, () => Number.NaN);
      if (!Number.isFinite(weird) || weird <= 0) return `random 返回 NaN 时延迟坏了：${weird}`;
      return null;
    },
  },
  {
    name: 'C3 断开 <2s 又连上 ⇒ 全程不产生任何「断开」状态',
    check: () => {
      const clock = fakeClock(0);
      const link = createLinkStatusMachine({ now: clock.now });
      const seen: { phase: string; visible: boolean }[] = [];
      const step = (state: ConnectionState, at: number) => {
        clock.set(at);
        const snapshot = link.onConnectionState(state);
        seen.push({ phase: snapshot.phase, visible: snapshot.visible });
        return snapshot;
      };
      step('open', 0);
      const grace = step('closed', 100);
      if (grace.phase !== 'grace') return `断开瞬间不是 grace：${grace.phase}`;
      if (grace.visible) return '断开瞬间就提示了（宽限期没生效）';
      if (link.noticeAt() !== 100 + LINK_GRACE_MS) {
        return `宽限唤醒时刻不对：${link.noticeAt()}（期望 ${100 + LINK_GRACE_MS}）`;
      }
      // 0.6s 后平台层重启完成，连回来。
      const back = step('open', 700);
      if (back.phase !== 'connected') return `重连后不是 connected：${back.phase}`;
      if (back.disconnectedAt !== null) return `重连后还留着断线时刻：${back.disconnectedAt}`;
      if (link.noticeAt() !== null) return `重连后还排着宽限定时器：${link.noticeAt()}`;
      // 宽限期定时器即使晚到（浏览器节流），也已经连上了 —— 不许翻成「已断开」。
      clock.set(5000);
      const woke = link.onWake();
      if (woke.phase !== 'connected' || woke.visible) {
        return `迟到的宽限唤醒把状态翻成了 ${woke.phase}（visible=${woke.visible}）`;
      }
      const visibleEver = seen.some((snapshot) => snapshot.visible);
      if (visibleEver) return `短断线产生了「断开」状态：${JSON.stringify(seen)}`;
      return null;
    },
  },
  {
    name: 'C4 平台层抖动 ×10（0.6s 断-连反复）⇒ visible 一次都不为 true',
    check: () => {
      const clock = fakeClock(0);
      const link = createLinkStatusMachine({ now: clock.now });
      link.onConnectionState('open');
      let visibleCount = 0;
      let offlineCount = 0;
      for (let round = 0; round < 10; round += 1) {
        clock.set(1000 * round + 100);
        const down = link.onConnectionState('closed');
        if (down.visible) visibleCount += 1;
        // 平台层重启窗口 0.6s
        clock.set(1000 * round + 700);
        // 中途定时器可能已被排上：即便它先醒也不许提示（已经连上了）
        const woke = link.onWake();
        if (woke.phase === 'offline') offlineCount += 1;
        const up = link.onConnectionState('open');
        if (up.visible) visibleCount += 1;
      }
      if (visibleCount !== 0) return `抖动里闪了 ${visibleCount} 次「已断开」`;
      if (offlineCount !== 0) return `抖动里越线成 offline ${offlineCount} 次`;
      if (link.noticeAt() !== null) return '稳定后还排着宽限定时器';
      return null;
    },
  },
  {
    name: 'C5 越过 2s 才提示；恢复即清；下一次断线重新计时',
    check: () => {
      const clock = fakeClock(0);
      const link = createLinkStatusMachine({ now: clock.now });
      link.onConnectionState('open');
      clock.set(100);
      const down = link.onConnectionState('closed');
      if (down.visible) return '刚断就提示（宽限期没生效）';
      clock.set(100 + LINK_GRACE_MS - 1);
      const early = link.onWake();
      if (early.visible) return `差 1ms 就提示了：${early.phase}`;
      if (early.phase !== 'grace') return `差 1ms 就离线了：${early.phase}`;
      if (link.noticeAt() !== 100 + LINK_GRACE_MS) return '早醒之后没有重新排期';
      clock.set(100 + LINK_GRACE_MS);
      const late = link.onWake();
      if (!late.visible) return '越过宽限期仍不提示（提示会永远不出现）';
      if (late.phase !== 'offline') return `越过宽限期状态错了：${late.phase}`;
      if (late.disconnectedAt !== 100) return `断线时刻丢了：${late.disconnectedAt}`;
      clock.set(100 + LINK_GRACE_MS + 500);
      const up = link.onConnectionState('open');
      if (up.visible) return '恢复后提示没清';
      if (up.disconnectedAt !== null) return '恢复后断线时刻没清';
      // 第二次断线：起点必须是这次，不是上次。
      clock.set(9000);
      const again = link.onConnectionState('closed');
      if (link.noticeAt() !== 9000 + LINK_GRACE_MS) {
        return `第二次断线继承了旧起点：${link.noticeAt()}（期望 ${9000 + LINK_GRACE_MS}）`;
      }
      if (again.visible) return '第二次断线立刻提示';
      return null;
    },
  },
  {
    name: 'C6 长断线里 connecting / reconnecting 抖动不重置宽限起点',
    check: () => {
      const clock = fakeClock(0);
      const link = createLinkStatusMachine({ now: clock.now });
      link.onConnectionState('open');
      clock.set(100);
      link.onConnectionState('reconnecting');
      for (const [at, state] of [
        [600, 'connecting'],
        [1400, 'reconnecting'],
        [3000, 'connecting'],
      ] as [number, ConnectionState][]) {
        clock.set(at);
        link.onConnectionState(state);
        if (link.noticeAt() !== 100 + LINK_GRACE_MS) {
          return `${at}ms 的重试把宽限起点推到了 ${link.noticeAt()}（永远等不到提示）`;
        }
      }
      clock.set(100 + LINK_GRACE_MS);
      const woke = link.onWake();
      if (!woke.visible) return '长断线一直不提示（重试把宽限窗无限延长了）';
      return null;
    },
  },
  {
    name: 'C7 重连判定：首次 hello 不算重连，之后每次 hello 恰好一次 hydrate',
    check: () => {
      const calls: number[] = [];
      const detector = createReconnectDetector();
      const hello = () => afterConnectionHello({ detector, onReconnected: () => calls.push(1) });
      const first = hello();
      if (first) return '首次连接被当成重连（会白拉一次快照）';
      if (calls.length !== 0) return `首次连接就 hydrate 了 ${calls.length} 次`;
      const reconnect = hello();
      if (!reconnect) return '第二次 hello 没被认成重连';
      if (calls.length !== 1) return `重连没有恰好触发一次 hydrate：${calls.length}`;
      // 一次重连只 hydrate 一次 —— 再点一次同名 hello 才算下一次重连。
      hello();
      if (calls.length !== 2) return `第二次重连的 hydrate 计数不对：${calls.length}`;
      detector.reset();
      const afterReset = hello();
      if (afterReset) return 'reset 之后的首个 hello 又被当成重连';
      if (calls.length !== 2) return 'reset 之后的首个 hello 触发了 hydrate';
      return null;
    },
  },
  {
    name: 'C8 端到端：断线卡住的 run → 重连强制 hydrate → 快照 interrupted 收口（不冒充完成）',
    check: () => {
      const clock = fakeClock(0);
      const link = createLinkStatusMachine({ now: clock.now });
      const store = new EventStore(0);
      // 断线前：run 跑到一半（worktree 有 run.started + 未闭合 delta）。
      link.onConnectionState('open');
      feed(store, stuckEntries());
      if (runningGroups(groups(store)).length !== 1) return '前提不成立：没有卡住的 running 组';

      // 断线 4s（越过宽限期）→ 提示；中途还有一次重试抖动。
      clock.set(100);
      link.onConnectionState('closed');
      clock.set(1500);
      link.onConnectionState('reconnecting');
      clock.set(100 + LINK_GRACE_MS);
      const offline = link.onWake();
      if (!offline.visible) return '断线 2s 后仍不提示（用户被蒙在鼓里）';

      // 重连成功：生产路径 = afterConnectionHello → recovery.onReconnected（强制 hydrate）。
      const INTERRUPTED_AT = T0 + 9000;
      const detail = {
        session_id: SESSION,
        run_id: RUN,
        status: 'interrupted',
        created_at: T0,
        updated_at: INTERRUPTED_AT,
        item_count: 2,
      } as unknown as SessionDetail;
      let hydrates = 0;
      const detector = createReconnectDetector();
      const forcedHydrate = () => {
        hydrates += 1;
        // Provider 里 onReconnected 做的事：拉快照 + 对账本地 live 状态。
        const terminal = sessionTerminalOfDetail(detail);
        if (terminal === undefined) return;
        store.items.closeRuns(SESSION, {
          ...(terminal.runId !== undefined ? { runIds: [terminal.runId] } : {}),
          status: terminal.status,
          at: terminal.at,
          via: 'session-snapshot',
        });
        store.items.flush();
      };

      afterConnectionHello({ detector, onReconnected: () => undefined }); // 首次 hello：不算重连
      clock.set(4100);
      const up = link.onConnectionState('open');
      if (up.visible) return '重连后提示没清';
      afterConnectionHello({ detector, onReconnected: forcedHydrate });
      if (hydrates !== 1) return `重连没有恰好强制 hydrate 一次：${hydrates}`;

      // 收口结果：停止按钮消失、live 思考清空、状态是 interrupted（不是 completed）。
      const list = groups(store);
      if (runningGroups(list).length !== 0) return '重连 hydrate 之后停止按钮还在';
      const group = list[0];
      if (group === undefined) return '收口之后渲染表里没有这一组了';
      if (group.status !== 'interrupted') return `快照 interrupted，组却是 ${group.status}`;
      if (String(group.status) === 'completed') return 'interrupted 被写成了 completed（冒充完成）';
      if (group.liveReasoning !== undefined) return `还挂着「正在思考」：${group.liveReasoning}`;
      if (group.liveText !== undefined) return `还挂着 live 正文：${group.liveText}`;
      if (group.completedAt !== INTERRUPTED_AT) return `中断时刻没落到组上：${group.completedAt}`;
      const reasoningItem = itemsOf(group).find((item) => item.kind === 'reasoning');
      if (reasoningItem === undefined) return '收口把已产出的思考丢了';
      if (reasoningItem.endedAt === undefined) return '思考 item 没有 endedAt（看不清到哪为止）';
      const textItem = itemsOf(group).find((item) => item.kind === 'text');
      if (textItem === undefined) return '收口把已产出的正文丢了';
      if (textItem.endedAt === undefined) return '正文 item 没有 endedAt';
      // 幂等：再 hydrate 一次（比如用户切回来）不许重复收口。
      const itemCount = group.items.length;
      forcedHydrate();
      const again = groups(store)[0];
      if (again === undefined) return '二次 hydrate 之后组没了';
      if (again.items.length !== itemCount) return '二次 hydrate 又多出了 item';
      if (store.items.getSnapshot().stats.reconciled !== 1) {
        return `二次 hydrate 把 stats.reconciled 涨了：${store.items.getSnapshot().stats.reconciled}`;
      }
      return null;
    },
  },
  {
    name: 'C9 接线守卫：handler / Provider / hook 真的用了这些模块（防静默脱线）',
    check: () => {
      const handlers = source('apps/web/src/gateway/connection-handlers.ts');
      if (!handlers.includes('afterConnectionHello({'))
        return 'connection-handlers 没走 afterConnectionHello（重连不 hydrate）';
      if (!handlers.includes('nextReconnectDelay(')) return 'connection-handlers 没走退避';
      if (handlers.includes('nextReconnectDelay(attempt)') === false) {
        return '退避调用没带 attempt（第一档就封顶/不变）';
      }
      const provider = source('apps/web/src/gateway/ConnectionProvider.tsx');
      if (!provider.includes('useLinkStatus(')) return 'ConnectionProvider 没接 useLinkStatus';
      if (!provider.includes('linkStatus.visible')) return 'stale 没依赖 linkStatus.visible（宽限期白做）';
      const hook = source('apps/web/src/gateway/use-link-status.ts');
      if (!hook.includes('createLinkStatusMachine')) return 'hook 没建状态机';
      if (!hook.includes('noticeAt()')) return 'hook 没按 noticeAt 排宽限定时器';
      // 退避只有一套实现：退避数学不许再长回 reconnect.ts（否则探针测的和线上跑的分家）
      const reconnect = source('apps/web/src/gateway/reconnect.ts');
      if (reconnect.includes('nextReconnectDelay')) {
        return 'reconnect.ts 里又长出了退避实现（两套实现会漂移）';
      }
      if (!reconnect.includes('classifyCloseCode')) return 'reconnect.ts 的关码分类被搬走了？';
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
  console.error(`reconnect: ${failures.length}/${FIXTURES.length} fixture(s) FAILED`);
  process.exit(1);
}

console.log(`reconnect: ${FIXTURES.length} fixtures passed`);

