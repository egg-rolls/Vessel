/**
 * ask 归属的窄属性测试（0.51：`parent_session_id` 与父 agent id 分家 + 会话页守卫）。
 *
 * 形态沿用 `src/refs-notice-hook.test.ts`（仓库没有 test gate；纯函数的窄属性测试是
 * 被允许的例外，直接跑 `bun run src/ask-attribution.test.ts`，判定看输出文本）。
 *
 * 断言的是**这一单的四条行为**，不是实现细节：
 *
 * 1. 新归属可读：父会话 id ≠ 父 agent id 时，两条链（事件实时 / `interactions.list`
 *    补回）都把两个键分别读出来，且不像旧代码那样二选一；
 * 2. 旧数据兑底：`parent_session_id` 里装的是 agent id 的历史记录，靠 roster 上溯
 *    能算对归属；
 * 3. 会话页守卫：父会话**不**渲染子成员的 ask（即便父会话正是它的归属）；
 * 4. 待批页仍能看到：同一条 ask 在待批聚类里在，且归属会话标对。
 *
 * **生产侧（bridge 写入）不在这里测**：`packages/agent/src/runtime.ts` import
 * `@vessel-agent/core`（workspace 别名），本 worktree 没有 node_modules、也不允许
 * `bun install`，所以这里 import 不到它。写入形状由 `scripts/check-ask-attribution.ts`
 * 门禁按源码断言（`parent_agent_id` / `parent_session_id` 各写各的，且不许再出现
 * `data.parent_session_id = member.parent_id` 那一行）。
 */

import {
  type AttributionIndex,
  attributedSessionId,
  attributionIndexOf,
  EMPTY_ATTRIBUTION_INDEX,
  pendingHome,
  pendingOwnedBySession,
  resolveParentSession,
  rosterAttributionIndex,
} from '../apps/web/src/domains/pending/attribution';
import { asksForSession, groupPendingAsks } from '../apps/web/src/domains/pending/cluster';
import { buildHydrationSnapshot } from '../apps/web/src/gateway/interaction-hydration';
import { askFromEvent } from '../apps/web/src/gateway/interactions';
import type { AskUserRequest, RunEvent } from '../apps/web/src/gateway/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

/** 父会话与父 agent 一定不同的两个 id（这一单的全部前提：它们不再混用）。 */
const PARENT_SESSION = 'd63d5884-2d2b-4bd0-9a1c-main4body';
const PARENT_AGENT = 'main';
const MEMBER_SESSION = 'e7bf8d04-fc9f-4c8a-9d3e-contractor';

/** 一条 bridge 之后的 ask 事件（父子归属都在，且两者不同）。 */
function bridgedAskEvent(): RunEvent {
  return {
    type: 'ask.user.requested',
    run_id: 'run-child',
    ts: 1000,
    data: {
      requestId: 'req-1',
      session_id: MEMBER_SESSION,
      parent_session_id: PARENT_SESSION,
      parent_agent_id: PARENT_AGENT,
      agent_id: MEMBER_SESSION,
      team_id: 'vessel',
      questions: [{ header: 'h', question: 'q' }],
    },
  };
}

/** roster：main（父）当前 primary body = PARENT_SESSION；contractor 自己的会话是成员会话。 */
const ROSTER = [
  { agent_id: PARENT_AGENT, session_id: PARENT_SESSION, role: 'member' },
  {
    agent_id: MEMBER_SESSION,
    session_id: MEMBER_SESSION,
    parent_id: PARENT_AGENT,
    role: 'temporary',
  },
];

/** 一条历史脏记录的提问模型（`parentSessionId` 里装的是 agent id）。 */
function legacyAsk(): AskUserRequest {
  return {
    requestId: 'req-legacy',
    questions: [{ header: 'h', question: 'q' }],
    runId: 'run-legacy',
    requestedAt: 10,
    sessionId: MEMBER_SESSION,
    parentSessionId: PARENT_AGENT,
    agentId: MEMBER_SESSION,
    teamId: 'vessel',
  };
}

/** 一条新归属的提问模型（父会话 / 父 agent 分开）。 */
function freshAsk(): AskUserRequest {
  return {
    requestId: 'req-fresh',
    questions: [{ header: 'h', question: 'q' }],
    runId: 'run-fresh',
    requestedAt: 20,
    sessionId: MEMBER_SESSION,
    parentSessionId: PARENT_SESSION,
    parentAgentId: PARENT_AGENT,
    agentId: MEMBER_SESSION,
    teamId: 'vessel',
  };
}

