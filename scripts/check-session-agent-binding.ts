#!/usr/bin/env bun

/**
 * 会话归属（additive `agent`，0.52）门禁。
 *
 * 用户的问题：会话卡片的第二行会**空白**或只剩 `primary`。根因是关联**单向** ——
 * `SessionInfo` 里没有指向 agent 的字段，UI 只能拿 session id 去三份名单反查，而
 * 「非 primary body 的会话（rotate 之前的旧身体）」「agent 已从 roster 消失」「跨节点」
 * 三类反查都够不着。这个字段把关联补成双向，`sessions.list` / `sessions.get` 各带上归属。
 *
 * 判据（每一条都对应一种真实退化）：
 *   A 现役 body：`primary: true`，name / state / presence 都带上；
 *   B 退役 body（来自 `body_history[]`）：`primary: false` —— 前端据此显示「名字（旧身体）」；
 *   C 已停用成员：`state: 'closed'` —— 前端据此默认归档（否则残留会话混在正常列表里）；
 *   D **现役赢**：同一 session 同时出现在 `session_id` 与 `body_history` 时，`primary: true`；
 *   E 不认识的会话不凭空造 `agent`（没有归属就别编）；
 *   F **additive 退化**：`agent.list()` 抛错时 `sessions.list` 照常返回、只是没有 `agent`
 *     字段 —— 增强字段绝不能让列表整体失败；
 *   G `sessions.get` 也带同一个形状的 `agent`。
 *
 * 用法：bun run scripts/check-session-agent-binding.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';

const failures: string[] = [];
let checked = 0;

function expect(cond: boolean, message: string): void {
  checked += 1;
  if (!cond) failures.push(message);
}

const session = (id: string) => ({
  session_id: id,
  title: id,
  preview: '',
  status: 'completed',
  started_at: 1,
  updated_at: 2,
  message_count: 0,
  title_source: 'manual',
});

const SESSIONS = ['s-live', 's-retired', 's-closed', 's-orphan'].map(session);

const MEMBERS = [
  {
    id: 'agent-live',
    name: 'builder',
    state: 'idle',
    presence: 'live',
    session_id: 's-live',
    body_history: [
      // 同一条 session 也在退役历史里：现役必须赢（D）。
      { session_id: 's-live', epoch: 0, retired_at: 1 },
      { session_id: 's-retired', epoch: 0, retired_at: 1 },
    ],
  },
  {
    id: 'agent-closed',
    name: 'gone',
    state: 'closed',
    presence: 'gone',
    session_id: 's-closed',
    body_history: [],
  },
];

function buildMethods(listImpl: () => Promise<unknown>) {
  return createSessionMethods({
    sessionFor: () =>
      ({
        listRich: async () => SESSIONS,
        load: async (sessionId: string) => SESSIONS.find((item) => item.session_id === sessionId),
        get: async (sessionId: string) => SESSIONS.find((item) => item.session_id === sessionId),
      }) as never,
    agent: { list: listImpl } as never,
  });
}

function find(methods: ReturnType<typeof buildMethods>, name: string) {
  const method = methods.find((item) => item.name === name);
  if (!method) throw new Error(`找不到 ${name}`);
  return method;
}

const methods = buildMethods((async () => MEMBERS) as never);
const list = (await find(methods, 'sessions.list').handler({}, {} as never)) as {
  sessions: Record<string, any>[];
};

const byId = new Map(list.sessions.map((item) => [item.session_id as string, item]));

// A. 现役 body
const live = byId.get('s-live')?.agent;
expect(live?.id === 'agent-live', 'A: 现役会话缺少 agent.id');
expect(live?.name === 'builder', 'A: 现役会话缺少 agent.name（前端就没法显示名字）');
expect(live?.primary === true, 'A: 现役会话必须 primary=true');
expect(live?.state === 'idle', 'A: 现役会话的状态没透出');
expect(live?.presence === 'live', 'A: 现役会话的 presence 没透出');

// B. 退役 body
const retired = byId.get('s-retired')?.agent;
expect(retired?.primary === false, 'B: 退役 body 的会话必须 primary=false（否则会显示成还活着）');
expect(retired?.name === 'builder', 'B: 退役 body 的会话也要有名字（「名字（旧身体）」靠它）');

// C. 已停用成员
const closed = byId.get('s-closed')?.agent;
expect(closed?.state === 'closed', 'C: 已停用成员的状态没透出（前端无法据此归档）');
expect(closed?.primary === true, 'C: 已停用成员的现役会话仍应是 primary');

// D. 现役赢
expect(live?.primary === true, 'D: body_history 里的同名 session 把现役顶掉了');

// E. 没有归属的会话不造字段
expect(byId.get('s-orphan')?.agent === undefined, 'E: 不认识的会话被编了一个 agent');

// F. additive 退化
const broken = buildMethods((async () => {
  throw new Error('registry down');
}) as never);
const brokenList = (await find(broken, 'sessions.list').handler({}, {} as never)) as {
  sessions: Record<string, any>[];
};
expect(
  brokenList.sessions.length === SESSIONS.length,
  'F: 成员列表查不到时列表少了会话（增强字段不该影响主结果）',
);
expect(
  brokenList.sessions.every((item) => item.agent === undefined),
  'F: 成员列表查不到时仍然编出了 agent 字段',
);

// G. sessions.get 同形状
const got = (await find(methods, 'sessions.get').handler(
  { session_id: 's-live' },
  {} as never,
)) as {
  agent?: { id?: string; primary?: boolean };
  session?: unknown;
};
expect(got.agent?.id === 'agent-live', 'G: sessions.get 没带 agent.id');
expect(got.agent?.primary === true, 'G: sessions.get 的 agent.primary 不对');
expect(got.session !== undefined, 'G: sessions.get 丢了 session 本体');

if (failures.length > 0) {
  console.error(
    `check-session-agent-binding: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-session-agent-binding: OK（${String(checked)} 项：现役 / 退役 / 已停用 / 现役赢 / 不编造 / 退化 / get 同形状）`,
);