function main(): void {
  const index: AttributionIndex = attributionIndexOf(ROSTER);

  // ---- 1. 新归属可读：两个键分别读出，且不相等 ----
  const fromEvent = askFromEvent(bridgedAskEvent());
  check(
    '事件链读回父会话',
    fromEvent?.parentSessionId === PARENT_SESSION,
    String(fromEvent?.parentSessionId),
  );
  check(
    '事件链读回父 agent',
    fromEvent?.parentAgentId === PARENT_AGENT,
    String(fromEvent?.parentAgentId),
  );
  check(
    '事件链两个键不串',
    fromEvent?.parentSessionId !== fromEvent?.parentAgentId,
    `${String(fromEvent?.parentSessionId)} / ${String(fromEvent?.parentAgentId)}`,
  );
  check(
    '事件链的成员会话不动',
    fromEvent?.sessionId === MEMBER_SESSION,
    String(fromEvent?.sessionId),
  );

  // `interactions.list` 补回（刷新 / 重连后唯一路径）也要两个键都在
  const snapshot = buildHydrationSnapshot({
    orphaned: [],
    pending: [
      {
        kind: 'ask',
        request_id: 'req-1',
        run_id: 'run-child',
        session_id: MEMBER_SESSION,
        parent_session_id: PARENT_SESSION,
        parent_agent_id: PARENT_AGENT,
        agent_id: MEMBER_SESSION,
        team_id: 'vessel',
        questions: [{ header: 'h', question: 'q' }],
        created_at: 1000,
        status: 'pending',
      },
    ],
  });
  const hydrated = snapshot.asks[0];
  check(
    'hydration 读回父会话',
    hydrated?.parentSessionId === PARENT_SESSION,
    String(hydrated?.parentSessionId),
  );
  check(
    'hydration 读回父 agent',
    hydrated?.parentAgentId === PARENT_AGENT,
    String(hydrated?.parentAgentId),
  );
  check(
    'hydration 两个键不串',
    hydrated?.parentSessionId !== hydrated?.parentAgentId,
    `${String(hydrated?.parentSessionId)} / ${String(hydrated?.parentAgentId)}`,
  );

  // ---- 2. 旧数据兑底：parent_session_id 里装的是 agent id ----
  check(
    '旧记录认得出 agent id 并上溯',
    resolveParentSession(legacyAsk(), index) === PARENT_SESSION,
    String(resolveParentSession(legacyAsk(), index)),
  );
  check(
    '旧记录不被当成会话 id',
    resolveParentSession(legacyAsk(), index) !== PARENT_AGENT,
    String(resolveParentSession(legacyAsk(), index)),
  );
  // 没有 roster 时退回旧行为（当成会话 id），但绝不崩、也不丢卡片
  check(
    '无 roster 兑底退旧行为',
    resolveParentSession(legacyAsk(), EMPTY_ATTRIBUTION_INDEX) === PARENT_AGENT,
    String(resolveParentSession(legacyAsk(), EMPTY_ATTRIBUTION_INDEX)),
  );
  // 新记录不依赖上溯：parent_agent_id 直接给出父会话
  check(
    '新记录按父 agent 解析',
    resolveParentSession(freshAsk(), index) === PARENT_SESSION,
    String(resolveParentSession(freshAsk(), index)),
  );
  // 父 agent 自己没有 live body（rotate 窗口）时继续上溯一级
  const windowIndex = attributionIndexOf([
    { agent_id: PARENT_AGENT, parent_id: 'root-agent' },
    { agent_id: 'root-agent', session_id: 'root-session' },
  ]);
  check(
    '父 agent 无 body 时再上一级',
    resolveParentSession(freshAsk(), windowIndex) === 'root-session',
    String(resolveParentSession(freshAsk(), windowIndex)),
  );
  // 环不致死循环（脏 roster 的兜底）：保留一份自指的索引
  const cyclicIndex = attributionIndexOf([{ agent_id: 'a', parent_id: 'a' }]);
  check(
    '自指 roster 不死循环',
    resolveParentSession({ parentSessionId: 'a', parentAgentId: 'a' }, cyclicIndex) === undefined,
  );
  // roster 从 NodeRoster 形状也能建出同一份索引（两条来源都要能用）
  const fromRoster = rosterAttributionIndex([{ agents: [], rosters: [{ members: ROSTER }] }]);
  check(
    'roster 形状建索引可用',
    resolveParentSession(legacyAsk(), fromRoster) === PARENT_SESSION,
    String(resolveParentSession(legacyAsk(), fromRoster)),
  );

  // ---- 3. 会话页守卫：父会话不渲染子成员的 ask ----
  const emptyRuns: ReadonlySet<string> = new Set();
  check(
    '父会话不渲染 contractor 的 ask',
    pendingOwnedBySession(legacyAsk(), PARENT_SESSION, emptyRuns) === false,
  );
  check(
    '父会话不渲染新归属的 ask',
    pendingOwnedBySession(freshAsk(), PARENT_SESSION, emptyRuns) === false,
  );
  check(
    '成员自己的会话也只在它自己的会话页渲染',
    pendingOwnedBySession(freshAsk(), MEMBER_SESSION, emptyRuns) === true,
  );
  // 父 agent 自己发的 ask（无 parent 字段）当然要在自己的会话页渲染
  const parentAsk: AskUserRequest = {
    requestId: 'req-parent',
    questions: [{ header: 'h', question: 'q' }],
    runId: 'run-parent',
    requestedAt: 30,
    sessionId: PARENT_SESSION,
    agentId: PARENT_AGENT,
  };
  check(
    '父自己的 ask 在父会话渲染',
    pendingOwnedBySession(parentAsk, PARENT_SESSION, emptyRuns) === true,
  );
  // 旧流（完全没有 session_id）：只能用 run 归属兜底
  const legacyStream = { runId: 'run-parent' };
  check(
    '缺 session 的老流按 run 兜底',
    pendingOwnedBySession(legacyStream, PARENT_SESSION, new Set(['run-parent'])) === true,
  );
  check(
    '缺 session 且 run 不属于该会话则不渲染',
    pendingOwnedBySession(legacyStream, PARENT_SESSION, new Set(['run-other'])) === false,
  );
  check('草稿态不渲染任何卡片', pendingOwnedBySession(parentAsk, null, emptyRuns) === false);

  // ---- 4. 待批页仍能看到，且归属算对了 ----
  const clusters = groupPendingAsks([legacyAsk(), freshAsk(), parentAsk], index);
  check('待批页三条都在', clusters.reduce((sum, c) => sum + c.requests.length, 0) === 3);
  const memberCluster = clusters.find((cluster) => cluster.agentId === MEMBER_SESSION);
  check('待批页有 contractor 那一簇', memberCluster !== undefined);
  check(
    '簇归属 = 父会话（旧数据兑底后）',
    memberCluster?.homeSessionId === PARENT_SESSION,
    String(memberCluster?.homeSessionId),
  );
  check(
    '旧数据与新数据落在同一簇',
    memberCluster?.requests.length === 2,
    String(memberCluster?.requests.length),
  );
  check(
    '簇里仍能看见成员自己的会话',
    memberCluster?.sessionId === MEMBER_SESSION,
    String(memberCluster?.sessionId),
  );
  const parentCluster = clusters.find((cluster) => cluster.agentId === PARENT_AGENT);
  check(
    '父自己的簇不标归属会话（与自己相同就不多说一句）',
    parentCluster?.homeSessionId === PARENT_SESSION,
    String(parentCluster?.homeSessionId),
  );

  // 「本会话有 N 条待批」入口：父会话能数到 contractor 那条
  check(
    '本会话待批计数含 contractor 的 ask',
    asksForSession([legacyAsk(), freshAsk(), parentAsk], PARENT_SESSION, index).length === 3,
  );
  check(
    '成员会话也只数到自己的那条',
    asksForSession([freshAsk()], MEMBER_SESSION, index).length === 1,
  );
  check(
    '无 roster 时父会话只数到自己的',
    asksForSession([legacyAsk(), parentAsk], PARENT_SESSION, EMPTY_ATTRIBUTION_INDEX).length === 1,
  );

  // 归属解析出来的两件事：展示（会话 id）与跳转落点（待批页 / 会话页）
  check(
    '成员 bridge 归到父会话',
    attributedSessionId(freshAsk(), index) === PARENT_SESSION,
    String(attributedSessionId(freshAsk(), index)),
  );
  const home = pendingHome(freshAsk(), index);
  check('成员 bridge 的落点是待批页', home.kind === 'agent', home.kind);
  check(
    '落点带上父会话（待批页据此定位那一簇）',
    home.kind === 'agent' && home.sessionId === PARENT_SESSION,
    home.kind === 'agent' ? String(home.sessionId) : home.kind,
  );
  const parentHome = pendingHome(parentAsk, index);
  check(
    '普通请求的落点是自己的会话页',
    parentHome.kind === 'session' && parentHome.sessionId === PARENT_SESSION,
    parentHome.kind,
  );
  check(
    '既无会话也无归属不给落点',
    pendingHome({ runId: 'run-x' } as unknown as AskUserRequest, index).kind === 'unknown',
  );

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK ask-attribution: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED ask-attribution: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

main();
